import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// ---------- Start OAuth ----------

export const startGoogleCalendarConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ targetOrigin: z.string().url() }).parse(input))
  .handler(async ({ data, context }) => {
    const clientKey = process.env["GOOGLE_CALENDAR_APP_USER_CONNECTOR_CLIENT_API_KEY"];
    if (!clientKey) throw new Error("Google Calendar client is not configured.");
    const { GATEWAY_BASE_URL, CONNECTOR_ID, GOOGLE_SCOPES } = await import(
      "./google-calendar.server"
    );
    const { getConnectionKeyForUser } = await import("./appUserConnections.server");
    const { authorizeAppUserOAuth } = await import("@/integrations/lovable/appUserConnector");
    const existing = await getConnectionKeyForUser(context.userId, CONNECTOR_ID);
    const { authorizationUrl } = await authorizeAppUserOAuth({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectorId: CONNECTOR_ID,
      appUserId: context.userId,
      clientAPIKey: clientKey,
      returnUrl: data.targetOrigin,
      responseMode: "web_message",
      webMessageTargetOrigin: data.targetOrigin,
      connectionAPIKey: existing ?? undefined,
      credentialsConfiguration: { scopes: GOOGLE_SCOPES },
    });
    return { authorizationUrl };
  });

// ---------- Save the key + fetch email label ----------

export const saveGoogleCalendarConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ connectionAPIKey: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { CONNECTOR_ID, fetchPrimaryCalendarLabel } = await import("./google-calendar.server");
    const { saveConnectionKeyForUser } = await import("./appUserConnections.server");
    const label = await fetchPrimaryCalendarLabel(data.connectionAPIKey);
    await saveConnectionKeyForUser(context.userId, CONNECTOR_ID, data.connectionAPIKey, label);
    return { ok: true, label };
  });

// ---------- Status ----------

export const getGoogleCalendarStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { CONNECTOR_ID, probeGoogleReadable } = await import("./google-calendar.server");
    const { getConnectionInfo, getConnectionKeyForUser } = await import(
      "./appUserConnections.server"
    );
    const info = await getConnectionInfo(context.userId, CONNECTOR_ID);
    if (!info) return { connected: false, accountLabel: null, readable: false, needsReconnect: false };
    // "Connected" must mean the key actually works — otherwise the UI lies.
    const key = await getConnectionKeyForUser(context.userId, CONNECTOR_ID);
    const readable = key ? await probeGoogleReadable(context.userId) : false;
    // A dead credential is cleared by the probe above — re-check so we don't
    // report a connection that no longer exists.
    const stillThere = key
      ? await getConnectionKeyForUser(context.userId, CONNECTOR_ID)
      : null;
    return {
      connected: !!stillThere,
      accountLabel: info.account_label ?? null,
      readable: readable && !!stillThere,
      needsReconnect: !!key && (!stillThere || !readable),
    };
  });


// ---------- Disconnect ----------

export const disconnectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { GATEWAY_BASE_URL, CONNECTOR_ID } = await import("./google-calendar.server");
    const { getConnectionKeyForUser, deleteConnectionForUser } = await import(
      "./appUserConnections.server"
    );
    const { disconnectAppUser } = await import("@/integrations/lovable/appUserConnector");
    const key = await getConnectionKeyForUser(context.userId, CONNECTOR_ID);
    if (key) {
      try {
        await disconnectAppUser({
          gatewayBaseUrl: GATEWAY_BASE_URL,
          connectionAPIKey: key,
          connectorId: CONNECTOR_ID,
        });
      } catch {
        /* ignore, still clear locally */
      }
    }
    await deleteConnectionForUser(context.userId, CONNECTOR_ID);
    return { ok: true };
  });

// ---------- Import a window from Google ----------

export const importGoogleCalendarWindow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ fromISO: z.string(), toISO: z.string() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { fetchGoogleBusy, CONNECTOR_ID } = await import("./google-calendar.server");
    const { getConnectionKeyForUser } = await import("./appUserConnections.server");
    const key = await getConnectionKeyForUser(context.userId, CONNECTOR_ID);
    if (!key) throw new Error("Google Calendar is not connected.");

    const { supabase, userId } = context;
    const events = await fetchGoogleBusy(userId, data.fromISO, data.toISO);
    if (events.length === 0) return { imported: 0 };

    const { data: existing } = await supabase
      .from("tasks")
      .select("title, start_at")
      .eq("user_id", userId)
      .gte("start_at", data.fromISO)
      .lte("start_at", data.toISO);
    const seen = new Set(
      ((existing ?? []) as Array<{ title: string; start_at: string }>).map(
        (r) => `${r.title.toLowerCase().trim()}|${new Date(r.start_at).getTime()}`,
      ),
    );

    const toInsert = events
      .filter((e) => !seen.has(`${e.title.toLowerCase().trim()}|${new Date(e.start).getTime()}`))
      .map((e) => {
        const start = new Date(e.start);
        const end = new Date(e.end);
        return {
          user_id: userId,
          title: e.title,
          notes: null,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          duration_minutes: Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000)),
          priority: "medium",
          category: "google",
          google_calendar_id: "primary",
        };
      });
    if (toInsert.length === 0) return { imported: 0 };
    const { error } = await supabase.from("tasks").insert(toInsert);
    if (error) throw new Error(error.message);
    console.log(`[gcal.import] imported ${toInsert.length} events for ${userId}`);
    return { imported: toInsert.length };
  });

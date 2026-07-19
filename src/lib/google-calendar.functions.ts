import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";
const CONNECTOR_ID = "google_calendar";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.events",
];

// ---------- Start OAuth ----------

export const startGoogleCalendarConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ targetOrigin: z.string().url() }).parse(input))
  .handler(async ({ data, context }) => {
    const clientKey = process.env.GOOGLE_CALENDAR_APP_USER_CONNECTOR_CLIENT_API_KEY;
    if (!clientKey) throw new Error("Google Calendar client is not configured.");
    const { authorizeAppUserOAuth } = await import("@/integrations/lovable/appUserConnector");
    const { authorizationUrl } = await authorizeAppUserOAuth({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectorId: CONNECTOR_ID,
      appUserId: context.userId,
      clientAPIKey: clientKey,
      returnUrl: data.targetOrigin,
      responseMode: "web_message",
      webMessageTargetOrigin: data.targetOrigin,
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
    const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
    const { saveConnectionKeyForUser } = await import("@/lib/appUserConnections.server");

    // Try to fetch the connected user's primary calendar id (which is their email).
    let label: string | null = null;
    try {
      const res = await callAsAppUser({
        gatewayBaseUrl: GATEWAY_BASE_URL,
        connectionAPIKey: data.connectionAPIKey,
        connectorId: CONNECTOR_ID,
        path: "/calendar/v3/calendars/primary",
      });
      if (res.ok) {
        const j = (await res.json()) as { id?: string; summary?: string };
        label = j.id ?? j.summary ?? null;
      }
    } catch {
      /* non-fatal */
    }

    await saveConnectionKeyForUser(context.userId, CONNECTOR_ID, data.connectionAPIKey, label);
    return { ok: true, label };
  });

// ---------- Status ----------

export const getGoogleCalendarStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getConnectionInfo } = await import("@/lib/appUserConnections.server");
    const info = await getConnectionInfo(context.userId, CONNECTOR_ID);
    return { connected: !!info, accountLabel: info?.account_label ?? null };
  });

// ---------- Disconnect ----------

export const disconnectGoogleCalendar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getConnectionKeyForUser, deleteConnectionForUser } = await import(
      "@/lib/appUserConnections.server"
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

// ---------- Push / update / delete against Google (internal, called from tasks.functions) ----------

export async function pushTaskToGoogle(
  userId: string,
  task: {
    id: string;
    title: string;
    notes: string | null;
    start_at: string;
    end_at: string;
    google_event_id: string | null;
  },
): Promise<{ google_event_id: string | null }> {
  const { getConnectionKeyForUser } = await import("@/lib/appUserConnections.server");
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  const key = await getConnectionKeyForUser(userId, CONNECTOR_ID);
  if (!key) return { google_event_id: task.google_event_id };
  const body = {
    summary: task.title,
    description: task.notes ?? undefined,
    start: { dateTime: new Date(task.start_at).toISOString() },
    end: { dateTime: new Date(task.end_at).toISOString() },
  };
  try {
    if (task.google_event_id) {
      const res = await callAsAppUser({
        gatewayBaseUrl: GATEWAY_BASE_URL,
        connectionAPIKey: key,
        connectorId: CONNECTOR_ID,
        path: `/calendar/v3/calendars/primary/events/${encodeURIComponent(task.google_event_id)}`,
        init: {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      });
      if (!res.ok) throw new Error(`Google PATCH failed: ${res.status}`);
      return { google_event_id: task.google_event_id };
    }
    const res = await callAsAppUser({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectionAPIKey: key,
      connectorId: CONNECTOR_ID,
      path: "/calendar/v3/calendars/primary/events",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    });
    if (!res.ok) throw new Error(`Google POST failed: ${res.status}`);
    const j = (await res.json()) as { id?: string };
    return { google_event_id: j.id ?? null };
  } catch (e) {
    console.error("pushTaskToGoogle failed", e);
    return { google_event_id: task.google_event_id };
  }
}

export async function deleteFromGoogle(userId: string, eventId: string | null) {
  if (!eventId) return;
  const { getConnectionKeyForUser } = await import("@/lib/appUserConnections.server");
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  const key = await getConnectionKeyForUser(userId, CONNECTOR_ID);
  if (!key) return;
  try {
    await callAsAppUser({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectionAPIKey: key,
      connectorId: CONNECTOR_ID,
      path: `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      init: { method: "DELETE" },
    });
  } catch (e) {
    console.error("deleteFromGoogle failed", e);
  }
}

// ---------- Import today from Google (read-only pull) ----------

export const importGoogleCalendarWindow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ fromISO: z.string(), toISO: z.string() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { getConnectionKeyForUser } = await import("@/lib/appUserConnections.server");
    const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
    const key = await getConnectionKeyForUser(context.userId, CONNECTOR_ID);
    if (!key) throw new Error("Google Calendar is not connected.");

    const url =
      `/calendar/v3/calendars/primary/events` +
      `?timeMin=${encodeURIComponent(data.fromISO)}` +
      `&timeMax=${encodeURIComponent(data.toISO)}` +
      `&singleEvents=true&orderBy=startTime&maxResults=250`;
    const res = await callAsAppUser({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectionAPIKey: key,
      connectorId: CONNECTOR_ID,
      path: url,
    });
    if (!res.ok) throw new Error(`Google list failed: ${res.status}`);
    const j = (await res.json()) as {
      items?: Array<{
        id: string;
        summary?: string;
        description?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }>;
    };
    const items = (j.items ?? []).filter((e) => e.start?.dateTime && e.end?.dateTime);

    // Insert any that don't already exist in tasks (match by google_event_id).
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("tasks")
      .select("google_event_id")
      .not("google_event_id", "is", null)
      .in(
        "google_event_id",
        items.map((i) => i.id),
      );
    const known = new Set((existing ?? []).map((r) => r.google_event_id as string));
    const toInsert = items
      .filter((e) => !known.has(e.id))
      .map((e) => {
        const start = new Date(e.start!.dateTime!);
        const end = new Date(e.end!.dateTime!);
        const dur = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000));
        return {
          user_id: userId,
          title: e.summary?.slice(0, 200) || "(untitled)",
          notes: e.description?.slice(0, 2000) ?? null,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          duration_minutes: dur,
          priority: "medium",
          category: "google",
          google_event_id: e.id,
          google_calendar_id: "primary",
        };
      });
    if (toInsert.length === 0) return { imported: 0 };
    const { error } = await supabase.from("tasks").insert(toInsert);
    if (error) throw new Error(error.message);
    return { imported: toInsert.length };
  });

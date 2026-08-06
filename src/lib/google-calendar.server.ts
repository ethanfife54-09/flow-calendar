// Server-only Google Calendar helpers (never imported from the browser).
import type { BusyBlock } from "./task-types";

export const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";
export const CONNECTOR_ID = "google_calendar";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/** Google/gateway told us the stored credential is dead — clear it so the UI
 * shows "reconnect" and the next OAuth run starts clean (no stale key header). */
export async function isDeadCredential(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;
  const body = await res.clone().text();
  return /refresh_token_expired|invalid_grant|credential_not_found|revoked|unauthorized_client/i.test(
    body,
  );
}

async function clearDeadCredential(userId: string, res: Response) {
  if (!(await isDeadCredential(res))) return;
  const { deleteConnectionForUser } = await import("./appUserConnections.server");
  console.warn(`[gcal] credential dead for ${userId} — clearing stored connection`);
  await deleteConnectionForUser(userId, CONNECTOR_ID).catch(() => {});
}

async function gcall(userId: string, path: string, init?: RequestInit) {
  const { getConnectionKeyForUser } = await import("./appUserConnections.server");
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  const key = await getConnectionKeyForUser(userId, CONNECTOR_ID);
  if (!key) return null;
  const res = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionAPIKey: key,
    connectorId: CONNECTOR_ID,
    path,
    init,
  });
  if (!res.ok) await clearDeadCredential(userId, res);
  return res;
}

/** Read the user's real Google Calendar events in a window (availability). */
export async function fetchGoogleBusy(
  userId: string,
  fromISO: string,
  toISO: string,
): Promise<BusyBlock[]> {
  const url =
    `/calendar/v3/calendars/primary/events` +
    `?timeMin=${encodeURIComponent(fromISO)}` +
    `&timeMax=${encodeURIComponent(toISO)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=250`;
  const res = await gcall(userId, url);
  if (!res) {
    console.log(`[gcal.busy] no connection for user ${userId}`);
    return [];
  }
  if (!res.ok) {
    console.error(`[gcal.busy] list failed ${res.status}: ${await res.text()}`);
    return [];
  }
  const j = (await res.json()) as {
    items?: Array<{
      summary?: string;
      status?: string;
      transparency?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };
  return (j.items ?? [])
    .filter(
      (e) =>
        e.status !== "cancelled" &&
        e.transparency !== "transparent" &&
        e.start?.dateTime &&
        e.end?.dateTime,
    )
    .map((e) => ({
      title: e.summary?.slice(0, 200) || "(busy)",
      start: new Date(e.start!.dateTime!).toISOString(),
      end: new Date(e.end!.dateTime!).toISOString(),
      source: "google" as const,
    }));
}

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
  const body = {
    summary: task.title,
    description: task.notes ?? undefined,
    start: { dateTime: new Date(task.start_at).toISOString() },
    end: { dateTime: new Date(task.end_at).toISOString() },
  };
  try {
    if (task.google_event_id) {
      const res = await gcall(
        userId,
        `/calendar/v3/calendars/primary/events/${encodeURIComponent(task.google_event_id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res) return { google_event_id: task.google_event_id };
      if (!res.ok) {
        console.error(`[gcal.push] PATCH failed ${res.status}: ${await res.text()}`);
        return { google_event_id: task.google_event_id };
      }
      return { google_event_id: task.google_event_id };
    }
    const res = await gcall(userId, "/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res) {
      console.warn(`[gcal.push] no connection key for user ${userId} — skipping sync`);
      return { google_event_id: null };
    }
    if (!res.ok) {
      console.error(`[gcal.push] POST failed ${res.status}: ${await res.text()}`);
      return { google_event_id: null };
    }
    const j = (await res.json()) as { id?: string };
    console.log(`[gcal.push] created event ${j.id} for task ${task.id}`);
    return { google_event_id: j.id ?? null };
  } catch (e) {
    console.error("[gcal.push] threw", e);
    return { google_event_id: task.google_event_id };
  }
}

export async function deleteFromGoogle(userId: string, eventId: string | null) {
  if (!eventId) return;
  try {
    const res = await gcall(
      userId,
      `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
    if (res && !res.ok && res.status !== 404 && res.status !== 410) {
      console.error(`[gcal.delete] failed ${res.status}: ${await res.text()}`);
    }
  } catch (e) {
    console.error("[gcal.delete] threw", e);
  }
}

export async function fetchPrimaryCalendarLabel(connectionAPIKey: string): Promise<string | null> {
  const { callAsAppUser } = await import("@/integrations/lovable/appUserConnector");
  try {
    const res = await callAsAppUser({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectionAPIKey,
      connectorId: CONNECTOR_ID,
      path: "/calendar/v3/calendars/primary",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { id?: string; summary?: string };
    return j.id ?? j.summary ?? null;
  } catch {
    return null;
  }
}

/** True only if we can actually read the calendar right now. Unlike
 * fetchGoogleBusy (which degrades to an empty list), this reports failures. */
export async function probeGoogleReadable(userId: string): Promise<boolean> {
  try {
    const res = await gcall(userId, "/calendar/v3/calendars/primary");
    return !!res && res.ok;
  } catch (e) {
    console.error("[gcal.probe] threw", e);
    return false;
  }
}

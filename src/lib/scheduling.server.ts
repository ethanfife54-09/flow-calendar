// Server-only scheduling + AI prompt helpers for TaskFlow.
// Kept out of *.functions.ts so server-function modules stay thin wrappers.

import type { BusyBlock, InterpretResult, ParsedTask, TaskChange } from "./task-types";

// ---------------- Timezone primitives ----------------

export function tzParts(date: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday as string,
  };
}

export function tzOffsetString(date: Date, timezone: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "numeric",
  });
  const part = dtf.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = part.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}

/** Convert a wall-clock time in `timezone` to the correct absolute instant (DST-safe). */
export function localWallToInstant(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timezone: string,
): Date {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), timezone);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = target - asUTC;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** Add N calendar days while keeping the same local wall-clock time. */
export function addDaysLocal(date: Date, days: number, timezone: string): Date {
  const p = tzParts(date, timezone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return localWallToInstant(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    p.hour,
    p.minute,
    timezone,
  );
}

/** Local weekday index (0=Sun) in the given timezone. */
export function localWeekday(date: Date, timezone: string): number {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names.indexOf(tzParts(date, timezone).weekday);
}

export function localDateCalendar(now: Date, timezone: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) {
    const d = addDaysLocal(now, i, timezone);
    const p = tzParts(d, timezone);
    const iso = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const label = i === 0 ? "today" : i === 1 ? "tomorrow" : `in ${i} days`;
    lines.push(`  ${label} = ${p.weekday} ${iso}`);
  }
  return lines.join("\n");
}

// ---------------- JSON parsing ----------------

const RECURRENCES = ["none", "daily", "weekdays", "weekly", "monthly"] as const;

export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        /* fall through */
      }
    }
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("AI returned non-JSON output.");
  }
}

function normalizeTask(
  raw: Partial<ParsedTask> & Record<string, unknown>,
  fallbackTitle: string,
): ParsedTask {
  const priority = (["low", "medium", "high"] as const).includes(raw.priority as never)
    ? (raw.priority as "low" | "medium" | "high")
    : "medium";
  const start = new Date(String(raw.start_at ?? ""));
  const endRaw = new Date(String(raw.end_at ?? ""));
  if (isNaN(start.getTime())) throw new Error("AI returned an invalid start time.");
  let end = endRaw;
  const dur = typeof raw.duration_minutes === "number" ? raw.duration_minutes : NaN;
  if (isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + (isNaN(dur) ? 30 : dur) * 60000);
  }
  const duration = Math.min(
    24 * 60,
    Math.max(5, !isNaN(dur) ? dur : Math.round((end.getTime() - start.getTime()) / 60000)),
  );
  const rec = RECURRENCES.includes(raw.recurrence as never)
    ? (raw.recurrence as ParsedTask["recurrence"])
    : "none";
  return {
    title: String(raw.title ?? fallbackTitle).slice(0, 200),
    start_at: start.toISOString(),
    end_at: new Date(start.getTime() + duration * 60000).toISOString(),
    duration_minutes: duration,
    priority,
    category: String(raw.category ?? "general").toLowerCase().slice(0, 40),
    notes: (raw.notes as string | null | undefined) ?? null,
    recurrence: rec,
    suggested_time_reason: (raw.suggested_time_reason as string | null | undefined) ?? null,
  };
}

export function parseInterpretResult(raw: string): InterpretResult {
  const parsed = extractJson(raw) as Record<string, unknown>;
  if (
    parsed &&
    parsed.type === "clarify" &&
    typeof parsed.question === "string" &&
    parsed.question.trim()
  ) {
    return { type: "clarify", question: parsed.question.trim() };
  }
  if (parsed && parsed.type === "changes" && Array.isArray(parsed.changes)) {
    const changes: TaskChange[] = (parsed.changes as Array<Record<string, unknown>>)
      .filter((c) => typeof c.id === "string" && (c.action === "move" || c.action === "delete"))
      .map((c) => ({
        id: String(c.id),
        action: c.action as "move" | "delete",
        title: typeof c.title === "string" ? c.title : null,
        start_at: typeof c.start_at === "string" ? new Date(c.start_at).toISOString() : null,
        end_at: typeof c.end_at === "string" ? new Date(c.end_at).toISOString() : null,
        duration_minutes: typeof c.duration_minutes === "number" ? c.duration_minutes : null,
      }));
    if (changes.length > 0) {
      return {
        type: "changes",
        changes,
        summary: typeof parsed.summary === "string" ? parsed.summary : null,
      };
    }
  }

  const tasksRaw = Array.isArray(parsed.tasks) ? parsed.tasks : null;
  if (!tasksRaw || tasksRaw.length === 0) {
    if (parsed.start_at && parsed.title) {
      return {
        type: "tasks",
        tasks: [normalizeTask(parsed as Partial<ParsedTask>, String(parsed.title))],
      };
    }
    throw new Error("AI response did not include tasks or a clarifying question.");
  }
  const tasks = tasksRaw.map((t) =>
    normalizeTask(t as Partial<ParsedTask>, String((t as { title?: string }).title ?? "Task")),
  );
  const summary = typeof parsed.summary === "string" ? parsed.summary : null;
  return { type: "tasks", tasks, summary };
}

// ---------------- Context loading ----------------

export type Prefs = {
  earliest_hour?: number | null;
  latest_hour?: number | null;
  reserved_blocks?: unknown;
  timezone?: string | null;
  work_style?: string | null;
  focus_length_minutes?: number | null;
  break_minutes?: number | null;
  goals?: string | null;
} | null;

export async function loadContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  nowISO: string,
  timezone: string,
): Promise<{ prefs: Prefs; busy: BusyBlock[] }> {
  const now = new Date(nowISO);
  const horizon = new Date(now.getTime() + 14 * 24 * 3600 * 1000);

  const [{ data: prefs }, { data: upcoming }] = await Promise.all([
    supabase
      .from("user_preferences")
      .select(
        "earliest_hour, latest_hour, reserved_blocks, timezone, work_style, focus_length_minutes, break_minutes, goals",
      )
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("tasks")
      .select("id, title, start_at, end_at")
      .eq("user_id", userId)
      .gte("end_at", now.toISOString())
      .lte("start_at", horizon.toISOString())
      .order("start_at", { ascending: true })
      .limit(150),
  ]);

  const busy: BusyBlock[] = ((upcoming ?? []) as Array<{
    id: string;
    title: string;
    start_at: string;
    end_at: string;
  }>).map((t) => ({
    id: t.id,
    title: t.title,
    start: t.start_at,
    end: t.end_at,
    source: "taskflow" as const,
  }));

  // Live Google Calendar availability — the AI must see what's really on the
  // user's calendar, not only what TaskFlow created.
  try {
    const { fetchGoogleBusy } = await import("./google-calendar.server");
    const gbusy = await fetchGoogleBusy(userId, now.toISOString(), horizon.toISOString());
    const seen = new Set(busy.map((b) => `${b.title.toLowerCase()}|${b.start}`));
    for (const g of gbusy) {
      if (seen.has(`${g.title.toLowerCase()}|${g.start}`)) continue;
      busy.push(g);
    }
    console.log(`[context] tz=${timezone} taskflow=${(upcoming ?? []).length} google=${gbusy.length}`);
  } catch (e) {
    console.error("[context] google availability lookup failed", e);
  }

  busy.sort((a, b) => a.start.localeCompare(b.start));
  return { prefs, busy };
}

// ---------------- Prompt ----------------

export function systemPrompt(args: {
  clientNowISO: string;
  timezone: string;
  prefs: Prefs;
  busy: BusyBlock[];
}) {
  const p = args.prefs ?? {};
  const now = new Date(args.clientNowISO);
  const local = tzParts(now, args.timezone);
  const offset = tzOffsetString(now, args.timezone);
  const localNowStr =
    `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}` +
    `T${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:00${offset}`;

  const busyLines =
    args.busy
      .slice(0, 80)
      .map((b) => {
        const s = tzParts(new Date(b.start), args.timezone);
        const e = tzParts(new Date(b.end), args.timezone);
        const d = `${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}`;
        const t = (x: { hour: number; minute: number }) =>
          `${String(x.hour).padStart(2, "0")}:${String(x.minute).padStart(2, "0")}`;
        const idPart = b.id ? ` (id: ${b.id})` : "";
        return `  - [${b.source}] ${b.title}: ${s.weekday} ${d} ${t(s)}–${t(e)} local${idPart}`;
      })
      .join("\n") || "  (nothing scheduled)";

  return `You are TaskFlow, an assistant that turns a user's natural-language request into structured calendar events.

Output MUST be a single JSON object with one of these two exact shapes (no prose, no markdown):

1) Tasks scheduled:
{
  "type": "tasks",
  "summary": string | null,
  "tasks": [
    {
      "title": string,
      "start_at": string,               // ISO 8601 WITH the user's timezone offset (e.g. ends in ${offset})
      "end_at": string,
      "duration_minutes": integer,
      "priority": "low" | "medium" | "high",
      "category": string,                // short lowercase: study, work, health, personal, errand, social, general
      "notes": string | null,
      "recurrence": "none" | "daily" | "weekdays" | "weekly" | "monthly",
      "suggested_time_reason": string | null   // ONLY non-null when YOU picked the time (user gave none)
    }
  ]
}

2) Change existing events (move / reschedule / delete). Use the "id:" values from the calendar below — ONLY ids marked [taskflow] can be changed:
{
  "type": "changes",
  "summary": string | null,
  "changes": [
    { "id": string, "action": "move", "start_at": string, "end_at": string, "duration_minutes": integer }
    // or { "id": string, "action": "delete" }
  ]
}

3) Clarifying question:
{ "type": "clarify", "question": string }

DATE & TIME RULES (misreading these is the worst failure mode):
- The user's LOCAL current time is ${localNowStr} (${local.weekday}), timezone ${args.timezone}.
- Resolve every relative reference against the LOCAL date, never UTC:
${localDateCalendar(now, args.timezone)}
- "tonight" / "this evening" = today 18:00–21:00 local. "this afternoon" = today 12:00–17:00 local.
- "this morning" = today from the earliest hour until 12:00 local.
- A bare weekday name = the NEXT occurrence of that weekday. "next <weekday>" is at least 7 days out.
- NEVER schedule anything in the past. If the requested local time today has already passed, ask a clarifying question or use the next sensible slot.
- Every start_at / end_at MUST carry the offset ${offset}.
- If the user states an explicit time, use exactly that time and leave suggested_time_reason null.

SCHEDULING RULES:
- The "Current calendar" below includes BOTH TaskFlow tasks and the user's real Google Calendar events. Treat every entry as busy time.
- NEVER re-create an event that already appears there. For "organize my day", add new blocks in the FREE gaps around them.
- If the message contains multiple distinct things, output ONE task per thing — never merge them.
- If no time is given, choose a free slot inside waking hours that overlaps nothing, and explain the choice in suggested_time_reason.
- If an explicit time collides with an important-looking existing event, ask a clarifying question instead of double-booking.
- When the user asks to move, reschedule, push back, or delete something that already exists, return shape 2 ("changes") referencing its id — never create a second copy of it.
- Only [google]-sourced entries with no id cannot be changed; if the user asks to change one, say so via a clarifying question.
- If a move/delete request is ambiguous or would affect several events, ASK a clarifying question first.
- New times in "changes" must also respect waking hours and avoid overlapping other busy entries.
- For "plan my day" requests, fill the free hours with focus blocks separated by breaks, respecting reserved blocks and work style.
- Set "recurrence" only when repetition is explicit ("every day", "weekly", "every weekday").
- Never schedule before ${p.earliest_hour ?? 7}:00 or after ${p.latest_hour ?? 21}:00 local time.
- Default duration 30 min; study/workout blocks 45–120 min.
- Focus length: ${p.focus_length_minutes ?? 60} min. Break length: ${p.break_minutes ?? 15} min. Work style: ${p.work_style ?? "balanced"}.
- Goals: ${p.goals ? JSON.stringify(p.goals) : "null"}
- Reserved blocks (weekly, local hours): ${JSON.stringify(p.reserved_blocks ?? [])}

Current calendar (busy — DO NOT DOUBLE-BOOK OR DUPLICATE):
${busyLines}

Return ONLY the JSON object.`;
}

// ---------------- Server-side conflict guard ----------------

type Interval = { start: number; end: number };

function overlaps(a: Interval, b: Interval) {
  return a.start < b.end && b.start < a.end;
}

function reservedIntervalsFor(
  day: Date,
  timezone: string,
  reserved: unknown,
): Interval[] {
  if (!Array.isArray(reserved)) return [];
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const wd = names[localWeekday(day, timezone)];
  const p = tzParts(day, timezone);
  const out: Interval[] = [];
  for (const r of reserved as Array<{
    day?: string;
    start_hour?: number;
    end_hour?: number;
  }>) {
    if (!r || (r.day !== "any" && r.day !== wd)) continue;
    const sh = Number(r.start_hour ?? 0);
    const eh = Number(r.end_hour ?? 0);
    if (!(eh > sh)) continue;
    out.push({
      start: localWallToInstant(p.year, p.month, p.day, sh, 0, timezone).getTime(),
      end: localWallToInstant(p.year, p.month, p.day, eh, 0, timezone).getTime(),
    });
  }
  return out;
}

/**
 * Final safety net: keeps AI output inside waking hours, out of the past, and
 * off of busy time. Only times the AI chose itself (suggested_time_reason set)
 * are moved — explicit user times are respected so "3:30 tomorrow" stays put.
 */
export function deconflict(args: {
  tasks: ParsedTask[];
  busy: BusyBlock[];
  prefs: Prefs;
  timezone: string;
  nowISO: string;
}): { tasks: ParsedTask[]; adjustments: string[] } {
  const { timezone } = args;
  const earliest = Math.min(23, Math.max(0, args.prefs?.earliest_hour ?? 7));
  const latest = Math.min(24, Math.max(earliest + 1, args.prefs?.latest_hour ?? 21));
  const now = new Date(args.nowISO).getTime();
  const adjustments: string[] = [];

  const taken: Interval[] = args.busy.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const out: ParsedTask[] = [];
  for (const t of args.tasks) {
    const dur = t.duration_minutes * 60000;
    let start = new Date(t.start_at);
    const flexible = !!t.suggested_time_reason;
    const originalISO = t.start_at;

    // Never in the past — round up to the next 15-minute boundary.
    if (start.getTime() < now) {
      const next = new Date(Math.ceil((now + 60000) / (15 * 60000)) * 15 * 60000);
      start = next;
    }

    const clampToWindow = (d: Date): Date => {
      const p = tzParts(d, timezone);
      const startOfWindow = localWallToInstant(p.year, p.month, p.day, earliest, 0, timezone);
      const endOfWindow = localWallToInstant(
        p.year,
        p.month,
        p.day,
        latest === 24 ? 23 : latest,
        latest === 24 ? 59 : 0,
        timezone,
      );
      if (d.getTime() < startOfWindow.getTime()) return startOfWindow;
      if (d.getTime() + dur > endOfWindow.getTime()) {
        const nextDay = addDaysLocal(d, 1, timezone);
        const np = tzParts(nextDay, timezone);
        return localWallToInstant(np.year, np.month, np.day, earliest, 0, timezone);
      }
      return d;
    };

    if (flexible) {
      let guard = 0;
      for (;;) {
        const clamped = clampToWindow(start);
        if (clamped.getTime() !== start.getTime()) {
          start = clamped;
          if (guard++ > 200) break;
          continue;
        }
        const slot = { start: start.getTime(), end: start.getTime() + dur };
        const blockers = [...taken, ...reservedIntervalsFor(start, timezone, args.prefs?.reserved_blocks)];
        const hit = blockers.find((b) => overlaps(slot, b));
        if (!hit) break;
        start = new Date(hit.end);
        if (guard++ > 200) break;
      }
    } else {
      // Respect explicit times, but still keep them out of the past.
      start = new Date(Math.max(start.getTime(), Math.min(start.getTime(), start.getTime())));
    }

    if (start.toISOString() !== originalISO) {
      adjustments.push(
        `${t.title}: moved to ${new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        }).format(start)} to avoid a conflict`,
      );
      console.log(`[deconflict] ${t.title} ${originalISO} -> ${start.toISOString()}`);
    }

    taken.push({ start: start.getTime(), end: start.getTime() + dur });
    out.push({
      ...t,
      start_at: start.toISOString(),
      end_at: new Date(start.getTime() + dur).toISOString(),
    });
  }
  return { tasks: out, adjustments };
}

// ---------------- Recurrence ----------------

export function expandOccurrences(
  start: Date,
  end: Date,
  recurrence: string,
  until: Date | null,
  timezone: string,
): Array<{ start: Date; end: Date }> {
  if (recurrence === "none") return [{ start, end }];
  const horizon = until ?? new Date(start.getTime() + 56 * 24 * 3600 * 1000);
  const dur = end.getTime() - start.getTime();
  const out: Array<{ start: Date; end: Date }> = [];
  let cursor = new Date(start);
  let safety = 0;
  while (cursor.getTime() <= horizon.getTime() && safety++ < 400) {
    if (recurrence === "weekdays") {
      const d = localWeekday(cursor, timezone);
      if (d !== 0 && d !== 6) out.push({ start: new Date(cursor), end: new Date(cursor.getTime() + dur) });
    } else {
      out.push({ start: new Date(cursor), end: new Date(cursor.getTime() + dur) });
    }
    if (recurrence === "daily" || recurrence === "weekdays") cursor = addDaysLocal(cursor, 1, timezone);
    else if (recurrence === "weekly") cursor = addDaysLocal(cursor, 7, timezone);
    else if (recurrence === "monthly") {
      const p = tzParts(cursor, timezone);
      cursor = localWallToInstant(p.year, p.month + 1, p.day, p.hour, p.minute, timezone);
    } else break;
  }
  return out;
}

// ---------------- Duplicate detection ----------------

export async function findDuplicates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  rows: Array<{ title: string; start_at: string }>,
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const times = rows.map((r) => new Date(r.start_at).getTime());
  const minTime = new Date(Math.min(...times) - 30 * 60000).toISOString();
  const maxTime = new Date(Math.max(...times) + 30 * 60000).toISOString();
  const { data: existing } = await supabase
    .from("tasks")
    .select("title, start_at")
    .eq("user_id", userId)
    .gte("start_at", minTime)
    .lte("start_at", maxTime);

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const existingRows = ((existing ?? []) as Array<{ title: string; start_at: string }>).map((e) => ({
    title: norm(e.title),
    t: new Date(e.start_at).getTime(),
  }));

  const dupes = new Set<string>();
  for (const r of rows) {
    const key = norm(r.title);
    const t = new Date(r.start_at).getTime();
    // Same (normalised) title within 30 minutes = duplicate.
    if (existingRows.some((e) => e.title === key && Math.abs(e.t - t) <= 30 * 60000)) {
      dupes.add(`${r.title}|${r.start_at}`);
    }
  }
  return dupes;
}

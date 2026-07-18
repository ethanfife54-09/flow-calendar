import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { chatCompletion, type ChatMessage, type ContentPart } from "./ai-gateway.server";
import { z } from "zod";

// ---------- Types ----------

export type ParsedTask = {
  title: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  priority: "low" | "medium" | "high";
  category: string;
  notes?: string | null;
  suggested_time_reason?: string | null;
};

export type InterpretResult =
  | { type: "tasks"; tasks: ParsedTask[]; summary?: string | null }
  | { type: "clarify"; question: string };

// ---------- Helpers ----------

function extractJson(raw: string): unknown {
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

function normalizeTask(raw: Partial<ParsedTask> & Record<string, unknown>, fallbackTitle: string): ParsedTask {
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
  const duration = Math.max(
    5,
    !isNaN(dur) ? dur : Math.round((end.getTime() - start.getTime()) / 60000),
  );
  return {
    title: String(raw.title ?? fallbackTitle).slice(0, 200),
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    duration_minutes: duration,
    priority,
    category: String(raw.category ?? "general").toLowerCase().slice(0, 40),
    notes: (raw.notes as string | null | undefined) ?? null,
    suggested_time_reason: (raw.suggested_time_reason as string | null | undefined) ?? null,
  };
}

function parseInterpretResult(raw: string): InterpretResult {
  const parsed = extractJson(raw) as Record<string, unknown>;
  if (parsed && parsed.type === "clarify" && typeof parsed.question === "string" && parsed.question.trim()) {
    return { type: "clarify", question: parsed.question.trim() };
  }
  const tasksRaw = Array.isArray(parsed.tasks) ? parsed.tasks : null;
  if (!tasksRaw || tasksRaw.length === 0) {
    // Fall back: model returned a single task at the root
    if (parsed.start_at && parsed.title) {
      return { type: "tasks", tasks: [normalizeTask(parsed as Partial<ParsedTask>, String(parsed.title))] };
    }
    throw new Error("AI response did not include tasks or a clarifying question.");
  }
  const tasks = tasksRaw.map((t) =>
    normalizeTask(t as Partial<ParsedTask>, String((t as { title?: string }).title ?? "Task")),
  );
  const summary = typeof parsed.summary === "string" ? parsed.summary : null;
  return { type: "tasks", tasks, summary };
}

async function loadContext(
  supabase: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  userId: string,
  nowISO: string,
) {
  const { data: prefs } = await supabase
    .from("user_preferences")
    .select(
      "earliest_hour, latest_hour, reserved_blocks, timezone, work_style, focus_length_minutes, break_minutes, goals",
    )
    .eq("user_id", userId)
    .maybeSingle();

  const now = new Date(nowISO);
  const weekLater = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const { data: upcoming } = await supabase
    .from("tasks")
    .select("title, start_at, end_at")
    .gte("start_at", now.toISOString())
    .lte("start_at", weekLater.toISOString())
    .order("start_at", { ascending: true })
    .limit(60);
  return { prefs, upcoming: upcoming ?? [] };
}

function systemPrompt(args: {
  clientNowISO: string;
  timezone: string;
  prefs: {
    earliest_hour?: number | null;
    latest_hour?: number | null;
    reserved_blocks?: unknown;
    work_style?: string | null;
    focus_length_minutes?: number | null;
    break_minutes?: number | null;
    goals?: string | null;
  } | null;
  upcoming: Array<{ title: string; start_at: string; end_at: string }>;
}) {
  const p = args.prefs ?? {};
  return `You are TaskFlow, an assistant that turns a user's natural-language request into structured calendar events.

Output MUST be a single JSON object with one of these two exact shapes (no prose, no markdown):

1) Tasks scheduled:
{
  "type": "tasks",
  "summary": string | null,           // one short sentence summarising what you scheduled, or null
  "tasks": [
    {
      "title": string,                 // short, imperative-friendly
      "start_at": string,              // ISO 8601 with timezone offset
      "end_at": string,                // ISO 8601 with timezone offset
      "duration_minutes": integer,
      "priority": "low" | "medium" | "high",
      "category": string,              // short lowercase: study, work, health, personal, errand, social, general
      "notes": string | null,
      "suggested_time_reason": string | null   // set only when YOU picked the time
    }
  ]
}

2) Ask a clarifying question when the request is genuinely ambiguous or missing critical info you cannot reasonably guess (e.g. "organise my day" with no clue what plans exist, an unspecified date that could mean several things, missing hard constraints):
{ "type": "clarify", "question": string }

Rules:
- Prefer scheduling when you have enough info. Only clarify when guessing would likely be wrong.
- For "organise my day" / "plan my day" / "block schedule" style requests, produce MULTIPLE tasks that fill the user's available hours today (or the day they specify), respecting reserved blocks, work style, focus length and break length. Include focus/study/work blocks AND short breaks between them if useful.
- Never schedule before ${p.earliest_hour ?? 7}:00 or after ${p.latest_hour ?? 21}:00 local time.
- Do not overlap existing events or reserved blocks.
- Interpret relative dates ("tomorrow evening", "Sunday after church") using the given current time.
- If the user gave an explicit time, use it exactly. Otherwise pick a realistic slot and set suggested_time_reason.
- Default single-task duration is 30 minutes; study/workout blocks are typically 45–120 minutes.
- Respect the user's preferred focus length (${p.focus_length_minutes ?? 60} min) and break length (${p.break_minutes ?? 15} min) when block-scheduling.
- Work style: ${p.work_style ?? "balanced"}. ${
    p.work_style === "intense"
      ? "Pack the day tightly with short breaks."
      : p.work_style === "relaxed"
        ? "Leave generous breaks and don't over-schedule."
        : "Balance productive blocks with reasonable breaks."
  }
- User's stated goals (may be null): ${p.goals ? JSON.stringify(p.goals) : "null"}
- Current time (user local): ${args.clientNowISO}
- Timezone: ${args.timezone}
- Reserved blocks: ${JSON.stringify(p.reserved_blocks ?? [])}
- Existing upcoming events (next 7 days):
${args.upcoming.map((t) => `  - ${t.title}: ${t.start_at} → ${t.end_at}`).join("\n") || "  (none)"}

Return ONLY the JSON object.`;
}

// ---------- Interpret text (with optional conversation history) ----------

const HistoryMsg = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

const InterpretInput = z.object({
  text: z.string().min(1).max(2000),
  clientNowISO: z.string().min(1),
  timezone: z.string().min(1),
  history: z.array(HistoryMsg).max(20).optional(),
});

export const interpretRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InterpretInput.parse(input))
  .handler(async ({ data, context }): Promise<InterpretResult> => {
    const { supabase, userId } = context;
    const { prefs, upcoming } = await loadContext(supabase, userId, data.clientNowISO);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt({ clientNowISO: data.clientNowISO, timezone: data.timezone, prefs, upcoming }) },
      ...(data.history ?? []).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: "user", content: data.text },
    ];

    const raw = await chatCompletion({
      messages,
      response_format: { type: "json_object" },
    });
    return parseInterpretResult(raw);
  });

// ---------- Interpret image (schedule photo / screenshot) ----------

const InterpretImageInput = z.object({
  imageDataUrl: z
    .string()
    .min(20)
    .max(8_000_000)
    .refine((s) => s.startsWith("data:image/"), "Must be a data:image/* URL"),
  note: z.string().max(500).optional(),
  clientNowISO: z.string().min(1),
  timezone: z.string().min(1),
});

export const interpretImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InterpretImageInput.parse(input))
  .handler(async ({ data, context }): Promise<InterpretResult> => {
    const { supabase, userId } = context;
    const { prefs, upcoming } = await loadContext(supabase, userId, data.clientNowISO);

    const userContent: ContentPart[] = [
      {
        type: "text",
        text:
          `The user uploaded an image of a schedule, timetable, or handwritten plan. ` +
          `Extract every event/task you can read and return them as scheduled tasks for the user. ` +
          `If dates aren't visible, assume the current week (starting today) unless context makes another week obvious. ` +
          (data.note ? `Additional note from user: ${data.note}` : ""),
      },
      { type: "image_url", image_url: { url: data.imageDataUrl } },
    ];

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt({ clientNowISO: data.clientNowISO, timezone: data.timezone, prefs, upcoming }) },
      { role: "user", content: userContent },
    ];

    const raw = await chatCompletion({
      messages,
      response_format: { type: "json_object" },
    });
    return parseInterpretResult(raw);
  });

// ---------- Task CRUD ----------

const TaskCreateInput = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(2000).nullable().optional(),
  start_at: z.string(),
  end_at: z.string(),
  duration_minutes: z.number().int().min(5).max(24 * 60),
  priority: z.enum(["low", "medium", "high"]),
  category: z.string().min(1).max(40),
});

export const createTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TaskCreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("tasks")
      .insert({ ...data, user_id: userId })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

const TaskCreateManyInput = z.object({ tasks: z.array(TaskCreateInput).min(1).max(30) });

export const createTasks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TaskCreateManyInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const rows = data.tasks.map((t) => ({ ...t, user_id: userId }));
    const { data: inserted, error } = await supabase.from("tasks").insert(rows).select("*");
    if (error) throw new Error(error.message);
    return inserted ?? [];
  });

const TaskUpdateInput = z.object({
  id: z.string().uuid(),
  patch: z.object({
    title: z.string().min(1).max(200).optional(),
    notes: z.string().max(2000).nullable().optional(),
    start_at: z.string().optional(),
    end_at: z.string().optional(),
    duration_minutes: z.number().int().min(5).max(24 * 60).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    category: z.string().min(1).max(40).optional(),
    completed: z.boolean().optional(),
  }),
});

export const updateTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TaskUpdateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("tasks")
      .update(data.patch)
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("tasks").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("tasks")
      .select("*")
      .order("start_at", { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// ---------- Preferences ----------

const PrefsUpdateInput = z.object({
  earliest_hour: z.number().int().min(0).max(23).optional(),
  latest_hour: z.number().int().min(1).max(24).optional(),
  reserved_blocks: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun", "any"]),
        start_hour: z.number().int().min(0).max(23),
        end_hour: z.number().int().min(1).max(24),
      }),
    )
    .optional(),
  timezone: z.string().min(1).max(60).optional(),
  work_style: z.enum(["relaxed", "balanced", "intense"]).optional(),
  focus_length_minutes: z.number().int().min(15).max(240).optional(),
  break_minutes: z.number().int().min(0).max(60).optional(),
  goals: z.string().max(1000).nullable().optional(),
  onboarded: z.boolean().optional(),
});

export const getPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("user_preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
    const { data: created, error: insErr } = await supabase
      .from("user_preferences")
      .insert({ user_id: userId })
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);
    return created;
  });

export const updatePreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => PrefsUpdateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("user_preferences")
      .update(data)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

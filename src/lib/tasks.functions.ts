import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { chatCompletion } from "./ai-gateway.server";
import { z } from "zod";

// ---------- AI: interpret natural-language task ----------

const InterpretInput = z.object({
  text: z.string().min(1).max(1000),
  clientNowISO: z.string().min(1),
  timezone: z.string().min(1),
});

type InterpretedTask = {
  title: string;
  start_at: string; // ISO
  end_at: string; // ISO
  duration_minutes: number;
  priority: "low" | "medium" | "high";
  category: string;
  notes?: string | null;
  suggested_time_reason?: string | null;
};

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // fenced code
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("AI returned non-JSON output.");
  }
}

export const interpretTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InterpretInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Load preferences + existing tasks in the next 7 days for context
    const { data: prefs } = await supabase
      .from("user_preferences")
      .select("earliest_hour, latest_hour, reserved_blocks, timezone")
      .eq("user_id", userId)
      .maybeSingle();

    const now = new Date(data.clientNowISO);
    const weekLater = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const { data: upcoming } = await supabase
      .from("tasks")
      .select("title, start_at, end_at")
      .gte("start_at", now.toISOString())
      .lte("start_at", weekLater.toISOString())
      .order("start_at", { ascending: true })
      .limit(50);

    const system = `You are TaskFlow, an assistant that converts a user's natural-language task into a structured calendar event.

Rules:
- Return ONLY valid JSON with this exact shape (no prose, no markdown):
  {
    "title": string,
    "start_at": string (ISO 8601 with timezone offset),
    "end_at": string (ISO 8601 with timezone offset),
    "duration_minutes": integer,
    "priority": "low" | "medium" | "high",
    "category": string (short lowercase word: study, work, health, personal, errand, social, general, etc.),
    "notes": string | null,
    "suggested_time_reason": string | null
  }
- If the user did not specify a time, pick a realistic slot considering their preferences and existing events.
- Never schedule before ${prefs?.earliest_hour ?? 7}:00 or after ${prefs?.latest_hour ?? 21}:00 in their timezone.
- Estimate a reasonable duration if the user didn't specify (default 30 minutes; study/workout blocks often 60-120).
- Interpret relative dates ("tomorrow evening", "Sunday after church") based on the current time.
- If the user gave an explicit time, use it exactly.
- Set suggested_time_reason ONLY when you picked the time yourself; explain briefly why.
- title should be short and imperative-friendly ("Finish physics homework").`;

    const userMsg = `Current time (user's local): ${data.clientNowISO}
Timezone: ${data.timezone}
User preferences: earliest_hour=${prefs?.earliest_hour ?? 7}, latest_hour=${prefs?.latest_hour ?? 21}, reserved_blocks=${JSON.stringify(prefs?.reserved_blocks ?? [])}

Existing upcoming events (next 7 days):
${(upcoming ?? []).map((t) => `- ${t.title}: ${t.start_at} → ${t.end_at}`).join("\n") || "(none)"}

User task: "${data.text}"

Return the JSON now.`;

    const raw = await chatCompletion({
      model: "google/gemini-3.5-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
    });

    const parsed = extractJson(raw) as Partial<InterpretedTask>;

    // Validate & coerce
    const priority = (["low", "medium", "high"] as const).includes(parsed.priority as never)
      ? (parsed.priority as "low" | "medium" | "high")
      : "medium";

    const start = new Date(parsed.start_at ?? "");
    const end = new Date(parsed.end_at ?? "");
    if (isNaN(start.getTime())) throw new Error("AI returned an invalid start time.");
    let endValid = end;
    if (isNaN(end.getTime()) || end <= start) {
      endValid = new Date(start.getTime() + (parsed.duration_minutes ?? 30) * 60000);
    }
    const duration = Math.max(5, parsed.duration_minutes ?? Math.round((endValid.getTime() - start.getTime()) / 60000));

    const result: InterpretedTask = {
      title: (parsed.title ?? data.text).slice(0, 200),
      start_at: start.toISOString(),
      end_at: endValid.toISOString(),
      duration_minutes: duration,
      priority,
      category: (parsed.category ?? "general").toLowerCase().slice(0, 40),
      notes: parsed.notes ?? null,
      suggested_time_reason: parsed.suggested_time_reason ?? null,
    };
    return result;
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

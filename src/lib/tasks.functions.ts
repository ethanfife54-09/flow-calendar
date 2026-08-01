import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { InterpretResult, ParsedTask, TaskInsertRow } from "./task-types";

export type { InterpretResult, ParsedTask } from "./task-types";

// ---------- Interpret text ----------

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
    const { loadContext, systemPrompt, parseInterpretResult, deconflict } = await import(
      "./scheduling.server"
    );
    const { chatCompletion } = await import("./ai-gateway.server");

    const { prefs, busy } = await loadContext(supabase, userId, data.clientNowISO, data.timezone);
    const messages = [
      {
        role: "system" as const,
        content: systemPrompt({
          clientNowISO: data.clientNowISO,
          timezone: data.timezone,
          prefs,
          busy,
        }),
      },
      ...(data.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: data.text },
    ];
    const raw = await chatCompletion({ messages, response_format: { type: "json_object" } });
    console.log(
      `[interpret.text] tz=${data.timezone} now=${data.clientNowISO} input=${JSON.stringify(
        data.text,
      )} raw=${raw.slice(0, 900)}`,
    );
    const result = parseInterpretResult(raw);
    if (result.type === "clarify") {
      console.log(`[interpret.text] clarify: ${result.question}`);
      return result;
    }
    if (result.type === "changes") {
      console.log(`[interpret.text] ${result.changes.length} change(s)`);
      return result;
    }
    const fixed = deconflict({
      tasks: result.tasks,
      busy,
      prefs,
      timezone: data.timezone,
      nowISO: data.clientNowISO,
    });
    console.log(
      `[interpret.text] scheduled ${fixed.tasks.length}: ${fixed.tasks
        .map((t: ParsedTask) => `${t.title}@${t.start_at}`)
        .join(", ")}${fixed.adjustments.length ? ` | adjusted: ${fixed.adjustments.join("; ")}` : ""}`,
    );
    return {
      type: "tasks",
      tasks: fixed.tasks,
      summary: result.summary,
      adjustments: fixed.adjustments,
    };
  });

// ---------- Interpret image ----------

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
    const { loadContext, systemPrompt, parseInterpretResult, deconflict } = await import(
      "./scheduling.server"
    );
    const { chatCompletion } = await import("./ai-gateway.server");
    const { prefs, busy } = await loadContext(supabase, userId, data.clientNowISO, data.timezone);

    const messages = [
      {
        role: "system" as const,
        content: systemPrompt({
          clientNowISO: data.clientNowISO,
          timezone: data.timezone,
          prefs,
          busy,
        }),
      },
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text:
              `The user uploaded an image of a schedule, timetable, or handwritten plan. ` +
              `Extract every event/task you can read and return them as scheduled tasks. ` +
              `If dates aren't visible, assume the current week starting today. ` +
              `If anything is unreadable or ambiguous, return a clarifying question instead of guessing. ` +
              (data.note ? `Note from user: ${data.note}` : ""),
          },
          { type: "image_url" as const, image_url: { url: data.imageDataUrl } },
        ],
      },
    ];
    const raw = await chatCompletion({ messages, response_format: { type: "json_object" } });
    console.log(`[interpret.image] tz=${data.timezone} raw=${raw.slice(0, 900)}`);
    const result = parseInterpretResult(raw);
    if (result.type !== "tasks") return result;
    const fixed = deconflict({
      tasks: result.tasks,
      busy,
      prefs,
      timezone: data.timezone,
      nowISO: data.clientNowISO,
    });
    console.log(`[interpret.image] scheduled ${fixed.tasks.length} task(s)`);
    return {
      type: "tasks",
      tasks: fixed.tasks,
      summary: result.summary,
      adjustments: fixed.adjustments,
    };
  });

// ---------- Task CRUD ----------

const RecurrenceEnum = z.enum(["none", "daily", "weekdays", "weekly", "monthly"]);

const TaskCreateInput = z.object({
  title: z.string().min(1).max(200),
  notes: z.string().max(2000).nullable().optional(),
  start_at: z.string(),
  end_at: z.string(),
  duration_minutes: z.number().int().min(5).max(24 * 60),
  priority: z.enum(["low", "medium", "high"]),
  category: z.string().min(1).max(40),
  recurrence: RecurrenceEnum.optional().default("none"),
  recurrence_until: z.string().nullable().optional(),
});

const TaskCreateManyInput = z.object({
  tasks: z.array(TaskCreateInput).min(1).max(30),
  timezone: z.string().min(1).max(60).optional(),
});

export const createTasks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TaskCreateManyInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { expandOccurrences, findDuplicates } = await import("./scheduling.server");
    const { pushTaskToGoogle } = await import("./google-calendar.server");
    const timezone = data.timezone ?? "UTC";

    const expanded: TaskInsertRow[] = [];
    for (const t of data.tasks) {
      const rec = t.recurrence ?? "none";
      const until = t.recurrence_until ? new Date(t.recurrence_until) : null;
      const occurrences = expandOccurrences(
        new Date(t.start_at),
        new Date(t.end_at),
        rec,
        until,
        timezone,
      );
      const seriesId = rec === "none" || occurrences.length <= 1 ? null : crypto.randomUUID();
      for (const o of occurrences) {
        expanded.push({
          user_id: userId,
          title: t.title,
          notes: t.notes ?? null,
          start_at: o.start.toISOString(),
          end_at: o.end.toISOString(),
          duration_minutes: t.duration_minutes,
          priority: t.priority,
          category: t.category,
          recurrence: rec,
          recurrence_until: t.recurrence_until ?? null,
          series_id: seriesId,
        });
      }
    }

    const dupes = await findDuplicates(
      supabase,
      userId,
      expanded.map((r) => ({ title: r.title as string, start_at: r.start_at as string })),
    );
    const filtered = expanded.filter((r) => !dupes.has(`${r.title}|${r.start_at}`));
    const skipped = expanded.length - filtered.length;
    if (filtered.length === 0) {
      console.log(`[tasks.create] all ${expanded.length} rows were duplicates`);
      return { inserted: [], skipped };
    }

    const { data: inserted, error } = await supabase.from("tasks").insert(filtered).select("*");
    if (error) throw new Error(error.message);
    console.log(`[tasks.create] inserted ${inserted?.length ?? 0} rows, syncing to Google`);

    // Must await — the Worker cancels pending promises once the handler returns.
    await Promise.all(
      (inserted ?? []).map(async (row: unknown) => {
        const r = row as unknown as {
          id: string;
          title: string;
          notes: string | null;
          start_at: string;
          end_at: string;
          google_event_id: string | null;
        };
        try {
          const res = await pushTaskToGoogle(userId, r);
          if (res.google_event_id && res.google_event_id !== r.google_event_id) {
            const { error: updErr } = await supabase
              .from("tasks")
              .update({ google_event_id: res.google_event_id, google_calendar_id: "primary" })
              .eq("id", r.id);
            if (updErr) console.error("[tasks.create] failed to save google_event_id", updErr);
          }
        } catch (e) {
          console.error("[tasks.create] pushTaskToGoogle threw", e);
        }
      }),
    );

    return { inserted: inserted ?? [], skipped };
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
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("tasks")
      .update(data.patch)
      .eq("id", data.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    if (data.patch.title || data.patch.start_at || data.patch.end_at || data.patch.notes !== undefined) {
      const { pushTaskToGoogle } = await import("./google-calendar.server");
      try {
        const res = await pushTaskToGoogle(userId, row as never);
        const existingId = (row as { google_event_id: string | null }).google_event_id;
        if (res.google_event_id && res.google_event_id !== existingId) {
          await supabase
            .from("tasks")
            .update({ google_event_id: res.google_event_id, google_calendar_id: "primary" })
            .eq("id", data.id);
        }
      } catch (e) {
        console.error("[tasks.update] pushTaskToGoogle threw", e);
      }
    }
    return row;
  });

const DeleteInput = z.object({
  id: z.string().uuid(),
  scope: z.enum(["single", "series", "following"]).optional().default("single"),
});

export const deleteTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => DeleteInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { deleteFromGoogle } = await import("./google-calendar.server");

    if (data.scope !== "single") {
      const { data: base } = await supabase
        .from("tasks")
        .select("*")
        .eq("id", data.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (base?.series_id) {
        let q = supabase
          .from("tasks")
          .select("id, google_event_id")
          .eq("user_id", userId)
          .eq("series_id", base.series_id);
        if (data.scope === "following") q = q.gte("start_at", base.start_at);
        const { data: rows } = await q;
        await Promise.all(
          ((rows ?? []) as Array<{ id: string; google_event_id: string | null }>).map((r) =>
            deleteFromGoogle(userId, r.google_event_id).catch((e: unknown) =>
              console.error("[tasks.delete] deleteFromGoogle threw", e),
            ),
          ),
        );
        let del = supabase.from("tasks").delete().eq("user_id", userId).eq("series_id", base.series_id);
        if (data.scope === "following") del = del.gte("start_at", base.start_at);
        const { error } = await del;
        if (error) throw new Error(error.message);
        return { ok: true };
      }
    }

    const { data: row } = await supabase
      .from("tasks")
      .select("google_event_id")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (row?.google_event_id) {
      await deleteFromGoogle(userId, row.google_event_id).catch((e: unknown) =>
        console.error("[tasks.delete] deleteFromGoogle threw", e),
      );
    }
    const { error } = await supabase.from("tasks").delete().eq("id", data.id).eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await context.supabase
      .from("tasks")
      .select("*")
      .gte("start_at", since)
      .order("start_at", { ascending: true })
      .limit(1000);
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
    // Self-heal for accounts created without a preferences row.
    const { data: created, error: insErr } = await supabase
      .from("user_preferences")
      .upsert({ user_id: userId }, { onConflict: "user_id" })
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
      .upsert({ user_id: userId, ...data }, { onConflict: "user_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

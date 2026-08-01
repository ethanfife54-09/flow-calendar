// Shared, browser-safe types (no runtime server code).

export type ParsedTask = {
  title: string;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  priority: "low" | "medium" | "high";
  category: string;
  notes?: string | null;
  recurrence?: "none" | "daily" | "weekdays" | "weekly" | "monthly";
  suggested_time_reason?: string | null;
};

export type InterpretResult =
  | { type: "tasks"; tasks: ParsedTask[]; summary?: string | null }
  | { type: "clarify"; question: string };

export type BusyBlock = { title: string; start: string; end: string; source: "taskflow" | "google" };

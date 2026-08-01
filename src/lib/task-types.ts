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

export type TaskChange = {
  id: string;
  action: "move" | "delete";
  title?: string | null;
  start_at?: string | null;
  end_at?: string | null;
  duration_minutes?: number | null;
};

export type InterpretResult =
  | { type: "tasks"; tasks: ParsedTask[]; summary?: string | null; adjustments?: string[] }
  | { type: "changes"; changes: TaskChange[]; summary?: string | null }
  | { type: "clarify"; question: string };

export type BusyBlock = {
  title: string;
  start: string;
  end: string;
  source: "taskflow" | "google";
  id?: string | null;
};

export type TaskInsertRow = {
  user_id: string;
  title: string;
  notes: string | null;
  start_at: string;
  end_at: string;
  duration_minutes: number;
  priority: "low" | "medium" | "high";
  category: string;
  recurrence: string;
  recurrence_until: string | null;
  series_id: string | null;
};

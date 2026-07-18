import { useMemo, useState } from "react";
import type { Task } from "@/routes/_authenticated/dashboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Check, Trash2, Pencil, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

type EditPatch = {
  title?: string;
  notes?: string | null;
  start_at?: string;
  end_at?: string;
  duration_minutes?: number;
  priority?: "low" | "medium" | "high";
  category?: string;
  completed?: boolean;
};

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

const PRIORITY_COLOR: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-primary/10 text-primary",
  high: "bg-destructive/10 text-destructive",
};

export function CalendarView({
  tasks,
  loading,
  onToggleComplete,
  onDelete,
  onEdit,
}: {
  tasks: Task[];
  loading: boolean;
  onToggleComplete: (t: Task) => void;
  onDelete: (t: Task) => void;
  onEdit: (t: Task, patch: EditPatch) => void;
}) {
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [editing, setEditing] = useState<Task | null>(null);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)),
    [anchor],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const key = startOfDay(new Date(t.start_at)).toISOString();
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return map;
  }, [tasks]);

  return (
    <div className="rounded-2xl border bg-card">
      <div className="flex items-center justify-between p-4 border-b">
        <div>
          <div className="text-sm font-medium">
            {days[0].toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </div>
          <div className="text-xs text-muted-foreground">
            {days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} –{" "}
            {days[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAnchor(startOfDay(new Date()))}
          >
            Today
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setAnchor(addDays(anchor, -7))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setAnchor(addDays(anchor, 7))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="divide-y">
        {loading && (
          <div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>
        )}
        {!loading &&
          days.map((day) => {
            const items = (byDay.get(day.toISOString()) ?? []).sort(
              (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
            );
            const isToday = sameDay(day, new Date());
            return (
              <div key={day.toISOString()} className="p-4 flex gap-4">
                <div className="w-14 shrink-0">
                  <div
                    className={cn(
                      "text-xs uppercase tracking-wide",
                      isToday ? "text-primary font-semibold" : "text-muted-foreground",
                    )}
                  >
                    {day.toLocaleDateString(undefined, { weekday: "short" })}
                  </div>
                  <div
                    className={cn(
                      "text-2xl font-semibold",
                      isToday ? "text-primary" : "text-foreground",
                    )}
                  >
                    {day.getDate()}
                  </div>
                </div>
                <div className="flex-1 space-y-1.5 min-w-0">
                  {items.length === 0 && (
                    <div className="text-sm text-muted-foreground/60 italic py-2">
                      Nothing scheduled
                    </div>
                  )}
                  {items.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      onToggleComplete={() => onToggleComplete(t)}
                      onDelete={() => onDelete(t)}
                      onEdit={() => setEditing(t)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
      </div>

      <EditDialog
        task={editing}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (editing) onEdit(editing, patch);
          setEditing(null);
        }}
      />
    </div>
  );
}

function TaskRow({
  task,
  onToggleComplete,
  onDelete,
  onEdit,
}: {
  task: Task;
  onToggleComplete: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const start = new Date(task.start_at);
  const end = new Date(task.end_at);
  const time = `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-lg border bg-background hover:bg-accent/30 transition p-2.5",
        task.completed && "opacity-60",
      )}
    >
      <button
        onClick={onToggleComplete}
        className={cn(
          "h-5 w-5 rounded-full border-2 shrink-0 flex items-center justify-center transition",
          task.completed
            ? "bg-primary border-primary"
            : "border-muted-foreground/40 hover:border-primary",
        )}
        aria-label="Toggle complete"
      >
        {task.completed && <Check className="h-3 w-3 text-primary-foreground" />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            "text-sm font-medium truncate",
            task.completed && "line-through",
          )}
        >
          {task.title}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {time}
          </span>
          <Badge variant="outline" className={cn("text-[10px] py-0 h-4", PRIORITY_COLOR[task.priority])}>
            {task.priority}
          </Badge>
          <span className="text-[10px] uppercase tracking-wide">{task.category}</span>
        </div>
      </div>
      <div className="opacity-0 group-hover:opacity-100 transition flex items-center">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditDialog({
  task,
  onClose,
  onSave,
}: {
  task: Task | null;
  onClose: () => void;
  onSave: (patch: EditPatch) => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState(30);
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [category, setCategory] = useState("general");

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setNotes(task.notes ?? "");
      setStart(toLocalInput(task.start_at));
      setDuration(task.duration_minutes);
      setPriority(task.priority as "low" | "medium" | "high");
      setCategory(task.category);
    }
  }, [task]);

  if (!task) return null;

  return (
    <Dialog open={!!task} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <Label>Duration (min)</Label>
              <Input
                type="number"
                min={5}
                value={duration}
                onChange={(e) => setDuration(parseInt(e.target.value) || 30)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Category</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const startDate = new Date(start);
              const endDate = new Date(startDate.getTime() + duration * 60000);
              onSave({
                title,
                notes: notes || null,
                start_at: startDate.toISOString(),
                end_at: endDate.toISOString(),
                duration_minutes: duration,
                priority,
                category,
              });
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

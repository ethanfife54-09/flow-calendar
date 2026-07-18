import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  getPreferences,
  interpretTask,
} from "@/lib/tasks.functions";
import { supabase } from "@/integrations/supabase/client";
import { TaskComposer } from "@/components/task-composer";
import { CalendarView } from "@/components/calendar-view";
import { PreferencesDialog } from "@/components/preferences-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Sparkles, LogOut, Settings2, CalendarPlus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [{ title: "TaskFlow · Dashboard" }],
  }),
  component: Dashboard,
});

export type Task = Awaited<ReturnType<typeof listTasks>>[number];

function Dashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [prefsOpen, setPrefsOpen] = useState(false);

  const list = useServerFn(listTasks);
  const create = useServerFn(createTask);
  const update = useServerFn(updateTask);
  const remove = useServerFn(deleteTask);
  const interpret = useServerFn(interpretTask);
  const getPrefs = useServerFn(getPreferences);

  const tasksQ = useQuery({ queryKey: ["tasks"], queryFn: () => list() });
  const prefsQ = useQuery({ queryKey: ["prefs"], queryFn: () => getPrefs() });

  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const interpretMut = useMutation({
    mutationFn: async (text: string) => {
      const parsed = await interpret({
        data: { text, clientNowISO: new Date().toISOString(), timezone },
      });
      return create({
        data: {
          title: parsed.title,
          notes: parsed.notes ?? null,
          start_at: parsed.start_at,
          end_at: parsed.end_at,
          duration_minutes: parsed.duration_minutes,
          priority: parsed.priority,
          category: parsed.category,
        },
      }).then((row) => ({ row, reason: parsed.suggested_time_reason }));
    },
    onSuccess: ({ row, reason }) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(`Scheduled: ${row.title}`, {
        description: reason ?? new Date(row.start_at).toLocaleString(),
      });
    },
    onError: (err: Error) => toast.error(err.message ?? "Could not schedule task"),
  });

  const updateMut = useMutation({
    mutationFn: (args: { id: string; patch: Parameters<typeof update>[0]["data"]["patch"] }) =>
      update({ data: args }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("Task deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleSignOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/80 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-semibold tracking-tight">TaskFlow</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" disabled title="Coming soon">
              <CalendarPlus className="h-4 w-4 mr-1.5" />
              Google Calendar
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setPrefsOpen(true)}>
              <Settings2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <TaskComposer
          onSubmit={(text) => interpretMut.mutate(text)}
          busy={interpretMut.isPending}
        />

        <CalendarView
          tasks={tasksQ.data ?? []}
          loading={tasksQ.isLoading}
          onToggleComplete={(t) =>
            updateMut.mutate({ id: t.id, patch: { completed: !t.completed } })
          }
          onDelete={(t) => removeMut.mutate(t.id)}
          onEdit={(t, patch) => updateMut.mutate({ id: t.id, patch })}
        />
      </main>

      <PreferencesDialog
        open={prefsOpen}
        onOpenChange={setPrefsOpen}
        prefs={prefsQ.data ?? null}
        onSaved={() => qc.invalidateQueries({ queryKey: ["prefs"] })}
      />
    </div>
  );
}

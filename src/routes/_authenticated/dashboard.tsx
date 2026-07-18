import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  listTasks,
  createTasks,
  updateTask,
  deleteTask,
  getPreferences,
  interpretRequest,
  interpretImage,
  type InterpretResult,
} from "@/lib/tasks.functions";
import { supabase } from "@/integrations/supabase/client";
import { TaskComposer, type ComposerMessage } from "@/components/task-composer";
import { CalendarView } from "@/components/calendar-view";
import { PreferencesDialog } from "@/components/preferences-dialog";
import { OnboardingDialog } from "@/components/onboarding-dialog";
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
  const [messages, setMessages] = useState<ComposerMessage[]>([]);

  const list = useServerFn(listTasks);
  const createMany = useServerFn(createTasks);
  const update = useServerFn(updateTask);
  const remove = useServerFn(deleteTask);
  const interpret = useServerFn(interpretRequest);
  const interpretImg = useServerFn(interpretImage);
  const getPrefs = useServerFn(getPreferences);

  const tasksQ = useQuery({ queryKey: ["tasks"], queryFn: () => list() });
  const prefsQ = useQuery({ queryKey: ["prefs"], queryFn: () => getPrefs() });

  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const showOnboarding = prefsQ.data && !prefsQ.data.onboarded;

  function historyForModel() {
    // Send last few turns as chat history so clarifications resolve.
    return messages.slice(-8).map((m) => ({
      role: m.role,
      content: m.content || (m.role === "user" && "image" in m && m.image ? "[image attached]" : ""),
    }));
  }

  async function handleInterpretResult(result: InterpretResult) {
    if (result.type === "clarify") {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.question, kind: "clarify" },
      ]);
      return;
    }
    if (result.tasks.length === 0) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I couldn't find anything to schedule. Could you rephrase?", kind: "clarify" },
      ]);
      return;
    }
    const inserted = await createMany({
      data: {
        tasks: result.tasks.map((t) => ({
          title: t.title,
          notes: t.notes ?? null,
          start_at: t.start_at,
          end_at: t.end_at,
          duration_minutes: t.duration_minutes,
          priority: t.priority,
          category: t.category,
        })),
      },
    });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    const summary =
      result.summary ??
      (inserted.length === 1
        ? `Scheduled: ${inserted[0].title} — ${new Date(inserted[0].start_at).toLocaleString()}`
        : `Scheduled ${inserted.length} tasks.`);
    setMessages((prev) => [...prev, { role: "assistant", content: summary, kind: "summary" }]);
    toast.success(inserted.length === 1 ? "Task scheduled" : `${inserted.length} tasks scheduled`);
  }

  const textMut = useMutation({
    mutationFn: async (text: string) => {
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      const result = await interpret({
        data: {
          text,
          clientNowISO: new Date().toISOString(),
          timezone,
          history: historyForModel(),
        },
      });
      await handleInterpretResult(result);
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Could not process request");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Sorry — ${err.message ?? "something went wrong"}.` },
      ]);
    },
  });

  const imgMut = useMutation({
    mutationFn: async (args: { dataUrl: string; note: string }) => {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: args.note || "Please add this schedule.", image: args.dataUrl },
      ]);
      const result = await interpretImg({
        data: {
          imageDataUrl: args.dataUrl,
          note: args.note || undefined,
          clientNowISO: new Date().toISOString(),
          timezone,
        },
      });
      await handleInterpretResult(result);
    },
    onError: (err: Error) => {
      toast.error(err.message ?? "Could not read image");
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Sorry — ${err.message ?? "couldn't read that image"}.` },
      ]);
    },
  });

  const updateMut = useMutation({
    mutationFn: (args: { id: string; patch: Record<string, unknown> }) =>
      update({ data: args as never }),
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

  // Auto-trim conversation buffer
  useEffect(() => {
    if (messages.length > 30) setMessages((prev) => prev.slice(-30));
  }, [messages.length]);

  const busy = textMut.isPending || imgMut.isPending;

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
            {messages.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setMessages([])}>
                New chat
              </Button>
            )}
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
          messages={messages}
          onSubmitText={(text) => textMut.mutate(text)}
          onSubmitImage={(dataUrl, note) => imgMut.mutate({ dataUrl, note })}
          busy={busy}
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

      {showOnboarding && (
        <OnboardingDialog
          open
          onDone={() => qc.invalidateQueries({ queryKey: ["prefs"] })}
        />
      )}
    </div>
  );
}

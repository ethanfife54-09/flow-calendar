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
import {
  startGoogleCalendarConnect,
  saveGoogleCalendarConnection,
  getGoogleCalendarStatus,
  disconnectGoogleCalendar,
  importGoogleCalendarWindow,
} from "@/lib/google-calendar.functions";
import { connectAppUser } from "@/integrations/lovable/appUserConnectorClient";
import { supabase } from "@/integrations/supabase/client";
import { TaskComposer, type ComposerMessage } from "@/components/task-composer";
import { CalendarView } from "@/components/calendar-view";
import { PreferencesDialog } from "@/components/preferences-dialog";
import { OnboardingDialog } from "@/components/onboarding-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Sparkles, LogOut, Settings2, Calendar, Check, Download, X } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "TaskFlow · Dashboard" }] }),
  component: Dashboard,
});

export type Task = Awaited<ReturnType<typeof listTasks>>[number];

const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";

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
  const gcalStatus = useServerFn(getGoogleCalendarStatus);
  const gcalStart = useServerFn(startGoogleCalendarConnect);
  const gcalSave = useServerFn(saveGoogleCalendarConnection);
  const gcalDisconnect = useServerFn(disconnectGoogleCalendar);
  const gcalImport = useServerFn(importGoogleCalendarWindow);

  const tasksQ = useQuery({ queryKey: ["tasks"], queryFn: () => list() });
  const prefsQ = useQuery({ queryKey: ["prefs"], queryFn: () => getPrefs() });
  const gcalQ = useQuery({ queryKey: ["gcal-status"], queryFn: () => gcalStatus() });

  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const showOnboarding = prefsQ.data && !prefsQ.data.onboarded;

  function historyForModel() {
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
    const res = await createMany({
      data: {
        tasks: result.tasks.map((t) => ({
          title: t.title,
          notes: t.notes ?? null,
          start_at: t.start_at,
          end_at: t.end_at,
          duration_minutes: t.duration_minutes,
          priority: t.priority,
          category: t.category,
          recurrence: t.recurrence ?? "none",
        })),
      },
    });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    const inserted = res.inserted;
    const skipped = res.skipped;
    const summary =
      result.summary ??
      (inserted.length === 1
        ? `Scheduled: ${inserted[0].title} — ${new Date(inserted[0].start_at).toLocaleString()}`
        : inserted.length > 0
          ? `Scheduled ${inserted.length} tasks.`
          : "Nothing new — everything was already on your calendar.");
    const fullSummary = skipped > 0
      ? `${summary} (skipped ${skipped} duplicate${skipped === 1 ? "" : "s"})`
      : summary;
    setMessages((prev) => [...prev, { role: "assistant", content: fullSummary, kind: "summary" }]);
    if (inserted.length > 0) {
      toast.success(inserted.length === 1 ? "Task scheduled" : `${inserted.length} tasks scheduled`);
    } else if (skipped > 0) {
      toast.info("Already on your calendar");
    }
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
    mutationFn: (args: { id: string; scope: "single" | "series" | "following" }) =>
      remove({ data: args }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("Deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function handleConnectGoogle() {
    const result = await connectAppUser({
      connectorId: "google_calendar",
      gatewayBaseUrl: GATEWAY_BASE_URL,
      start: async (targetOrigin) => {
        return await gcalStart({ data: { targetOrigin } });
      },
    });
    if (!result.success) {
      toast.error(result.error ?? "Sign in was cancelled");
      return;
    }
    if (!result.connectionAPIKey) {
      toast.error("Google denied offline access — cannot sync.");
      return;
    }
    await gcalSave({ data: { connectionAPIKey: result.connectionAPIKey } });
    toast.success("Google Calendar connected");
    qc.invalidateQueries({ queryKey: ["gcal-status"] });
  }

  async function handleDisconnectGoogle() {
    await gcalDisconnect();
    toast.success("Google Calendar disconnected");
    qc.invalidateQueries({ queryKey: ["gcal-status"] });
  }

  const importMut = useMutation({
    mutationFn: async () => {
      const from = new Date();
      const to = new Date(from.getTime() + 14 * 24 * 3600 * 1000);
      return gcalImport({ data: { fromISO: from.toISOString(), toISO: to.toISOString() } });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(`Imported ${r.imported} event${r.imported === 1 ? "" : "s"} from Google`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleMoveDay(t: Task, newDay: Date) {
    const oldStart = new Date(t.start_at);
    const newStart = new Date(newDay);
    newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), 0, 0);
    const newEnd = new Date(newStart.getTime() + t.duration_minutes * 60000);
    updateMut.mutate({ id: t.id, patch: { start_at: newStart.toISOString(), end_at: newEnd.toISOString() } });
  }

  async function handleSignOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  useEffect(() => {
    if (messages.length > 30) setMessages((prev) => prev.slice(-30));
  }, [messages.length]);

  const busy = textMut.isPending || imgMut.isPending;
  const gcalConnected = gcalQ.data?.connected ?? false;

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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant={gcalConnected ? "outline" : "ghost"} size="sm">
                  <Calendar className="h-4 w-4 mr-1.5" />
                  {gcalConnected ? (
                    <>
                      <Check className="h-3 w-3 mr-1 text-primary" /> Google
                    </>
                  ) : (
                    "Connect Google"
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {gcalConnected ? (
                  <>
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground truncate">
                      {gcalQ.data?.accountLabel ?? "Connected"}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => importMut.mutate()} disabled={importMut.isPending}>
                      <Download className="h-4 w-4 mr-2" />
                      {importMut.isPending ? "Importing…" : "Import next 2 weeks"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleDisconnectGoogle}>
                      <X className="h-4 w-4 mr-2" />
                      Disconnect
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem onClick={handleConnectGoogle}>
                    <Calendar className="h-4 w-4 mr-2" />
                    Connect your Google account
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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
          onDelete={(t, scope) => removeMut.mutate({ id: t.id, scope })}
          onEdit={(t, patch) => updateMut.mutate({ id: t.id, patch })}
          onMoveDay={handleMoveDay}
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

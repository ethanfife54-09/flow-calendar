import { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowUp } from "lucide-react";

const EXAMPLES = [
  "Finish physics homework tomorrow evening",
  "Remind me to call John after church Sunday",
  "Study calculus for 2 hours sometime tomorrow",
  "Workout at 7am Wednesday",
];

export function TaskComposer({
  onSubmit,
  busy,
}: {
  onSubmit: (text: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy]);

  function submit() {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText("");
  }

  return (
    <div className="rounded-2xl border bg-card p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <div className="mt-2 pl-1">
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add a task in plain English…"
          className="min-h-[56px] resize-none border-0 focus-visible:ring-0 shadow-none p-2 text-base"
          disabled={busy}
        />
        <Button
          size="icon"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="rounded-full h-9 w-9"
          aria-label="Schedule task"
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2 pl-6">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className="text-xs px-2.5 py-1 rounded-full bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition"
            onClick={() => setText(ex)}
            disabled={busy}
          >
            {ex}
          </button>
        ))}
      </div>
      {busy && (
        <div className="text-xs text-muted-foreground mt-2 pl-6 flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          Thinking…
        </div>
      )}
    </div>
  );
}

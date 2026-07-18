import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { updatePreferences } from "@/lib/tasks.functions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ChevronRight, Sparkles } from "lucide-react";

type Block = {
  label: string;
  day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "any";
  start_hour: number;
  end_hour: number;
};

export function OnboardingDialog({
  open,
  onDone,
}: {
  open: boolean;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [earliest, setEarliest] = useState(7);
  const [latest, setLatest] = useState(21);
  const [workStyle, setWorkStyle] = useState<"relaxed" | "balanced" | "intense">("balanced");
  const [focusLen, setFocusLen] = useState(60);
  const [breakLen, setBreakLen] = useState(15);
  const [goals, setGoals] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const save = useServerFn(updatePreferences);

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          earliest_hour: earliest,
          latest_hour: latest,
          work_style: workStyle,
          focus_length_minutes: focusLen,
          break_minutes: breakLen,
          goals: goals.trim() || null,
          reserved_blocks: blocks,
          onboarded: true,
        },
      }),
    onSuccess: () => {
      toast.success("You're all set!");
      onDone();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const steps = [
    {
      title: "Welcome to TaskFlow",
      description: "A quick setup so the AI schedules things the way you like. Takes ~30 seconds.",
      body: (
        <div className="flex flex-col items-center text-center py-6 gap-3">
          <div className="h-14 w-14 rounded-2xl bg-primary flex items-center justify-center">
            <Sparkles className="h-7 w-7 text-primary-foreground" />
          </div>
          <p className="text-sm text-muted-foreground max-w-sm">
            Tell me a bit about your day and preferences. You can change any of this later in
            Settings.
          </p>
        </div>
      ),
    },
    {
      title: "When can I schedule things?",
      description: "The AI will only place tasks between these hours.",
      body: (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Earliest hour</Label>
            <Input
              type="number"
              min={0}
              max={23}
              value={earliest}
              onChange={(e) => setEarliest(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
            />
            <p className="text-xs text-muted-foreground mt-1">0 – 23</p>
          </div>
          <div>
            <Label>Latest hour</Label>
            <Input
              type="number"
              min={1}
              max={24}
              value={latest}
              onChange={(e) => setLatest(Math.max(1, Math.min(24, parseInt(e.target.value) || 24)))}
            />
            <p className="text-xs text-muted-foreground mt-1">1 – 24</p>
          </div>
        </div>
      ),
    },
    {
      title: "How do you like to work?",
      description: "This shapes block scheduling and break placement.",
      body: (
        <div className="space-y-3">
          <div>
            <Label>Work style</Label>
            <Select value={workStyle} onValueChange={(v) => setWorkStyle(v as typeof workStyle)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relaxed">Relaxed — generous breaks</SelectItem>
                <SelectItem value="balanced">Balanced — steady rhythm</SelectItem>
                <SelectItem value="intense">Intense — pack the day</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Focus block (min)</Label>
              <Input
                type="number"
                min={15}
                max={240}
                value={focusLen}
                onChange={(e) => setFocusLen(parseInt(e.target.value) || 60)}
              />
            </div>
            <div>
              <Label>Break (min)</Label>
              <Input
                type="number"
                min={0}
                max={60}
                value={breakLen}
                onChange={(e) => setBreakLen(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>
      ),
    },
    {
      title: "Any recurring blocks?",
      description: "Windows the AI should never schedule over (workouts, classes, sleep, etc.).",
      body: (
        <div className="space-y-2">
          {blocks.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              Optional. Add one to reserve time — e.g. workout every day 7–8am.
            </p>
          )}
          {blocks.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="Label"
                value={b.label}
                className="flex-1"
                onChange={(e) => {
                  const next = [...blocks];
                  next[i] = { ...b, label: e.target.value };
                  setBlocks(next);
                }}
              />
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={b.day}
                onChange={(e) => {
                  const next = [...blocks];
                  next[i] = { ...b, day: e.target.value as Block["day"] };
                  setBlocks(next);
                }}
              >
                {(["any", "mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                min={0}
                max={23}
                value={b.start_hour}
                className="w-16"
                onChange={(e) => {
                  const next = [...blocks];
                  next[i] = { ...b, start_hour: parseInt(e.target.value) || 0 };
                  setBlocks(next);
                }}
              />
              <span className="text-xs text-muted-foreground">–</span>
              <Input
                type="number"
                min={1}
                max={24}
                value={b.end_hour}
                className="w-16"
                onChange={(e) => {
                  const next = [...blocks];
                  next[i] = { ...b, end_hour: parseInt(e.target.value) || 0 };
                  setBlocks(next);
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setBlocks([...blocks, { label: "Workout", day: "any", start_hour: 7, end_hour: 8 }])
            }
          >
            + Add block
          </Button>
        </div>
      ),
    },
    {
      title: "What are you focused on?",
      description: "Optional. The AI uses this to prioritize when you say things like 'organize my day'.",
      body: (
        <Textarea
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
          placeholder="e.g. Preparing for calculus midterm on Nov 30, launching my side project, staying consistent with the gym."
          className="min-h-[120px]"
        />
      ),
    },
  ];

  const cur = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{cur.title}</DialogTitle>
          <DialogDescription>{cur.description}</DialogDescription>
        </DialogHeader>
        <div>{cur.body}</div>
        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <div className="flex gap-1">
            {steps.map((_, i) => (
              <span
                key={i}
                className={
                  "h-1.5 w-6 rounded-full " + (i <= step ? "bg-primary" : "bg-muted")
                }
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={mut.isPending}>
                Back
              </Button>
            )}
            {!isLast ? (
              <Button onClick={() => setStep(step + 1)}>
                Next <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            ) : (
              <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
                {mut.isPending ? "Saving…" : "Finish"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

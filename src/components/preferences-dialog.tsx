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
import { Plus, Trash2 } from "lucide-react";

type Block = {
  label: string;
  day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "any";
  start_hour: number;
  end_hour: number;
};

type Prefs = {
  earliest_hour: number;
  latest_hour: number;
  reserved_blocks: unknown;
  timezone: string;
  work_style?: string;
  focus_length_minutes?: number;
  break_minutes?: number;
  goals?: string | null;
} | null;

const DAYS: Block["day"][] = ["any", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function PreferencesDialog({
  open,
  onOpenChange,
  prefs,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  prefs: Prefs;
  onSaved: () => void;
}) {
  const [earliest, setEarliest] = useState(7);
  const [latest, setLatest] = useState(21);
  const [workStyle, setWorkStyle] = useState<"relaxed" | "balanced" | "intense">("balanced");
  const [focusLen, setFocusLen] = useState(60);
  const [breakLen, setBreakLen] = useState(15);
  const [goals, setGoals] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const save = useServerFn(updatePreferences);

  useEffect(() => {
    if (prefs) {
      setEarliest(prefs.earliest_hour);
      setLatest(prefs.latest_hour);
      setWorkStyle(((prefs.work_style ?? "balanced") as "relaxed" | "balanced" | "intense"));
      setFocusLen(prefs.focus_length_minutes ?? 60);
      setBreakLen(prefs.break_minutes ?? 15);
      setGoals(prefs.goals ?? "");
      setBlocks(Array.isArray(prefs.reserved_blocks) ? (prefs.reserved_blocks as Block[]) : []);
    }
  }, [prefs, open]);

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
        },
      }),
    onSuccess: () => {
      toast.success("Preferences saved");
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>
            Everything the AI uses when scheduling. Change any of this any time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Hours</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Earliest</Label>
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={earliest}
                  onChange={(e) => setEarliest(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                />
                <p className="text-xs text-muted-foreground mt-1">Hour of day (0–23)</p>
              </div>
              <div>
                <Label>Latest</Label>
                <Input
                  type="number"
                  min={1}
                  max={24}
                  value={latest}
                  onChange={(e) => setLatest(Math.max(1, Math.min(24, parseInt(e.target.value) || 24)))}
                />
                <p className="text-xs text-muted-foreground mt-1">Hour of day (1–24)</p>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Work style</Label>
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
          </section>

          <section className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Goals</Label>
            <Textarea
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              placeholder="What are you focused on this week/month?"
              className="min-h-[80px]"
            />
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Reserved blocks</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setBlocks([...blocks, { label: "Workout", day: "any", start_hour: 7, end_hour: 8 }])
                }
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add
              </Button>
            </div>
            <div className="space-y-2">
              {blocks.length === 0 && (
                <p className="text-xs text-muted-foreground italic">
                  Windows the AI should never schedule over (workouts, sleep, classes).
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
                    {DAYS.map((d) => (
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
                    size="icon"
                    onClick={() => setBlocks(blocks.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

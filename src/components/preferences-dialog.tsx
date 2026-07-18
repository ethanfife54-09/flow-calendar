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
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

type Block = { label: string; day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" | "any"; start_hour: number; end_hour: number };

type Prefs = {
  earliest_hour: number;
  latest_hour: number;
  reserved_blocks: unknown;
  timezone: string;
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
  const [blocks, setBlocks] = useState<Block[]>([]);
  const save = useServerFn(updatePreferences);

  useEffect(() => {
    if (prefs) {
      setEarliest(prefs.earliest_hour);
      setLatest(prefs.latest_hour);
      setBlocks(Array.isArray(prefs.reserved_blocks) ? (prefs.reserved_blocks as Block[]) : []);
    }
  }, [prefs, open]);

  const mut = useMutation({
    mutationFn: () =>
      save({
        data: {
          earliest_hour: earliest,
          latest_hour: latest,
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Scheduling preferences</DialogTitle>
          <DialogDescription>
            Rules the AI uses when scheduling your tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Don't schedule before</Label>
              <Input
                type="number"
                min={0}
                max={23}
                value={earliest}
                onChange={(e) => setEarliest(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
              />
              <p className="text-xs text-muted-foreground mt-1">Hour of day (0-23)</p>
            </div>
            <div>
              <Label>Don't schedule after</Label>
              <Input
                type="number"
                min={1}
                max={24}
                value={latest}
                onChange={(e) => setLatest(Math.max(1, Math.min(24, parseInt(e.target.value) || 24)))}
              />
              <p className="text-xs text-muted-foreground mt-1">Hour of day (1-24)</p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Reserved blocks</Label>
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
                  Reserve recurring windows (workouts, study blocks) so the AI won't schedule over them.
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
          </div>
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

import { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Sparkles, ArrowUp, ImagePlus, X, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComposerMessage =
  | { role: "user"; content: string; image?: string }
  | { role: "assistant"; content: string; kind?: "clarify" | "summary" };

const EXAMPLES = [
  "Study calculus for 2 hours tomorrow",
  "Organize my day to implement my plans and study for the calculus test",
  "Remind me to call John after church Sunday",
  "Workout at 7am Wednesday",
];

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function downscaleImage(file: File, maxDim = 1600): Promise<string> {
  const url = await fileToDataUrl(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(url);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(url);
    img.src = url;
  });
}

export function TaskComposer({
  messages,
  onSubmitText,
  onSubmitImage,
  busy,
}: {
  messages: ComposerMessage[];
  onSubmitText: (text: string) => void;
  onSubmitImage: (dataUrl: string, note: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    if (!busy) ref.current?.focus();
  }, [busy, messages.length]);

  function submit() {
    const t = text.trim();
    if (busy) return;
    if (image) {
      onSubmitImage(image, t);
      setText("");
      setImage(null);
      return;
    }
    if (!t) return;
    onSubmitText(t);
    setText("");
  }

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    const url = await downscaleImage(file);
    setImage(url);
    ref.current?.focus();
  }

  return (
    <div className="rounded-2xl border bg-card shadow-sm overflow-hidden">
      {messages.length > 0 && (
        <div className="max-h-64 overflow-y-auto px-4 py-3 space-y-2 border-b bg-muted/30">
          {messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                "text-sm rounded-lg px-3 py-2 max-w-[85%]",
                m.role === "user"
                  ? "bg-primary text-primary-foreground ml-auto"
                  : "bg-background border",
              )}
            >
              {"image" in m && m.image && (
                <img
                  src={m.image}
                  alt="uploaded"
                  className="rounded mb-1 max-h-32 object-cover"
                />
              )}
              {m.content && <div className="whitespace-pre-wrap">{m.content}</div>}
              {m.role === "assistant" && m.kind === "clarify" && (
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <Wand2 className="h-3 w-3" /> awaiting your reply
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="p-3">
        {image && (
          <div className="relative inline-block mb-2">
            <img src={image} alt="preview" className="h-20 rounded-md border" />
            <button
              onClick={() => setImage(null)}
              className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-background border shadow flex items-center justify-center"
              aria-label="Remove image"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
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
            placeholder={
              image
                ? "Add a note about this schedule (optional)…"
                : "Add tasks in plain English, or upload a schedule photo…"
            }
            className="min-h-[56px] resize-none border-0 focus-visible:ring-0 shadow-none p-2 text-base"
            disabled={busy}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              if (fileRef.current) fileRef.current.value = "";
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            aria-label="Upload image"
            title="Upload a schedule photo"
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={submit}
            disabled={busy || (!text.trim() && !image)}
            className="rounded-full h-9 w-9"
            aria-label="Send"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
        {messages.length === 0 && !image && (
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
        )}
        {busy && (
          <div className="text-xs text-muted-foreground mt-2 pl-6 flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
            Thinking…
          </div>
        )}
      </div>
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Sparkles, Calendar, MessageSquare, Settings2 } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TaskFlow — Natural language to calendar" },
      {
        name: "description",
        content:
          "Type tasks in plain English. TaskFlow's AI schedules them into a clean, smart calendar.",
      },
      { property: "og:title", content: "TaskFlow — Natural language to calendar" },
      {
        property: "og:description",
        content: "Type tasks in plain English. TaskFlow's AI schedules them into a clean, smart calendar.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard", replace: true });
      else setChecking(false);
    });
  }, [navigate]);

  if (checking) return <div className="min-h-screen bg-background" />;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="px-6 py-5 flex items-center justify-between max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-lg font-semibold tracking-tight">TaskFlow</span>
        </div>
        <Button onClick={() => navigate({ to: "/auth" })}>Sign in</Button>
      </header>

      <main className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-3xl text-center py-16">
          <div className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1 text-xs text-muted-foreground mb-6">
            <Sparkles className="h-3 w-3" /> AI-powered scheduling
          </div>
          <h1 className="text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Type it. We'll schedule it.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-xl mx-auto">
            "Finish physics homework tomorrow evening." TaskFlow turns natural language into
            organized calendar events — smart, minimal, and fast.
          </p>
          <div className="mt-8 flex gap-3 justify-center">
            <Button size="lg" onClick={() => navigate({ to: "/auth" })}>
              Get started
            </Button>
          </div>

          <div className="grid sm:grid-cols-3 gap-4 mt-16 text-left">
            {[
              { icon: MessageSquare, title: "Natural input", body: "Talk to it like a friend." },
              { icon: Calendar, title: "Smart calendar", body: "Auto-scheduled around your day." },
              { icon: Settings2, title: "Your rules", body: "Quiet hours & reserved blocks." },
            ].map((f) => (
              <div key={f.title} className="rounded-xl border bg-card p-5">
                <f.icon className="h-5 w-5 mb-3 text-primary" />
                <div className="font-medium">{f.title}</div>
                <div className="text-sm text-muted-foreground mt-1">{f.body}</div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

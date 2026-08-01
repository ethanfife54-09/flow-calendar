import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Prefer the locally stored session so a transient network error doesn't
    // sign people out mid-use; only redirect when there is genuinely no session.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) throw redirect({ to: "/auth" });
    return { user: sessionData.session.user };
  },

  component: () => <Outlet />,
});

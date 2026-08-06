REVOKE ALL ON public.app_user_connections FROM anon, authenticated;
GRANT ALL ON public.app_user_connections TO service_role;

ALTER TABLE public.app_user_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_user_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no client access to connector credentials" ON public.app_user_connections;
CREATE POLICY "no client access to connector credentials"
ON public.app_user_connections
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);
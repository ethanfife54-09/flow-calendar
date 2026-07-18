ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS onboarded boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS work_style text NOT NULL DEFAULT 'balanced';
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS focus_length_minutes integer NOT NULL DEFAULT 60;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS break_minutes integer NOT NULL DEFAULT 15;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS goals text;
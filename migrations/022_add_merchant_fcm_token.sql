ALTER TABLE public.merchant
ADD COLUMN IF NOT EXISTS fcm_token TEXT;

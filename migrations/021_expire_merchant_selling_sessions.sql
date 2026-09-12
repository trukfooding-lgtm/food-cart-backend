-- Run in Supabase SQL Editor after enabling pg_cron (Integrations > Cron).
-- This job runs in the database even when the mobile app or API is asleep.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
DECLARE existing_job bigint;
BEGIN
  SELECT jobid INTO existing_job FROM cron.job WHERE jobname = 'expire-merchant-selling-sessions';
  IF existing_job IS NOT NULL THEN PERFORM cron.unschedule(existing_job); END IF;
END $$;
SELECT cron.schedule('expire-merchant-selling-sessions', '* * * * *',
  $job$UPDATE public.merchant_status
    SET status = 'ปิดร้าน', updated_at = CURRENT_TIMESTAMP
    WHERE status <> 'ปิดร้าน' AND selling_ends_at <= CURRENT_TIMESTAMP$job$);

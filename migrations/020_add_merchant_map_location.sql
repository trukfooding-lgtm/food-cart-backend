-- PostgreSQL / Supabase: retain existing merchant statuses and hours.
-- NULL means the merchant has not yet published a selling location/session.
BEGIN;

ALTER TABLE public.merchant_status
  ADD COLUMN IF NOT EXISTS latitude double precision
    CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS longitude double precision
    CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS location_name text,
  ADD COLUMN IF NOT EXISTS selling_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS selling_ends_at timestamptz;

COMMIT;

-- Allow the backend to keep uncertain SlipOK results for merchant review.
-- Preserve the existing slip statuses and limit this change to order_slips.status.
BEGIN;

ALTER TABLE public.order_slips
  DROP CONSTRAINT IF EXISTS order_slips_status_chk;

ALTER TABLE public.order_slips
  ADD CONSTRAINT order_slips_status_chk
  CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'MANUAL_REVIEW'));

COMMIT;

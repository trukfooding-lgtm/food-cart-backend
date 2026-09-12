BEGIN;
ALTER TABLE public.merchant_hours ADD COLUMN IF NOT EXISTS weekly_hours jsonb;
ALTER TABLE public.merchant_status
  ADD COLUMN IF NOT EXISTS scheduled_open boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opening_notified boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.process_merchant_selling_sessions()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE shop record;
BEGIN
  -- Lock each due session so concurrent API reads and cron cannot notify twice.
  FOR shop IN SELECT s.*, m.name FROM public.merchant_status s
    JOIN public.merchant m ON m.id=s.merchant_id
    WHERE (s.scheduled_open OR NOT s.opening_notified OR s.status <> 'ปิดร้าน')
      AND s.selling_started_at <= CURRENT_TIMESTAMP
    FOR UPDATE OF s SKIP LOCKED
  LOOP
    IF shop.selling_ends_at <= CURRENT_TIMESTAMP THEN
      UPDATE public.merchant_status SET status='ปิดร้าน', scheduled_open=false,
        opening_notified=true, updated_at=CURRENT_TIMESTAMP WHERE merchant_id=shop.merchant_id;
    ELSIF shop.selling_ends_at > CURRENT_TIMESTAMP THEN
      IF shop.scheduled_open THEN
        UPDATE public.merchant_status SET status='เปิดร้าน', scheduled_open=false,
          updated_at=CURRENT_TIMESTAMP WHERE merchant_id=shop.merchant_id;
      END IF;
      IF NOT shop.opening_notified AND (shop.scheduled_open OR shop.status='เปิดร้าน') THEN
        INSERT INTO public.notifications (user_id,title,body)
          SELECT DISTINCT customer_id, 'ร้านรถเข็นที่คุณติดตามเปิดขายแล้ว',
            'ร้าน ' || shop.name || ' เปิดขายแล้วนะ 📍 อยู่ที่ ' || COALESCE(shop.location_name,'จุดขาย')
          FROM public.followed WHERE merchant_id=shop.merchant_id;
        UPDATE public.merchant_status SET opening_notified=true WHERE merchant_id=shop.merchant_id;
      END IF;
    END IF;
  END LOOP;
END $$;
COMMIT;
-- Replace the previous job. No shop opens from weekly hours without a pinned session.
SELECT cron.schedule('expire-merchant-selling-sessions', '* * * * *',
  'SELECT public.process_merchant_selling_sessions()');

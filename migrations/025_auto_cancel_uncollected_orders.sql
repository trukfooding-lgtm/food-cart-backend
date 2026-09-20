-- ยกเลิกออเดอร์ที่พร้อมรับแต่ไม่มีผู้มารับหลังหมดเวลาขาย
-- ทำงานจาก Supabase/pg_cron และถูกเรียกซ้ำได้อย่างปลอดภัย

CREATE OR REPLACE FUNCTION public.expire_merchant_sessions_and_cancel_uncollected_orders()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  expired_session RECORD;
  pending_order RECORD;
  cancel_reason CONSTANT TEXT := 'ลูกค้าไม่มารับอาหารภายในเวลาที่ร้านเปิดทำการ';
  report_type CONSTANT TEXT := 'ลูกค้าไม่มารับอาหารภายในเวลาร้าน';
  report_details TEXT;
BEGIN
  FOR expired_session IN
    SELECT merchant_id, selling_ends_at, location_name
    FROM public.merchant_status
    WHERE selling_ends_at IS NOT NULL
      AND selling_ends_at <= CURRENT_TIMESTAMP
    FOR UPDATE
  LOOP
    UPDATE public.merchant_status
       SET status = 'ปิดร้าน', updated_at = CURRENT_TIMESTAMP
     WHERE merchant_id = expired_session.merchant_id;

    FOR pending_order IN
      SELECT
        mo.source_order_id,
        mo.merchant_id,
        mo.customer_id
      FROM public.merchant_orders mo
      JOIN public.orders o
        ON o.id = mo.source_order_id
       AND o.merchant_id = mo.merchant_id
      WHERE mo.merchant_id = expired_session.merchant_id
        AND mo.merchant_status = 'รอรับสินค้า'
        AND o.status NOT IN ('รับอาหารสำเร็จแล้ว', 'สำเร็จ', 'ยกเลิก')
      FOR UPDATE OF mo, o
    LOOP
      -- การเปลี่ยนสถานะก่อนสร้างรายงานทำให้การทำงานรอบถัดไปไม่ซ้ำรายการเดิม
      UPDATE public.merchant_orders
         SET merchant_status = 'ยกเลิก',
             reject_reason = cancel_reason,
             rejected_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
       WHERE merchant_id = pending_order.merchant_id
         AND source_order_id = pending_order.source_order_id
         AND merchant_status = 'รอรับสินค้า';

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      UPDATE public.orders
         SET status = 'ยกเลิก', updated_at = CURRENT_TIMESTAMP
       WHERE id = pending_order.source_order_id
         AND merchant_id = pending_order.merchant_id
         AND status NOT IN ('รับอาหารสำเร็จแล้ว', 'สำเร็จ', 'ยกเลิก');

      report_details := cancel_reason
        || ' เลขออเดอร์ #' || pending_order.source_order_id
        || ' เวลาปิดร้าน ' || COALESCE(to_char(expired_session.selling_ends_at, 'YYYY-MM-DD HH24:MI:SS TZH:TZM'), '-')
        || ' จุดขายล่าสุด ' || COALESCE(expired_session.location_name, 'ไม่ระบุ');

      INSERT INTO public.merchant_issue_reports
        (merchant_id, issue_type, order_reference, details, image_url)
      VALUES
        (pending_order.merchant_id, report_type, pending_order.source_order_id::text, report_details, NULL);

      INSERT INTO public.notifications (user_id, title, body)
      VALUES
        (pending_order.customer_id,
         'ออเดอร์ถูกยกเลิก',
         'ออเดอร์ #' || pending_order.source_order_id || ' ถูกยกเลิกเนื่องจาก ' || cancel_reason);
    END LOOP;
  END LOOP;
END;
$$;

-- ฟังก์ชันนี้ให้ pg_cron/Backend เรียกเท่านั้น ไม่เปิดเป็น API สาธารณะ
REVOKE ALL ON FUNCTION public.expire_merchant_sessions_and_cancel_uncollected_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_merchant_sessions_and_cancel_uncollected_orders() TO postgres;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE
  existing_job BIGINT;
BEGIN
  SELECT jobid INTO existing_job
  FROM cron.job
  WHERE jobname = 'expire-merchant-selling-sessions';

  IF existing_job IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job);
  END IF;
END $$;

SELECT cron.schedule(
  'expire-merchant-selling-sessions',
  '* * * * *',
  $job$SELECT public.expire_merchant_sessions_and_cancel_uncollected_orders();$job$
);

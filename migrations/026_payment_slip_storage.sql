-- PostgreSQL / Supabase: หลักฐานสลิปและการแจ้งเตือนร้านค้า
-- เก็บไฟล์จริงใน Supabase Storage; ฐานข้อมูลเก็บเพียง storage://bucket/path

CREATE TABLE IF NOT EXISTS order_slips (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  uploader_type TEXT NOT NULL,
  uploader_id BIGINT,
  slip_url TEXT NOT NULL,
  amount NUMERIC(12, 2),
  expected_amount NUMERIC(12, 2),
  detected_amount NUMERIC(12, 2),
  status TEXT NOT NULL,
  note TEXT,
  validation_reason TEXT,
  ocr_text TEXT,
  transaction_id TEXT,
  payment_channel TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_slips_transaction_id
  ON order_slips (transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_slips_order_created_at
  ON order_slips (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS merchant_notifications (
  id BIGSERIAL PRIMARY KEY,
  merchant_id BIGINT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_notification_source
  ON merchant_notifications (merchant_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_merchant_notifications_merchant_event
  ON merchant_notifications (merchant_id, event_at DESC);

-- ระบบเดิมบางฐานข้อมูลสร้าง source_type เป็น PostgreSQL enum จึงเพิ่มค่า
-- ที่ backend ใช้โดยไม่เปลี่ยนข้อมูลเก่า; ถ้าเป็น TEXT จะไม่มีผล
DO $$
DECLARE
  enum_schema TEXT;
  enum_name TEXT;
  enum_value TEXT;
BEGIN
  SELECT type_namespace.nspname, source_type.typname
    INTO enum_schema, enum_name
  FROM pg_attribute column_definition
  JOIN pg_class notification_table
    ON notification_table.oid = column_definition.attrelid
  JOIN pg_type source_type
    ON source_type.oid = column_definition.atttypid
  JOIN pg_namespace type_namespace
    ON type_namespace.oid = source_type.typnamespace
  WHERE notification_table.relname = 'merchant_notifications'
    AND column_definition.attname = 'source_type'
    AND column_definition.attnum > 0
    AND NOT column_definition.attisdropped
    AND source_type.typtype = 'e';

  IF enum_name IS NOT NULL THEN
    FOREACH enum_value IN ARRAY ARRAY['payment_verified', 'payment_issue']
    LOOP
      EXECUTE format(
        'ALTER TYPE %I.%I ADD VALUE IF NOT EXISTS %L',
        enum_schema,
        enum_name,
        enum_value
      );
    END LOOP;
  END IF;
END $$;

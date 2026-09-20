-- สถานะระงับบัญชีจาก Admin แยกจากข้อมูลต้นทาง customer/merchant
CREATE TABLE IF NOT EXISTS public.account_suspensions (
  account_type TEXT NOT NULL CHECK (account_type IN ('customer', 'merchant')),
  account_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ระงับบัญชี', 'ใช้งานปกติ')),
  reason TEXT NOT NULL,
  changed_by TEXT,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_type, account_id)
);

CREATE TABLE IF NOT EXISTS public.account_status_events (
  event_id TEXT PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('customer', 'merchant')),
  account_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ระงับบัญชี', 'ใช้งานปกติ')),
  reason TEXT NOT NULL,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_suspensions_status_idx
  ON public.account_suspensions (account_type, status);

ALTER TABLE public.account_suspensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_status_events ENABLE ROW LEVEL SECURITY;

-- merchant_notifications เคยถูกสร้างด้วยชนิด ENUM ในบางสภาพแวดล้อม
-- เปลี่ยนเป็น text เพื่อรองรับชนิด account_suspended โดยคงข้อมูลเดิมทั้งหมด
DO $$
BEGIN
  IF to_regclass('public.merchant_notifications') IS NOT NULL THEN
    ALTER TABLE public.merchant_notifications
      ALTER COLUMN source_type TYPE TEXT USING source_type::TEXT;
  END IF;
END $$;

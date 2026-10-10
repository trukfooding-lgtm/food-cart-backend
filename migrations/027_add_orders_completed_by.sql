-- ใครปิดออเดอร์: merchant = ร้านกดส่งมอบ, auto = ระบบปิดอัตโนมัติ, customer = ลูกค้ายืนยัน
-- ใช้แยกรายได้จริง (ไม่นับออเดอร์ที่ระบบปิดอัตโนมัติ)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_by TEXT NULL;

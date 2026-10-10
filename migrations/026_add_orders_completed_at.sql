-- เก็บเวลาส่งมอบจริงของออเดอร์ ใช้คำนวณเวลาเตรียมอาหารที่เรียนรู้จากการขายจริง
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

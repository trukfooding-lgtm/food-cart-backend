CREATE TABLE IF NOT EXISTS customer_merchant_points (
  customer_id INTEGER NOT NULL REFERENCES customer(customer_id) ON DELETE CASCADE,
  merchant_id INTEGER NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS customer_point_transactions (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customer(customer_id) ON DELETE CASCADE,
  merchant_id INTEGER NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  order_id INTEGER NULL REFERENCES orders(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('EARN', 'REDEEM', 'REFUND')),
  points INTEGER NOT NULL CHECK (points > 0),
  amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_point_transactions_customer
  ON customer_point_transactions (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_point_transactions_order
  ON customer_point_transactions (order_id, type);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS original_total NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_total NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS loyalty_rate_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS points_refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS points_awarded_at TIMESTAMPTZ;

UPDATE orders
SET
  original_total = COALESCE(original_total, total_price),
  final_total = COALESCE(final_total, total_price)
WHERE original_total IS NULL
   OR final_total IS NULL;

ALTER TABLE orders
  ALTER COLUMN original_total SET DEFAULT 0,
  ALTER COLUMN final_total SET DEFAULT 0;

ALTER TABLE customer_merchant_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_point_transactions ENABLE ROW LEVEL SECURITY;

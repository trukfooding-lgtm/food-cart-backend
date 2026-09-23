CREATE TABLE IF NOT EXISTS merchant_loyalty_settings (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchant(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  baht_per_point INTEGER NOT NULL DEFAULT 50 CHECK (baht_per_point > 0),
  points_for_discount INTEGER NOT NULL DEFAULT 100 CHECK (points_for_discount > 0),
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 10.00 CHECK (discount_amount > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE merchant_loyalty_settings ENABLE ROW LEVEL SECURITY;

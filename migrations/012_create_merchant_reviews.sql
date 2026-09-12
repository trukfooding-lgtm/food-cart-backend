CREATE TABLE IF NOT EXISTS merchant_reviews (
  id INT NOT NULL AUTO_INCREMENT,
  review_id INT NOT NULL,
  order_id INT NOT NULL,
  merchant_id INT NOT NULL,
  customer_id INT NOT NULL,
  customer_name VARCHAR(255) NULL,
  rating INT NOT NULL,
  comment TEXT NULL,
  images LONGTEXT NULL,
  reviewed_at TIMESTAMP NULL,
  synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_merchant_review (merchant_id, review_id),
  KEY idx_merchant_reviews_merchant (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

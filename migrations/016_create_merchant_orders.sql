CREATE TABLE IF NOT EXISTS merchant_orders (
  id INT NOT NULL AUTO_INCREMENT,
  source_order_id INT NOT NULL,
  merchant_id INT NOT NULL,
  customer_id INT NOT NULL,
  customer_name VARCHAR(255) NULL,
  items_summary TEXT NULL,
  total_price DECIMAL(10,2) NOT NULL,
  merchant_status ENUM('ใหม่', 'กำลังปรุง', 'รอรับสินค้า', 'เสร็จสิ้น', 'ยกเลิก') NOT NULL DEFAULT 'ใหม่',
  prep_minutes INT NULL,
  reject_reason TEXT NULL,
  rejected_at DATETIME NULL,
  ordered_at DATETIME NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_merchant_source_order (merchant_id, source_order_id),
  KEY idx_merchant_orders_status (merchant_id, merchant_status, ordered_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

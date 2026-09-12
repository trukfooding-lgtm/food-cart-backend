CREATE TABLE IF NOT EXISTS merchant_issue_reports (
  id INT NOT NULL AUTO_INCREMENT,
  merchant_id INT NOT NULL,
  issue_type VARCHAR(100) NOT NULL,
  order_reference VARCHAR(100) NULL,
  details TEXT NOT NULL,
  image_url TEXT NULL,
  status ENUM('รอตรวจสอบ', 'กำลังตรวจสอบ', 'แก้ไขแล้ว') NOT NULL DEFAULT 'รอตรวจสอบ',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_merchant_reports_merchant (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

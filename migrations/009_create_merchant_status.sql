CREATE TABLE IF NOT EXISTS merchant_status (
  merchant_id INT NOT NULL,
  status ENUM('เปิดร้าน', 'กำลังย้าย', 'ปิดร้าน') NOT NULL DEFAULT 'ปิดร้าน',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

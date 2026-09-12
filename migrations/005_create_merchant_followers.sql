-- ตารางผู้ติดตามสำหรับฝั่งร้านค้าโดยเฉพาะ
-- ไม่แก้ไขโครงสร้างหรือข้อมูลของ followed และ customer
DROP VIEW IF EXISTS merchant_followers;

CREATE TABLE IF NOT EXISTS merchant_followers (
  id INT NOT NULL AUTO_INCREMENT,
  merchant_id INT NOT NULL,
  customer_id INT NOT NULL,
  username VARCHAR(255) NULL,
  name_surname VARCHAR(255) NULL,
  email VARCHAR(255) NULL,
  followed_at TIMESTAMP NULL,
  synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_merchant_customer (merchant_id, customer_id),
  KEY idx_merchant_followers_merchant (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

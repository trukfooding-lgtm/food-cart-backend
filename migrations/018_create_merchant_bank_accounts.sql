CREATE TABLE IF NOT EXISTS merchant_bank_accounts (
  id INT NOT NULL AUTO_INCREMENT,
  merchant_id INT NOT NULL,
  bank_code VARCHAR(10) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_number VARCHAR(30) NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_merchant_bank_account (merchant_id, bank_code, account_number),
  KEY idx_merchant_bank_accounts_merchant (merchant_id, is_primary)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

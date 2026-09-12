ALTER TABLE merchant_bank_accounts
  ADD COLUMN payment_type VARCHAR(20) NOT NULL DEFAULT 'BANK_ACCOUNT' AFTER merchant_id,
  MODIFY COLUMN bank_code VARCHAR(10) NULL,
  MODIFY COLUMN account_name VARCHAR(255) NULL,
  MODIFY COLUMN account_number VARCHAR(30) NULL,
  ADD COLUMN promptpay_type VARCHAR(20) NULL AFTER account_number,
  ADD COLUMN promptpay_id VARCHAR(30) NULL AFTER promptpay_type,
  ADD COLUMN receiver_name VARCHAR(255) NULL AFTER promptpay_id,
  ADD UNIQUE KEY uq_merchant_promptpay
    (merchant_id, payment_type, promptpay_type, promptpay_id);

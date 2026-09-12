CREATE TABLE IF NOT EXISTS merchant_notifications (
  id INT NOT NULL AUTO_INCREMENT,
  merchant_id INT NOT NULL,
  source_type ENUM('order', 'follower', 'review') NOT NULL,
  source_id VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  event_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_merchant_notification_source (merchant_id, source_type, source_id),
  KEY idx_merchant_notifications_merchant (merchant_id, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

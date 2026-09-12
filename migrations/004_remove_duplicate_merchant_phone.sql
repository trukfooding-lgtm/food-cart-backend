UPDATE merchant
SET store_phone = phone
WHERE (store_phone IS NULL OR store_phone = '')
  AND phone IS NOT NULL
  AND phone <> '';

ALTER TABLE merchant
  DROP COLUMN IF EXISTS phone;

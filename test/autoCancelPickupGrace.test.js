const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../migrations/029_add_pickup_grace_before_auto_cancel.sql'),
  'utf8'
);
const merchantRoutes = fs.readFileSync(
  path.join(__dirname, '../routes/merchants.js'),
  'utf8'
);

test('auto-cancel waits until the store session ends and the ready time is at least 15 minutes old', () => {
  assert.match(migration, /selling_ends_at <= CURRENT_TIMESTAMP/);
  assert.match(migration, /merchant_status = 'รอรับสินค้า'/);
  assert.match(migration, /updated_at <= CURRENT_TIMESTAMP - INTERVAL '15 minutes'/);
});

test('merchant status updates record the time used by the pickup grace check', () => {
  assert.match(
    merchantRoutes,
    /UPDATE merchant_orders\s+SET\s+merchant_status = \$1,\s+updated_at = NOW\(\)/
  );
});

test('migration preserves the existing cron job and database tables', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.expire_merchant_sessions_and_cancel_uncollected_orders/);
  assert.doesNotMatch(migration, /cron\.(schedule|unschedule)/);
  assert.doesNotMatch(migration, /CREATE TABLE|ALTER TABLE|DROP TABLE/);
});

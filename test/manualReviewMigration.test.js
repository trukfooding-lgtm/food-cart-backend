const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../migrations/030_allow_manual_review_order_slips.sql'),
  'utf8'
);

test('order slip status constraint preserves current values and permits manual review', () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS order_slips_status_chk/);
  assert.match(
    migration,
    /CHECK\s*\(status IN \('PENDING',\s*'VERIFIED',\s*'REJECTED',\s*'MANUAL_REVIEW'\)\)/
  );
});

test('manual review migration changes only the order slip status constraint', () => {
  assert.match(migration, /ALTER TABLE public\.order_slips/);
  assert.doesNotMatch(migration, /CREATE TABLE|DROP TABLE|UPDATE\s+public\./i);
  assert.match(migration, /\nBEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
});

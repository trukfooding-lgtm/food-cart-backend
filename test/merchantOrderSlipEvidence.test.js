const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('merchant order API exposes latest slip status and evidence presence', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'merchants.js'),
    'utf8',
  );

  assert.match(source, /latest_slip\.status AS latest_slip_status/);
  assert.match(source, /latest_slip\.created_at AS latest_slip_created_at/);
  assert.match(source, /\(latest_slip\.created_at IS NOT NULL\) AS has_payment_slip/);
  assert.match(source, /SELECT os\.status, os\.created_at[\s\S]*?FROM order_slips os/);
});

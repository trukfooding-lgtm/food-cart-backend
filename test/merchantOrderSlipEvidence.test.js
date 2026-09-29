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

test('merchant notification API keeps payment source IDs compatible with order lookup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'merchants.js'),
    'utf8',
  );

  assert.match(
    source,
    /WHEN source_type = 'payment_issue' AND source_id LIKE '%:slip:%'[\s\S]*?THEN split_part\(source_id, ':slip:', 1\)[\s\S]*?END AS source_id/,
  );
});

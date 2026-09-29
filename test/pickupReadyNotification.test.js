const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildPickupReadyNotificationBody,
  getPickupReadyNotificationBody,
  formatBangkokDeadline
} = require('../services/pickupReadyNotification');

const notificationService = fs.readFileSync(
  path.join(__dirname, '../services/pickupReadyNotification.js'),
  'utf8'
);

test('formats pickup deadline in Bangkok time and warns about cancellation and refunds', () => {
  const body = buildPickupReadyNotificationBody(
    123,
    new Date('2026-09-29T05:30:00.000Z')
  );

  assert.match(body, /ออเดอร์ #123/);
  assert.match(body, /12:30 น\./);
  assert.match(body, /อาจถูกยกเลิก/);
  assert.match(body, /ไม่คืนเงินอัตโนมัติ/);
  assert.match(body, /หากร้านเก็บอาหารไว้ โปรดติดต่อร้าน/);
});

test('uses a store-contact fallback when no selling-end deadline is available', () => {
  assert.equal(formatBangkokDeadline(null), null);

  const body = buildPickupReadyNotificationBody(456, null);
  assert.match(body, /ออเดอร์ #456/);
  assert.match(body, /ติดต่อร้านเพื่อยืนยันเวลารับ/);
  assert.doesNotMatch(body, /รับก่อน \d{2}:\d{2}/);
  assert.match(body, /ไม่คืนเงินอัตโนมัติ/);
});

test('queries the exact later-of-store-close-or-15-minute deadline used by auto-cancel', async () => {
  assert.match(
    notificationService,
    /GREATEST\(\s*ms\.selling_ends_at,\s*mo\.updated_at \+ INTERVAL '15 minutes'\s*\)/
  );

  let requestedValues;
  const body = await getPickupReadyNotificationBody(
    {
      query: async (_sql, values) => {
        requestedValues = values;
        return { rows: [{ pickup_deadline: new Date('2026-09-29T05:45:00.000Z') }] };
      }
    },
    9,
    321
  );

  assert.deepEqual(requestedValues, [9, 321]);
  assert.match(body, /12:45 น\./);
});

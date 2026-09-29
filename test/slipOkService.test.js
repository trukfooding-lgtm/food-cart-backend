const test = require('node:test');
const assert = require('node:assert/strict');
const {
  verifySlipWithSlipOk,
  validateSlipTransactionTime
} = require('../backend_payment_module/services/slipOkService');

const paymentWindow = {
  paymentWindowStart: '2026-09-30T03:00:00.000Z',
  paymentDeadline: '2026-09-30T03:05:00.000Z',
  now: '2026-09-30T03:02:00.000Z'
};

function validSlipData(overrides = {}) {
  return {
    success: true,
    amount: 25,
    transRef: 'TX-UNIQUE-123',
    transTimestamp: '2026-09-30T03:01:00.000Z',
    receiver: { account: { value: 'xxx-x-x1234-x' } },
    ...overrides
  };
}

function fetchForSlip(data) {
  const replies = [
    { success: true, data: { quota: 100, overQuota: 0 } },
    { success: true, data }
  ];
  return async () => ({
    ok: true,
    json: async () => replies.shift()
  });
}

test('accepts an authentic slip only when its timestamp is inside the order payment window', async () => {
  const result = await verifySlipWithSlipOk({
    buffer: Buffer.from('slip'),
    expectedAmount: 25,
    merchant: { recipientIdentifiers: ['1234'] },
    ...paymentWindow,
    env: { SLIPOK_API_KEY: 'test-key', SLIPOK_BRANCH_ID: 'test-branch' },
    fetchImpl: fetchForSlip(validSlipData())
  });

  assert.equal(result.verified, true);
  assert.equal(result.transactionId, 'TX-UNIQUE-123');
});

test('rejects a genuine old transfer made before the current order was created', async () => {
  const result = await verifySlipWithSlipOk({
    buffer: Buffer.from('old slip'),
    expectedAmount: 25,
    merchant: { recipientIdentifiers: ['1234'] },
    ...paymentWindow,
    env: { SLIPOK_API_KEY: 'test-key', SLIPOK_BRANCH_ID: 'test-branch' },
    fetchImpl: fetchForSlip(validSlipData({ transTimestamp: '2026-09-30T02:59:59.000Z' }))
  });

  assert.equal(result.verified, false);
  assert.equal(result.manualReview, false);
  assert.equal(result.ocrStatus, 'REJECTED');
  assert.match(result.reason, /ก่อนสร้างคำสั่งซื้อ/);
});

test('rejects a transfer after the order payment deadline', () => {
  const result = validateSlipTransactionTime(
    { transTimestamp: '2026-09-30T03:05:01.000Z' },
    paymentWindow
  );

  assert.equal(result.valid, false);
  assert.equal(result.manualReview, false);
  assert.match(result.reason, /เกินกำหนดชำระ/);
});

test('sends a response without a usable transaction timestamp to merchant review, never auto-approves it', async () => {
  const result = await verifySlipWithSlipOk({
    buffer: Buffer.from('timestamp missing'),
    expectedAmount: 25,
    merchant: { recipientIdentifiers: ['1234'] },
    ...paymentWindow,
    env: { SLIPOK_API_KEY: 'test-key', SLIPOK_BRANCH_ID: 'test-branch' },
    fetchImpl: fetchForSlip(validSlipData({ transTimestamp: undefined }))
  });

  assert.equal(result.verified, false);
  assert.equal(result.manualReview, true);
  assert.equal(result.ocrStatus, 'MANUAL_REVIEW');
});

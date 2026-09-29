const test = require('node:test');
const assert = require('node:assert/strict');
const { getPaymentSlipUrl } = require('../backend_payment_module/services/slipStorageService');

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
};

test('converts an existing private-bucket slip reference into a fetchable signed URL', async () => {
  let requestUrl;
  const signedUrl = await getPaymentSlipUrl(
    'storage://payment-slips/234/order-234-proof.jpg',
    {
      env,
      fetchImpl: async (url, options) => {
        requestUrl = url;
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
        return {
          ok: true,
          status: 200,
          json: async () => ({ signedURL: '/object/sign/payment-slips/234/order-234-proof.jpg?token=abc' }),
        };
      },
    },
  );

  assert.equal(
    requestUrl,
    'https://example.supabase.co/storage/v1/object/sign/payment-slips/234/order-234-proof.jpg',
  );
  assert.equal(
    signedUrl,
    'https://example.supabase.co/storage/v1/object/sign/payment-slips/234/order-234-proof.jpg?token=abc',
  );
});

test('leaves external legacy URLs unchanged and rejects a different private bucket', async () => {
  assert.equal(
    await getPaymentSlipUrl('https://legacy.example/slip.jpg'),
    'https://legacy.example/slip.jpg',
  );
  await assert.rejects(
    getPaymentSlipUrl('storage://other-bucket/234/slip.jpg', { env }),
    /ไม่อนุญาตให้อ่านสลิปจาก bucket อื่น/,
  );
});

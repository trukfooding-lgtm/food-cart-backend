const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let slips = [];
let orderCustomerId = 17;
let calls = [];
let notifications = [];
let slipOkState = 'not-configured';
let slipOkResult;
let failMerchantNotification = false;
let deletedSlipLocations = [];
let orderDetailsResult = {
  id: 42,
  customer_order_status: 'รอชำระเงิน',
  merchant_status: 'รอชำระเงิน',
  latest_slip_status: 'MANUAL_REVIEW'
};

const pool = {
  async connect() {
    return {
      async query(sql, values = []) {
        calls.push({ sql, values });
        if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) {
          return { rows: [{ id: 42, customer_id: orderCustomerId, merchant_id: 8,
            total_price: 25, status: 'รอชำระเงิน', payment_deadline: null }] };
        }
        if (sql.includes('SELECT id, order_id FROM order_slips')) return { rows: [] };
        if (sql.includes('FROM order_slips') && sql.includes("uploader_type = 'CUSTOMER'")) {
          return { rows: slips.length ? [{ id: slips.at(-1).id, status: slips.at(-1).status }] : [] };
        }
        if (sql.includes('INSERT INTO order_slips')) {
          slips.push({ id: slips.length + 1, status: values[6], transaction_id: values[9] });
        }
        if (sql.includes("SET status = 'MANUAL_REVIEW'")) slips.at(-1).status = 'MANUAL_REVIEW';
        return { rows: [] };
      },
      release() {}
    };
  },
  async query(sql, values = []) {
    calls.push({ sql, values });
    return sql.includes('AS latest_slip_status')
      ? { rows: [orderDetailsResult] }
      : { rows: [] };
  }
};

const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
const storagePath = require.resolve('../backend_payment_module/services/slipStorageService');
require.cache[storagePath] = {
  id: storagePath, filename: storagePath, loaded: true,
  exports: {
    SlipStorageError: class SlipStorageError extends Error {},
    uploadPaymentSlip: async ({ orderId, fileName }) => `storage://payment-slips/${orderId}/${fileName}`,
    getPaymentSlipUrl: async location => location,
    deletePaymentSlip: async location => deletedSlipLocations.push(location)
  }
};
const notificationPath = require.resolve('../services/merchant_push_notification');
require.cache[notificationPath] = {
  id: notificationPath, filename: notificationPath, loaded: true,
  exports: {
    sendMerchantNotification: async item => {
      if (failMerchantNotification) throw new Error('push provider unavailable');
      notifications.push(item);
    }
  }
};

const layers = [];
const mockRouter = {
  stack: layers,
  get(path, ...handlers) { layers.push({ route: { path, stack: handlers.map(handle => ({ handle })) } }); },
  post(path, ...handlers) { layers.push({ route: { path, stack: handlers.map(handle => ({ handle })) } }); },
  put(path, ...handlers) { layers.push({ route: { path, stack: handlers.map(handle => ({ handle })) } }); }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express') return { Router: () => mockRouter };
  if (request === 'multer') {
    const multer = () => ({ single: () => (_req, _res, next) => next?.() });
    multer.memoryStorage = () => ({});
    multer.diskStorage = () => ({});
    return multer;
  }
  if (request.endsWith('/services/slipOkService')) {
    return {
      getSlipOkConfigState: () => slipOkState,
      verifySlipWithSlipOk: async () => slipOkResult
    };
  }
  if (request === 'firebase-admin/app') {
    return { initializeApp() {}, cert: value => value, getApps: () => [{}] };
  }
  if (request === 'firebase-admin/messaging') return { getMessaging: () => ({}) };
  if (request.endsWith('/services/menuImageStorageService')) {
    return { uploadMenuImage: async () => null };
  }
  if (request.endsWith('/services/account_status')) {
    return { getActiveSuspension: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const router = require('../backend_payment_module/routes/paymentRoutes');
require('../routes/orders');
Module._load = originalLoad;

function handlerFor(path) {
  const route = router.stack.find(layer => layer.route?.path === path)?.route;
  assert.ok(route, `route ${path} should exist`);
  return route.stack.at(-1).handle;
}

async function invoke(handler, req) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler(req, res);
  return res;
}

function reset() {
  slips = [];
  orderCustomerId = 17;
  calls = [];
  notifications = [];
  failMerchantNotification = false;
  deletedSlipLocations = [];
  slipOkState = 'not-configured';
  slipOkResult = undefined;
  orderDetailsResult = {
    id: 42,
    customer_order_status: 'รอชำระเงิน',
    merchant_status: 'รอชำระเงิน',
    latest_slip_status: 'MANUAL_REVIEW'
  };
}

test('SlipOK unavailable saves evidence for merchant review and never marks order paid', async () => {
  reset();
  const response = await invoke(handlerFor('/orders/:orderId/payment-slip'), {
    params: { orderId: '42' }, body: {},
    file: { buffer: Buffer.from('slip'), mimetype: 'image/jpeg' }
  });
  assert.equal(response.body.status, 'MANUAL_REVIEW');
  assert.equal(slips[0].status, 'MANUAL_REVIEW');
  assert.ok(!calls.some(call => call.sql.includes("SET status = 'ชำระเงินแล้ว'")));
  assert.ok(!calls.some(call => call.sql.includes('UPDATE orders')));
});

test('merchant notification failure does not delete a committed manual-review slip', async () => {
  reset();
  failMerchantNotification = true;
  const response = await invoke(handlerFor('/orders/:orderId/payment-slip'), {
    params: { orderId: '42' }, body: {},
    file: { buffer: Buffer.from('slip-proof'), mimetype: 'image/jpeg' }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'MANUAL_REVIEW');
  assert.equal(slips[0].status, 'MANUAL_REVIEW');
  assert.equal(deletedSlipLocations.length, 0);
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('SlipOK approval marks the customer order paid and starts merchant preparation', async () => {
  reset();
  slipOkState = 'configured';
  slipOkResult = {
    verified: true,
    manualReview: false,
    detectedAmount: 25,
    transactionId: 'SLIPOK-APPROVED-42',
    ocrStatus: 'VERIFIED',
    ocrText: '{"provider":"SlipOK"}',
    reason: 'SlipOK ยืนยันยอดและบัญชีผู้รับแล้ว'
  };

  const response = await invoke(handlerFor('/orders/:orderId/payment-slip'), {
    params: { orderId: '42' }, body: {},
    file: { buffer: Buffer.from('approved-slip'), mimetype: 'image/jpeg' }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'VERIFIED');
  assert.equal(response.body.transactionId, 'SLIPOK-APPROVED-42');
  assert.equal(slips[0].status, 'VERIFIED');
  assert.ok(calls.some(call => call.sql.includes("SET status = 'ชำระเงินแล้ว'")));
  assert.ok(calls.some(call => call.sql.includes("SET merchant_status = 'กำลังปรุง'")));
});

test('SlipOK rejection records rejected evidence without changing order status', async () => {
  reset();
  slipOkState = 'configured';
  slipOkResult = {
    verified: false,
    manualReview: false,
    detectedAmount: 24,
    transactionId: 'SLIPOK-REJECTED-42',
    ocrStatus: 'REJECTED',
    ocrText: '{"provider":"SlipOK"}',
    reason: 'ยอดเงินไม่ตรงกับคำสั่งซื้อ'
  };

  const response = await invoke(handlerFor('/orders/:orderId/payment-slip'), {
    params: { orderId: '42' }, body: {},
    file: { buffer: Buffer.from('rejected-slip'), mimetype: 'image/jpeg' }
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.status, 'REJECTED');
  assert.equal(slips[0].status, 'REJECTED');
  assert.ok(!calls.some(call => call.sql.includes('UPDATE orders')));
  assert.ok(!calls.some(call => call.sql.includes('UPDATE merchant_orders')));
});

test('customer may request review only for their own order with an uploaded slip', async () => {
  reset();
  const handler = handlerFor('/orders/:orderId/payment-slip/request-review');
  let response = await invoke(handler, { params: { orderId: '42' }, body: { customerId: 17 } });
  assert.equal(response.statusCode, 409);

  slips = [{ id: 9, status: 'REJECTED' }];
  orderCustomerId = 18;
  response = await invoke(handler, { params: { orderId: '42' }, body: { customerId: 17 } });
  assert.equal(response.statusCode, 404);
  assert.equal(slips[0].status, 'REJECTED');

  orderCustomerId = 17;
  response = await invoke(handler, { params: { orderId: '42' }, body: { customerId: 17 } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'MANUAL_REVIEW');
  assert.ok(!calls.some(call => call.sql.includes('UPDATE orders')));
  assert.ok(!calls.some(call => call.sql.includes('UPDATE merchant_orders')));
  assert.equal(notifications.at(-1).title, 'ลูกค้าขอให้ตรวจสอบสลิป');
});

test('customer cannot change a verified slip to manual review', async () => {
  reset();
  slips = [{ id: 10, status: 'VERIFIED' }];
  const response = await invoke(handlerFor('/orders/:orderId/payment-slip/request-review'), {
    params: { orderId: '42' }, body: { customerId: 17 }
  });
  assert.equal(response.statusCode, 409);
  assert.equal(slips[0].status, 'VERIFIED');
});

test('order detail exposes latest slip review without replacing order or merchant status', async () => {
  reset();
  const response = await invoke(handlerFor('/:id'), { params: { id: '42' } });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.latest_slip_status, 'MANUAL_REVIEW');
  assert.equal(response.body.data.customer_order_status, 'รอชำระเงิน');
  assert.equal(response.body.data.merchant_status, 'รอชำระเงิน');
  const orderQuery = calls.find(call => call.sql.includes('AS latest_slip_status'))?.sql || '';
  assert.match(orderQuery, /uploader_type = 'CUSTOMER'/);
  assert.match(orderQuery, /ORDER BY os\.created_at DESC, os\.id DESC/);
});

test('payment route is mounted before the orders catch-all route', () => {
  const server = require('node:fs').readFileSync(require.resolve('../server'), 'utf8');
  assert.ok(server.indexOf("app.use('/api', paymentRoutes)") < server.indexOf("app.use('/api/orders', ordersRoutes)"));
});

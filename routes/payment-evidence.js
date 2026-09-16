const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const { pool } = require('../config/db');
const { requireAccessToken } = require('../config/access-token');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpeg|webp)$/.test(file.mimetype));
  },
});

const bucket = process.env.PAYMENT_EVIDENCE_BUCKET || 'payment-evidence';

function config() {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!baseUrl || !serviceKey) {
    const error = new Error('ยังไม่ได้ตั้งค่า Supabase Storage ใน Backend');
    error.status = 503;
    throw error;
  }
  return { baseUrl, serviceKey };
}

function storagePath(pathname) {
  return pathname.split('/').map(encodeURIComponent).join('/');
}

async function uploadToStorage(file, objectPath) {
  const { baseUrl, serviceKey } = config();
  const response = await fetch(
    `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${storagePath(objectPath)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': file.mimetype,
        'x-upsert': 'false',
      },
      body: file.buffer,
    }
  );

  if (!response.ok) {
    const message = await response.text();
    const error = new Error(`อัปโหลดหลักฐานไม่สำเร็จ: ${message}`);
    error.status = 502;
    throw error;
  }
}

async function streamFromStorage(objectPath, res) {
  const { baseUrl, serviceKey } = config();
  const response = await fetch(
    `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${storagePath(objectPath)}`,
    { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
  );

  if (!response.ok || !response.body) {
    return res.status(404).json({ success: false, message: 'ไม่พบหลักฐาน' });
  }

  res.set('Content-Type', response.headers.get('content-type') || 'image/*');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', 'inline');
  const reader = response.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function integerId(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : null;
}

function ensureActor(req, type, id) {
  return req.actor && req.actor.type === type && String(req.actor.id) === String(id);
}

function objectPath(type, actorId, orderId, file) {
  const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
  return type === 'CUSTOMER'
    ? `customers/${actorId}/orders/${orderId}/${randomUUID()}${ext}`
    : `merchants/${actorId}/refunds/${orderId}/${randomUUID()}${ext}`;
}

async function orderForActor(orderId, actor) {
  const { rows } = await pool.query(
    'SELECT id, customer_id, merchant_id FROM orders WHERE id = $1',
    [orderId]
  );
  if (!rows.length) return null;
  const order = rows[0];
  if (actor.type === 'CUSTOMER' && String(order.customer_id) !== String(actor.id)) return null;
  if (actor.type === 'MERCHANT' && String(order.merchant_id) !== String(actor.id)) return null;
  return order;
}

router.get('/customers/:customerId/bank-accounts', requireAccessToken, async (req, res) => {
  const customerId = integerId(req.params.customerId);
  if (!customerId || !ensureActor(req, 'CUSTOMER', customerId)) {
    return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูข้อมูลนี้' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, customer_id, payment_type, bank_code, account_name,
              account_number, promptpay_type, promptpay_id, receiver_name,
              is_primary, is_verified, created_at, updated_at
       FROM customer_bank_accounts
       WHERE customer_id = $1
       ORDER BY is_primary DESC, id ASC`,
      [customerId]
    );
    res.json({ success: true, accounts: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'ดึงบัญชีไม่สำเร็จ' });
  }
});

router.put('/customers/:customerId/bank-accounts/:accountId/primary', requireAccessToken, async (req, res) => {
  const customerId = integerId(req.params.customerId);
  const accountId = integerId(req.params.accountId);
  if (!customerId || !accountId || !ensureActor(req, 'CUSTOMER', customerId)) {
    return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์แก้ไขข้อมูลนี้' });
  }

  try {
    const result = await pool.query(
      `UPDATE customer_bank_accounts
       SET is_primary = TRUE, updated_at = NOW()
       WHERE customer_id = $1 AND id = $2`,
      [customerId, accountId]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'ไม่พบบัญชี' });
    res.json({ success: true, message: 'ตั้งเป็นบัญชีหลักแล้ว' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'อัปเดตบัญชีไม่สำเร็จ' });
  }
});

async function saveSlip(req, res, type) {
  const orderId = integerId(req.params.orderId);
  if (!orderId || !req.actor || !['CUSTOMER', 'MERCHANT'].includes(type)) {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  }
  const order = await orderForActor(orderId, req.actor);
  if (!order) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์กับออเดอร์นี้' });
  if (!req.file) return res.status(400).json({ success: false, message: 'กรุณาแนบรูปสลิป' });

  const amount = req.body.amount === undefined || req.body.amount === ''
    ? null
    : Number(req.body.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    return res.status(400).json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });
  }

  const objectPathValue = objectPath(type, req.actor.id, orderId, req.file);
  await uploadToStorage(req.file, objectPathValue);

  const note = type === 'MERCHANT' ? (req.body.note || 'คืนเงินลูกค้า') : (req.body.note || null);
  const { rows } = await pool.query(
    `INSERT INTO order_slips
       (order_id, uploader_type, uploader_id, slip_url, amount, transfer_time, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, order_id, uploader_type, uploader_id, amount, transfer_time, status, note, created_at`,
    [String(orderId), type, Number(req.actor.id), objectPathValue, amount, req.body.transfer_time || null, note]
  );

  res.status(201).json({ success: true, slip: rows[0] });
}

router.post('/orders/:orderId/payment-slip', requireAccessToken, upload.single('slip'), async (req, res) => {
  try {
    if (req.actor.type !== 'CUSTOMER') return res.status(403).json({ success: false, message: 'เฉพาะลูกค้าเท่านั้น' });
    await saveSlip(req, res, 'CUSTOMER');
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message || 'บันทึกสลิปไม่สำเร็จ' });
  }
});

router.post('/orders/:orderId/refund-slip', requireAccessToken, upload.single('slip'), async (req, res) => {
  try {
    if (req.actor.type !== 'MERCHANT') return res.status(403).json({ success: false, message: 'เฉพาะร้านค้าเท่านั้น' });
    await saveSlip(req, res, 'MERCHANT');
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message || 'บันทึกสลิปไม่สำเร็จ' });
  }
});

router.get('/orders/:orderId/slips', requireAccessToken, async (req, res) => {
  const orderId = integerId(req.params.orderId);
  if (!orderId) return res.status(400).json({ success: false, message: 'รหัสออเดอร์ไม่ถูกต้อง' });
  try {
    const order = await orderForActor(orderId, req.actor);
    if (!order) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูข้อมูลนี้' });
    const { rows } = await pool.query(
      `SELECT id, order_id, uploader_type, uploader_id, amount,
              transfer_time, status, note, created_at
       FROM order_slips WHERE order_id = $1 ORDER BY id ASC`,
      [String(orderId)]
    );
    res.json({ success: true, slips: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: 'ดึงหลักฐานไม่สำเร็จ' });
  }
});

router.get('/orders/:orderId/slips/:slipId/view', requireAccessToken, async (req, res) => {
  const orderId = integerId(req.params.orderId);
  const slipId = integerId(req.params.slipId);
  if (!orderId || !slipId) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  try {
    const order = await orderForActor(orderId, req.actor);
    if (!order) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูข้อมูลนี้' });
    const { rows } = await pool.query(
      'SELECT slip_url FROM order_slips WHERE id = $1 AND order_id = $2',
      [slipId, String(orderId)]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบหลักฐาน' });
    await streamFromStorage(rows[0].slip_url, res);
  } catch (error) {
    if (!res.headersSent) res.status(error.status || 500).json({ success: false, message: error.message || 'เปิดหลักฐานไม่สำเร็จ' });
  }
});

module.exports = router;

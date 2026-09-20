const crypto = require('crypto');
const { pool } = require('../config/db');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { sendMerchantNotification } = require('./merchant_push_notification');

let firebaseReady = false;

try {
  if (getApps().length === 0) {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;
    } else {
      serviceAccount = require('../serviceAccountKey.json');
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  firebaseReady = true;
} catch (error) {
  console.warn('Account status Firebase setup warning:', error.message);
}

const ACCOUNT_TYPES = new Set(['customer', 'merchant']);
const ACCOUNT_STATUSES = new Set(['ระงับบัญชี', 'ใช้งานปกติ']);

function normalizeAccount(account) {
  const userId = String(account?.user_id || '').trim();
  const role = String(account?.role || '').trim();
  const expectedPrefix = role === 'Shop' ? 'merchant:' : role === 'Customer' ? 'customer:' : '';
  const [prefix, rawId] = userId.split(':');
  const accountType = prefix || (role === 'Shop' ? 'merchant' : role === 'Customer' ? 'customer' : '');
  const accountId = Number(account?.account_id ?? rawId);
  if (!expectedPrefix || prefix !== expectedPrefix || !ACCOUNT_TYPES.has(accountType) || !Number.isInteger(accountId) || accountId <= 0) {
    throw new Error('ข้อมูลบัญชีไม่ถูกต้อง');
  }
  return {accountType, accountId};
}

function validateEvent(input) {
  const eventId = String(input?.event_id || '').trim();
  const status = String(input?.status || '').trim();
  const reason = String(input?.reason || '').trim();
  const changedBy = String(input?.changed_by || '').trim();
  if (!eventId || eventId.length > 160 || !/^[a-zA-Z0-9:_-]+$/.test(eventId)) throw new Error('รหัสเหตุการณ์ไม่ถูกต้อง');
  if (!ACCOUNT_STATUSES.has(status)) throw new Error('สถานะบัญชีไม่ถูกต้อง');
  if (reason.length < 5 || reason.length > 1000) throw new Error('เหตุผลบัญชีไม่ถูกต้อง');
  const account = normalizeAccount(input);
  return {eventId, status, reason, changedBy: changedBy.slice(0, 255), ...account};
}

async function sendCustomerPush(customerId, title, body, data = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT fcm_token FROM customer WHERE customer_id = $1`,
      [customerId]
    );
    const token = String(rows[0]?.fcm_token || '').trim();
    if (!token || !firebaseReady) return;
    await getMessaging().send({
      token,
      notification: {title, body},
      data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)]))
    });
  } catch (error) {
    console.warn('Account status customer push warning:', error.message);
  }
}

async function getActiveSuspension(accountType, accountId) {
  if (!ACCOUNT_TYPES.has(accountType) || !Number.isInteger(Number(accountId))) return null;
  const { rows } = await pool.query(
    `SELECT status, reason, status_changed_at
       FROM account_suspensions
      WHERE account_type = $1 AND account_id = $2 AND status = 'ระงับบัญชี'
      LIMIT 1`,
    [accountType, Number(accountId)]
  );
  return rows[0] || null;
}

async function applyAccountStatus(input) {
  const event = validateEvent(input);
  const client = await pool.connect();
  let duplicate = false;
  try {
    await client.query('BEGIN');

    const sourceTable = event.accountType === 'customer' ? 'customer' : 'merchant';
    const sourceColumn = event.accountType === 'customer' ? 'customer_id' : 'id';
    const source = await client.query(
      `SELECT ${sourceColumn} FROM ${sourceTable} WHERE ${sourceColumn} = $1 LIMIT 1`,
      [event.accountId]
    );
    if (!source.rows.length) throw new Error('ไม่พบบัญชีต้นทาง');

    const inserted = await client.query(
      `INSERT INTO account_status_events
        (event_id, account_type, account_id, status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.eventId, event.accountType, event.accountId, event.status, event.reason, event.changedBy || null]
    );
    if (!inserted.rows.length) {
      duplicate = true;
      await client.query('COMMIT');
      return {duplicate: true, status: event.status};
    }

    await client.query(
      `INSERT INTO account_suspensions
        (account_type, account_id, status, reason, changed_by, status_changed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (account_type, account_id)
       DO UPDATE SET status = EXCLUDED.status,
                     reason = EXCLUDED.reason,
                     changed_by = EXCLUDED.changed_by,
                     status_changed_at = NOW(),
                     updated_at = NOW()`,
      [event.accountType, event.accountId, event.status, event.reason, event.changedBy || null]
    );

    if (event.status === 'ระงับบัญชี') {
      const title = event.accountType === 'customer' ? 'บัญชีของคุณถูกระงับ' : 'บัญชีร้านค้าถูกระงับ';
      const body = `บัญชีถูกระงับเนื่องจาก: ${event.reason}`;
      if (event.accountType === 'customer') {
        await client.query(
          `INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)`,
          [event.accountId, title, body]
        );
      }
    }

    await client.query('COMMIT');

    if (event.status === 'ระงับบัญชี') {
      const title = event.accountType === 'customer' ? 'บัญชีของคุณถูกระงับ' : 'บัญชีร้านค้าถูกระงับ';
      const body = `บัญชีถูกระงับเนื่องจาก: ${event.reason}`;
      const data = {
        event_type: 'account_suspended',
        account_type: event.accountType,
        account_id: event.accountId,
        reason: event.reason
      };
      if (event.accountType === 'customer') {
        await sendCustomerPush(event.accountId, title, body, data);
      } else {
        await sendMerchantNotification({
          merchantId: event.accountId,
          sourceType: 'account_suspended',
          sourceId: event.eventId,
          title,
          message: body,
          data
        });
      }
    }

    return {duplicate, status: event.status};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function safeEqualSecret(received, expected) {
  const a = Buffer.from(String(received || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  applyAccountStatus,
  getActiveSuspension,
  safeEqualSecret
};

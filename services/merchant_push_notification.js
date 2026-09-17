const { pool } = require('../config/db');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

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

    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  firebaseReady = true;
} catch (error) {
  console.log('Merchant Firebase Admin setup warning:', error.message);
}

async function sendMerchantNotification({
  merchantId,
  sourceType,
  sourceId,
  title,
  message,
  data = {}
}) {
  try {
    const { rows: insertedNotifications } = await pool.query(
      `INSERT INTO merchant_notifications
        (
          merchant_id,
          source_type,
          source_id,
          title,
          message,
          event_at
        )
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT
         (merchant_id, source_type, source_id)
       DO NOTHING
       RETURNING id`,
      [
        merchantId,
        sourceType,
        String(sourceId),
        title,
        message
      ]
    );

    // รายการนี้ถูกบันทึกไว้แล้ว จึงไม่ยิง Push ซ้ำ
    if (insertedNotifications.length === 0) return;

    const { rows: merchants } = await pool.query(
      `SELECT fcm_token
       FROM merchant
       WHERE id = $1`,
      [merchantId]
    );

    const token = merchants[0]?.fcm_token;
    if (!token || !firebaseReady) return;

    const messageData = Object.fromEntries(
      Object.entries({
        recipient_type: 'merchant',
        merchant_id: String(merchantId),
        event_type: String(sourceType),
        source_id: String(sourceId),
        ...data
      }).map(([key, value]) => [key, String(value)])
    );

    await getMessaging().send({
      token,
      notification: {
        title,
        body: message
      },
      data: messageData
    });

    console.log(`Notification sent to merchant: ${merchantId}`);
  } catch (error) {
    // การแจ้งเตือนต้องไม่ทำให้การสั่งซื้อ ติดตาม หรือรีวิวล้มเหลว
    console.error('Merchant notification error:', error.message);
  }
}

module.exports = {
  sendMerchantNotification
};

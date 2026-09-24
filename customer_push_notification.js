const { pool } = require('../config/db');
const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

function getFirebaseMessaging() {
  const apps = getApps();
  if (apps.length > 0) return getMessaging(apps[0]);

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : process.env.FIREBASE_SERVICE_ACCOUNT
    : require('../serviceAccountKey.json');

  const app = initializeApp({ credential: cert(serviceAccount) });
  return getMessaging(app);
}

async function sendCustomerPushNotifications(customerIds, title, body) {
  const normalizedIds = [...new Set(
    (Array.isArray(customerIds) ? customerIds : [customerIds])
      .map(Number)
      .filter(id => Number.isInteger(id) && id > 0)
  )];

  if (normalizedIds.length === 0) return;

  try {
    const { rows } = await pool.query(
      `SELECT customer_id, fcm_token
       FROM customer
       WHERE customer_id = ANY($1::int[])
         AND NULLIF(BTRIM(fcm_token), '') IS NOT NULL`,
      [normalizedIds]
    );
    if (rows.length === 0) return;

    const messaging = getFirebaseMessaging();
    await Promise.all(rows.map(async customer => {
      try {
        await messaging.send({
          token: customer.fcm_token,
          notification: { title, body },
          data: { click_action: 'FLUTTER_NOTIFICATION_CLICK' }
        });
      } catch (error) {
        console.error(
          `Customer FCM send failed for customer ${customer.customer_id}:`,
          error.message
        );
      }
    }));
  } catch (error) {
    console.error('Customer FCM notification error:', error.message);
  }
}

module.exports = { sendCustomerPushNotifications };

// ==========================================================
// ระบบคิวและแจ้งเตือนลูกค้า (ชำระเงินหน้าร้าน)
// - getOrderQueueInfo: คิวที่ / เหลืออีกกี่คิว / ช่วงเวลาพร้อมรับของออเดอร์
// - notifyOrderAccepted: แจ้งลูกค้าตอนร้านรับออเดอร์ (คิวที่ + ช่วงเวลา)
// - notifyQueueAfterCompletion: แจ้งลูกค้าที่ใกล้ถึงคิวเมื่อออเดอร์ก่อนหน้าส่งมอบแล้ว
// - notifyOrderCancelledByMerchant: แจ้งลูกค้าเมื่อร้านยกเลิกออเดอร์
// ไฟล์ใหม่ ไม่แก้ไขการทำงานเดิม
// ==========================================================
const { pool } = require('../config/db');
const { getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// ความกว้างช่วงเวลาพร้อมรับ ต้องตรงกับ routes/merchants.js (เช่น 20–30 นาที)
const READY_RANGE_WIDTH_MINUTES = 10;

const CLOSED_CUSTOMER_STATUSES = [
  'รับอาหารสำเร็จแล้ว',
  'ปฏิเสธ',
  'ยกเลิก',
  'CANCELLED',
  'CANCELED'
];

const NEAR_QUEUE_TITLE = 'ใกล้ถึงคิวคุณแล้ว';

function formatClock(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

// บันทึกแจ้งเตือนลงตาราง notifications และส่ง FCM (รูปแบบเดียวกับ routes/orders.js)
async function sendCustomerPush(customerId, title, body) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, body)
       VALUES ($1, $2, $3)`,
      [customerId, title, body]
    );

    const { rows: users } = await pool.query(
      `SELECT fcm_token
       FROM customer
       WHERE customer_id = $1`,
      [customerId]
    );

    if (users.length > 0 && users[0].fcm_token && getApps().length > 0) {
      await getMessaging().send({
        token: users[0].fcm_token,
        notification: { title, body },
        data: { click_action: 'FLUTTER_NOTIFICATION_CLICK' }
      });
    }
  } catch (error) {
    console.error('Queue notification error:', error.message);
  }
}

// ออเดอร์ที่ยังอยู่ในคิวของร้าน เรียงตามลำดับการสั่ง (สั่งก่อนได้ก่อน)
async function loadActiveQueue(db, merchantId) {
  const { rows } = await db.query(
    `SELECT
       o.id AS order_id,
       o.customer_id,
       mo.prep_minutes,
       mo.updated_at AS accepted_at
     FROM orders o
     LEFT JOIN merchant_orders mo
       ON mo.source_order_id = o.id
      AND mo.merchant_id = o.merchant_id
     WHERE o.merchant_id = $1
       AND o.status <> ALL($2::text[])
       AND COALESCE(mo.merchant_status, 'ใหม่') NOT IN ('เสร็จสิ้น', 'ยกเลิก')
     ORDER BY o.id ASC`,
    [merchantId, CLOSED_CUSTOMER_STATUSES]
  );
  return rows;
}

function readyRange(row) {
  const prep = Number(row.prep_minutes);
  if (row.prep_minutes === null || !Number.isFinite(prep) || !row.accepted_at) {
    return null;
  }
  const acceptedAt = new Date(row.accepted_at);
  const readyMaxAt = new Date(acceptedAt.getTime() + prep * 60000);
  let readyMinAt = new Date(
    readyMaxAt.getTime() - READY_RANGE_WIDTH_MINUTES * 60000
  );
  if (readyMinAt < acceptedAt) readyMinAt = acceptedAt;
  return { readyMinAt, readyMaxAt };
}

// คิวของออเดอร์หนึ่งรายการ
async function getOrderQueueInfo(db, merchantId, orderId) {
  const queue = await loadActiveQueue(db, merchantId);
  const index = queue.findIndex(
    (row) => String(row.order_id) === String(orderId)
  );

  if (index === -1) {
    return { inQueue: false, queueCount: queue.length };
  }

  const range = readyRange(queue[index]);
  return {
    inQueue: true,
    queueNumber: index + 1,
    ordersAhead: index,
    queueCount: queue.length,
    readyMinAt: range ? range.readyMinAt : null,
    readyMaxAt: range ? range.readyMaxAt : null
  };
}

// แจ้งลูกค้าตอนร้านรับออเดอร์
async function notifyOrderAccepted(merchantId, orderId) {
  try {
    const { rows } = await pool.query(
      'SELECT customer_id FROM orders WHERE id = $1 AND merchant_id = $2',
      [orderId, merchantId]
    );
    if (rows.length === 0) return;

    const info = await getOrderQueueInfo(pool, merchantId, orderId);
    if (!info.inQueue) return;

    const rangeText = info.readyMinAt && info.readyMaxAt
      ? ` รับได้ประมาณ ${formatClock(info.readyMinAt)}–${formatClock(info.readyMaxAt)} น.`
      : '';
    await sendCustomerPush(
      rows[0].customer_id,
      'ร้านรับออเดอร์แล้ว',
      `ออเดอร์ #${orderId} คิวที่ ${info.queueNumber}` +
        ` (เหลืออีก ${info.ordersAhead} คิว)${rangeText}`
    );
  } catch (error) {
    console.error('notifyOrderAccepted error:', error.message);
  }
}

// เมื่อมีออเดอร์ส่งมอบแล้ว แจ้งลูกค้าที่ถึงคิวหรือเหลืออีก 1 คิว (แจ้งครั้งเดียวต่อออเดอร์)
async function notifyQueueAfterCompletion(merchantId) {
  try {
    const queue = await loadActiveQueue(pool, merchantId);
    const nearOrders = queue.slice(0, 2);

    for (const row of nearOrders) {
      const marker = `#${row.order_id} `;
      const { rows: sent } = await pool.query(
        `SELECT 1
         FROM notifications
         WHERE user_id = $1
           AND title = $2
           AND body LIKE $3
         LIMIT 1`,
        [row.customer_id, NEAR_QUEUE_TITLE, `%${marker}%`]
      );
      if (sent.length > 0) continue;

      await sendCustomerPush(
        row.customer_id,
        NEAR_QUEUE_TITLE,
        `ออเดอร์ #${row.order_id} ใกล้ได้รับแล้ว เดินไปที่ร้านได้เลย`
      );
    }
  } catch (error) {
    console.error('notifyQueueAfterCompletion error:', error.message);
  }
}

// แจ้งลูกค้าเมื่อร้านยกเลิกออเดอร์
async function notifyOrderCancelledByMerchant(customerId, orderId, reason) {
  await sendCustomerPush(
    customerId,
    'ร้านยกเลิกออเดอร์',
    `ออเดอร์ #${orderId} ถูกยกเลิก เนื่องจาก${reason} ขออภัยในความไม่สะดวก`
  );
}

module.exports = {
  getOrderQueueInfo,
  notifyOrderAccepted,
  notifyQueueAfterCompletion,
  notifyOrderCancelledByMerchant
};

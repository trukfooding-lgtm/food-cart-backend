const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { sendMerchantNotification } = require('../services/merchant_push_notification');

// ==========================================================
// Setup Firebase Admin
// ==========================================================
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
 credential: cert(serviceAccount),
 });
 }

 firebaseReady = true;
 console.log('Firebase Admin connected successfully');
} catch (err) {
 console.log('Firebase Admin setup warning:', err.message);
}

// ==========================================================
// Helper: บันทึกแจ้งเตือนลง DB และส่ง FCM
// ==========================================================
async function sendPushNotification(customerId, title, body) {
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

 if (
 users.length > 0 &&
 users[0].fcm_token &&
 firebaseReady
 ) {
 await getMessaging().send({
 token: users[0].fcm_token,
 notification: {
 title,
 body,
 },
 data: {
 click_action: 'FLUTTER_NOTIFICATION_CLICK',
 },
 });

 console.log(
 'Notification sent to customer: ' + customerId
 );
 }
 } catch (error) {
 console.error(
 'Notification error:',
 error.message
 );
 }
}

// ==========================================================
// 1. POST /api/orders/create
// ==========================================================
router.post('/create', async (req, res) => {
 const {
 customer_id,
 merchant_id,
 total_price,
 status,
 items,
 } = req.body;

 if (
 !customer_id ||
 !total_price ||
 !items ||
 items.length === 0
 ) {
 return res.status(400).json({
 message: 'ข้อมูลออเดอร์ไม่ครบถ้วน',
 });
 }

 try {
 const orderStatus = status || 'รอชำระเงิน';
 const mId = merchant_id || 1;

 const orderResult = await pool.query(
 `INSERT INTO orders
 (customer_id, merchant_id, total_price, status)
 VALUES ($1, $2, $3, $4)
 RETURNING id`,
 [
 customer_id,
 mId,
 total_price,
 orderStatus,
 ]
 );

 const newOrderId = orderResult.rows[0].id;

 for (const item of items) {
 await pool.query(
 `INSERT INTO order_items
 (order_id, item_name, quantity, price, note)
 VALUES ($1, $2, $3, $4, $5)`,
 [
 newOrderId,
 item.name,
 item.qty,
 item.price,
 item.note,
 ]
 );
 }

 // ส่งออเดอร์เข้าตาราง merchant_orders ของร้านค้า
await pool.query(
 'INSERT INTO merchant_orders (source_order_id, merchant_id, customer_id, merchant_status) VALUES ($1, $2, $3, $4)',
 [newOrderId, mId, customer_id, 'ใหม่']
);

 sendMerchantNotification({
 merchantId: mId,
 sourceType: 'order',
 sourceId: newOrderId,
 title: 'มีออเดอร์ใหม่',
 message: `ออเดอร์ #${newOrderId} ยอดรวม ${total_price} บาท`,
 data: {
 order_id: newOrderId
 }
 });

 await sendPushNotification(
 customer_id,
 'สั่งอาหารสำเร็จแล้ว',
 `ออเดอร์ #${newOrderId} ส่งไปยังร้านค้าเรียบร้อยแล้ว`
 );

 res.status(201).json({
 message: 'สั่งอาหารสำเร็จ',
 orderId: newOrderId,
 });
 } catch (error) {
 console.error(
 'Error creating order:',
 error
 );

 res.status(500).json({
 message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์',
 error: error.message,
 });
 }
});

// ==========================================================
// 2. GET /api/orders/customer/:customerId
// ==========================================================
router.get(
 '/customer/:customerId',
 async (req, res) => {
 try {
 const sql = `
 SELECT
 o.id AS order_id,
 o.merchant_id,
 COALESCE(
 m.name,
 'ร้านค้าทั่วไป'
 ) AS merchant_name,
 o.total_price,
 o.status,
 mo.merchant_status,
 o.refund_status,
 o.created_at,
 mo.merchant_status,
 mo.prep_minutes,
 mo.reject_reason,
 mo.rejected_at,
 oi.item_name,
 oi.quantity,
 oi.price,
 oi.note,
 r.rating AS "ratingScore",
 r.comment,
 r.images
 FROM orders o
 LEFT JOIN merchant m
 ON o.merchant_id = m.id
 LEFT JOIN order_items oi
 ON o.id = oi.order_id
 LEFT JOIN merchant_orders mo
 ON o.id = mo.source_order_id
 AND o.merchant_id = mo.merchant_id
 LEFT JOIN reviews r
 ON o.id = r.order_id
 WHERE o.customer_id = $1
 ORDER BY o.created_at DESC
 `;

 const { rows } = await pool.query(
 sql,
 [req.params.customerId]
 );

 const ordersMap = {};

 for (const row of rows) {
 if (!ordersMap[row.order_id]) {
 ordersMap[row.order_id] = {
 order_id: row.order_id,
 merchant_id: row.merchant_id,
 merchant_name:
 row.merchant_name,
 total_price:
 row.total_price,
 status: row.status,
 refund_status:
 row.refund_status,
 created_at:
 row.created_at,
 prep_minutes:
 row.prep_minutes,
 reject_reason:
 row.reject_reason,
 rejected_at:
 row.rejected_at,
 ratingScore:
 row.ratingScore,
 comment: row.comment,
 images: row.images,
 items: [],
 };
 }

 if (row.item_name) {
 ordersMap[
 row.order_id
 ].items.push({
 name: row.item_name,
 qty: row.quantity,
 price: row.price,
 note: row.note,
 });
 }
 }

 const orders =
 Object.values(ordersMap);

 res.json({
 success: true,
 data: orders,
 });
 } catch (error) {
 console.error(
 'Error fetching orders:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
 }
);

// ==========================================================
// 3. GET /api/orders/:id
// ==========================================================
router.get('/:id', async (req, res) => {
 try {
 const { rows } = await pool.query(
 `SELECT
 o.*,
 mo.prep_minutes,
 mo.reject_reason,
 mo.rejected_at
 FROM orders o
 LEFT JOIN merchant_orders mo
 ON o.id = mo.source_order_id
 AND o.merchant_id = mo.merchant_id
 WHERE o.id = $1`,
 [req.params.id]
 );

 if (rows.length === 0) {
 return res.status(404).json({
 success: false,
 message: 'ไม่พบออเดอร์',
 });
 }

 res.json({
 success: true,
 data: rows[0],
 });
 } catch (error) {
 console.error(
 'Error fetching order by id:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
});

// ==========================================================
// PUT /api/orders/:id/cancel
// ยกเลิกคำสั่งซื้อโดยลูกค้าและซิงก์สถานะไปฝั่งร้านค้า
// ==========================================================
router.put('/:id/cancel', async (req, res) => {
 const orderId = req.params.id;
 const reason = String(req.body?.reason || 'ลูกค้าขอยกเลิกคำสั่งซื้อ').trim();
 let connection;

 try {
 connection = await pool.connect();
 await connection.query('BEGIN');

 const { rows: orders } = await connection.query(
 `SELECT id, merchant_id, status
 FROM orders
 WHERE id = $1
 FOR UPDATE`,
 [orderId]
 );

 if (orders.length === 0) {
 await connection.query('ROLLBACK');
 return res.status(404).json({
 success: false,
 message: 'ไม่พบออเดอร์นี้'
 });
 }

 const order = orders[0];
 const nonCancellableStatuses = [
 'PAID',
 'ชำระเงินแล้ว',
 'กำลังปรุง',
 'พร้อมรับ',
 'รอรับสินค้า',
 'รับอาหารสำเร็จแล้ว',
 'สำเร็จ'
 ];

 if (nonCancellableStatuses.includes(order.status)) {
 await connection.query('ROLLBACK');
 return res.status(409).json({
 success: false,
 message: 'ไม่สามารถยกเลิกออเดอร์ที่กำลังดำเนินการหรือชำระเงินแล้วได้'
 });
 }

 const merchantResult = await connection.query(
 `UPDATE merchant_orders
 SET merchant_status = 'ยกเลิก',
 reject_reason = $1,
 rejected_at = NOW()
 WHERE source_order_id = $2
 AND merchant_id = $3`,
 [reason || 'ลูกค้าขอยกเลิกคำสั่งซื้อ', orderId, order.merchant_id]
 );

 if (merchantResult.rowCount === 0) {
 await connection.query('ROLLBACK');
 return res.status(404).json({
 success: false,
 message: 'ไม่พบออเดอร์ฝั่งร้านค้า'
 });
 }

 await connection.query(
 `UPDATE orders
 SET status = 'ยกเลิก'
 WHERE id = $1`,
 [orderId]
 );

 await connection.query('COMMIT');

 await sendMerchantNotification({
 merchantId: order.merchant_id,
 sourceType: 'order_cancelled',
 sourceId: orderId,
 title: 'ออเดอร์ถูกยกเลิก',
 message: `ออเดอร์ #${orderId} ถูกยกเลิกโดยลูกค้า`,
 data: {
 order_id: orderId,
 cancelled_by: 'customer'
 }
 });

 res.json({
 success: true,
 status: 'ยกเลิก',
 message: 'ยกเลิกออเดอร์และซิงก์สถานะไปฝั่งร้านค้าสำเร็จ'
 });
 } catch (error) {
 if (connection) {
 await connection.query('ROLLBACK');
 }

 console.error('Error cancelling order:', error);
 res.status(500).json({
 success: false,
 message: 'ไม่สามารถยกเลิกออเดอร์ได้'
 });
 } finally {
 connection?.release();
 }
});

// ==========================================================
// 4. PUT /api/orders/:id/complete
// ==========================================================
router.put(
 '/:id/complete',
 async (req, res) => {
 try {
 const orderId = req.params.id;

 const {
 rows: orderRows,
 } = await pool.query(
 `SELECT customer_id, merchant_id
 FROM orders
 WHERE id = $1`,
 [orderId]
 );

 const result = await pool.query(
 `UPDATE orders
 SET status = 'รับอาหารสำเร็จแล้ว'
 WHERE id = $1`,
 [orderId]
 );

 if (result.rowCount === 0) {
 return res.status(404).json({
 success: false,
 message:
 'ไม่พบออเดอร์นี้ในระบบ',
 });
 }

 if (orderRows.length > 0) {
 await sendPushNotification(
 orderRows[0].customer_id,
 'รับอาหารสำเร็จแล้ว',
 `ออเดอร์ #${orderId} ขอบคุณที่ใช้บริการ ขอให้อร่อยกับมื้ออาหาร`
 );

 await sendMerchantNotification({
 merchantId: orderRows[0].merchant_id,
 sourceType: 'order_completed',
 sourceId: orderId,
 title: 'คำสั่งซื้อเสร็จสิ้น',
 message: `ออเดอร์ #${orderId} ลูกค้ายืนยันรับอาหารแล้ว`,
 data: {
 order_id: orderId,
 completed_by: 'customer'
 }
 });
 }

 res.json({
 success: true,
 message:
 'อัปเดตสถานะสำเร็จ',
 });
 } catch (error) {
 console.error(
 'Error completing order:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
 }
);

// ==========================================================
// 5. POST /api/orders/review
// ==========================================================
router.post('/review', async (req, res) => {
 const {
 order_id,
 merchant_id,
 customer_id,
 rating,
 comment,
 images,
 } = req.body;

 try {
 const { rows: reviews } = await pool.query(
 `INSERT INTO reviews
 (
 order_id,
 merchant_id,
 customer_id,
 rating,
 comment,
 images
 )
 VALUES ($1, $2, $3, $4, $5, $6)
 RETURNING id`,
 [
 order_id,
 merchant_id,
 customer_id,
 rating,
 comment,
 JSON.stringify(images),
 ]
 );

 sendMerchantNotification({
 merchantId: merchant_id,
 sourceType: 'review',
 sourceId: reviews[0].id,
 title: 'มีรีวิวใหม่',
 message: `ลูกค้าให้คะแนน ${rating} ดาว`,
 data: {
 order_id
 }
 });

 await pool.query(
 `UPDATE orders
 SET is_rated = 1
 WHERE id = $1`,
 [order_id]
 );

 res.json({
 success: true,
 message:
 'บันทึกรีวิวสำเร็จ',
 });
 } catch (error) {
 console.error(
 'Error submitting review:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
});

// ==========================================================
// 6. Upload image
// ==========================================================
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
 destination: function (
 req,
 file,
 cb
 ) {
 cb(null, 'uploads/');
 },

 filename: function (
 req,
 file,
 cb
 ) {
 cb(
 null,
 Date.now() +
 path.extname(
 file.originalname
 )
 );
 },
});

const upload = multer({
 storage,
});

router.post(
 '/upload-image',
 upload.single('image'),
 function (req, res) {
 if (!req.file) {
 return res.status(400).json({
 success: false,
 message:
 'No file uploaded',
 });
 }

 const imageUrl =
 `${req.protocol}://${req.get('host')}` +
 `/uploads/${req.file.filename}`;

 res.json({
 success: true,
 url: imageUrl,
 });
 }
);

// ==========================================================
// 7. POST /api/orders/fcm-token
// ==========================================================
router.post(
 '/fcm-token',
 async (req, res) => {
 const {
 customer_id,
 fcm_token,
 } = req.body;

 if (
 !customer_id ||
 !fcm_token
 ) {
 return res.status(400).json({
 success: false,
 message:
 'ข้อมูลไม่ครบถ้วน',
 });
 }

 try {
 await pool.query(
 `UPDATE customer
 SET fcm_token = $1
 WHERE customer_id = $2`,
 [
 fcm_token,
 customer_id,
 ]
 );

 res.json({
 success: true,
 message:
 'บันทึก FCM Token เรียบร้อย',
 });
 } catch (error) {
 console.error(
 'Error saving FCM Token:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
 }
);

// ==========================================================
// 8. GET /api/orders/notifications/:customerId
// ==========================================================
router.get(
 '/notifications/:customerId',
 async (req, res) => {
 try {
 const { rows } =
 await pool.query(
 `SELECT
 id,
 title,
 body,
 is_read,
 created_at
 FROM notifications
 WHERE user_id = $1
 ORDER BY created_at DESC`,
 [req.params.customerId]
 );

 res.json({
 success: true,
 data: rows,
 });
 } catch (error) {
 console.error(
 'Error fetching notifications:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
 }
);

// ==========================================================
// 9. PUT /api/orders/:id/status
// ==========================================================
router.put(
 '/:id/status',
 async (req, res) => {
 const { status } = req.body;
 const orderId = req.params.id;

 try {
 const {
 rows: orderRows,
 } = await pool.query(
 `SELECT customer_id
 FROM orders
 WHERE id = $1`,
 [orderId]
 );

 if (
 orderRows.length === 0
 ) {
 return res.status(404).json({
 success: false,
 message:
 'ไม่พบออเดอร์นี้',
 });
 }

 const customerId =
 orderRows[0].customer_id;

 await pool.query(
 `UPDATE orders
 SET status = $1
 WHERE id = $2`,
 [status, orderId]
 );

 let title =
 'อัปเดตสถานะออเดอร์';

 let body =
 `ออเดอร์ #${orderId} ` +
 `ของคุณเปลี่ยนสถานะเป็น ${status}`;

 if (
 status ===
 'รับคำสั่งซื้อ' ||
 status ===
 'กำลังปรุงอาหาร'
 ) {
 title =
 'ร้านค้ารับออเดอร์แล้ว';

 body =
 `ออเดอร์ #${orderId} ` +
 'ทางร้านกำลังเริ่มปรุงอาหารให้คุณ';
 } else if (
 status === 'พร้อมรับ' ||
 status ===
 'อาหารเสร็จแล้ว'
 ) {
 title =
 'อาหารเสร็จแล้วพร้อมรับ';

 body =
 `ออเดอร์ #${orderId} ` +
 'ปรุงเสร็จแล้ว สามารถมารับอาหารได้เลย';
 } else if (
 status === 'ยกเลิก' ||
 status ===
 'ยกเลิกคำสั่งซื้อ'
 ) {
 title =
 'ออเดอร์ถูกยกเลิก';

 body =
 `ออเดอร์ #${orderId} ` +
 'ถูกยกเลิกโดยทางร้าน';
 }

 await sendPushNotification(
 customerId,
 title,
 body
 );

 res.json({
 success: true,
 message:
 'อัปเดตสถานะและส่งแจ้งเตือนสำเร็จ',
 });
 } catch (error) {
 console.error(
 'Error updating order status:',
 error
 );

 res.status(500).json({
 success: false,
 message: 'Server Error',
 error: error.message,
 });
 }
 }
);


// ==========================================================
// 10. POST /api/orders/:id/payment-slip -> อัปโหลดและตรวจสอบสลิปการโอนเงิน (Layered PostgreSQL Fraud Checks)
// ==========================================================
const usedSlipTransactions = new Set();

function parsedFloatOrNull(value) {
 const parsed = parseFloat(value || '');
 return Number.isFinite(parsed) ? parsed : null;
}

// เก็บสลิปที่ตรวจไม่ผ่านไว้ให้ร้านค้าเปิดตรวจสอบและรายงานได้
// โดยไม่เปลี่ยนสถานะออเดอร์เป็นชำระเงินแล้ว
async function recordRejectedSlip({
 orderId,
 customerId,
 merchantId,
 slipUrl,
 expectedAmount,
 detectedAmount,
 reason,
 ocrText,
 }) {
 let slipNotificationId = `attempt-${Date.now()}`;

 try {
   const { rows: insertedSlipRows } = await pool.query(
     `INSERT INTO order_slips
       (order_id, uploader_type, uploader_id, slip_url, amount, expected_amount,
        detected_amount, status, note, validation_reason, ocr_text,
        transaction_id, payment_channel, verified_at)
      VALUES
       ($1, 'CUSTOMER', $2, $3, $4, $5, $6, 'REJECTED', $7, $7, $8,
        $9, NULL, NULL)
       RETURNING id`,
     [
       String(orderId),
       customerId,
       slipUrl,
       Number.isFinite(detectedAmount) ? detectedAmount : null,
       Number.isFinite(expectedAmount) ? expectedAmount : null,
       Number.isFinite(detectedAmount) ? detectedAmount : null,
       String(reason || 'ระบบตรวจพบสลิปผิดปกติ').slice(0, 2000),
       String(ocrText || '').slice(0, 8000),
       `REJECTED_${orderId}_${Date.now()}`,
     ],
   );

   if (insertedSlipRows[0]?.id != null) {
     slipNotificationId = String(insertedSlipRows[0].id);
   }
 } catch (error) {
   // การบันทึกหลักฐานต้องไม่ทำให้การตอบกลับสถานะสลิปล้มเหลว
   console.warn('Rejected slip record warning:', error.message);
 }

 try {
   await sendMerchantNotification({
     merchantId,
     sourceType: 'payment_slip_rejected',
     sourceId: `${orderId}:${slipNotificationId}`,
     title: 'ตรวจพบสลิปผิดปกติ',
     message: `ออเดอร์ #${orderId}: ${String(reason || 'ระบบตรวจพบสลิปผิดปกติ')}`,
     data: {
       order_id: orderId,
       slip_id: slipNotificationId,
       payment_status: 'REJECTED',
     },
   });
 } catch (error) {
   console.warn('Rejected slip notification warning:', error.message);
 }
}

router.post(
  '/:id/payment-slip',
  upload.single('slip'),
  async (req, res) => {
    const orderId = req.params.id;
    const {
      expectedAmount,
      merchantId,
      ocrStatus,
      ocrText,
      transactionId,
      detectedAmount,
      recipient,
      transferDateTime,
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาแนบรูปภาพสลิปโอนเงิน',
      });
    }

    const slipUrl = `/uploads/${req.file.filename}`;

    try {
      // Layer 1: ตรวจสอบคำสั่งซื้อในฐานข้อมูล PostgreSQL ($1)
      const { rows: orderRows } = await pool.query(
        'SELECT * FROM orders WHERE id = $1',
        [orderId]
      );

      if (orderRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'ไม่พบออเดอร์นี้ในระบบ',
        });
      }

      const order = orderRows[0];
      const customerId = order.customer_id;
      const mId = merchantId || order.merchant_id || 1;
      const dbOrderTotal = parseFloat(order.total_price);
      const normalizedOcrStatus = String(ocrStatus || '').trim().toUpperCase();

      // Layer 2: Server-side Fraud Checks บน Transaction ID (ป้องกันการใช้สลิปซ้ำ Replay Attack)
      const normTxId = (transactionId || '')
        .trim()
        .replace(/[\s\-_]/g, '')
        .toUpperCase();

      if (normTxId) {
        if (usedSlipTransactions.has(normTxId)) {
          const reason = `ตรวจพบการใช้สลิปซ้ำ รหัสธุรกรรม (${transactionId}) นี้เคยถูกใช้งานไปแล้ว`;
          await recordRejectedSlip({
            orderId,
            customerId,
            merchantId: mId,
            slipUrl,
            expectedAmount: dbOrderTotal,
            detectedAmount: parsedFloatOrNull(detectedAmount || expectedAmount),
            reason,
            ocrText,
          });
          return res.status(400).json({
            success: false,
            status: 'REJECTED',
            message: reason,
          });
        }
      }

      // Layer 3: Server-side Amount Match กับฐานข้อมูลจริง
      const parsedDetectedAmount = parseFloat(
        detectedAmount || expectedAmount || 0
      );
      if (Math.abs(parsedDetectedAmount - dbOrderTotal) > 0.01) {
        const reason = `ยอดเงินในสลิป (฿${parsedDetectedAmount.toFixed(2)}) ไม่ตรงกับยอดคำสั่งซื้อจริง (฿${dbOrderTotal.toFixed(2)})`;
        await recordRejectedSlip({
          orderId,
          customerId,
          merchantId: mId,
          slipUrl,
          expectedAmount: dbOrderTotal,
          detectedAmount: parsedDetectedAmount,
          reason,
          ocrText,
        });
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          message: reason,
        });
      }

      // Layer 4: ตรวจสอบสถานะการคัดกรองเบื้องต้น
      if (normalizedOcrStatus === 'REJECTED') {
        const reason = 'สลิปไม่ผ่านการตรวจสอบความถูกต้องของระบบธนาคาร';
        await recordRejectedSlip({
          orderId,
          customerId,
          merchantId: mId,
          slipUrl,
          expectedAmount: dbOrderTotal,
          detectedAmount: parsedDetectedAmount,
          reason,
          ocrText,
        });
        return res.status(400).json({
          success: false,
          status: 'REJECTED',
          message: reason,
        });
      }

      // สลิปอ่านไม่ได้: บันทึกหลักฐานให้ร้านค้าตรวจสอบ/รายงาน
      // แต่คงผลตอบกลับ MANUAL_REVIEW เดิมของฝั่งลูกค้าไว้
      const isUnreadableSlip = normalizedOcrStatus === 'UNREADABLE';
      if (isUnreadableSlip) {
        await recordRejectedSlip({
          orderId,
          customerId,
          merchantId: mId,
          slipUrl,
          expectedAmount: dbOrderTotal,
          detectedAmount: parsedDetectedAmount,
          reason:
            'รูปภาพไม่มีหลักฐานหรือสำเนาของธนาคารที่ถูกต้อง (ตรวจพบสลิปไม่แท้หรืออ่านสลิปไม่ได้)',
          ocrText,
        });
      }

      // Helper function ปรับสถานะออเดอร์อย่างปลอดภัย
      async function updateOrderStatusSafely(statusVal) {
        try {
          await pool.query(
            'UPDATE orders SET status = $1, slip_url = $2 WHERE id = $3',
            [statusVal, slipUrl, orderId]
          );
        } catch (_) {
          await pool.query(
            'UPDATE orders SET status = $1 WHERE id = $2',
            [statusVal, orderId]
          );
        }
      }

      // Layer 5: จัดการเคสที่ไม่แน่ใจ หรือต้องตรวจสอบเพิ่มเติม (MANUAL_REVIEW)
      if (
        normalizedOcrStatus === 'MANUAL_REVIEW' ||
        isUnreadableSlip ||
        !normTxId
      ) {
        await updateOrderStatusSafely('รอตรวจสอบการชำระเงิน');

        await sendPushNotification(
          customerId,
          'กำลังตรวจสอบสลิป',
          `ออเดอร์ #${orderId} ร้านค้ากำลังตรวจสอบหลักฐานการชำระเงินของคุณ`
        );

        if (!isUnreadableSlip && typeof sendMerchantNotification === 'function') {
          try {
            await sendMerchantNotification({
              merchantId: mId,
              sourceType: 'payment_slip_review',
              sourceId: orderId,
              title: 'มีสลิปรอตรวจสอบ',
              message: `ออเดอร์ #${orderId} ลูกค้าแนบสลิปแล้ว กรุณาตรวจสอบยอดเงิน ฿${dbOrderTotal.toFixed(2)}`,
            });
          } catch (e) {
            console.warn('Merchant notification warning:', e.message);
          }
        }

        return res.json({
          success: true,
          status: 'MANUAL_REVIEW',
          message: 'ส่งสลิปให้ร้านค้าตรวจสอบเรียบร้อยแล้ว กำลังรอร้านค้ายืนยันยอดเงิน',
        });
      }

      // Layer 6: เมื่อผ่านครบทุกชั้นอย่างสมบูรณ์ (VERIFIED)
      usedSlipTransactions.add(normTxId);
      await updateOrderStatusSafely('ชำระเงินแล้ว');

      await sendPushNotification(
        customerId,
        'ชำระเงินสำเร็จแล้ว',
        `ออเดอร์ #${orderId} ตรวจสอบยอดชำระเรียบร้อย ทางร้านจะเริ่มเตรียมอาหารให้คุณ`
      );

      if (typeof sendMerchantNotification === 'function') {
        try {
          await sendMerchantNotification({
            merchantId: mId,
            sourceType: 'order_paid',
            sourceId: orderId,
            title: 'ชำระเงินแล้ว',
            message: `ออเดอร์ #${orderId} ตรวจสอบยอดชำระ ฿${dbOrderTotal.toFixed(2)} สำเร็จแล้ว`,
          });
        } catch (e) {
          console.warn('Merchant notification warning:', e.message);
        }
      }

      return res.json({
        success: true,
        status: 'VERIFIED',
        transactionId: transactionId || `TX-${Date.now()}`,
        message: 'ตรวจสอบสลิปสำเร็จ ชำระเงินเรียบร้อย',
      });
    } catch (error) {
      console.error('Error verifying payment slip:', error);
      return res.status(500).json({
        success: false,
        message: 'Server Error',
        error: error.message,
      });
    }
  }
);

module.exports = router;

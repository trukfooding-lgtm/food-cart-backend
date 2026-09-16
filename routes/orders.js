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
    const serviceAccount = require('../serviceAccountKey.json');

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
          o.created_at,
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
            created_at:
              row.created_at,
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
      `SELECT *
       FROM orders
       WHERE id = $1`,
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
        `SELECT customer_id
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

module.exports = router;
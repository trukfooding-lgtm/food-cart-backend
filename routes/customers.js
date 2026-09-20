const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { sendMerchantNotification } = require('../services/merchant_push_notification');
const { getActiveSuspension } = require('../services/account_status');

// ==========================================================
// ตั้งค่าโฟลเดอร์ uploads สำหรับเก็บรูปโปรไฟล์
// ==========================================================
const uploadDir = path.join(__dirname, '../uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    cb(
      null,
      'profile_' +
        Date.now() +
        path.extname(file.originalname)
    );
  },
});

const upload = multer({ storage });

// ==========================================================
// 1. POST /api/customers/register
// สมัครสมาชิกลูกค้า
// ==========================================================
router.post('/register', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        message:
          'กรุณากรอกชื่อ อีเมล และรหัสผ่านให้ครบ',
      });
    }

    // เช็กอีเมลซ้ำ
    const { rows: existing } =
      await pool.query(
        `SELECT customer_id
         FROM customer
         WHERE email = $1`,
        [email]
      );

    if (existing.length > 0) {
      return res.status(409).json({
        message:
          'อีเมลนี้ถูกใช้สมัครสมาชิกไปแล้ว',
      });
    }

    const username =
      email.split('@')[0];

    // เพิ่มลูกค้าใหม่
    const result = await pool.query(
      `INSERT INTO customer
       (
         username,
         name_surname,
         email,
         password,
         phone
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING customer_id`,
      [
        username,
        name,
        email,
        password,
        phone || null,
      ]
    );

    const customerId =
      result.rows[0].customer_id;

    res.status(201).json({
      success: true,
      message: 'สมัครสมาชิกสำเร็จ',

      customer: {
        customer_id: customerId,
        username,
        name_surname: name,
        email,
        phone,
      },
    });
  } catch (err) {
    console.error(
      'Register error:',
      err
    );

    res.status(500).json({
      success: false,
      message:
        'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: err.message,
    });
  }
});

// ==========================================================
// 2. POST /api/customers/login
// เข้าสู่ระบบลูกค้า
// ==========================================================
router.post('/login', async (req, res) => {
  try {
    const {
      email,
      password,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message:
          'กรุณากรอกอีเมลและรหัสผ่าน',
      });
    }

    const { rows } =
      await pool.query(
        `SELECT *
         FROM customer
         WHERE email = $1`,
        [email]
      );

    if (rows.length === 0) {
      return res.status(401).json({
        message:
          'ไม่พบบัญชีผู้ใช้นี้',
      });
    }

    const customer = rows[0];

    if (
      password !== customer.password
    ) {
      return res.status(401).json({
        message:
          'รหัสผ่านไม่ถูกต้อง',
      });
    }

    const suspension = await getActiveSuspension('customer', customer.customer_id);
    if (suspension) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: `บัญชีถูกระงับเนื่องจาก: ${suspension.reason}`,
        reason: suspension.reason,
      });
    }

    delete customer.password;

    res.json({
      success: true,
      message:
        'เข้าสู่ระบบสำเร็จ',
      customer,
    });
  } catch (err) {
    console.error(
      'Login error:',
      err
    );

    res.status(500).json({
      success: false,
      message:
        'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: err.message,
    });
  }
});

// ==========================================================
// 3. POST /api/customers/reset-password
// รีเซ็ตรหัสผ่าน
// ==========================================================
router.post(
  '/reset-password',
  async (req, res) => {
    try {
      const {
        email,
        newPassword,
      } = req.body;

      if (
        !email ||
        !newPassword
      ) {
        return res.status(400).json({
          success: false,
          message:
            'ข้อมูลไม่ครบถ้วน',
        });
      }

      const result =
        await pool.query(
          `UPDATE customer
           SET password = $1
           WHERE email = $2`,
          [
            newPassword,
            email,
          ]
        );

      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message:
            'ไม่พบบัญชีผู้ใช้ที่ตรงกับอีเมลนี้',
        });
      }

      res.json({
        success: true,
        message:
          'เปลี่ยนรหัสผ่านในฐานข้อมูลสำเร็จแล้ว',
      });
    } catch (err) {
      console.error(
        'Reset password error:',
        err
      );

      res.status(500).json({
        success: false,
        message:
          'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
        error: err.message,
      });
    }
  }
);

// ==========================================================
// 4. GET /api/customers
// ดูรายชื่อลูกค้าทั้งหมด
// ==========================================================
router.get('/', async (req, res) => {
  try {
    const { rows } =
      await pool.query(
        `SELECT
           customer_id,
           username,
           name_surname,
           email,
           phone,
           profile_image
         FROM customer`
      );

    res.json(rows);
  } catch (err) {
    console.error(
      'Get customers error:',
      err
    );

    res.status(500).json({
      message:
        'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: err.message,
    });
  }
});

// ==========================================================
// 5. GET /api/customers/:id
// ดูข้อมูลลูกค้ารายคน
// ==========================================================
router.get('/:id', async (req, res) => {
  try {
    const { rows } =
      await pool.query(
        `SELECT
           customer_id,
           username,
           name_surname,
           email,
           phone,
           profile_image
         FROM customer
         WHERE customer_id = $1`,
        [req.params.id]
      );

    if (rows.length === 0) {
      return res.status(404).json({
        message:
          'ไม่พบข้อมูลลูกค้า',
      });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(
      'Get customer error:',
      err
    );

    res.status(500).json({
      message:
        'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: err.message,
    });
  }
});

// ==========================================================
// 6. PUT /api/customers/:id
// แก้ไขข้อมูลลูกค้า
// ==========================================================
router.put('/:id', async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      profile_image,
    } = req.body;

    const params = [
      name,
      email,
      phone,
    ];

    let sql = `
      UPDATE customer
      SET
        name_surname = $1,
        email = $2,
        phone = $3
    `;

    if (
      profile_image !== undefined
    ) {
      params.push(profile_image);

      sql += `
        , profile_image = $4
      `;
    }

    const customerIdPosition =
      params.length + 1;

    params.push(req.params.id);

    sql += `
      WHERE customer_id =
        $${customerIdPosition}
    `;

    const result =
      await pool.query(
        sql,
        params
      );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message:
          'ไม่พบข้อมูลลูกค้าที่จะแก้ไข',
      });
    }

    res.json({
      success: true,
      message:
        'แก้ไขข้อมูลสำเร็จ',
    });
  } catch (err) {
    console.error(
      'Update customer error:',
      err
    );

    res.status(500).json({
      success: false,
      message:
        'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: err.message,
    });
  }
});

// ==========================================================
// 7. DELETE /api/customers/:id
// ลบบัญชีลูกค้า
// ==========================================================
router.delete(
  '/:id',
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `DELETE FROM customer
           WHERE customer_id = $1`,
          [req.params.id]
        );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            'ไม่พบข้อมูลลูกค้าที่จะลบ',
        });
      }

      res.json({
        success: true,
        message:
          'ลบข้อมูลสำเร็จ',
      });
    } catch (err) {
      console.error(
        'Delete customer error:',
        err
      );

      res.status(500).json({
        success: false,
        message:
          'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
        error: err.message,
      });
    }
  }
);

// ==========================================================
// 8. POST /api/customers/follow
// กดติดตาม / ยกเลิกติดตาม
// ==========================================================
router.post('/follow', async (req, res) => {
  const {
    customer_id,
    merchant_id,
  } = req.body;

  if (
    !customer_id ||
    !merchant_id
  ) {
    return res.status(400).json({
      success: false,
      message:
        'ข้อมูลไม่ครบถ้วน',
    });
  }

  try {
    const {
      rows: existing,
    } = await pool.query(
      `SELECT
         customer_id,
         merchant_id
       FROM followed
       WHERE customer_id = $1
       AND merchant_id = $2`,
      [
        customer_id,
        merchant_id,
      ]
    );

    // ถ้าติดตามอยู่แล้ว → ยกเลิก
    if (existing.length > 0) {
      await pool.query(
        `DELETE FROM followed
         WHERE customer_id = $1
         AND merchant_id = $2`,
        [
          customer_id,
          merchant_id,
        ]
      );

      return res.json({
        success: true,
        message:
          'ยกเลิกการติดตามแล้ว',
        isFollowing: false,
      });
    }

    // ถ้ายังไม่ได้ติดตาม → เพิ่ม
    await pool.query(
      `INSERT INTO followed
       (
         customer_id,
         merchant_id
       )
       VALUES ($1, $2)`,
      [
        customer_id,
        merchant_id,
      ]
    );

    sendMerchantNotification({
      merchantId: merchant_id,
      sourceType: 'follower',
      sourceId: `${customer_id}:${merchant_id}`,
      title: 'มีผู้ติดตามร้านค้ารายใหม่',
      message: 'ลูกค้ากดติดตามร้านค้าของคุณ',
      data: {
        customer_id
      }
    });

    res.json({
      success: true,
      message:
        'ติดตามร้านค้าสำเร็จ',
      isFollowing: true,
    });
  } catch (error) {
    console.error(
      'Error toggling follow:',
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
// 9. GET /api/customers/:customerId/followed
// ดึงร้านค้าที่ติดตาม
// ==========================================================
router.get(
  '/:customerId/followed',
  async (req, res) => {
    try {
      const {
        rows: followed,
      } = await pool.query(
        `SELECT merchant_id
         FROM followed
         WHERE customer_id = $1`,
        [
          req.params.customerId,
        ]
      );

      const merchantIds =
        followed.map(
          (f) => f.merchant_id
        );

      res.json({
        success: true,
        data: merchantIds,
      });
    } catch (error) {
      console.error(
        'Error fetching followed:',
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
// 10. POST /api/customers/upload-image
// อัปโหลดรูปโปรไฟล์
// ==========================================================
router.post(
  '/upload-image',
  upload.single('image'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message:
          'กรุณาเลือกรูปภาพ',
      });
    }

    // รองรับทั้ง localhost และ Render
    const imageUrl =
      `${req.protocol}://${req.get('host')}` +
      `/uploads/${req.file.filename}`;

    res.json({
      success: true,
      url: imageUrl,
      filename:
        req.file.filename,
    });
  }
);

module.exports = router;

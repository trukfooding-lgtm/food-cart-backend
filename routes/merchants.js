const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');

// ==========================================================
// POST /api/merchants/register -> สมัครสมาชิกผู้ค้า
// ==========================================================
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, type } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        message: 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน'
      });
    }

    const { rows: existing } = await pool.query(
      'SELECT id FROM merchant WHERE email = $1',
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        message: 'อีเมลนี้ถูกใช้สมัครร้านค้าไปแล้ว'
      });
    }

    await pool.query(
      `INSERT INTO merchant
        (name, email, password, store_phone, type)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        name,
        email,
        password,
        phone || null,
        type || 'ร้านอาหารสตรีทฟู้ด'
      ]
    );

    res.status(201).json({
      success: true,
      message: 'สมัครสมาชิกผู้ค้าสำเร็จ'
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาด',
      error: err.message
    });
  }
});

// ==========================================================
// POST /api/merchants/login -> เข้าสู่ระบบผู้ค้า
// ==========================================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: 'กรุณากรอกอีเมลและรหัสผ่าน'
      });
    }

    const { rows } = await pool.query(
      'SELECT * FROM merchant WHERE email = $1',
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        message: 'ไม่พบบัญชีผู้ค้านี้'
      });
    }

    const merchant = rows[0];

    if (password !== merchant.password) {
      return res.status(401).json({
        message: 'รหัสผ่านไม่ถูกต้อง'
      });
    }

    delete merchant.password;

    res.json({
      success: true,
      message: 'เข้าสู่ระบบผู้ค้าสำเร็จ',
      merchant
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาด',
      error: err.message
    });
  }
});

// ==========================================================
// GET /api/merchants/trucks
// ดึงรายชื่อร้านค้าทั้งหมดพร้อมเมนูอาหาร
// ==========================================================
router.get('/trucks', async (req, res) => {
  try {
    const { rows: merchants } = await pool.query(
      `SELECT id, name, type, store_phone AS phone
       FROM merchant`
    );

    for (let i = 0; i < merchants.length; i++) {
      const { rows: menus } = await pool.query(
        `SELECT id, name, price, image_url
         FROM menus
         WHERE merchant_id = $1`,
        [merchants[i].id]
      );

      merchants[i].items = menus;
    }

    res.json({
      success: true,
      data: merchants
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message
    });
  }
});

// ==========================================================
// GET /api/merchants/:id
// ดึงข้อมูลโปรไฟล์ร้านค้ารายคน
// ==========================================================
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         name,
         email,
         store_phone,
         type,
         line_id,
         facebook_url,
         created_at
       FROM merchant
       WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลร้านค้า'
      });
    }

    res.json({
      success: true,
      merchant: rows[0]
    });
  } catch (error) {
    console.error(
      'Error fetching merchant profile:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: error.message
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id
// แก้ไขข้อมูลโปรไฟล์ร้านค้า
// ==========================================================
router.put('/:id', async (req, res) => {
  try {
    const {
      name,
      email,
      store_phone,
      type,
      line_id,
      facebook_url
    } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: 'กรุณากรอกชื่อร้านและอีเมล'
      });
    }

    const result = await pool.query(
      `UPDATE merchant
       SET
         name = $1,
         email = $2,
         store_phone = $3,
         type = $4,
         line_id = $5,
         facebook_url = $6
       WHERE id = $7`,
      [
        name,
        email,
        store_phone || null,
        type || null,
        line_id || null,
        facebook_url || null,
        req.params.id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบข้อมูลร้านค้าที่ต้องการแก้ไข'
      });
    }

    res.json({
      success: true,
      message: 'แก้ไขโปรไฟล์ร้านค้าสำเร็จ'
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'อีเมลนี้ถูกใช้งานแล้ว'
      });
    }

    console.error(
      'Error updating merchant profile:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: error.message
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id/password
// เปลี่ยนรหัสผ่านร้านค้า
// ==========================================================
router.put('/:id/password', async (req, res) => {
  try {
    const {
      currentPassword,
      newPassword
    } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'กรุณากรอกรหัสผ่านให้ครบ'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร'
      });
    }

    const { rows } = await pool.query(
      `SELECT password
       FROM merchant
       WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบบัญชีร้านค้า'
      });
    }

    if (rows[0].password !== currentPassword) {
      return res.status(401).json({
        success: false,
        message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง'
      });
    }

    await pool.query(
      `UPDATE merchant
       SET password = $1
       WHERE id = $2`,
      [
        newPassword,
        req.params.id
      ]
    );

    res.json({
      success: true,
      message: 'เปลี่ยนรหัสผ่านสำเร็จ'
    });
  } catch (error) {
    console.error(
      'Error changing merchant password:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์',
      error: error.message
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/hours
// ดึงเวลาทำการของร้าน
// ==========================================================
router.get('/:id/hours', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         merchant_id,
         open_everyday,
         selected_days,
         TO_CHAR(open_time, 'HH24:MI') AS open_time,
         TO_CHAR(close_time, 'HH24:MI') AS close_time
       FROM merchant_hours
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      hours: rows[0] || null
    });
  } catch (error) {
    console.error(
      'Error fetching merchant hours:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดเวลาทำการได้'
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id/hours
// บันทึกเวลาทำการของร้าน
// ==========================================================
router.put('/:id/hours', async (req, res) => {
  try {
    const {
      open_everyday,
      selected_days,
      open_time,
      close_time
    } = req.body;

    if (
      !open_time ||
      !close_time ||
      !Array.isArray(selected_days)
    ) {
      return res.status(400).json({
        success: false,
        message: 'ข้อมูลเวลาทำการไม่ครบ'
      });
    }

    await pool.query(
      `INSERT INTO merchant_hours
        (
          merchant_id,
          open_everyday,
          selected_days,
          open_time,
          close_time
        )
       VALUES ($1, $2, $3, $4, $5)

       ON CONFLICT (merchant_id)

       DO UPDATE SET
         open_everyday = EXCLUDED.open_everyday,
         selected_days = EXCLUDED.selected_days,
         open_time = EXCLUDED.open_time,
         close_time = EXCLUDED.close_time`,
      [
        req.params.id,
        open_everyday ? 1 : 0,
        selected_days.join(','),
        open_time,
        close_time
      ]
    );

    res.json({
      success: true,
      message: 'บันทึกเวลาทำการสำเร็จ'
    });
  } catch (error) {
    console.error(
      'Error saving merchant hours:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึกเวลาทำการได้'
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/prep-time
// ดึงเวลาเตรียมอาหาร
// ==========================================================
router.get('/:id/prep-time', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT prep_minutes
       FROM merchant_prep_time
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      prepMinutes:
        rows[0]?.prep_minutes ?? 15
    });
  } catch (error) {
    console.error(
      'Error fetching merchant prep time:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดเวลาเตรียมอาหารได้'
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id/prep-time
// บันทึกเวลาเตรียมอาหาร
// ==========================================================
router.put('/:id/prep-time', async (req, res) => {
  try {
    const prepMinutes =
      Number(req.body.prep_minutes);

    if (
      !Number.isInteger(prepMinutes) ||
      prepMinutes < 0 ||
      prepMinutes > 1439
    ) {
      return res.status(400).json({
        success: false,
        message: 'เวลาเตรียมอาหารไม่ถูกต้อง'
      });
    }

    await pool.query(
      `INSERT INTO merchant_prep_time
        (
          merchant_id,
          prep_minutes
        )
       VALUES ($1, $2)

       ON CONFLICT (merchant_id)

       DO UPDATE SET
         prep_minutes =
           EXCLUDED.prep_minutes`,
      [
        req.params.id,
        prepMinutes
      ]
    );

    res.json({
      success: true,
      message: 'บันทึกเวลาเตรียมอาหารสำเร็จ'
    });
  } catch (error) {
    console.error(
      'Error saving merchant prep time:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึกเวลาเตรียมอาหารได้'
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/status
// ดึงสถานะร้านค้า
// ==========================================================
router.get('/:id/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status
       FROM merchant_status
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      status:
        rows[0]?.status ?? 'ปิดร้าน'
    });
  } catch (error) {
    console.error(
      'Error fetching merchant status:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดสถานะร้านได้'
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id/status
// บันทึกสถานะร้านค้า
// ==========================================================
router.put('/:id/status', async (req, res) => {
  try {
    const allowedStatuses = [
      'เปิดร้าน',
      'กำลังย้าย',
      'ปิดร้าน'
    ];

    const { status } = req.body;

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'สถานะร้านไม่ถูกต้อง'
      });
    }

    await pool.query(
      `INSERT INTO merchant_status
        (
          merchant_id,
          status
        )
       VALUES ($1, $2)

       ON CONFLICT (merchant_id)

       DO UPDATE SET
         status = EXCLUDED.status`,
      [
        req.params.id,
        status
      ]
    );

    res.json({
      success: true,
      message: 'บันทึกสถานะร้านสำเร็จ'
    });
  } catch (error) {
    console.error(
      'Error saving merchant status:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึกสถานะร้านได้'
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/preferences
// ดึงการตั้งค่าร้าน
// ==========================================================
router.get('/:id/preferences', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         order_notification,
         auto_hide_menu
       FROM merchant_preferences
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      preferences:
        rows[0] || {
          order_notification: 1,
          auto_hide_menu: 1
        }
    });
  } catch (error) {
    console.error(
      'Error fetching merchant preferences:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดการตั้งค่าได้'
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id/preferences
// บันทึกการตั้งค่าร้าน
// ==========================================================
router.put('/:id/preferences', async (req, res) => {
  try {
    const {
      order_notification,
      auto_hide_menu
    } = req.body;

    if (
      typeof order_notification !== 'boolean' ||
      typeof auto_hide_menu !== 'boolean'
    ) {
      return res.status(400).json({
        success: false,
        message: 'ข้อมูลการตั้งค่าไม่ถูกต้อง'
      });
    }

    await pool.query(
      `INSERT INTO merchant_preferences
        (
          merchant_id,
          order_notification,
          auto_hide_menu
        )
       VALUES ($1, $2, $3)

       ON CONFLICT (merchant_id)

       DO UPDATE SET
         order_notification =
           EXCLUDED.order_notification,
         auto_hide_menu =
           EXCLUDED.auto_hide_menu`,
      [
        req.params.id,
        order_notification ? 1 : 0,
        auto_hide_menu ? 1 : 0
      ]
    );

    res.json({
      success: true,
      message: 'บันทึกการตั้งค่าสำเร็จ'
    });
  } catch (error) {
    console.error(
      'Error saving merchant preferences:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึกการตั้งค่าได้'
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/loyalty-settings
// ดึงเงื่อนไขแต้ม
// ==========================================================
router.get(
  '/:id/loyalty-settings',
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           is_enabled,
           baht_per_point,
           points_for_discount,
           discount_amount
         FROM merchant_loyalty_settings
         WHERE merchant_id = $1`,
        [req.params.id]
      );

      res.json({
        success: true,
        settings: rows[0] || null
      });
    } catch (error) {
      console.error(
        'Error fetching loyalty settings:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถโหลดการตั้งค่าแต้มได้'
      });
    }
  }
);

// ==========================================================
// PUT /api/merchants/:id/loyalty-settings
// บันทึกเงื่อนไขแต้ม
// ==========================================================
router.put(
  '/:id/loyalty-settings',
  async (req, res) => {
    try {
      const {
        is_enabled,
        baht_per_point,
        points_for_discount,
        discount_amount
      } = req.body;

      const baht =
        Number(baht_per_point);

      const points =
        Number(points_for_discount);

      const discount =
        Number(discount_amount);

      if (
        typeof is_enabled !== 'boolean' ||
        !Number.isInteger(baht) ||
        baht <= 0 ||
        !Number.isInteger(points) ||
        points <= 0 ||
        !Number.isFinite(discount) ||
        discount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'เงื่อนไขแต้มไม่ถูกต้อง'
        });
      }

      await pool.query(
        `INSERT INTO merchant_loyalty_settings
          (
            merchant_id,
            is_enabled,
            baht_per_point,
            points_for_discount,
            discount_amount
          )
         VALUES ($1, $2, $3, $4, $5)

         ON CONFLICT (merchant_id)

         DO UPDATE SET
           is_enabled =
             EXCLUDED.is_enabled,
           baht_per_point =
             EXCLUDED.baht_per_point,
           points_for_discount =
             EXCLUDED.points_for_discount,
           discount_amount =
             EXCLUDED.discount_amount`,
        [
          req.params.id,
          is_enabled ? 1 : 0,
          baht,
          points,
          discount
        ]
      );

      res.json({
        success: true,
        message:
          'บันทึกเงื่อนไขแต้มสำเร็จ'
      });
    } catch (error) {
      console.error(
        'Error saving loyalty settings:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถบันทึกการตั้งค่าแต้มได้'
      });
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/reviews
// รีวิวสำหรับฝั่งร้านค้า
// ==========================================================
router.get('/:id/reviews', async (req, res) => {
  const connection =
    await pool.connect();

  try {
    await connection.query('BEGIN');

    await connection.query(
      `DELETE FROM merchant_reviews
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    await connection.query(
      `INSERT INTO merchant_reviews
        (
          review_id,
          order_id,
          merchant_id,
          customer_id,
          customer_name,
          rating,
          comment,
          images,
          reviewed_at
        )

       SELECT
         r.id,
         r.order_id,
         r.merchant_id,
         r.customer_id,
         COALESCE(
           c.name_surname,
           c.username
         ),
         r.rating,
         r.comment,
         r.images,
         r.created_at

       FROM reviews r

       LEFT JOIN customer c
         ON c.customer_id =
            r.customer_id

       WHERE r.merchant_id = $1`,
      [req.params.id]
    );

    const {
      rows: reviews
    } = await connection.query(
      `SELECT
         review_id,
         order_id,
         customer_id,
         customer_name,
         rating,
         comment,
         images,
         reviewed_at
       FROM merchant_reviews
       WHERE merchant_id = $1
       ORDER BY reviewed_at DESC`,
      [req.params.id]
    );

    await connection.query('COMMIT');

    const averageRating =
      reviews.length
        ? reviews.reduce(
            (sum, review) =>
              sum +
              Number(review.rating),
            0
          ) / reviews.length
        : 0;

    res.json({
      success: true,
      totalReviews:
        reviews.length,
      averageRating,
      data: reviews
    });
  } catch (error) {
    await connection.query(
      'ROLLBACK'
    );

    console.error(
      'Error fetching merchant reviews:',
      error
    );

    res.status(500).json({
      success: false,
      message:
        'ไม่สามารถโหลดรีวิวได้'
    });
  } finally {
    connection.release();
  }
});

// ==========================================================
// CRUD /api/merchants/:id/menus
// จัดการเมนูฝั่งร้าน
// ==========================================================
router.get('/:id/menus', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         name,
         price,
         quantity,
         is_available,
         image_url,
         option_groups
       FROM merchant_menus
       WHERE merchant_id = $1
       ORDER BY id DESC`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error(
      'Error fetching merchant menus:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดเมนูได้'
    });
  }
});

router.post('/:id/menus', async (req, res) => {
  try {
    const {
      name,
      price,
      quantity,
      is_available,
      image_url,
      option_groups
    } = req.body;

    if (
      !name ||
      Number(price) < 0 ||
      Number(quantity) < 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'ข้อมูลเมนูไม่ถูกต้อง'
      });
    }

    const result = await pool.query(
      `INSERT INTO merchant_menus
        (
          merchant_id,
          name,
          price,
          quantity,
          is_available,
          image_url,
          option_groups
        )
       VALUES
        ($1, $2, $3, $4, $5, $6, $7)

       RETURNING id`,
      [
        req.params.id,
        name,
        Number(price),
        Number(quantity),
        is_available ? 1 : 0,
        image_url || null,
        JSON.stringify(
          option_groups || []
        )
      ]
    );

    res.status(201).json({
      success: true,
      id: result.rows[0].id
    });
  } catch (error) {
    console.error(
      'Error creating merchant menu:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถเพิ่มเมนูได้'
    });
  }
});

router.put(
  '/:id/menus/:menuId',
  async (req, res) => {
    try {
      const {
        name,
        price,
        quantity,
        is_available,
        image_url,
        option_groups
      } = req.body;

      const result =
        await pool.query(
          `UPDATE merchant_menus
           SET
             name = $1,
             price = $2,
             quantity = $3,
             is_available = $4,
             image_url = $5,
             option_groups = $6
           WHERE id = $7
             AND merchant_id = $8`,
          [
            name,
            Number(price),
            Number(quantity),
            is_available ? 1 : 0,
            image_url || null,
            JSON.stringify(
              option_groups || []
            ),
            req.params.menuId,
            req.params.id
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          success: false,
          message: 'ไม่พบเมนู'
        });
      }

      res.json({
        success: true
      });
    } catch (error) {
      console.error(
        'Error updating merchant menu:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถแก้ไขเมนูได้'
      });
    }
  }
);

router.delete(
  '/:id/menus/:menuId',
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `DELETE FROM merchant_menus
           WHERE id = $1
             AND merchant_id = $2`,
          [
            req.params.menuId,
            req.params.id
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          success: false,
          message: 'ไม่พบเมนู'
        });
      }

      res.json({
        success: true
      });
    } catch (error) {
      console.error(
        'Error deleting merchant menu:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถลบเมนูได้'
      });
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/notifications
// การแจ้งเตือนฝั่งร้าน
// ==========================================================
router.get(
  '/:id/notifications',
  async (req, res) => {
    try {
      const merchantId =
        req.params.id;

      await pool.query(
        `INSERT INTO merchant_notifications
          (
            merchant_id,
            source_type,
            source_id,
            title,
            message,
            event_at
          )

         SELECT
           merchant_id,
           'order',
           id::text,
           'มีออเดอร์ใหม่',
           'ออเดอร์ #' ||
             id::text ||
             ' ยอดรวม ' ||
             total_price::text ||
             ' บาท',
           created_at

         FROM orders

         WHERE merchant_id = $1

         ON CONFLICT
           (
             merchant_id,
             source_type,
             source_id
           )
         DO NOTHING`,
        [merchantId]
      );

      await pool.query(
        `INSERT INTO merchant_notifications
          (
            merchant_id,
            source_type,
            source_id,
            title,
            message,
            event_at
          )

         SELECT
           merchant_id,
           'follower',
           customer_id::text ||
             ':' ||
             merchant_id::text,
           'มีผู้ติดตามร้านค้ารายใหม่',
           'ลูกค้ากดติดตามร้านค้าของคุณ',
           created_at

         FROM followed

         WHERE merchant_id = $1

         ON CONFLICT
           (
             merchant_id,
             source_type,
             source_id
           )
         DO NOTHING`,
        [merchantId]
      );

      await pool.query(
        `INSERT INTO merchant_notifications
          (
            merchant_id,
            source_type,
            source_id,
            title,
            message,
            event_at
          )

         SELECT
           merchant_id,
           'review',
           id::text,
           'มีรีวิวใหม่',
           'ลูกค้าให้คะแนน ' ||
             rating::text ||
             ' ดาว',
           created_at

         FROM reviews

         WHERE merchant_id = $1

         ON CONFLICT
           (
             merchant_id,
             source_type,
             source_id
           )
         DO NOTHING`,
        [merchantId]
      );

      const { rows } =
        await pool.query(
          `SELECT
             id,
             source_type,
             title,
             message,
             event_at
           FROM merchant_notifications
           WHERE merchant_id = $1
           ORDER BY event_at DESC`,
          [merchantId]
        );

      res.json({
        success: true,
        data: rows
      });
    } catch (error) {
      console.error(
        'Error fetching merchant notifications:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถโหลดการแจ้งเตือนได้'
      });
    }
  }
);

// ==========================================================
// POST /api/merchants/:id/issue-reports
// ส่งรายงานปัญหา
// ==========================================================
router.post(
  '/:id/issue-reports',
  async (req, res) => {
    try {
      const {
        issue_type,
        order_reference,
        details,
        image_url
      } = req.body;

      if (
        !issue_type ||
        !details ||
        (
          issue_type ===
            'ปัญหาเกี่ยวกับออเดอร์' &&
          !order_reference
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'ข้อมูลรายงานไม่ครบ'
        });
      }

      const result =
        await pool.query(
          `INSERT INTO merchant_issue_reports
            (
              merchant_id,
              issue_type,
              order_reference,
              details,
              image_url
            )
           VALUES
            ($1, $2, $3, $4, $5)

           RETURNING id`,
          [
            req.params.id,
            issue_type,
            order_reference || null,
            details,
            image_url || null
          ]
        );

      res.status(201).json({
        success: true,
        id: result.rows[0].id
      });
    } catch (error) {
      console.error(
        'Error creating merchant issue report:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถส่งรายงานได้'
      });
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/orders
// รายการออเดอร์จริงฝั่งร้าน
// ==========================================================
router.get('/:id/orders', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO merchant_orders
        (
          source_order_id,
          merchant_id,
          customer_id,
          customer_name,
          items_summary,
          total_price,
          merchant_status,
          ordered_at
        )

       SELECT
         o.id,
         o.merchant_id,
         o.customer_id,

         COALESCE(
           NULLIF(
             c.name_surname,
             ''
           ),
           c.username
         ),

         STRING_AGG(
           oi.item_name ||
             ' x' ||
             oi.quantity::text,
           ', '
           ORDER BY oi.id
         ),

         o.total_price,

         CASE
           WHEN
             o.status =
               'รับอาหารสำเร็จแล้ว'
           THEN 'เสร็จสิ้น'

           WHEN
             o.status IN (
               'ปฏิเสธ',
               'ยกเลิก'
             )
           THEN 'ยกเลิก'

           ELSE 'ใหม่'
         END,

         o.created_at

       FROM orders o

       LEFT JOIN customer c
         ON c.customer_id =
            o.customer_id

       LEFT JOIN order_items oi
         ON oi.order_id = o.id

       WHERE o.merchant_id = $1

       GROUP BY
         o.id,
         o.merchant_id,
         o.customer_id,
         c.name_surname,
         c.username,
         o.total_price,
         o.status,
         o.created_at

       ON CONFLICT
         (
           merchant_id,
           source_order_id
         )

       DO UPDATE SET
         customer_name =
           EXCLUDED.customer_name,

         items_summary =
           EXCLUDED.items_summary,

         total_price =
           EXCLUDED.total_price,

         merchant_status =
           CASE
             WHEN
               EXCLUDED.merchant_status =
                 'เสร็จสิ้น'
             THEN 'เสร็จสิ้น'

             ELSE
               merchant_orders
                 .merchant_status
           END`,
      [req.params.id]
    );

    const { rows } =
      await pool.query(
        `SELECT
           source_order_id AS order_id,
           customer_id,
           customer_name,
           items_summary,
           total_price,
           merchant_status,
           prep_minutes,
           reject_reason,
           rejected_at,
           ordered_at

         FROM merchant_orders

         WHERE merchant_id = $1

         ORDER BY ordered_at DESC`,
        [req.params.id]
      );

    res.json({
      success: true,
      data: rows
    });
  } catch (error) {
    console.error(
      'Error fetching merchant orders:',
      error
    );

    res.status(500).json({
      success: false,
      message:
        'ไม่สามารถโหลดออเดอร์ได้'
    });
  }
});

// ==========================================================
// PUT /api/merchants/:id/orders/:orderId/status
// อัปเดตสถานะเฉพาะฝั่งร้าน
// ==========================================================
router.put(
  '/:id/orders/:orderId/status',
  async (req, res) => {
    const allowedStatuses = [
      'กำลังปรุง',
      'รอรับสินค้า',
      'ยกเลิก'
    ];

    const {
      status,
      prep_minutes,
      reject_reason
    } = req.body;

    if (
      !allowedStatuses.includes(
        status
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'สถานะออเดอร์ไม่ถูกต้อง'
      });
    }

    if (
      status === 'ยกเลิก' &&
      !String(
        reject_reason || ''
      ).trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          'กรุณาระบุเหตุผลที่ปฏิเสธ'
      });
    }

    try {
      const result =
        await pool.query(
          `UPDATE merchant_orders

           SET
             merchant_status = $1,

             prep_minutes =
               COALESCE(
                 $2,
                 prep_minutes
               ),

             reject_reason =
               CASE
                 WHEN
                   $3 = 'ยกเลิก'
                 THEN $4
                 ELSE reject_reason
               END,

             rejected_at =
               CASE
                 WHEN
                   $5 = 'ยกเลิก'
                 THEN NOW()
                 ELSE rejected_at
               END

           WHERE merchant_id = $6
             AND source_order_id = $7`,
          [
            status,
            prep_minutes || null,
            status,
            reject_reason || null,
            status,
            req.params.id,
            req.params.orderId
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            'ไม่พบออเดอร์ฝั่งร้าน'
        });
      }

      res.json({
        success: true
      });
    } catch (error) {
      console.error(
        'Error updating merchant order:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถอัปเดตออเดอร์ได้'
      });
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/sales-summary
// สรุปยอดขายฝั่งร้าน
// ==========================================================
router.get(
  '/:id/sales-summary',
  async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM merchant_sales_summary
         WHERE merchant_id = $1`,
        [req.params.id]
      );

      await pool.query(
        `INSERT INTO merchant_sales_summary
          (
            merchant_id,
            sale_date,
            total_orders,
            total_sales
          )

         SELECT
           merchant_id,
           DATE(ordered_at),
           COUNT(*),
           SUM(total_price)

         FROM merchant_orders

         WHERE merchant_id = $1

           AND merchant_status IN (
             'กำลังปรุง',
             'รอรับสินค้า',
             'เสร็จสิ้น'
           )

         GROUP BY
           merchant_id,
           DATE(ordered_at)`,
        [req.params.id]
      );

      const {
        rows: daily
      } = await pool.query(
        `SELECT
           sale_date,
           total_orders,
           total_sales

         FROM merchant_sales_summary

         WHERE merchant_id = $1
           AND sale_date >=
             CURRENT_DATE -
             INTERVAL '6 days'

         ORDER BY sale_date`,
        [req.params.id]
      );

      const {
        rows: totals
      } = await pool.query(
        `SELECT
           COALESCE(
             SUM(total_sales),
             0
           )
           AS available_balance

         FROM merchant_sales_summary

         WHERE merchant_id = $1`,
        [req.params.id]
      );

      res.json({
        success: true,
        daily,
        available_balance:
          totals[0]
            .available_balance
      });
    } catch (error) {
      console.error(
        'Error fetching merchant sales summary:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถโหลดสรุปยอดขายได้'
      });
    }
  }
);

// ==========================================================
// DELETE /api/merchants/:id
// ลบบัญชีและข้อมูลที่เกี่ยวข้อง
// ==========================================================
router.delete('/:id', async (req, res) => {
  const connection =
    await pool.connect();

  try {
    await connection.query('BEGIN');

    const {
      rows: existing
    } = await connection.query(
      `SELECT id
       FROM merchant
       WHERE id = $1`,
      [req.params.id]
    );

    if (existing.length === 0) {
      await connection.query(
        'ROLLBACK'
      );

      return res.status(404).json({
        success: false,
        message:
          'ไม่พบบัญชีร้านค้า'
      });
    }

    await connection.query(
      `DELETE FROM reviews
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    await connection.query(
      `DELETE FROM followed
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    await connection.query(
      `DELETE FROM merchant
       WHERE id = $1`,
      [req.params.id]
    );

    await connection.query(
      'COMMIT'
    );

    res.json({
      success: true,
      message:
        'ลบบัญชีร้านค้าสำเร็จ'
    });
  } catch (error) {
    await connection.query(
      'ROLLBACK'
    );

    console.error(
      'Error deleting merchant account:',
      error
    );

    res.status(500).json({
      success: false,
      message:
        'ไม่สามารถลบบัญชีร้านค้าได้',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

// ==========================================================
// GET /api/merchants/:merchantId/followers
// ยอดและรายชื่อผู้ติดตามร้านค้า
// ==========================================================
router.get(
  '/:merchantId/followers',
  async (req, res) => {
    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      await connection.query(
        `DELETE FROM merchant_followers
         WHERE merchant_id = $1`,
        [req.params.merchantId]
      );

      await connection.query(
        `INSERT INTO merchant_followers
          (
            merchant_id,
            customer_id,
            username,
            name_surname,
            email,
            followed_at
          )

         SELECT
           fm.merchant_id,
           c.customer_id,
           c.username,
           c.name_surname,
           c.email,
           fm.created_at

         FROM followed fm

         INNER JOIN customer c
           ON c.customer_id =
              fm.customer_id

         WHERE fm.merchant_id = $1`,
        [req.params.merchantId]
      );

      const {
        rows: followers
      } = await connection.query(
        `SELECT
           customer_id,
           username,
           name_surname,
           email,
           followed_at

         FROM merchant_followers

         WHERE merchant_id = $1

         ORDER BY followed_at DESC`,
        [req.params.merchantId]
      );

      await connection.query(
        'COMMIT'
      );

      res.json({
        success: true,
        totalFollowers:
          followers.length,
        data: followers
      });
    } catch (error) {
      await connection.query(
        'ROLLBACK'
      );

      console.error(
        'Error fetching merchant followers:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถโหลดผู้ติดตามร้านค้าได้',
        error: error.message
      });
    } finally {
      connection.release();
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/followers/count
// ดึงจำนวนผู้ติดตามร้านค้า
// ==========================================================
router.get(
  '/:id/followers/count',
  async (req, res) => {
    try {
      const { rows } =
        await pool.query(
          `SELECT COUNT(*) AS count
           FROM followed
           WHERE merchant_id = $1`,
          [req.params.id]
        );

      res.json({
        success: true,
        count:
          Number(rows[0].count)
      });
    } catch (error) {
      console.error(
        'Error fetching followers count:',
        error
      );

      res.status(500).json({
        success: false,
        message: 'Server Error'
      });
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/bank-accounts
// บัญชีธนาคารของร้าน
// ==========================================================
router.get(
  '/:id/bank-accounts',
  async (req, res) => {
    try {
      const {
        rows: accounts
      } = await pool.query(
        `SELECT
           id,
           payment_type,
           bank_code,
           account_name,
           account_number,
           promptpay_type,
           promptpay_id,
           receiver_name,
           is_primary,
           created_at,
           updated_at

         FROM merchant_bank_accounts

         WHERE merchant_id = $1

         ORDER BY
           is_primary DESC,
           created_at ASC`,
        [req.params.id]
      );

      res.json({
        success: true,
        data: accounts
      });
    } catch (error) {
      console.error(
        'Error fetching merchant bank accounts:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถโหลดบัญชีธนาคารได้'
      });
    }
  }
);

// ==========================================================
// POST /api/merchants/:id/bank-accounts
// เพิ่มบัญชีธนาคาร / PromptPay
// ==========================================================
router.post(
  '/:id/bank-accounts',
  async (req, res) => {
    const {
      payment_type =
        'BANK_ACCOUNT',
      bank_code,
      account_name,
      account_number,
      promptpay_type,
      promptpay_id,
      receiver_name,
      is_primary
    } = req.body;

    const cleanName =
      String(
        account_name || ''
      ).trim();

    const cleanNumber =
      String(
        account_number || ''
      ).trim();

    const cleanPromptPayId =
      String(
        promptpay_id || ''
      ).trim();

    const cleanReceiverName =
      String(
        receiver_name || ''
      ).trim();

    const allowedBanks = [
      'KBANK',
      'SCB',
      'BBL',
      'KTB'
    ];

    const allowedPromptPayTypes = [
      'PHONE',
      'NATIONAL_ID',
      'TAX_ID'
    ];

    if (
      ![
        'BANK_ACCOUNT',
        'PROMPTPAY'
      ].includes(payment_type)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'วิธีรับเงินไม่ถูกต้อง'
      });
    }

    if (
      payment_type ===
      'BANK_ACCOUNT'
    ) {
      if (
        !allowedBanks.includes(
          bank_code
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'ธนาคารไม่ถูกต้อง'
        });
      }

      if (
        !cleanName ||
        !/^[\p{L}\p{M}\s]+$/u.test(
          cleanName
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'ชื่อบัญชีต้องเป็นตัวอักษรเท่านั้น'
        });
      }

      if (
        !cleanNumber ||
        !/^\d+$/.test(
          cleanNumber
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'เลขบัญชีต้องเป็นตัวเลขเท่านั้น'
        });
      }
    } else {
      if (
        !allowedPromptPayTypes.includes(
          promptpay_type
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'ประเภท PromptPay ไม่ถูกต้อง'
        });
      }

      if (
        !cleanReceiverName ||
        !/^[\p{L}\p{M}\s]+$/u.test(
          cleanReceiverName
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'ชื่อผู้รับเงินต้องเป็นตัวอักษรเท่านั้น'
        });
      }

      if (
        !/^\d+$/.test(
          cleanPromptPayId
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'หมายเลข PromptPay ต้องเป็นตัวเลขเท่านั้น'
        });
      }

      if (
        promptpay_type ===
          'PHONE' &&
        !/^0\d{9}$/.test(
          cleanPromptPayId
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            'หมายเลขโทรศัพท์ไม่ถูกต้อง'
        });
      }

      if (
        promptpay_type !==
          'PHONE' &&
        cleanPromptPayId.length !==
          13
      ) {
        return res.status(400).json({
          success: false,
          message:
            'หมายเลข PromptPay ต้องมี 13 หลัก'
        });
      }
    }

    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      if (
        is_primary === true ||
        is_primary === 1
      ) {
        await connection.query(
          `UPDATE merchant_bank_accounts
           SET is_primary = 0
           WHERE merchant_id = $1`,
          [req.params.id]
        );
      }

      const result =
        await connection.query(
          `INSERT INTO merchant_bank_accounts
            (
              merchant_id,
              payment_type,
              bank_code,
              account_name,
              account_number,
              promptpay_type,
              promptpay_id,
              receiver_name,
              is_primary
            )

           VALUES
            (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9
            )

           RETURNING id`,
          [
            req.params.id,

            payment_type,

            payment_type ===
            'BANK_ACCOUNT'
              ? bank_code
              : null,

            payment_type ===
            'BANK_ACCOUNT'
              ? cleanName
              : null,

            payment_type ===
            'BANK_ACCOUNT'
              ? cleanNumber
              : null,

            payment_type ===
            'PROMPTPAY'
              ? promptpay_type
              : null,

            payment_type ===
            'PROMPTPAY'
              ? cleanPromptPayId
              : null,

            payment_type ===
            'PROMPTPAY'
              ? cleanReceiverName
              : null,

            is_primary === true ||
            is_primary === 1
              ? 1
              : 0
          ]
        );

      await connection.query(
        'COMMIT'
      );

      res.status(201).json({
        success: true,
        message:
          'เพิ่มช่องทางรับเงินเรียบร้อยแล้ว',
        id:
          result.rows[0].id
      });
    } catch (error) {
      await connection.query(
        'ROLLBACK'
      );

      if (
        error.code === '23505'
      ) {
        return res.status(409).json({
          success: false,
          message:
            'บัญชีธนาคารนี้มีอยู่แล้ว'
        });
      }

      console.error(
        'Error creating merchant bank account:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถเพิ่มบัญชีธนาคารได้'
      });
    } finally {
      connection.release();
    }
  }
);

// ==========================================================
// PUT /api/merchants/:id/bank-accounts/:accountId/primary
// เลือกบัญชีหลัก
// ==========================================================
router.put(
  '/:id/bank-accounts/:accountId/primary',
  async (req, res) => {
    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      const {
        rows: accounts
      } = await connection.query(
        `SELECT id
         FROM merchant_bank_accounts
         WHERE id = $1
           AND merchant_id = $2`,
        [
          req.params.accountId,
          req.params.id
        ]
      );

      if (
        accounts.length === 0
      ) {
        await connection.query(
          'ROLLBACK'
        );

        return res.status(404).json({
          success: false,
          message:
            'ไม่พบบัญชีธนาคารของร้าน'
        });
      }

      await connection.query(
        `UPDATE merchant_bank_accounts
         SET is_primary = 0
         WHERE merchant_id = $1`,
        [req.params.id]
      );

      await connection.query(
        `UPDATE merchant_bank_accounts
         SET is_primary = 1
         WHERE id = $1
           AND merchant_id = $2`,
        [
          req.params.accountId,
          req.params.id
        ]
      );

      await connection.query(
        'COMMIT'
      );

      res.json({
        success: true,
        message:
          'เปลี่ยนบัญชีหลักสำเร็จ'
      });
    } catch (error) {
      await connection.query(
        'ROLLBACK'
      );

      console.error(
        'Error selecting primary bank account:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถเปลี่ยนบัญชีหลักได้'
      });
    } finally {
      connection.release();
    }
  }
);

// ==========================================================
// DELETE /api/merchants/:id/bank-accounts/:accountId
// ลบบัญชีธนาคาร
// ==========================================================
router.delete(
  '/:id/bank-accounts/:accountId',
  async (req, res) => {
    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      const {
        rows: accounts
      } = await connection.query(
        `SELECT
           id,
           is_primary

         FROM merchant_bank_accounts

         WHERE id = $1
           AND merchant_id = $2

         FOR UPDATE`,
        [
          req.params.accountId,
          req.params.id
        ]
      );

      if (
        accounts.length === 0
      ) {
        await connection.query(
          'ROLLBACK'
        );

        return res.status(404).json({
          success: false,
          message:
            'ไม่พบบัญชีธนาคารของร้าน'
        });
      }

      const {
        rows: counts
      } = await connection.query(
        `SELECT COUNT(*) AS total
         FROM merchant_bank_accounts
         WHERE merchant_id = $1`,
        [req.params.id]
      );

      if (
        Number(
          accounts[0].is_primary
        ) === 1 &&
        Number(
          counts[0].total
        ) > 1
      ) {
        await connection.query(
          'ROLLBACK'
        );

        return res.status(409).json({
          success: false,
          code:
            'PRIMARY_ACCOUNT',
          message:
            'กรุณาเลือกบัญชีอื่นเป็นบัญชีหลักก่อนลบ'
        });
      }

      await connection.query(
        `DELETE FROM merchant_bank_accounts
         WHERE id = $1
           AND merchant_id = $2`,
        [
          req.params.accountId,
          req.params.id
        ]
      );

      await connection.query(
        'COMMIT'
      );

      res.json({
        success: true,
        message:
          'ลบบัญชีธนาคารสำเร็จ'
      });
    } catch (error) {
      await connection.query(
        'ROLLBACK'
      );

      console.error(
        'Error deleting merchant bank account:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถลบบัญชีธนาคารได้'
      });
    } finally {
      connection.release();
    }
  }
);

module.exports = router;
// ==========================================================
// ส่วนหัวมอดูล: ระบบการทำงานฝั่งร้านค้า (Merchant Module Router)
// ทำหน้าที่จัดการการเข้าสู่ระบบ สมัครสมาชิก แก้ไขโปรไฟล์ จัดการเมนู เวลาทำการ จุดขาย สรุปยอดขาย และรายงานปัญหา
// ==========================================================
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { installMerchantMap, expireStores } = require('../services/merchant_map');
const { getActiveSuspension } = require('../services/account_status');
const {
  getOrderQueueInfo,
  notifyOrderAccepted,
  notifyOrderCancelledByMerchant
} = require('../services/customer_queue_notification');
installMerchantMap(router);

// ==========================================================
// ขอบเขตที่ 1.3.3.1: เข้าสู่ระบบ สมัครสมาชิก และผูกบัญชีรับเงิน
// POST /api/merchants/register -> สมัครสมาชิกผู้ค้าพร้อมบัญชีรับเงิน
// ==========================================================
router.post('/register', async (req, res) => {
  const connection = await pool.connect();

  try {
    const {
      name,
      email,
      password,
      phone,
      type,
      bank_account: bankAccount
    } = req.body;

    // จุดที่อาจารย์อาจสั่งแก้: เพิ่มเงื่อนไขตรวจสอบความยาวรหัสผ่าน
    // ตรวจสอบรหัสผ่านขั้นต่ำ: if (password.length < 6) return res.status(400).json({ message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
    if (!name || !email || !password || !phone) {
      return res.status(400).json({
        message: 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน'
      });
    }

    if (!bankAccount || typeof bankAccount !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'กรุณาเพิ่มบัญชีรับเงินอย่างน้อย 1 บัญชี'
      });
    }

    const {
      payment_type: paymentType = 'BANK_ACCOUNT',
      bank_code: bankCode,
      account_name: accountName,
      account_number: accountNumber,
      promptpay_type: promptPayType,
      promptpay_id: promptPayId,
      receiver_name: receiverName
    } = bankAccount;

    const cleanAccountName = String(accountName || '').trim();
    const cleanAccountNumber = String(accountNumber || '').trim();
    const cleanPromptPayId = String(promptPayId || '').trim();
    const cleanReceiverName = String(receiverName || '').trim();
    // จุดที่อาจารย์อาจสั่งแก้: เพิ่มธนาคารที่รองรับในระบบ
    // เพิ่มรหัสธนาคาร: const allowedBanks = ['KBANK', 'SCB', 'BBL', 'KTB', 'GSB', 'BAY'];
    const allowedBanks = ['KBANK', 'SCB', 'BBL', 'KTB'];
    const allowedPromptPayTypes = ['PHONE'];

    if (!['BANK_ACCOUNT', 'PROMPTPAY'].includes(paymentType)) {
      return res.status(400).json({
        success: false,
        message: 'วิธีรับเงินไม่ถูกต้อง'
      });
    }

    if (paymentType === 'BANK_ACCOUNT') {
      if (!allowedBanks.includes(bankCode)) {
        return res.status(400).json({
          success: false,
          message: 'ธนาคารไม่ถูกต้อง'
        });
      }

      if (!cleanAccountName || !/^[\p{L}\p{M}\s]+$/u.test(cleanAccountName)) {
        return res.status(400).json({
          success: false,
          message: 'ชื่อบัญชีต้องเป็นตัวอักษรเท่านั้น'
        });
      }

      if (!cleanAccountNumber || !/^\d+$/.test(cleanAccountNumber)) {
        return res.status(400).json({
          success: false,
          message: 'เลขบัญชีต้องเป็นตัวเลขเท่านั้น'
        });
      }
    } else {
      if (!allowedPromptPayTypes.includes(promptPayType)) {
        return res.status(400).json({
          success: false,
          message: 'ประเภท PromptPay ไม่ถูกต้อง'
        });
      }

      if (!cleanReceiverName || !/^[\p{L}\p{M}\s]+$/u.test(cleanReceiverName)) {
        return res.status(400).json({
          success: false,
          message: 'ชื่อผู้รับเงินต้องเป็นตัวอักษรเท่านั้น'
        });
      }

      const promptPayIdValid = /^0\d{9}$/.test(cleanPromptPayId);

      if (!promptPayIdValid) {
        return res.status(400).json({
          success: false,
          message: 'หมายเลข PromptPay ไม่ถูกต้อง'
        });
      }
    }

    // ตอบอาจารย์: "ใช้คำสั่ง BEGIN เพื่อเริ่มต้น Transaction ในการบันทึกข้อมูลร้านค้าและบัญชีธนาคารไปพร้อมกันแบบปรมาณู"
    await connection.query('BEGIN');

    const { rows: existing } = await connection.query(
      'SELECT id FROM merchant WHERE email = $1',
      [email]
    );

    if (existing.length > 0) {
      await connection.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'อีเมลนี้ถูกใช้สมัครร้านค้าไปแล้ว'
      });
    }

    // จุดที่อาจารย์อาจสั่งแก้: กำหนดประเภทร้านค้าเริ่มต้น
    // ประเภทร้านค้าเริ่มต้น: type || 'ร้านอาหารทั่วไป'
    const { rows: merchants } = await connection.query(
      `INSERT INTO merchant
        (name, email, password, store_phone, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        name,
        email,
        password,
        phone || null,
        type || 'ร้านอาหารสตรีทฟู้ด'
      ]
    );

    const merchantId = merchants[0].id;

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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
      [
        merchantId,
        paymentType,
        paymentType === 'BANK_ACCOUNT' ? bankCode : null,
        paymentType === 'BANK_ACCOUNT' ? cleanAccountName : null,
        paymentType === 'BANK_ACCOUNT' ? cleanAccountNumber : null,
        paymentType === 'PROMPTPAY' ? promptPayType : null,
        paymentType === 'PROMPTPAY' ? cleanPromptPayId : null,
        paymentType === 'PROMPTPAY' ? cleanReceiverName : null
      ]
    );

    await connection.query('COMMIT');

    // จุดที่อาจารย์อาจสั่งแก้: ข้อความเมื่อสมัครสมาชิกสำเร็จ
    // ข้อความตอบกลับ: message: 'ลงทะเบียนร้านค้าสำเร็จแล้ว'
    res.status(201).json({
      success: true,
      message: 'สมัครสมาชิกผู้ค้าสำเร็จ',
      merchant_id: merchantId
    });
  } catch (err) {
    await connection.query('ROLLBACK');
    console.error(err);

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'อีเมลหรือบัญชีรับเงินนี้ถูกใช้แล้ว'
      });
    }

    res.status(500).json({
      success: false,
      message: 'เกิดข้อผิดพลาด',
      error: err.message
    });
  } finally {
    connection.release();
  }
});

// ==========================================================
// ขอบเขตที่ 1.3.3.1: เข้าสู่ระบบร้านค้า
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

    // จุดที่อาจารย์อาจสั่งแก้: เข้ารหัสรหัสผ่านก่อนเปรียบเทียบ
    // ตรวจสอบรหัสผ่านผ่าน bcrypt: const match = await bcrypt.compare(password, merchant.password);
    if (password !== merchant.password) {
      return res.status(401).json({
        message: 'รหัสผ่านไม่ถูกต้อง'
      });
    }

    // ตอบอาจารย์: "เรียกฟังก์ชัน getActiveSuspension เพื่อตรวจสอบว่าร้านค้าถูกระงับการใช้งานอยู่หรือไม่ หากถูกระงับจะตอบกลับด้วยรหัส 403"
    const suspension = await getActiveSuspension('merchant', merchant.id);
    if (suspension) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_SUSPENDED',
        message: `บัญชีถูกระงับเนื่องจาก: ${suspension.reason}`,
        reason: suspension.reason,
      });
    }

    delete merchant.password;
    delete merchant.fcm_token;

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
// POST /api/merchants/reset-password -> รีเซ็ตรหัสผ่านผู้ค้าหลังยืนยัน OTP
// ==========================================================
// ==========================================================
// ขอบเขตที่ 1.3.3.1: กู้คืนรหัสผ่านร้านค้าหลังยืนยัน OTP
// POST /api/merchants/reset-password -> รีเซ็ตรหัสผ่านผู้ค้าหลังยืนยัน OTP
// ==========================================================
router.post('/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาระบุอีเมลและรหัสผ่านใหม่'
      });
    }
    // จุดที่อาจารย์อาจสั่งแก้: ปรับความยาวรหัสผ่านใหม่ขั้นต่ำ
    // ความยาวรหัสผ่านขั้นต่ำ: if (String(newPassword).length < 8) return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร'
      });
    }

    // ตอบอาจารย์: "อัปเดตรหัสผ่านใหม่ในตาราง merchant โดยใช้อีเมลเป็นเงื่อนไขในการค้นหา"
    const result = await pool.query(
      `UPDATE merchant SET password = $1 WHERE email = $2`,
      [String(newPassword), String(email).trim()]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบบัญชีร้านค้าที่ตรงกับอีเมลนี้'
      });
    }
    return res.json({
      success: true,
      message: 'เปลี่ยนรหัสผ่านร้านค้าสำเร็จแล้ว'
    });
  } catch (error) {
    console.error('Merchant reset password error:', error);
    return res.status(500).json({
      success: false,
      message: 'ไม่สามารถเปลี่ยนรหัสผ่านร้านค้าได้'
    });
  }
});

// ==========================================================
// ขอบเขตที่ 1.3.3.1: ลงทะเบียนอุปกรณ์รับ Push Notification
// POST /api/merchants/:id/fcm-token
// ==========================================================
router.post('/:id/fcm-token', async (req, res) => {
  const { fcm_token: fcmToken } = req.body;

  if (!fcmToken) {
    return res.status(400).json({
      success: false,
      message: 'กรุณาระบุ FCM Token'
    });
  }

  try {
    const result = await pool.query(
      `UPDATE merchant
       SET fcm_token = $1
       WHERE id = $2`,
      [fcmToken, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'ไม่พบร้านค้านี้'
      });
    }

    // ตอบอาจารย์: "ใช้คำสั่ง ON CONFLICT เพื่ออัปเดตเวลาล่าสุดกรณีที่ Token เดิมถูกลงทะเบียนไว้แล้ว เพื่อป้องกันข้อมูลซ้ำซ้อน"
    await pool.query(
      `INSERT INTO merchant_fcm_tokens (merchant_id, fcm_token, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (merchant_id, fcm_token)
       DO UPDATE SET updated_at = NOW()`,
      [req.params.id, fcmToken]
    );

    res.json({
      success: true,
      message: 'บันทึก FCM Token ของร้านค้าเรียบร้อย'
    });
  } catch (error) {
    console.error('Error saving merchant FCM Token:', error);
    res.status(500).json({
      success: false,
      message: 'ไม่สามารถบันทึก FCM Token ของร้านค้าได้'
    });
  }
});

// ==========================================================
// ขอบเขตที่ 1.3.3.1: อัปโหลดรูปโปรไฟล์ร้านค้า
// POST /api/merchants/:id/profile-image -> บันทึกรูปโปรไฟล์ร้านในฐานข้อมูล
// ==========================================================
router.post('/:id/profile-image', async (req, res) => {
  try {
    const image = String(req.body?.profile_image || '').trim();
    if (!image.startsWith('data:image/')) {
      return res.status(400).json({
        success: false,
        message: 'รูปโปรไฟล์ไม่ถูกต้อง'
      });
    }
    // จุดที่อาจารย์อาจสั่งแก้: ปรับขนาดรูปโปรไฟล์สูงสุด
    // ขนาดรูปสูงสุด 5MB: if (Buffer.byteLength(image, 'utf8') > 5 * 1024 * 1024)
    if (Buffer.byteLength(image, 'utf8') > 2 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        message: 'รูปโปรไฟล์มีขนาดใหญ่เกิน 2 MB'
      });
    }
    const result = await pool.query(
      `UPDATE merchant SET profile_image = $1 WHERE id = $2`,
      [image, req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบร้านค้านี้' });
    }
    return res.json({ success: true, profile_image: image });
  } catch (error) {
    console.error('Error saving merchant profile image:', error);
    return res.status(500).json({ success: false, message: 'บันทึกรูปโปรไฟล์ไม่สำเร็จ' });
  }
});

// ==========================================================
// ขอบเขตที่ 1.3.3.1: ดูข้อมูลโปรไฟล์ร้านค้ารายบุคคล
// GET /api/merchants/:id -> ดึงข้อมูลโปรไฟล์ร้านค้ารายคน
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
         profile_image,
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
// ขอบเขตที่ 1.3.3.1: แก้ไขข้อมูลโปรไฟล์ร้านค้า
// PUT /api/merchants/:id -> แก้ไขข้อมูลโปรไฟล์ร้านค้า
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
// ขอบเขตที่ 1.3.3.1: เปลี่ยนรหัสผ่านร้านค้า
// PUT /api/merchants/:id/password -> เปลี่ยนรหัสผ่านร้านค้า
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

    // จุดที่อาจารย์อาจสั่งแก้: ปรับความยาวรหัสผ่านใหม่
    // ตรวจความยาวรหัสผ่านใหม่: if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
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

    // ตอบอาจารย์: "ตรวจสอบรหัสผ่านเดิมก่อนว่าถูกต้องหรือไม่ หากรหัสผ่านเดิมไม่ถูกต้องจะยกเลิกกระบวนการทันทีเพื่อความปลอดภัย"
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
    await expireStores();
    const { rows } = await pool.query(
      `SELECT status, selling_ends_at
       FROM merchant_status
       WHERE merchant_id = $1`,
      [req.params.id]
    );

    res.json({
      success: true,
      status:
        rows[0]?.status ?? 'ปิดร้าน',
      selling_ends_at:
        rows[0]?.selling_ends_at ?? null
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

      const { rows } =
        await pool.query(
          `SELECT
             id,
             source_type,
             source_id,
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
// DELETE /api/merchants/:id/notifications
// ลบการแจ้งเตือนทั้งหมดของร้านค้า
// ==========================================================
router.delete(
  '/:id/notifications',
  async (req, res) => {
    try {
      const result = await pool.query(
        `DELETE FROM merchant_notifications
         WHERE merchant_id = $1`,
        [req.params.id]
      );

      res.json({
        success: true,
        deletedCount: result.rowCount || 0
      });
    } catch (error) {
      console.error(
        'Error deleting merchant notifications:',
        error
      );

      res.status(500).json({
        success: false,
        message: 'ไม่สามารถลบการแจ้งเตือนได้'
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

    // ดึงจาก orders เป็นแหล่งข้อมูลหลักด้วย เพื่อไม่ให้ออเดอร์หาย
    // หากรายการใน merchant_orders (ตารางสำเนาเพื่อเก็บสถานะร้าน) ยังไม่ทันถูกสร้าง
    const { rows } =
      await pool.query(
        `SELECT
           o.id AS order_id,
           o.customer_id,
           COALESCE(
             NULLIF(mo.customer_name, ''),
             NULLIF(c.name_surname, ''),
             c.username,
             'ไม่ระบุชื่อลูกค้า'
           ) AS customer_name,
           COALESCE(
             NULLIF(mo.items_summary, ''),
             (
               SELECT STRING_AGG(
                 oi.item_name || ' x' || oi.quantity::text,
                 ', ' ORDER BY oi.id
               )
               FROM order_items oi
               WHERE oi.order_id = o.id
             ),
             '-'
           ) AS items_summary,
           o.total_price,
           COALESCE(
             mo.merchant_status,
             CASE
               WHEN o.status = 'รับอาหารสำเร็จแล้ว' THEN 'เสร็จสิ้น'
               WHEN o.status IN ('ปฏิเสธ', 'ยกเลิก') THEN 'ยกเลิก'
               ELSE 'ใหม่'
             END
           ) AS merchant_status,
           mo.prep_minutes,
           mo.updated_at AS merchant_updated_at,
           mo.reject_reason,
           mo.rejected_at,
           COALESCE(mo.ordered_at, o.created_at) AS ordered_at,
           o.status AS customer_order_status,
           o.transaction_id,
           latest_slip.status AS latest_slip_status,
           latest_slip.created_at AS latest_slip_created_at,
           (latest_slip.created_at IS NOT NULL) AS has_payment_slip,
           CASE
             WHEN o.transaction_id IS NOT NULL
               OR o.status IN (
                 'PAID',
                 'ชำระเงินแล้ว',
                 'พร้อมรับ',
                 'รับอาหารสำเร็จแล้ว'
               )
               OR mo.merchant_status = 'ชำระเงินแล้ว'
             THEN TRUE
             ELSE FALSE
           END AS is_paid,
           CASE
             WHEN o.transaction_id IS NOT NULL
               OR o.status IN (
                 'PAID',
                 'ชำระเงินแล้ว',
                 'พร้อมรับ',
                 'รับอาหารสำเร็จแล้ว'
               )
               OR mo.merchant_status = 'ชำระเงินแล้ว'
             THEN COALESCE(o.paid_at, mo.updated_at)
             ELSE NULL
           END AS paid_at,
           CASE
             WHEN o.status = 'รอชำระเงิน'
             THEN o.payment_deadline
             ELSE NULL
           END AS payment_deadline,
           COALESCE(
             to_jsonb(o)->>'customer_points',
             to_jsonb(o)->>'points_balance',
             to_jsonb(o)->>'points_remaining',
             to_jsonb(o)->>'loyalty_points',
             to_jsonb(o)->>'reward_points'
           ) AS customer_points,
           COALESCE(
             to_jsonb(o)->>'points_used',
             to_jsonb(o)->>'used_points',
             to_jsonb(o)->>'points_redeemed',
             to_jsonb(o)->>'redeemed_points'
           ) AS points_used,
           COALESCE(
             to_jsonb(o)->>'points_discount',
             to_jsonb(o)->>'points_discount_amount',
             to_jsonb(o)->>'redeemed_amount',
             to_jsonb(o)->>'discount_from_points'
           ) AS points_discount

         FROM orders o

         LEFT JOIN customer c
           ON c.customer_id = o.customer_id

         LEFT JOIN merchant_orders mo
           ON o.id = mo.source_order_id
          AND o.merchant_id = mo.merchant_id

         LEFT JOIN LATERAL (
           SELECT os.status, os.created_at
           FROM order_slips os
           WHERE os.order_id = o.id::text
           ORDER BY os.created_at DESC
           LIMIT 1
         ) latest_slip ON TRUE

         WHERE o.merchant_id = $1

         ORDER BY COALESCE(mo.ordered_at, o.created_at) DESC`,
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
// PUT /api/merchants/:id/orders/prep-shift
// ร้านค้าเลื่อนเวลาเตรียมของทุกออเดอร์ที่ยังอยู่ในคิวพร้อมกัน (+นาที)
// ไม่เปลี่ยนเวลาที่รับออเดอร์ (updated_at) และไม่ส่งแจ้งเตือนใดๆ
// ==========================================================
router.put('/:id/orders/prep-shift', async (req, res) => {
  try {
    const minutes = Number(req.body.minutes);

    if (
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 120
    ) {
      return res.status(400).json({
        success: false,
        message: 'จำนวนนาทีที่เลื่อนไม่ถูกต้อง'
      });
    }

    const result = await pool.query(
      `UPDATE merchant_orders mo
       SET prep_minutes = mo.prep_minutes + $2::int
       FROM orders o
       WHERE o.id = mo.source_order_id
         AND mo.merchant_id = $1
         AND mo.prep_minutes IS NOT NULL
         AND mo.merchant_status IN (
           'ใหม่',
           'รอชำระเงิน',
           'รอตรวจสอบ',
           'กำลังปรุง',
           'รอรับสินค้า',
           'พร้อมรับ'
         )
         AND o.status NOT IN (
           'รับอาหารสำเร็จแล้ว',
           'ปฏิเสธ',
           'ยกเลิก',
           'CANCELLED',
           'CANCELED'
         )`,
      [req.params.id, minutes]
    );

    res.json({
      success: true,
      updated: result.rowCount,
      message: 'เลื่อนเวลาเตรียมทั้งคิวสำเร็จ'
    });
  } catch (error) {
    console.error(
      'Error shifting merchant prep time:',
      error
    );

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถเลื่อนเวลาเตรียมได้'
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/order-eta?items=N
// ให้ลูกค้าดูคิวและเวลาที่คาดว่าจะได้รับอาหารก่อนกดสั่ง (ชำระหน้าร้าน)
// - items = จำนวนชิ้นที่ลูกค้ากำลังจะสั่ง (ไม่ส่งมาจะนับเป็น 1)
// - ใช้สูตรเดียวกับแอปร้าน: เวลาต่อชิ้น x จำนวนชิ้น ต่อออเดอร์
// - เพิ่มใหม่เท่านั้น ไม่แก้ route เดิม
// ==========================================================
const ETA_BUSY_THRESHOLD_MINUTES = 20;
const ETA_COOKING_STATUSES = ['ใหม่', 'รอชำระเงิน', 'รอตรวจสอบ', 'กำลังปรุง'];
// ออเดอร์ที่เลยเวลาแต่ยังไม่ส่งมอบ ให้นับว่ายังเหลืออีกกี่นาที (ไม่นับเป็นเสร็จแล้ว)
const ETA_OVERDUE_EXTRA_MINUTES = 5;

function formatEtaClock(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

// คำนวณเวลารอจากรายการออเดอร์ที่ค้างอยู่ (แยกเป็นฟังก์ชันล้วนเพื่อทดสอบได้)
function calcOrderEta({ queueRows, perItemMinutes, items, now, sellingEndsAt }) {
  let start = now;
  let unknownAheadMinutes = 0;

  for (const row of queueRows) {
    const prep = row.prep_minutes === null || row.prep_minutes === undefined
      ? null
      : Number(row.prep_minutes);
    const acceptedAt = row.accepted_at ? new Date(row.accepted_at) : null;

    if (prep !== null && Number.isFinite(prep) && prep >= 0 && acceptedAt) {
      // prep_minutes เก็บเป็นเวลาช้าสุดของช่วง (รวมเวลาเผื่อ 10 นาที)
      // ต่อคิวจากเวลาที่คาดว่าเสร็จจริง (ไม่รวมเวลาเผื่อ) เพื่อไม่ให้เวลาเผื่อสะสมทุกคิว
      const expectedPrep = Math.max(0, prep - ETA_RANGE_WIDTH_MINUTES);
      const readyBy = new Date(acceptedAt.getTime() + expectedPrep * 60000);
      const effectiveReadyBy = readyBy > now
        ? readyBy
        : new Date(now.getTime() + ETA_OVERDUE_EXTRA_MINUTES * 60000);
      if (effectiveReadyBy > start) start = effectiveReadyBy;
    } else {
      const qty = Number(row.item_qty) > 0 ? Number(row.item_qty) : 1;
      unknownAheadMinutes += perItemMinutes * qty;
    }
  }

  const readyAt = new Date(
    start.getTime() + (unknownAheadMinutes + perItemMinutes * items) * 60000
  );
  const waitMinutes = Math.max(
    0,
    Math.ceil((readyAt.getTime() - now.getTime()) / 60000)
  );
  const closesBeforeReady = Boolean(
    sellingEndsAt && readyAt.getTime() > new Date(sellingEndsAt).getTime()
  );

  return {
    queueCount: queueRows.length,
    waitMinutes,
    readyAt,
    isBusy: waitMinutes >= ETA_BUSY_THRESHOLD_MINUTES,
    closesBeforeReady
  };
}

// ==========================================================
// ช่วงเวลารับอาหาร (แบบ Shopee เช่น 20–30 นาที)
// - เวลาเร็วสุด = เวลารอจากคิว ปัดขึ้นทีละ 5 นาที
// - เวลาช้าสุด = เวลาเร็วสุด + 10 นาที (เผื่อร้านทำไม่ทัน)
// ==========================================================
const ETA_RANGE_ROUND_MINUTES = 5;
const ETA_RANGE_WIDTH_MINUTES = 10;

function calcReadyRange(waitMinutes) {
  const minMinutes = Math.max(
    ETA_RANGE_ROUND_MINUTES,
    Math.ceil(Number(waitMinutes) / ETA_RANGE_ROUND_MINUTES) *
      ETA_RANGE_ROUND_MINUTES
  );
  return {
    minMinutes,
    maxMinutes: minMinutes + ETA_RANGE_WIDTH_MINUTES
  };
}

// เวลาต่อชิ้นที่ใช้คำนวณ ถ้าร้านตั้งไว้ 0 นาที ให้ใช้ 5 นาทีแทน
const ETA_ZERO_PER_ITEM_FALLBACK_MINUTES = 5;

function effectivePerItemMinutes(value) {
  const minutes = Number(value ?? 15);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes
    : ETA_ZERO_PER_ITEM_FALLBACK_MINUTES;
}

// เวลาต่อชิ้นที่เรียนรู้จากการขายจริงของร้าน
// - ใช้เวลาตั้งแต่รับออเดอร์จนกดส่งมอบ หารด้วยจำนวนชิ้น แล้วใช้ค่ากลาง (median)
// - ใช้ 30 ออเดอร์ล่าสุด ต้องมีอย่างน้อย 5 ออเดอร์ ถ้าไม่ถึงใช้เวลาที่ร้านตั้งไว้ (ร้านใหม่)
// - ไม่นับออเดอร์ที่ใช้เวลาเกิน 60 นาที และออเดอร์ที่ระบบปิดให้อัตโนมัติ
const LEARNED_PREP_MIN_SAMPLES = 5;
const LEARNED_PREP_MAX_SAMPLES = 30;
const LEARNED_PREP_MAX_ORDER_MINUTES = 60;

async function getPerItemMinutes(db, merchantId, configuredValue) {
  const fallback = effectivePerItemMinutes(configuredValue);
  try {
    const { rows } = await db.query(
      `SELECT
         EXTRACT(EPOCH FROM (o.completed_at - mo.updated_at)) / 60.0 AS minutes,
         COALESCE(
           (
             SELECT SUM(oi.quantity)::int
             FROM order_items oi
             WHERE oi.order_id = o.id
           ),
           1
         ) AS item_qty
       FROM orders o
       JOIN merchant_orders mo
         ON mo.source_order_id = o.id
        AND mo.merchant_id = o.merchant_id
       WHERE o.merchant_id = $1
         AND o.completed_at IS NOT NULL
         AND mo.updated_at IS NOT NULL
         AND mo.prep_minutes IS NOT NULL
         AND o.completed_at > mo.updated_at
         AND o.completed_at <= mo.updated_at + ($2::int * INTERVAL '1 minute')
         AND o.completed_at < mo.updated_at + ((mo.prep_minutes + 14) * INTERVAL '1 minute')
       ORDER BY o.completed_at DESC
       LIMIT $3`,
      [merchantId, LEARNED_PREP_MAX_ORDER_MINUTES, LEARNED_PREP_MAX_SAMPLES]
    );

    const samples = rows
      .map((row) => Number(row.minutes) / Math.max(1, Number(row.item_qty) || 1))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);

    if (samples.length < LEARNED_PREP_MIN_SAMPLES) return fallback;

    const middle = Math.floor(samples.length / 2);
    const median = samples.length % 2
      ? samples[middle]
      : (samples[middle - 1] + samples[middle]) / 2;
    return Math.max(1, Math.round(median));
  } catch (error) {
    console.error('Error learning prep time:', error.message);
    return fallback;
  }
}

// คำนวณเวลาเตรียมของออเดอร์ที่ร้านรับอัตโนมัติจากคิวจริง
// คืนค่าเป็นเวลาช้าสุดของช่วง (นาที นับจากตอนรับออเดอร์)
// เรียงคิวตามลำดับการสั่ง (สั่งก่อนได้ก่อน) นับเฉพาะออเดอร์ที่สั่งก่อนออเดอร์นี้และยังทำอยู่
async function estimateAutoPrepMinutes(db, merchantId, orderId) {
  // ล็อกต่อร้าน กันออเดอร์ที่รับพร้อมกันคำนวณคิวซ้อนกัน (ปลดล็อกเองเมื่อจบ transaction)
  await db.query(
    'SELECT pg_advisory_xact_lock(918273, $1::int)',
    [merchantId]
  );

  const { rows: prepRows } = await db.query(
    `SELECT prep_minutes
     FROM merchant_prep_time
     WHERE merchant_id = $1`,
    [merchantId]
  );
  const perItemMinutes = await getPerItemMinutes(
    db,
    merchantId,
    prepRows[0]?.prep_minutes
  );

  const { rows: itemRows } = await db.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS item_qty
     FROM order_items
     WHERE order_id = $1`,
    [orderId]
  );
  const items = Number(itemRows[0]?.item_qty) > 0
    ? Number(itemRows[0].item_qty)
    : 1;

  const { rows: orderRows } = await db.query(
    `SELECT
       COALESCE(
         mo.merchant_status,
         CASE
           WHEN o.status = 'รับอาหารสำเร็จแล้ว' THEN 'เสร็จสิ้น'
           WHEN o.status IN ('ปฏิเสธ', 'ยกเลิก') THEN 'ยกเลิก'
           ELSE 'ใหม่'
         END
       ) AS merchant_status,
       mo.prep_minutes,
       mo.updated_at AS accepted_at,
       COALESCE(
         (
           SELECT SUM(oi.quantity)::int
           FROM order_items oi
           WHERE oi.order_id = o.id
         ),
         1
       ) AS item_qty
     FROM orders o
     LEFT JOIN merchant_orders mo
       ON mo.source_order_id = o.id
      AND mo.merchant_id = o.merchant_id
     WHERE o.merchant_id = $1
       AND o.id < $2
       AND o.status NOT IN (
         'รับอาหารสำเร็จแล้ว',
         'ปฏิเสธ',
         'ยกเลิก',
         'CANCELLED',
         'CANCELED'
       )`,
    [merchantId, orderId]
  );

  const queueRows = orderRows.filter((row) =>
    ETA_COOKING_STATUSES.includes(row.merchant_status)
  );

  const eta = calcOrderEta({
    queueRows,
    perItemMinutes,
    items,
    now: new Date(),
    sellingEndsAt: null
  });

  return calcReadyRange(eta.waitMinutes).maxMinutes;
}

router.get('/:id/order-eta', async (req, res) => {
  try {
    await expireStores();

    const rawItems = Number.parseInt(req.query.items, 10);
    const items = Number.isInteger(rawItems) && rawItems > 0
      ? Math.min(rawItems, 99)
      : 1;

    const { rows: statusRows } = await pool.query(
      `SELECT status, selling_ends_at
       FROM merchant_status
       WHERE merchant_id = $1`,
      [req.params.id]
    );
    const storeStatus = statusRows[0]?.status ?? 'ปิดร้าน';
    const sellingEndsAt = statusRows[0]?.selling_ends_at ?? null;
    const now = new Date();
    const accepting =
      storeStatus === 'เปิดร้าน' &&
      (!sellingEndsAt || new Date(sellingEndsAt) > now);

    const { rows: prepRows } = await pool.query(
      `SELECT prep_minutes
       FROM merchant_prep_time
       WHERE merchant_id = $1`,
      [req.params.id]
    );
    const perItemMinutes = await getPerItemMinutes(
      pool,
      req.params.id,
      prepRows[0]?.prep_minutes
    );

    const { rows: orderRows } = await pool.query(
      `SELECT
         COALESCE(
           mo.merchant_status,
           CASE
             WHEN o.status = 'รับอาหารสำเร็จแล้ว' THEN 'เสร็จสิ้น'
             WHEN o.status IN ('ปฏิเสธ', 'ยกเลิก') THEN 'ยกเลิก'
             ELSE 'ใหม่'
           END
         ) AS merchant_status,
         mo.prep_minutes,
         mo.updated_at AS accepted_at,
         COALESCE(
           (
             SELECT SUM(oi.quantity)::int
             FROM order_items oi
             WHERE oi.order_id = o.id
           ),
           1
         ) AS item_qty
       FROM orders o
       LEFT JOIN merchant_orders mo
         ON mo.source_order_id = o.id
        AND mo.merchant_id = o.merchant_id
       WHERE o.merchant_id = $1
         AND o.status NOT IN (
           'รับอาหารสำเร็จแล้ว',
           'ปฏิเสธ',
           'ยกเลิก',
           'CANCELLED',
           'CANCELED'
         )`,
      [req.params.id]
    );

    // นับเฉพาะออเดอร์ที่ยังทำอยู่ (ที่ทำเสร็จรอรับแล้วไม่ถือเป็นคิว)
    const queueRows = orderRows.filter((row) =>
      ETA_COOKING_STATUSES.includes(row.merchant_status)
    );

    const eta = calcOrderEta({
      queueRows,
      perItemMinutes,
      items,
      now,
      sellingEndsAt
    });

    // ช่วงเวลารับอาหาร เช่น 20–30 นาที
    const range = calcReadyRange(eta.waitMinutes);
    const readyMinAt = new Date(now.getTime() + range.minMinutes * 60000);
    const readyMaxAt = new Date(now.getTime() + range.maxMinutes * 60000);
    const rangeClock =
      `${formatEtaClock(readyMinAt)}–${formatEtaClock(readyMaxAt)}`;

    let message;
    if (!accepting) {
      message = 'ขณะนี้ร้านยังไม่เปิดรับออเดอร์';
    } else if (eta.closesBeforeReady) {
      message =
        `ร้านจะปิดเวลา ${formatEtaClock(new Date(sellingEndsAt))} น. ` +
        `แต่ออเดอร์นี้คาดว่าเสร็จประมาณ ${rangeClock} น. อาจรับไม่ทัน`;
    } else if (eta.isBusy) {
      message =
        `คิวเยอะ อาจรอ ${range.minMinutes}–${range.maxMinutes} นาที ` +
        `(ประมาณ ${rangeClock} น.)`;
    } else {
      message =
        `คาดว่าจะได้รับใน ${range.minMinutes}–${range.maxMinutes} นาที ` +
        `(ประมาณ ${rangeClock} น.)`;
    }

    res.json({
      success: true,
      accepting,
      store_status: storeStatus,
      selling_ends_at: sellingEndsAt,
      queue_count: eta.queueCount,
      wait_minutes: eta.waitMinutes,
      ready_at: eta.readyAt.toISOString(),
      per_item_minutes: perItemMinutes,
      is_busy: eta.isBusy,
      busy_threshold_minutes: ETA_BUSY_THRESHOLD_MINUTES,
      closes_before_ready: eta.closesBeforeReady,
      min_minutes: range.minMinutes,
      max_minutes: range.maxMinutes,
      ready_min_at: readyMinAt.toISOString(),
      ready_max_at: readyMaxAt.toISOString(),
      message
    });
  } catch (error) {
    console.error('Error calculating order eta:', error);

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถคำนวณเวลาคิวได้'
    });
  }
});

// ==========================================================
// GET /api/merchants/:id/orders/:orderId/queue
// คิวของออเดอร์สำหรับลูกค้า: คิวที่ / เหลืออีกกี่คิว / ช่วงเวลาพร้อมรับ
// ==========================================================
router.get('/:id/orders/:orderId/queue', async (req, res) => {
  try {
    const info = await getOrderQueueInfo(pool, req.params.id, req.params.orderId);
    res.json({
      success: true,
      in_queue: info.inQueue,
      queue_number: info.queueNumber ?? null,
      orders_ahead: info.ordersAhead ?? null,
      queue_count: info.queueCount,
      ready_min_at: info.readyMinAt ? info.readyMinAt.toISOString() : null,
      ready_max_at: info.readyMaxAt ? info.readyMaxAt.toISOString() : null
    });
  } catch (error) {
    console.error('Error fetching order queue:', error);
    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดคิวได้'
    });
  }
});

// ออเดอร์ที่ยังค้างอยู่ของร้าน (ยังไม่ส่งมอบและไม่ถูกยกเลิก)
const ACTIVE_ORDER_CLOSED_STATUSES = [
  'รับอาหารสำเร็จแล้ว',
  'ปฏิเสธ',
  'ยกเลิก',
  'CANCELLED',
  'CANCELED'
];

// ==========================================================
// GET /api/merchants/:id/orders/active-count
// จำนวนออเดอร์ที่ยังค้าง ใช้ถามร้านก่อนปิดร้านหรือย้ายร้าน
// ==========================================================
router.get('/:id/orders/active-count', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM orders o
       LEFT JOIN merchant_orders mo
         ON mo.source_order_id = o.id
        AND mo.merchant_id = o.merchant_id
       WHERE o.merchant_id = $1
         AND o.status <> ALL($2::text[])
         AND COALESCE(mo.merchant_status, 'ใหม่') NOT IN ('เสร็จสิ้น', 'ยกเลิก')`,
      [req.params.id, ACTIVE_ORDER_CLOSED_STATUSES]
    );
    res.json({ success: true, count: rows[0]?.count ?? 0 });
  } catch (error) {
    console.error('Error counting active orders:', error);
    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดจำนวนออเดอร์ได้'
    });
  }
});

// ==========================================================
// POST /api/merchants/:id/orders/cancel-active
// ร้านมีเหตุขัดข้อง: ยกเลิกออเดอร์ที่ค้างทั้งหมด และแจ้งลูกค้าทุกคน
// ==========================================================
router.post('/:id/orders/cancel-active', async (req, res) => {
  const reason =
    String(req.body?.reason || '').trim() || 'ร้านมีเหตุขัดข้อง';
  let connection;

  try {
    connection = await pool.connect();
    await connection.query('BEGIN');

    const { rows: activeOrders } = await connection.query(
      `SELECT o.id, o.customer_id
       FROM orders o
       LEFT JOIN merchant_orders mo
         ON mo.source_order_id = o.id
        AND mo.merchant_id = o.merchant_id
       WHERE o.merchant_id = $1
         AND o.status <> ALL($2::text[])
         AND COALESCE(mo.merchant_status, 'ใหม่') NOT IN ('เสร็จสิ้น', 'ยกเลิก')
       FOR UPDATE OF o`,
      [req.params.id, ACTIVE_ORDER_CLOSED_STATUSES]
    );

    const orderIds = activeOrders.map((row) => row.id);

    if (orderIds.length > 0) {
      await connection.query(
        `UPDATE merchant_orders
         SET merchant_status = 'ยกเลิก',
             reject_reason = $3,
             rejected_at = NOW()
         WHERE merchant_id = $1
           AND source_order_id = ANY($2::int[])`,
        [req.params.id, orderIds, reason]
      );

      await connection.query(
        `UPDATE orders
         SET status = 'ยกเลิก',
             updated_at = NOW()
         WHERE merchant_id = $1
           AND id = ANY($2::int[])`,
        [req.params.id, orderIds]
      );
    }

    await connection.query('COMMIT');

    for (const order of activeOrders) {
      notifyOrderCancelledByMerchant(order.customer_id, order.id, reason);
    }

    res.json({
      success: true,
      cancelled: orderIds.length,
      message: `ยกเลิกออเดอร์ที่ค้าง ${orderIds.length} รายการแล้ว`
    });
  } catch (error) {
    if (connection) {
      await connection.query('ROLLBACK');
    }
    console.error('Error cancelling active orders:', error);
    res.status(500).json({
      success: false,
      message: 'ไม่สามารถยกเลิกออเดอร์ได้'
    });
  } finally {
    connection?.release();
  }
});

// ==========================================================
// PUT /api/merchants/:id/orders/:orderId/status
// อัปเดตสถานะฝั่งร้านและลูกค้าให้ตรงกัน
// ==========================================================
router.put(
  '/:id/orders/:orderId/status',
  async (req, res) => {
    const allowedStatuses = [
      'รอชำระเงิน',
      'กำลังปรุง',
      'รอรับสินค้า',
      'ยกเลิก'
    ];

    const {
      status,
      prep_minutes,
      reject_reason,
      merchant_confirmed_payment
    } = req.body;
    const merchantConfirmedPayment = merchant_confirmed_payment === true;

    const customerStatusByMerchantStatus = {
      'รอชำระเงิน': 'รอชำระเงิน',
      'กำลังปรุง': 'ชำระเงินแล้ว',
      'รอรับสินค้า': 'พร้อมรับ',
      'ยกเลิก': 'ยกเลิก'
    };

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

    let connection;

    try {
      connection = await pool.connect();
      await connection.query('BEGIN');

      const { rows: customerOrders } =
        await connection.query(
          `SELECT
             o.status,
             o.transaction_id,
             (
               SELECT mo.merchant_status
               FROM merchant_orders mo
               WHERE mo.source_order_id = o.id
                 AND mo.merchant_id = o.merchant_id
               LIMIT 1
             ) AS merchant_status
           FROM orders o
           WHERE o.id = $1
             AND o.merchant_id = $2
           FOR UPDATE`,
          [req.params.orderId, req.params.id]
        );

      if (customerOrders.length === 0) {
        await connection.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message:
            'ไม่พบออเดอร์ฝั่งลูกค้า'
        });
      }

      const customerOrder =
        customerOrders[0];
      const customerHasPaid =
        Boolean(
          customerOrder.transaction_id
        ) ||
        [
          'PAID',
          'ชำระเงินแล้ว',
          'พร้อมรับ',
          'รับอาหารสำเร็จแล้ว'
        ].includes(
          customerOrder.status
        ) ||
        customerOrder.merchant_status ===
          'ชำระเงินแล้ว';

      if (
        (status === 'กำลังปรุง' || status === 'รอรับสินค้า') &&
        !customerHasPaid &&
        !merchantConfirmedPayment
      ) {
        await connection.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message:
            'ลูกค้ายังไม่ได้ชำระเงิน'
        });
      }

      if (status === 'กำลังปรุง') {
        const { rows: latestSlips } = await connection.query(
          `SELECT 1
           FROM order_slips
           WHERE order_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [req.params.orderId]
        );

        if (latestSlips.length === 0) {
          await connection.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            message: 'ยังไม่พบหลักฐานสลิปสำหรับยืนยัน'
          });
        }

        if (merchantConfirmedPayment) {
          await connection.query(
            `UPDATE order_slips
             SET status = 'VERIFIED',
                 verified_at = COALESCE(verified_at, NOW()),
                 validation_reason = COALESCE(validation_reason, 'ร้านค้ายืนยันรับเงินด้วยตนเอง')
             WHERE id = (
               SELECT id
               FROM order_slips
               WHERE order_id = $1
               ORDER BY created_at DESC
               LIMIT 1
             )`,
            [req.params.orderId]
          );
        } else {
          const { rows: verifiedSlips } = await connection.query(
            `SELECT 1
             FROM order_slips
             WHERE order_id = $1
               AND status = 'VERIFIED'
             ORDER BY created_at DESC
             LIMIT 1`,
            [req.params.orderId]
          );

          if (verifiedSlips.length === 0) {
            await connection.query('ROLLBACK');
            return res.status(409).json({
              success: false,
              message: 'ยังไม่พบสลิปที่ผ่านการตรวจสอบ'
            });
          }
        }
      }

      // รับออเดอร์โดยไม่ระบุเวลาเตรียม (รับอัตโนมัติจากแอปร้าน)
      // ให้ระบบคำนวณจากคิวจริงเป็นเวลาช้าสุดของช่วง เฉพาะออเดอร์ที่ยังไม่เคยมีเวลาเตรียม
      let effectivePrepMinutes = prep_minutes ?? null;
      let autoAccepted = false;
      if (status === 'รอชำระเงิน' && effectivePrepMinutes === null) {
        const { rows: currentPrepRows } = await connection.query(
          `SELECT prep_minutes
           FROM merchant_orders
           WHERE merchant_id = $1
             AND source_order_id = $2`,
          [req.params.id, req.params.orderId]
        );

        if (
          currentPrepRows.length > 0 &&
          currentPrepRows[0].prep_minutes === null
        ) {
          effectivePrepMinutes = await estimateAutoPrepMinutes(
            connection,
            req.params.id,
            req.params.orderId
          );
          autoAccepted = true;
        }
      }

      const result =
        await connection.query(
          `UPDATE merchant_orders

           SET
             merchant_status = $1,

             prep_minutes =
               COALESCE(
                 $2,
                  prep_minutes
               ),

             updated_at =
               CASE
                 WHEN $2 IS NOT NULL THEN NOW()
                 ELSE updated_at
               END,

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
            effectivePrepMinutes,
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
        await connection.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message:
            'ไม่พบออเดอร์ฝั่งร้าน'
        });
      }

      const customerStatus =
        customerStatusByMerchantStatus[
          status
        ];

      const customerOrderResult =
        await connection.query(
          `UPDATE orders
           SET
             status = $1,
             payment_deadline =
               CASE
                 WHEN $1 = 'รอชำระเงิน'
                 THEN NOW() + INTERVAL '5 minutes'
                 ELSE payment_deadline
               END,
             updated_at = NOW()
           WHERE id = $2
             AND merchant_id = $3`,
          [
            customerStatus,
            req.params.orderId,
            req.params.id
          ]
        );

      if (
        customerOrderResult.rowCount === 0
      ) {
        await connection.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message:
            'ไม่พบออเดอร์ฝั่งลูกค้า'
        });
      }

      await connection.query('COMMIT');

      // แจ้งลูกค้าว่าร้านรับออเดอร์แล้ว พร้อมคิวและช่วงเวลา (ทำงานเบื้องหลัง ไม่รอผล)
      if (autoAccepted) {
        notifyOrderAccepted(req.params.id, req.params.orderId);
      }

      res.json({
        success: true,
        merchant_status: status,
        customer_status: customerStatus
      });
    } catch (error) {
      if (connection) {
        await connection.query('ROLLBACK');
      }

      console.error(
        'Error updating merchant order:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          'ไม่สามารถอัปเดตออเดอร์ได้'
      });
    } finally {
      connection?.release();
    }
  }
);

// ==========================================================
// GET /api/merchants/:id/top-menus?period=today|week
// เมนูขายดี 5 อันดับ นับจากออเดอร์ที่ส่งมอบแล้ว (ไม่นับที่ยกเลิก)
// ==========================================================
router.get('/:id/top-menus', async (req, res) => {
  try {
    const period = req.query.period === 'week' ? 'week' : 'today';
    const dateCondition = period === 'week'
      ? `DATE(COALESCE(o.completed_at, o.paid_at, mo.updated_at, mo.ordered_at))
           >= DATE_TRUNC('week', CURRENT_DATE)::date`
      : `DATE(COALESCE(o.completed_at, o.paid_at, mo.updated_at, mo.ordered_at))
           = CURRENT_DATE`;

    const { rows } = await pool.query(
      `SELECT
         oi.item_name AS name,
         SUM(oi.quantity)::int AS quantity,
         SUM(oi.quantity * oi.price) AS sales
       FROM order_items oi
       JOIN orders o
         ON o.id = oi.order_id
       LEFT JOIN merchant_orders mo
         ON mo.source_order_id = o.id
        AND mo.merchant_id = o.merchant_id
       WHERE o.merchant_id = $1
         AND (
           o.status = 'รับอาหารสำเร็จแล้ว'
           OR mo.merchant_status = 'เสร็จสิ้น'
         )
         AND COALESCE(mo.merchant_status, '') <> 'ยกเลิก'
         AND o.status NOT IN ('ปฏิเสธ', 'ยกเลิก', 'CANCELLED', 'CANCELED')
         AND ${dateCondition}
       GROUP BY oi.item_name
       ORDER BY quantity DESC, sales DESC
       LIMIT 5`,
      [req.params.id]
    );

    res.json({ success: true, period, data: rows });
  } catch (error) {
    console.error('Error fetching top menus:', error);
    res.status(500).json({
      success: false,
      message: 'ไม่สามารถโหลดเมนูขายดีได้'
    });
  }
});

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
           mo.merchant_id,
           DATE(COALESCE(o.completed_at, o.paid_at, mo.updated_at, mo.ordered_at)),
           COUNT(*),
           SUM(COALESCE(mo.total_price, o.total_price))

         FROM merchant_orders mo

         LEFT JOIN orders o
           ON o.id = mo.source_order_id
          AND o.merchant_id = mo.merchant_id

         WHERE mo.merchant_id = $1

           -- ชำระเงินหน้าร้าน: นับเฉพาะออเดอร์ที่ร้านกดส่งมอบแล้ว ไม่นับที่ยกเลิก และไม่หักค่าคอม
           AND (
             o.status = 'รับอาหารสำเร็จแล้ว'
             OR mo.merchant_status = 'เสร็จสิ้น'
           )
           AND mo.merchant_status <> 'ยกเลิก'
           AND COALESCE(o.status, '') NOT IN ('ปฏิเสธ', 'ยกเลิก', 'CANCELLED', 'CANCELED')

         GROUP BY
           mo.merchant_id,
           DATE(COALESCE(o.completed_at, o.paid_at, mo.updated_at, mo.ordered_at))`,
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

      const {
        rows: periodTotals
      } = await pool.query(
        `SELECT
           COALESCE(
             SUM(total_orders) FILTER (
               WHERE sale_date = CURRENT_DATE
             ),
             0
           )::int AS today_orders,
           COALESCE(
             SUM(total_sales) FILTER (
               WHERE sale_date = CURRENT_DATE
             ),
             0
           ) AS today_sales,
           COALESCE(
             SUM(total_orders) FILTER (
               WHERE sale_date >= DATE_TRUNC('week', CURRENT_DATE)::date
             ),
             0
           )::int AS week_orders,
           COALESCE(
             SUM(total_sales) FILTER (
               WHERE sale_date >= DATE_TRUNC('week', CURRENT_DATE)::date
             ),
             0
           ) AS week_sales,
           COALESCE(
             SUM(total_orders) FILTER (
               WHERE sale_date >= DATE_TRUNC('year', CURRENT_DATE)::date
             ),
             0
           )::int AS year_orders,
           COALESCE(
             SUM(total_sales) FILTER (
               WHERE sale_date >= DATE_TRUNC('year', CURRENT_DATE)::date
             ),
             0
           ) AS year_sales

         FROM merchant_sales_summary

         WHERE merchant_id = $1`,
        [req.params.id]
      );

      const period = periodTotals[0] || {};

      res.json({
        success: true,
        daily,
        today: {
          orders: Number(period.today_orders || 0),
          sales: period.today_sales || 0
        },
        week: {
          orders: Number(period.week_orders || 0),
          sales: period.week_sales || 0
        },
        year: {
          orders: Number(period.year_orders || 0),
          sales: period.year_sales || 0
        },
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

    const allowedPromptPayTypes = ['PHONE'];

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

      if (!/^0\d{9}$/.test(cleanPromptPayId)) {
        return res.status(400).json({
          success: false,
          message:
            'หมายเลขโทรศัพท์ไม่ถูกต้อง'
        });
      }
    }

    const connection =
      await pool.connect();

    try {
      await connection.query(
        'BEGIN'
      );

      // Serialize additions for this merchant before counting both payment types.
      await connection.query(
        'SELECT id FROM merchant WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      const accountCount = await connection.query(
        'SELECT COUNT(*) AS total FROM merchant_bank_accounts WHERE merchant_id = $1',
        [req.params.id]
      );
      if (Number(accountCount.rows[0].total) >= 2) {
        await connection.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          code: 'BANK_ACCOUNT_LIMIT_REACHED',
          message: 'คุณเพิ่มธนาคารเต็ม 2 บัญชีแล้ว'
        });
      }

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

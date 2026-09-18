/**
 * Payment Routes สำหรับ Express.js Backend เชื่อมต่อกับ Supabase PostgreSQL
 * 
 * รองรับ:
 * - ดึงข้อมูลช่องทางชำระเงินของร้านค้าจาก Supabase จริง (ตาราง merchant_bank_accounts / merchants)
 * - อัปเดตสถานะคำสั่งซื้อใน Supabase เป็น 'PAID' ทันทีเมื่อตรวจสลิปผ่าน
 * - ตรวจสอบสลิปในเครื่อง 100% ป้องกันสลิปซ้ำผ่าน Transaction ID
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { generatePromptPayPayload } = require('../services/promptPayService');
const { sendMerchantNotification } = require('../../services/merchant_push_notification');

const { createWorker } = require('tesseract.js');
let pool = null;
try {
  const dbConfig = require('../../config/db');
  pool = dbConfig.pool;
  console.log('🔗 [Payment Module] เชื่อมต่อกับ Supabase PostgreSQL สำเร็จ');
} catch (e) {
  console.warn('⚠️ [Payment Module] ไม่พบ ../../config/db จะใช้โหมด Standalone / Fallback แทน');
}

// ตั้งค่า Multer เก็บรูปสลิปในหน่วยความจำ Memory (ขนาดไม่เกิน 5MB)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: (parseInt(process.env.MAX_SLIP_FILE_SIZE_MB, 10) || 5) * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('กรุณาอัปโหลดไฟล์รูปภาพเท่านั้น (JPEG, PNG, WEBP)'));
    }
  }
});

// ตารางชื่อธนาคารภาษาไทย
const BANK_MAP = {
  'KBANK': 'ธนาคารกสิกรไทย',
  'SCB': 'ธนาคารไทยพาณิชย์',
  'KTB': 'ธนาคารกรุงไทย',
  'BBL': 'ธนาคารกรุงเทพ',
  'BAY': 'ธนาคารกรุงศรีอยุธยา',
  'TTB': 'ธนาคารทหารไทยธนชาต',
  'GSB': 'ธนาคารออมสิน'
};

const slipUploadDirectory = path.resolve(__dirname, '../../uploads/slips');

function normalisePaymentType(value) {
  return String(value || '').trim().toUpperCase() === 'PROMPTPAY'
    ? 'PROMPTPAY'
    : 'BANK_ACCOUNT';
}

function publicSlipUrl(req, fileName) {
  return `${req.protocol}://${req.get('host')}/uploads/slips/${fileName}`;
}

function getFileExtension(file) {
  const byMimeType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };
  return byMimeType[file.mimetype] || 'jpg';
}

async function performServerOcr(imageBuffer, expectedAmount) {
  try {
    const worker = await createWorker('tha+eng');
    const { data: { text } } = await worker.recognize(imageBuffer);
    await worker.terminate();

    const normalized = String(text || '').replace(/[๐-๙]/g, d => '0123456789'['๐๑๒๓๔๕๖๗๘๙'.indexOf(d)]).replaceAll('\u00a0', ' ');
    const amountPattern = /(?<!\d)(\d{1,3}(?:[,\s]\d{3})*|\d+)(?:[.,](\d{1,2}))?(?!\d)/g;
    const exp = Number(expectedAmount);
    const candidates = [];

    let match;
    while ((match = amountPattern.exec(normalized)) !== null) {
      const whole = match[1].replace(/[,\s]/g, '');
      const fraction = (match[2] || '').padEnd(2, '0');
      const val = parseFloat(fraction ? `${whole}.${fraction}` : whole);
      if (val && val > 0 && val <= 1000000) {
        candidates.push(val);
      }
    }

    const matching = candidates.find(a => Math.abs(a - exp) < 0.01);
    if (matching) {
      return {
        verified: true,
        detectedAmount: matching,
        ocrStatus: 'VERIFIED',
        ocrText: normalized,
        reason: `ระบบเซิร์ฟเวอร์อ่านยอดจากสลิปตรงกับยอดออเดอร์ (฿${matching.toFixed(2)})`
      };
    }

    const closest = candidates.length > 0
      ? candidates.reduce((prev, curr) => Math.abs(curr - exp) < Math.abs(prev - exp) ? curr : prev)
      : null;

    return {
      verified: false,
      detectedAmount: closest,
      ocrStatus: candidates.length > 0 ? 'REJECTED' : 'UNREADABLE',
      ocrText: normalized,
      reason: candidates.length > 0
        ? `ยอดจากสลิป ฿${closest.toFixed(2)} ไม่ตรงกับยอดที่ต้องชำระ ฿${exp.toFixed(2)}`
        : 'ระบบเซิร์ฟเวอร์อ่านยอดเงินจากสลิปไม่ได้ กรุณาแนบสลิปที่ชัดเจน'
    };
  } catch (err) {
    console.error('⚠️ [Server OCR Error]:', err.message);
    return null;
  }
}

function evaluateClientOcr({ expectedAmount, detectedAmount, ocrStatus, ocrText }) {
  const detected = Number(detectedAmount);
  const isAmountMatch = Number.isFinite(detected) &&
    Math.abs(detected - Number(expectedAmount)) < 0.01;
  const hasReadableText = String(ocrText || '').trim().length >= 3;

  if (String(ocrStatus || '').toUpperCase() === 'VERIFIED' &&
      isAmountMatch && hasReadableText) {
    return {
      verified: true,
      detectedAmount: detected,
      reason: 'ระบบอ่านยอดจากสลิปตรงกับยอดออเดอร์'
    };
  }

  if (!hasReadableText || String(ocrStatus || '').toUpperCase() === 'UNREADABLE') {
    return {
      verified: false,
      detectedAmount: Number.isFinite(detected) ? detected : null,
      reason: 'ระบบอ่านยอดเงินจากสลิปไม่ได้ กรุณาแนบสลิปที่ชัดเจน'
    };
  }

  return {
    verified: false,
    detectedAmount: Number.isFinite(detected) ? detected : null,
    reason: `ยอดจากสลิป ${Number.isFinite(detected) ? `฿${detected.toFixed(2)}` : 'ไม่ถูกต้อง'} ไม่ตรงกับยอดที่ต้องชำระ ฿${Number(expectedAmount).toFixed(2)}`
  };
}

/**
 * ดึงข้อมูลบัญชีธนาคารและพร้อมเพย์ของร้านค้าจาก Supabase PostgreSQL
 * @param {number|string} merchantId 
 */
async function getMerchantPaymentConfig(merchantId) {
  const cleanId = parseInt(merchantId, 10) || 1;

  if (pool) {
    try {
      // ค้นหาเฉพาะบัญชีหลักที่ร้านตั้งไว้ จึงไม่ส่งหลายช่องทางให้ลูกค้าเลือก
      let bankResult = null;
      try {
        bankResult = await pool.query(
          `SELECT *
           FROM merchant_bank_accounts
           WHERE merchant_id = $1 AND is_primary = 1
           ORDER BY id ASC
           LIMIT 1`,
          [cleanId]
        );
      } catch (_) {
        // กรณีชื่อตารางเป็น bank_accounts
        try {
          bankResult = await pool.query(
            'SELECT * FROM bank_accounts WHERE merchant_id = $1 AND is_primary = 1 ORDER BY id ASC LIMIT 1',
            [cleanId]
          );
        } catch (_) {}
      }

      // 2. ค้นหาชื่อร้านค้า (ชื่อตารางจริงของระบบคือ merchant)
      let merchantInfo = null;
      try {
        const mRes = await pool.query('SELECT * FROM merchant WHERE id = $1 LIMIT 1', [cleanId]);
        if (mRes.rows.length > 0) merchantInfo = mRes.rows[0];
      } catch (_) {}

      if (bankResult && bankResult.rows.length > 0) {
        const acc = bankResult.rows[0];
        const paymentType = normalisePaymentType(acc.payment_type);
        const bankCode = (acc.bank_code || acc.bank || 'KBANK').toUpperCase();
        const bankName = acc.bank_name || BANK_MAP[bankCode] || 'ธนาคารกสิกรไทย';
        const accNo = acc.account_number || acc.account_no || '';
        const accName = acc.account_name || acc.holder_name || merchantInfo?.name || merchantInfo?.title || 'ร้านค้า Food Truck';
        const promptpay = acc.promptpay_id || acc.promptpay_number || acc.promptpay || '';

        return {
          id: cleanId,
          name: merchantInfo?.name || merchantInfo?.title || 'ร้านค้า Food Truck',
          primaryChannel: paymentType,
          promptpay: paymentType === 'PROMPTPAY' ? promptpay : '',
          bankAccount: paymentType === 'BANK_ACCOUNT' && accNo ? {
            bank: bankCode,
            bankName: bankName,
            accountNumber: accNo,
            accountName: accName
          } : null
        };
      }
    } catch (dbErr) {
      console.warn('⚠️ เกิดข้อผิดพลาดในการ Query ธนาคารร้านค้า:', dbErr.message);
    }
  }

  // ไม่มีบัญชีหลัก: ห้ามเดาบัญชีหรือแสดง QR สำรองให้ลูกค้าจ่ายผิดร้าน
  return {
    id: cleanId,
    name: 'ร้านค้า',
    promptpay: '',
    primaryChannel: null,
    bankAccount: null
  };
}

/**
 * Handler สำหรับดึงข้อมูลชำระเงิน
 */
async function handleGetPaymentInfo(req, res) {
  try {
    const { orderId } = req.params;
    const cleanOrderId = orderId.toString().replace(/[^0-9]/g, '');

    let orderTotal = null;
    let merchantId = null;
    let paymentDeadline = null;

    // ดึงข้อมูลยอดเงินและ merchant_id ของออเดอร์จากตาราง orders ใน Supabase
    if (pool) {
      try {
        const orderRes = await pool.query(
          `SELECT id, total_price, merchant_id, status, payment_deadline
           FROM orders
           WHERE id = $1
           LIMIT 1`,
          [cleanOrderId]
        );
        if (orderRes.rows.length === 0) {
          return res.status(404).json({ success: false, message: 'ไม่พบออเดอร์นี้' });
        }
        const ord = orderRes.rows[0];
        orderTotal = parseFloat(ord.total_price);
        merchantId = ord.merchant_id;
        paymentDeadline = ord.payment_deadline;

          // ออเดอร์เก่าที่เพิ่งเปิดหน้าชำระเงิน ให้มีเวลา 5 นาทีครั้งเดียว
        if (!paymentDeadline && ord.status === 'รอชำระเงิน') {
          const deadlineResult = await pool.query(
            `UPDATE orders
             SET payment_deadline = NOW() + INTERVAL '5 minutes',
                 updated_at = NOW()
             WHERE id = $1
             RETURNING payment_deadline`,
            [cleanOrderId]
          );
          paymentDeadline = deadlineResult.rows[0]?.payment_deadline || null;
        }
      } catch (err) {
        console.warn('⚠️ ไม่สามารถ Query ข้อมูลออเดอร์จาก Supabase ได้ (ใช้ค่ายอดเงินที่ส่งมา):', err.message);
      }
    }

    if (!pool || merchantId == null || orderTotal == null) {
      return res.status(503).json({ success: false, message: 'ไม่สามารถอ่านข้อมูลชำระเงินจากฐานข้อมูลได้' });
    }

    const merchant = await getMerchantPaymentConfig(merchantId);
    if (!merchant.primaryChannel ||
        (merchant.primaryChannel === 'PROMPTPAY' && !merchant.promptpay) ||
        (merchant.primaryChannel === 'BANK_ACCOUNT' && !merchant.bankAccount)) {
      return res.status(422).json({ success: false, message: 'ร้านค้ายังไม่ได้ตั้งบัญชีหลักสำหรับรับชำระเงิน' });
    }

    let promptPayPayload = null;
    if (merchant.primaryChannel === 'PROMPTPAY' && merchant.promptpay) {
      promptPayPayload = generatePromptPayPayload(merchant.promptpay, orderTotal);
    }

    return res.json({
      success: true,
      data: {
        orderId: cleanOrderId,
        totalPrice: orderTotal,
        primaryChannel: merchant.primaryChannel,
        paymentDeadline,
        merchant: {
          id: merchant.id,
          name: merchant.name
        },
        promptPay: merchant.primaryChannel === 'PROMPTPAY' ? {
          target: merchant.promptpay,
          qrPayload: promptPayPayload
        } : null,
        bankAccount: merchant.primaryChannel === 'BANK_ACCOUNT' && merchant.bankAccount ? {
          bank: merchant.bankAccount.bank,
          bankName: merchant.bankAccount.bankName,
          accountNumber: merchant.bankAccount.accountNumber,
          accountName: merchant.bankAccount.accountName
        } : null
      }
    });
  } catch (error) {
    console.error('Error fetching payment info:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * Handler สำหรับรับรูปสลิป ตรวจสอบ และอัปเดตสถานะออเดอร์
 */
async function handlePostPaymentSlip(req, res) {
  let connection;
  let savedFilePath = null;
  try {
    const { orderId } = req.params;
    const cleanOrderId = orderId.toString().replace(/[^0-9]/g, '');

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'กรุณาแนบรูปภาพสลิปการโอนเงิน'
      });
    }

    if (!pool) {
      return res.status(503).json({
        success: false,
        message: 'ระบบตรวจสอบสลิปยังไม่พร้อมใช้งาน'
      });
    }

    connection = await pool.connect();
    await connection.query('BEGIN');

    const { rows: orders } = await connection.query(
      `SELECT id, customer_id, merchant_id, total_price, status, payment_deadline
       FROM orders
       WHERE id = $1
       FOR UPDATE`,
      [cleanOrderId]
    );

    if (orders.length === 0) {
      await connection.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'ไม่พบออเดอร์นี้' });
    }

    const order = orders[0];
    const expectedAmount = Number(order.total_price);
    const now = Date.now();
    if (order.payment_deadline && new Date(order.payment_deadline).getTime() < now) {
      await connection.query('ROLLBACK');
      return res.status(422).json({
        success: false,
        code: 'PAYMENT_EXPIRED',
        message: 'หมดเวลาชำระเงินแล้ว กรุณาสร้างคำสั่งซื้อใหม่'
      });
    }

    if (['ชำระเงินแล้ว', 'PAID', 'พร้อมรับ', 'รับอาหารสำเร็จแล้ว'].includes(order.status)) {
      await connection.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'ออเดอร์นี้ชำระเงินแล้ว'
      });
    }

    const merchant = await getMerchantPaymentConfig(order.merchant_id);
    // ตรวจจากไฟล์ภาพบน Backend เท่านั้น ห้ามเชื่อค่า OCR/ยอดเงินที่ client ส่งมา
    // เพื่อป้องกันการปลอมค่าให้สลิปที่ไม่ผ่านกลายเป็นสลิปผ่าน
    console.log('🔍 [Server OCR] Executing server-side OCR on slip image...');
    const verification = await performServerOcr(req.file.buffer, expectedAmount) || {
      verified: false,
      detectedAmount: null,
      ocrStatus: 'UNREADABLE',
      ocrText: '',
      reason: 'ระบบเซิร์ฟเวอร์ไม่สามารถอ่านสลิปได้ กรุณาแนบสลิปจริงที่ชัดเจน'
    };

    const transactionId = `IMG_${crypto.createHash('sha256').update(req.file.buffer).digest('hex')}`;

    const { rows: duplicateSlips } = await connection.query(
      'SELECT id, order_id FROM order_slips WHERE transaction_id = $1 LIMIT 1',
      [transactionId]
    );
    if (duplicateSlips.length > 0) {
      await connection.query('ROLLBACK');
      return res.status(422).json({
        success: false,
        code: 'DUPLICATE_SLIP',
        message: `สลิปนี้ถูกใช้กับออเดอร์ #${duplicateSlips[0].order_id} แล้ว`
      });
    }

    await fs.mkdir(slipUploadDirectory, { recursive: true });
    const fileName = `order-${cleanOrderId}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${getFileExtension(req.file)}`;
    savedFilePath = path.join(slipUploadDirectory, fileName);
    await fs.writeFile(savedFilePath, req.file.buffer);
    const slipUrl = publicSlipUrl(req, fileName);
    const slipStatus = verification.verified ? 'VERIFIED' : 'REJECTED';

    await connection.query(
      `INSERT INTO order_slips
        (order_id, uploader_type, uploader_id, slip_url, amount, expected_amount,
         detected_amount, status, note, validation_reason, ocr_text,
         transaction_id, payment_channel, verified_at)
       VALUES
        ($1, 'CUSTOMER', $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11,
         CASE WHEN $7 = 'VERIFIED' THEN NOW() ELSE NULL END)`,
      [
        cleanOrderId,
        order.customer_id,
        slipUrl,
        verification.detectedAmount,
        expectedAmount,
        verification.detectedAmount,
        slipStatus,
        verification.reason,
        String(req.body.ocrText || '').slice(0, 8000),
        transactionId,
        merchant.primaryChannel
      ]
    );

    if (!verification.verified) {
      await connection.query('COMMIT');
      await sendMerchantNotification({
        merchantId: order.merchant_id,
        sourceType: 'payment_issue',
        sourceId: cleanOrderId,
        title: 'ตรวจพบสลิปผิดปกติ',
        message: `ออเดอร์ #${cleanOrderId}: ${verification.reason}`,
        data: { order_id: cleanOrderId, payment_status: 'REJECTED' }
      });
      return res.status(422).json({
        success: false,
        code: 'SLIP_REJECTED',
        status: 'REJECTED',
        message: verification.reason,
        detectedAmount: verification.detectedAmount
      });
    }

    await connection.query(
      `UPDATE orders
       SET status = 'ชำระเงินแล้ว',
           transaction_id = $1,
           paid_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [transactionId, cleanOrderId]
    );
    await connection.query(
      `UPDATE merchant_orders
       SET merchant_status = 'ชำระเงินแล้ว', updated_at = NOW()
       WHERE source_order_id = $1 AND merchant_id = $2`,
      [cleanOrderId, order.merchant_id]
    );
    await connection.query('COMMIT');

    await sendMerchantNotification({
      merchantId: order.merchant_id,
      sourceType: 'payment_verified',
      sourceId: cleanOrderId,
      title: 'ลูกค้าชำระเงินแล้ว',
      message: `ออเดอร์ #${cleanOrderId} ยอด ฿${expectedAmount.toFixed(2)} ตรวจสอบสลิปผ่านแล้ว กรุณาตรวจสอบและกดยืนยันรับสลิป`,
      data: { order_id: cleanOrderId, payment_status: 'VERIFIED' }
    });

    return res.json({
      success: true,
      message: 'ระบบตรวจสอบยอดชำระเรียบร้อย',
      status: 'VERIFIED',
      paymentStatus: 'ชำระเงินแล้ว',
      transactionId,
      paidAmount: verification.detectedAmount,
      matchReason: verification.reason
    });

  } catch (error) {
    if (connection) await connection.query('ROLLBACK');
    if (savedFilePath) await fs.unlink(savedFilePath).catch(() => {});
    console.error('❌ [Payment Verification Failed]: ' + error.message);
    return res.status(400).json({
      success: false,
      message: error.message
    });
  } finally {
    connection?.release();
  }
}

// ร้านค้าเปิดดูหลักฐานได้เฉพาะออเดอร์ของร้านตัวเอง
router.get('/merchants/:merchantId/orders/:orderId/payment-slip', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT os.order_id, os.slip_url, os.expected_amount, os.detected_amount,
              os.status, os.validation_reason, os.created_at,
              o.customer_id, c.name_surname AS customer_name
       FROM order_slips os
       JOIN orders o ON o.id::text = os.order_id
       LEFT JOIN customer c ON c.customer_id = o.customer_id
       WHERE os.order_id = $1 AND o.merchant_id = $2
       ORDER BY os.created_at DESC
       LIMIT 1`,
      [String(req.params.orderId).replace(/[^0-9]/g, ''), req.params.merchantId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบหลักฐานการชำระเงิน' });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ร้านรายงานเฉพาะสลิปที่ระบบตรวจไม่ผ่าน โดยไม่ใช่การยืนยันชำระเงิน
router.post('/merchants/:merchantId/orders/:orderId/payment-slip/report', async (req, res) => {
  try {
    const orderId = String(req.params.orderId).replace(/[^0-9]/g, '');
    const { rows } = await pool.query(
      `SELECT o.customer_id, os.validation_reason
       FROM orders o
       JOIN order_slips os ON os.order_id = o.id::text
       WHERE o.id = $1 AND o.merchant_id = $2 AND os.status = 'REJECTED'
       ORDER BY os.created_at DESC
       LIMIT 1`,
      [orderId, req.params.merchantId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'ไม่พบสลิปผิดปกติสำหรับออเดอร์นี้' });
    }

    const reason = rows[0].validation_reason || 'ระบบตรวจพบสลิปผิดปกติ';
    await pool.query(
      `INSERT INTO merchant_issue_reports
        (merchant_id, issue_type, order_reference, details, status)
       VALUES ($1, 'SLIP_MISMATCH', $2, $3, 'รอตรวจสอบ')`,
      [req.params.merchantId, `ORD-${orderId}`, reason]
    );
    await pool.query(
      `INSERT INTO notifications (user_id, title, body)
       VALUES ($1, 'สลิปการชำระเงินมีปัญหา', $2)`,
      [rows[0].customer_id, `ออเดอร์ #${orderId}: ${reason} กรุณาแนบสลิปใหม่`]
    );
    return res.json({ success: true, message: 'รายงานสลิปผิดปกติและแจ้งลูกค้าแล้ว' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// รองรับทั้งแบบ app.use('/api', paymentRoutes) และ app.use('/api/orders', paymentRoutes)
router.get('/orders/:orderId/payment-info', handleGetPaymentInfo);
router.get('/:orderId/payment-info', handleGetPaymentInfo);

router.post('/orders/:orderId/payment-slip', upload.single('slip'), handlePostPaymentSlip);
router.post('/:orderId/payment-slip', upload.single('slip'), handlePostPaymentSlip);

module.exports = router;

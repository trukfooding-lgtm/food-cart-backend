const express = require('express');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');

const { testConnection } = require('./config/db');
const customerRoutes = require('./routes/customers');
const merchantRoutes = require('./routes/merchants');
const ordersRoutes = require('./routes/orders');
const internalAccountStatusRoutes = require('./routes/internal_account_status');

const app = express();
const PORT = process.env.PORT || 3000;
const smtpUser = process.env.SMTP_USER?.trim();
const smtpPass = process.env.SMTP_PASS?.trim();
const smtpFrom = process.env.SMTP_FROM?.trim();

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  requireTLS: true,
  family: 4,
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

const otpStore = {};

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

app.get('/', (req, res) => {
  res.json({ message: 'Food Cart App API กำลังทำงานอยู่' });
});

app.use('/api/customers', customerRoutes);
app.use('/api/merchants', merchantRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/internal', internalAccountStatusRoutes);
const paymentRoutes = require('./backend_payment_module/routes/paymentRoutes');
app.use('/api', paymentRoutes);

app.post('/api/otp/send', async (req, res) => {
  const recipientEmail =
    typeof req.body?.email === 'string' ? req.body.email.trim() : '';

  if (!recipientEmail) {
    return res.status(400).json({
      success: false,
      message: 'กรุณาระบุอีเมล'
    });
  }

  if (!smtpUser || !smtpPass) {
    console.error('OTP email is unavailable: SMTP_USER/SMTP_PASS is not configured');
    return res.status(503).json({
      success: false,
      message: 'ระบบส่งอีเมลยังไม่ได้ตั้งค่า กรุณาติดต่อผู้ดูแลระบบ'
    });
  }

  const otp = Math.floor(
    100000 + Math.random() * 900000
  ).toString();

  try {
    await transporter.sendMail({
      from: smtpFrom || '"Food Cart App" <no-reply@gmail.com>',
      to: recipientEmail,
      subject:
        'รหัส OTP สำหรับตั้งรหัสผ่านใหม่ (Food Cart App)',
      html:
        '<h2>รหัสยืนยันตัวตนของคุณคือ</h2>' +
        '<h1 style="color: #00C7E6;">' +
        otp +
        '</h1>' +
        '<p>รหัสนี้มีอายุ 5 นาที</p>',
    });

    otpStore[recipientEmail] = {
      code: otp,
      expiresAt: Date.now() + (5 * 60 * 1000)
    };

    res.json({
      success: true,
      message: 'ส่ง OTP ไปยังอีเมลแล้ว!'
    });
  } catch (error) {
    console.error('Nodemailer Error:', {
      code: error.code,
      responseCode: error.responseCode,
      response: error.response,
      message: error.message,
    });

    res.status(500).json({
      success: false,
      message: 'ไม่สามารถส่งอีเมลได้'
    });
  }
});

app.post('/api/otp/verify', (req, res) => {
  const { email, otp } = req.body;

  const record = otpStore[email];

  if (
    !record ||
    Date.now() > record.expiresAt
  ) {
    return res.status(400).json({
      success: false,
      message: 'รหัส OTP หมดอายุ'
    });
  }

  if (record.code !== otp) {
    return res.status(400).json({
      success: false,
      message: 'รหัส OTP ไม่ถูกต้อง'
    });
  }

  delete otpStore[email];

  res.json({
    success: true,
    message: 'ยืนยันตัวตนสำเร็จ'
  });
});

app.use((req, res) => {
  res.status(404).json({
    message: 'ไม่พบ endpoint นี้'
  });
});

app.listen(PORT, async () => {
  console.log(
    'Server is running at http://localhost:' +
    PORT
  );

  await testConnection();
});

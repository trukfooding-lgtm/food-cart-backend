const express = require('express');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');

const { testConnection } = require('./config/db');
const customerRoutes = require('./routes/customers');
const merchantRoutes = require('./routes/merchants');
const ordersRoutes = require('./routes/orders');

const app = express();
const PORT = process.env.PORT || 3000;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { 
    user: process.env.SMTP_USER, 
    pass: process.env.SMTP_PASS 
  },
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
const paymentRoutes = require('./backend_payment_module/routes/paymentRoutes');
app.use('/api', paymentRoutes);

app.post('/api/otp/send', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      message: 'กรุณาระบุอีเมล'
    });
  }

  const otp = Math.floor(
    100000 + Math.random() * 900000
  ).toString();

  otpStore[email] = {
    code: otp,
    expiresAt: Date.now() + (5 * 60 * 1000)
  };

  try {
    await transporter.sendMail({
      from:
        process.env.SMTP_FROM ||
        '"Food Cart App" <no-reply@gmail.com>',
      to: email,
      subject:
        'รหัส OTP สำหรับตั้งรหัสผ่านใหม่ (Food Cart App)',
      html:
        '<h2>รหัสยืนยันตัวตนของคุณคือ</h2>' +
        '<h1 style="color: #00C7E6;">' +
        otp +
        '</h1>' +
        '<p>รหัสนี้มีอายุ 5 นาที</p>',
    });

    res.json({
      success: true,
      message: 'ส่ง OTP ไปยังอีเมลแล้ว!'
    });
  } catch (error) {
    console.error(
      'Nodemailer Error: ',
      error
    );

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
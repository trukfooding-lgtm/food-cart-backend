const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { testConnection } = require('./config/db');
const customerRoutes = require('./routes/customers');
const merchantRoutes = require('./routes/merchants');
const ordersRoutes = require('./routes/orders');
const internalAccountStatusRoutes = require('./routes/internal_account_status');

const app = express();
const PORT = process.env.PORT || 3000;
const brevoApiKey = process.env.BREVO_API_KEY?.trim();
const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL?.trim();
const brevoSenderName = process.env.BREVO_SENDER_NAME?.trim() || 'Food Cart App';

const otpStore = {};

async function sendOtpEmail(recipientEmail, otp) {
  const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': brevoApiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: {
        email: brevoSenderEmail,
        name: brevoSenderName,
      },
      to: [{ email: recipientEmail }],
      subject: 'รหัส OTP สำหรับตั้งรหัสผ่านใหม่ (Food Cart App)',
      htmlContent:
        '<h2>รหัสยืนยันตัวตนของคุณคือ</h2>' +
        '<h1 style="color: #00C7E6;">' +
        otp +
        '</h1>' +
        '<p>รหัสนี้มีอายุ 5 นาที</p>',
    }),
  });

  if (brevoResponse.ok) {
    return true;
  }

  console.error('Brevo OTP Error:', {
    status: brevoResponse.status,
    response: await brevoResponse.text(),
  });
  return false;
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

app.get('/', (req, res) => {
  res.json({ message: 'Food Cart App API กำลังทำงานอยู่' });
});

app.use('/api/customers', customerRoutes);
app.use('/api/merchants', merchantRoutes);
const paymentRoutes = require('./backend_payment_module/routes/paymentRoutes');
// Register the specific payment-slip endpoint before the legacy generic
// orders router, whose /:id/payment-slip route would otherwise intercept it.
app.use('/api', paymentRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/internal', internalAccountStatusRoutes);

app.post('/api/otp/send', async (req, res) => {
  const recipientEmail =
    typeof req.body?.email === 'string' ? req.body.email.trim() : '';

  if (!recipientEmail) {
    return res.status(400).json({
      success: false,
      message: 'กรุณาระบุอีเมล'
    });
  }

  if (!brevoApiKey || !brevoSenderEmail) {
    console.error('OTP email is unavailable: Brevo environment variables are not configured');
    return res.status(503).json({
      success: false,
      message: 'ระบบส่งอีเมลยังไม่ได้ตั้งค่า กรุณาติดต่อผู้ดูแลระบบ'
    });
  }

  const otp = Math.floor(
    100000 + Math.random() * 900000
  ).toString();

  try {
    if (!await sendOtpEmail(recipientEmail, otp)) {
      return res.status(500).json({
        success: false,
        message: 'ไม่สามารถส่งอีเมลได้'
      });
    }

    otpStore[recipientEmail] = {
      code: otp,
      expiresAt: Date.now() + (5 * 60 * 1000)
    };

    res.json({
      success: true,
      message: 'ส่ง OTP ไปยังอีเมลแล้ว!'
    });
  } catch (error) {
    console.error('Brevo OTP Error:', error.message);

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

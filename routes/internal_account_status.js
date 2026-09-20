const express = require('express');
const { applyAccountStatus, safeEqualSecret } = require('../services/account_status');

const router = express.Router();

router.post('/account-status', async (req, res) => {
  const configuredSecret = String(process.env.FOOD_CART_ADMIN_SECRET || '');
  const receivedSecret = String(req.get('x-foodcart-admin-secret') || '');
  if (!configuredSecret || !safeEqualSecret(receivedSecret, configuredSecret)) {
    return res.status(401).json({success: false, message: 'ไม่ได้รับอนุญาต'});
  }

  try {
    const result = await applyAccountStatus(req.body);
    return res.json({success: true, ...result});
  } catch (error) {
    console.error('Account status integration error:', error.message);
    return res.status(400).json({success: false, message: error.message || 'บันทึกสถานะบัญชีไม่สำเร็จ'});
  }
});

module.exports = router;

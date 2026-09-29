const API_URL = 'https://api.slipok.com/api/line/apikey';

function getSlipOkConfigState(env = process.env) {
  const apiKey = String(env.SLIPOK_API_KEY || '').trim();
  const branchId = String(env.SLIPOK_BRANCH_ID || '').trim();
  if (!apiKey && !branchId) return 'not-configured';
  if (!apiKey || !branchId) return 'incomplete';
  return 'configured';
}

function normalizeName(value) {
  return String(value || '').toLocaleLowerCase('th-TH').replace(/[^\p{L}\p{N}]/gu, '');
}

function receiverMatch(receiver, merchant) {
  const identifiers = (merchant?.recipientIdentifiers || [])
    .map(value => String(value || '').replace(/\D/g, ''))
    .filter(value => value.length >= 4);
  const receiverValues = [
    receiver?.account?.value,
    receiver?.proxy?.value
  ].map(value => String(value || ''));
  const maskedDigits = receiverValues.map(value => value.replace(/\D/g, ''));

  if (identifiers.some(expected => maskedDigits.some(actual =>
    actual.length >= 4 && expected.endsWith(actual.slice(-4))))) {
    return true;
  }

  const accountHasReadableDigits = maskedDigits.some(value => value.length >= 4);
  if (accountHasReadableDigits && identifiers.length > 0) return false;

  const names = [merchant?.recipientName, merchant?.name]
    .map(normalizeName).filter(value => value.length >= 4);
  const visibleReceiverNames = [receiver?.displayName, receiver?.name]
    .map(value => normalizeName(String(value || '').replace(/[*•xX]/g, '')))
    .filter(value => value.length >= 4);
  if (names.some(expected => visibleReceiverNames.some(actual =>
    expected.includes(actual) || actual.includes(expected)))) {
    return true;
  }

  return null;
}

function serializeSlipEvidence(data, amount) {
  return JSON.stringify({
    provider: 'SlipOK',
    amount,
    transRef: data?.transRef || null,
    transDate: data?.transDate || null,
    transTime: data?.transTime || null,
    transTimestamp: data?.transTimestamp || null,
    receiverName: data?.receiver?.displayName || data?.receiver?.name || null,
    receiverAccount: data?.receiver?.account?.value || null,
    receiverProxy: data?.receiver?.proxy?.value || null
  });
}

function resultForUnavailable(reason, providerData = null) {
  const data = providerData?.data || null;
  const amount = Number(data?.amount);
  return {
    verified: false,
    manualReview: true,
    detectedAmount: Number.isFinite(amount) ? amount : null,
    transactionId: data?.transRef ? String(data.transRef) : null,
    ocrStatus: 'MANUAL_REVIEW',
    ocrText: data ? serializeSlipEvidence(data, amount) : '',
    reason
  };
}

function validateSlipTransactionTime(data, {
  paymentWindowStart,
  paymentDeadline,
  now = new Date()
} = {}) {
  const timestamp = data?.transTimestamp;
  const transactionTime = typeof timestamp === 'string' ? new Date(timestamp) : null;
  const windowStart = paymentWindowStart ? new Date(paymentWindowStart) : null;
  const windowEnd = paymentDeadline ? new Date(paymentDeadline) : null;
  const checkedAt = new Date(now);

  if (!transactionTime || !Number.isFinite(transactionTime.getTime()) ||
      !windowStart || !Number.isFinite(windowStart.getTime())) {
    return {
      valid: false,
      manualReview: true,
      reason: 'ข้อมูลเวลาโอนหรือเวลาสร้างออเดอร์ไม่ครบ กรุณาให้ร้านตรวจสอบ'
    };
  }

  if (paymentDeadline && !Number.isFinite(windowEnd.getTime())) {
    return {
      valid: false,
      manualReview: true,
      reason: 'ข้อมูลกำหนดเวลาชำระเงินไม่ถูกต้อง กรุณาให้ร้านตรวจสอบ'
    };
  }

  if (!Number.isFinite(checkedAt.getTime())) {
    return {
      valid: false,
      manualReview: true,
      reason: 'ระบบอ่านเวลาปัจจุบันไม่ได้ กรุณาให้ร้านตรวจสอบ'
    };
  }

  if (transactionTime < windowStart) {
    return {
      valid: false,
      manualReview: false,
      reason: 'เวลาที่โอนในสลิปเกิดก่อนสร้างคำสั่งซื้อนี้'
    };
  }

  if (windowEnd && transactionTime > windowEnd) {
    return {
      valid: false,
      manualReview: false,
      reason: 'เวลาที่โอนในสลิปเกินกำหนดชำระของคำสั่งซื้อนี้'
    };
  }

  // SlipOK returns the bank transaction timestamp in UTC. Allow a small
  // clock skew but never accept a timestamp materially in the future.
  if (transactionTime.getTime() > checkedAt.getTime() + 60_000) {
    return {
      valid: false,
      manualReview: false,
      reason: 'เวลาโอนในสลิปอยู่ในอนาคต ไม่สามารถยืนยันการชำระเงินได้'
    };
  }

  return { valid: true, manualReview: false, reason: null };
}

async function fetchJsonWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return { response, body: await response.json() };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifySlipWithSlipOk({
  buffer,
  expectedAmount,
  fileName,
  contentType,
  merchant,
  paymentWindowStart,
  paymentDeadline,
  now = new Date(),
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  const apiKey = String(env.SLIPOK_API_KEY || '').trim();
  const branchId = String(env.SLIPOK_BRANCH_ID || '').trim();
  if (!apiKey || !branchId || typeof fetchImpl !== 'function') {
    return resultForUnavailable('ระบบตรวจสอบสลิปภายนอกยังตั้งค่าไม่ครบ กรุณาให้ร้านตรวจสอบ');
  }

  const form = new FormData();
  form.append('files', new Blob([buffer], { type: contentType || 'image/jpeg' }), fileName || 'slip.jpg');
  form.append('amount', String(Number(expectedAmount)));
  // ปิด log ฝั่งผู้ให้บริการ เพราะแต่ละร้านในแอปมีบัญชีรับเงินคนละบัญชี
  // ระบบแอปจะตรวจ transRef ซ้ำในฐานข้อมูลของตัวเองแทน
  form.append('log', 'false');

  let response;
  let body;
  try {
    const quotaResult = await fetchJsonWithTimeout(
      fetchImpl,
      `${API_URL}/${encodeURIComponent(branchId)}/quota`,
      { method: 'GET', headers: { 'x-authorization': apiKey } },
      10000
    );
    const remainingQuota = Number(quotaResult.body?.data?.quota);
    const overQuota = Number(quotaResult.body?.data?.overQuota || 0);
    if (!quotaResult.response.ok || quotaResult.body?.success !== true || !Number.isFinite(remainingQuota)) {
      return resultForUnavailable('ตรวจสอบโควตา SlipOK ไม่ได้ จึงส่งสลิปให้ร้านตรวจสอบแทน');
    }
    if (env.SLIPOK_ALLOW_OVER_QUOTA !== 'true' && (remainingQuota <= 0 || overQuota > 0)) {
      return resultForUnavailable('โควตาตรวจสลิปฟรีหมดแล้ว จึงส่งหลักฐานให้ร้านตรวจสอบแทน');
    }

    const checkResult = await fetchJsonWithTimeout(fetchImpl, `${API_URL}/${encodeURIComponent(branchId)}`, {
      method: 'POST',
      headers: { 'x-authorization': apiKey },
      body: form,
    }, 15000);
    response = checkResult.response;
    body = checkResult.body;
  } catch (error) {
    return resultForUnavailable('ติดต่อระบบตรวจสอบสลิปไม่ได้ กรุณาให้ร้านตรวจสอบหลักฐาน');
  }

  const data = body?.data || null;
  const detectedAmount = Number(data?.amount);
  const transactionId = data?.transRef ? String(data.transRef).trim() : null;
  const evidence = data ? serializeSlipEvidence(data, detectedAmount) : '';
  const invalidSlipCodes = new Set([1006, 1007, 1008, 1011, 1012]);

  if (!response.ok) {
    if (Number(body?.code) === 1013) {
      return {
        verified: false,
        manualReview: false,
        detectedAmount: Number.isFinite(detectedAmount) ? detectedAmount : null,
        transactionId,
        ocrStatus: 'REJECTED',
        ocrText: evidence,
        reason: Number.isFinite(detectedAmount)
          ? `ยอดจากสลิป ฿${detectedAmount.toFixed(2)} ไม่ตรงกับยอดที่ต้องชำระ ฿${Number(expectedAmount).toFixed(2)}`
          : 'ยอดเงินในสลิปไม่ตรงกับยอดคำสั่งซื้อ'
      };
    }
    if (invalidSlipCodes.has(Number(body?.code))) {
      return {
        verified: false,
        manualReview: false,
        detectedAmount: Number.isFinite(detectedAmount) ? detectedAmount : null,
        transactionId,
        ocrStatus: 'REJECTED',
        ocrText: evidence,
        reason: body?.message || 'ระบบตรวจพบว่าสลิปไม่ถูกต้องหรือถูกใช้ซ้ำ'
      };
    }
    return resultForUnavailable('ระบบตรวจสอบสลิปขัดข้องหรือใช้โควตาครบ กรุณาให้ร้านตรวจสอบ', body);
  }

  if (body?.success !== true || data?.success !== true || !Number.isFinite(detectedAmount) || !transactionId) {
    return resultForUnavailable('ระบบยังยืนยันข้อมูลสลิปได้ไม่ครบ กรุณาให้ร้านตรวจสอบ', body);
  }

  if (Math.abs(detectedAmount - Number(expectedAmount)) >= 0.01) {
    return {
      verified: false,
      manualReview: false,
      detectedAmount,
      transactionId,
      ocrStatus: 'REJECTED',
      ocrText: evidence,
      reason: `ยอดจากสลิป ฿${detectedAmount.toFixed(2)} ไม่ตรงกับยอดที่ต้องชำระ ฿${Number(expectedAmount).toFixed(2)}`
    };
  }

  const timeValidation = validateSlipTransactionTime(data, {
    paymentWindowStart,
    paymentDeadline,
    now
  });
  if (!timeValidation.valid) {
    return {
      verified: false,
      manualReview: timeValidation.manualReview,
      detectedAmount,
      transactionId,
      ocrStatus: timeValidation.manualReview ? 'MANUAL_REVIEW' : 'REJECTED',
      ocrText: evidence,
      reason: timeValidation.reason
    };
  }

  const recipient = receiverMatch(data.receiver, merchant);
  if (recipient !== true) {
    return {
      verified: false,
      manualReview: recipient === null,
      detectedAmount,
      transactionId,
      ocrStatus: recipient === null ? 'MANUAL_REVIEW' : 'REJECTED',
      ocrText: evidence,
      reason: recipient === null
        ? 'สลิปผ่านการตรวจสอบ แต่ยืนยันบัญชีผู้รับกับข้อมูลร้านไม่ได้ กรุณาให้ร้านตรวจสอบ'
        : 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีร้านค้า'
    };
  }

  return {
    verified: true,
    manualReview: false,
    detectedAmount,
    transactionId,
    ocrStatus: 'VERIFIED',
    ocrText: evidence,
    reason: 'SlipOK ยืนยันสลิป ยอดเงิน และบัญชีผู้รับตรงกับคำสั่งซื้อ'
  };
}

module.exports = {
  getSlipOkConfigState,
  verifySlipWithSlipOk,
  validateSlipTransactionTime
};

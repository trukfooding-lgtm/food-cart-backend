const DEFAULT_BUCKET = 'payment-slips';
const SIGNED_URL_TTL_SECONDS = 15 * 60;

class SlipStorageError extends Error {
  constructor(message, code = 'SLIP_STORAGE_ERROR') {
    super(message);
    this.name = 'SlipStorageError';
    this.code = code;
  }
}

function getConfig() {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const bucket = String(process.env.SLIP_STORAGE_BUCKET || DEFAULT_BUCKET);

  if (!baseUrl || !serviceRoleKey) {
    throw new SlipStorageError(
      'ยังไม่ได้ตั้งค่า SUPABASE_URL หรือ SUPABASE_SERVICE_ROLE_KEY สำหรับเก็บสลิป',
      'SLIP_STORAGE_NOT_CONFIGURED'
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(bucket)) {
    throw new SlipStorageError('ชื่อ SLIP_STORAGE_BUCKET ไม่ถูกต้อง');
  }
  return { baseUrl, serviceRoleKey, bucket };
}

function encodeObjectPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function storageHeaders(config, extra = {}) {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    ...extra
  };
}

async function readError(response) {
  const body = await response.text();
  return body || `${response.status} ${response.statusText}`;
}

function parseLocation(location) {
  const match = /^storage:\/\/([^/]+)\/(.+)$/.exec(String(location || ''));
  return match ? { bucket: match[1], objectPath: match[2] } : null;
}

async function uploadPaymentSlip({ orderId, fileName, buffer, contentType }) {
  const config = getConfig();
  const objectPath = `${String(orderId)}/${fileName}`;
  const response = await fetch(
    `${config.baseUrl}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodeObjectPath(objectPath)}`,
    {
      method: 'POST',
      headers: storageHeaders(config, {
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'false'
      }),
      body: buffer
    }
  );

  if (!response.ok) {
    throw new SlipStorageError(`อัปโหลดสลิปไปยัง Storage ไม่สำเร็จ: ${await readError(response)}`);
  }
  return `storage://${config.bucket}/${objectPath}`;
}

async function getPaymentSlipUrl(location) {
  const parsed = parseLocation(location);
  if (!parsed) return location;

  const config = getConfig();
  if (parsed.bucket !== config.bucket) {
    throw new SlipStorageError('ไม่อนุญาตให้อ่านสลิปจาก bucket อื่น');
  }
  const response = await fetch(
    `${config.baseUrl}/storage/v1/object/sign/${encodeURIComponent(parsed.bucket)}/${encodeObjectPath(parsed.objectPath)}`,
    {
      method: 'POST',
      headers: storageHeaders(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS })
    }
  );
  if (!response.ok) {
    throw new SlipStorageError(`สร้างลิงก์สลิปชั่วคราวไม่สำเร็จ: ${await readError(response)}`);
  }
  const result = await response.json();
  const signedUrl = result.signedURL || result.signedUrl;
  if (!signedUrl) throw new SlipStorageError('Storage ไม่ส่งลิงก์สลิปกลับมา');
  return new URL(signedUrl, config.baseUrl).toString();
}

async function deletePaymentSlip(location) {
  const parsed = parseLocation(location);
  if (!parsed) return;

  const config = getConfig();
  if (parsed.bucket !== config.bucket) return;
  const response = await fetch(
    `${config.baseUrl}/storage/v1/object/${encodeURIComponent(parsed.bucket)}`,
    {
      method: 'DELETE',
      headers: storageHeaders(config, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefixes: [parsed.objectPath] })
    }
  );
  if (!response.ok) {
    console.warn(`ลบสลิปที่ rollback ไม่สำเร็จ: ${await readError(response)}`);
  }
}

module.exports = {
  SlipStorageError,
  uploadPaymentSlip,
  getPaymentSlipUrl,
  deletePaymentSlip
};

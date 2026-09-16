const crypto = require('crypto');

const TOKEN_TTL_SECONDS = 24 * 60 * 60;

function getSecret() {
  return process.env.PAYMENT_EVIDENCE_TOKEN_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(value)
    .digest('base64url');
}

function createAccessToken(type, id) {
  if (!getSecret()) return null;

  const payload = encode({
    type,
    id: String(id),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  });

  return `${payload}.${sign(payload)}`;
}

function verifyAccessToken(token) {
  if (!getSecret() || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const expected = sign(parts[0]);
  const actual = parts[1];
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.type || !payload.id || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : null;
}

function requireAccessToken(req, res, next) {
  const payload = verifyAccessToken(bearerToken(req));
  if (!payload) {
    return res.status(401).json({
      success: false,
      message: 'ต้องเข้าสู่ระบบก่อนใช้งานข้อมูลนี้',
    });
  }
  req.actor = payload;
  next();
}

module.exports = { createAccessToken, requireAccessToken };

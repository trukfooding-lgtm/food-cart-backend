const DEFAULT_PUBLIC_BASE_URL = 'https://food-cart-c20i.onrender.com';
const UPLOADS_SEGMENT = 'uploads';

function getPublicBaseUrl(env = process.env) {
  const configured = String(env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).trim();
  let baseUrl;
  try {
    baseUrl = new URL(configured);
  } catch (_) {
    baseUrl = new URL(DEFAULT_PUBLIC_BASE_URL);
  }

  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    baseUrl = new URL(DEFAULT_PUBLIC_BASE_URL);
  } else if (
    baseUrl.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '0.0.0.0'].includes(baseUrl.hostname)
  ) {
    baseUrl.protocol = 'https:';
  }
  return baseUrl.origin;
}

function isSupabaseStorageUrl(url) {
  return url.pathname.includes('/storage/v1/object/');
}

function hasUploadsPath(url) {
  return url.pathname.split('/').includes(UPLOADS_SEGMENT);
}

function normalizeUploadImageUrl(imageUrl, env = process.env) {
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) return imageUrl;

  const value = imageUrl.trim();
  const publicBaseUrl = getPublicBaseUrl(env);
  const base = new URL(publicBaseUrl);
  let parsed;
  try {
    parsed = new URL(value, base);
  } catch (_) {
    return imageUrl;
  }

  if (isSupabaseStorageUrl(parsed) || !hasUploadsPath(parsed)) return imageUrl;

  const configuredHost = base.host;
  const knownUploadHosts = new Set([
    configuredHost,
    'food-cart-c20i.onrender.com',
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
  ]);
  if (parsed.host && !knownUploadHosts.has(parsed.host)) return imageUrl;

  return new URL(
    `${parsed.pathname}${parsed.search}${parsed.hash}`,
    publicBaseUrl,
  ).toString();
}

function normalizeMenuImageFields(menu, env = process.env) {
  return {
    ...menu,
    image_url: normalizeUploadImageUrl(menu?.image_url, env),
  };
}

module.exports = {
  getPublicBaseUrl,
  normalizeMenuImageFields,
  normalizeUploadImageUrl,
};

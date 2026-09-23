const { randomUUID } = require('crypto');

const MENU_IMAGES_BUCKET = 'menu-images';

function getConfig(env = process.env) {
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!baseUrl || !serviceRoleKey) {
    throw new Error('Supabase Storage is not configured for menu images');
  }
  return { baseUrl, serviceRoleKey };
}

function getExtension(fileName) {
  const safeName = String(fileName || '').replace(/\\/g, '/').split('/').pop();
  const extension = safeName.includes('.') ? safeName.slice(safeName.lastIndexOf('.')) : '';
  return /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : '';
}

async function uploadMenuImage({ fileName, buffer, contentType, env, fetchImpl }) {
  const { baseUrl, serviceRoleKey } = getConfig(env);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Menu image is empty');
  }

  const objectPath = `${randomUUID()}${getExtension(fileName)}`;
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  const response = await (fetchImpl || fetch)(
    `${baseUrl}/storage/v1/object/${MENU_IMAGES_BUCKET}/${encodedPath}`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: buffer,
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase Storage rejected menu image (${response.status})`);
  }

  return `${baseUrl}/storage/v1/object/public/${MENU_IMAGES_BUCKET}/${encodedPath}`;
}

module.exports = { uploadMenuImage };

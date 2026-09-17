/**
 * บริการสร้าง EMVCo PromptPay QR Code Payload
 * เขียนด้วย Pure JavaScript ไม่ขึ้นกับไลบรารีภายนอก ปลอดภัยและเสถียร 100%
 */

// คำนวณ CRC16-CCITT (Checksum ท้ายสตริงตามมาตรฐาน EMVCo)
function crc16(data) {
  var crc = 0xFFFF;
  for (var i = 0; i < data.length; i++) {
    var x = ((crc >> 8) ^ data.charCodeAt(i)) & 0xFF;
    x ^= x >> 4;
    crc = ((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// ฟอร์แมต TLV (Tag-Length-Value)
function formatTLV(tag, value) {
  var len = value.length.toString().padStart(2, '0');
  return tag + len + value;
}

// ฟอร์แมตเบอร์โทรศัพท์พร้อมเพย์เป็นมาตรฐานสากล (08x-xxx-xxxx -> 00668xxxxxxxx)
function formatPromptPayTarget(target) {
  var cleaned = target.replace(/[^0-9]/g, '');
  if (cleaned.length === 10 && cleaned.startsWith('0')) {
    // เบอร์มือถือไทย 10 หลัก
    return '0066' + cleaned.substring(1);
  }
  // เลขบัตรประชาชน หรือ e-Wallet ID (13-15 หลัก)
  return cleaned;
}

/**
 * สร้าง EMVCo Payload สำหรับ PromptPay QR
 * @param {string} target - เบอร์โทรศัพท์พร้อมเพย์ หรือเลขบัตรประชาชน
 * @param {number|string} amount - ยอดเงิน (ถ้ามี)
 * @returns {string} EMVCo QR String
 */
function generatePromptPayPayload(target, amount) {
  if (amount === undefined) amount = null;
  var formattedTarget = formatPromptPayTarget(target);
  var targetTag = formattedTarget.length >= 13 ? '02' : '01';

  // Sub-tags ของ PromptPay (Tag 29)
  var aid = formatTLV('00', 'A000000677010111'); // PromptPay AID
  var targetVal = formatTLV(targetTag, formattedTarget);
  var merchantAccountInfo = formatTLV('29', aid + targetVal);

  // ข้อมูลพื้นฐาน EMVCo
  var payloadFormat = formatTLV('00', '01');
  var pointOfInitiation = formatTLV('01', amount ? '12' : '11'); // 12 = Dynamic, 11 = Static
  var countryCode = formatTLV('58', 'TH');
  var currencyTHB = formatTLV('53', '764'); // รหัสเงินบาท

  var rawData = payloadFormat + pointOfInitiation + merchantAccountInfo + countryCode + currencyTHB;

  if (amount && Number(amount) > 0) {
    var formattedAmount = Number(amount).toFixed(2);
    rawData = rawData + formatTLV('54', formattedAmount);
  }

  // Tag 63: CRC Checksum
  rawData = rawData + '6304';
  var checksum = crc16(rawData);
  return rawData + checksum;
}

/**
 * สร้าง URL รูปภาพ QR Code สำหรับแสดงบนหน้าจอ
 * @param {string} payload - EMVCo String
 * @returns {string} URL สำหรับแสดงรูป QR Code
 */
function getQrImageUrl(payload) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=' + encodeURIComponent(payload);
}

module.exports = {
  generatePromptPayPayload: generatePromptPayPayload,
  getQrImageUrl: getQrImageUrl
};
function formatBangkokDeadline(deadline) {
  if (deadline == null) return null;

  const date = deadline instanceof Date ? deadline : new Date(deadline);
  if (!Number.isFinite(date.getTime())) return null;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

function buildPickupReadyNotificationBody(orderId, deadline) {
  const formattedDeadline = formatBangkokDeadline(deadline);
  if (formattedDeadline) {
    return `ออเดอร์ #${orderId} พร้อมรับ กรุณารับก่อน ${formattedDeadline} น. หลังจากนั้นอาจถูกยกเลิก ระบบไม่คืนเงินอัตโนมัติ หากร้านเก็บอาหารไว้ โปรดติดต่อร้าน`;
  }

  return `ออเดอร์ #${orderId} พร้อมรับ กรุณาติดต่อร้านเพื่อยืนยันเวลารับ หากออเดอร์ถูกยกเลิก ระบบไม่คืนเงินอัตโนมัติ หากร้านเก็บอาหารไว้ โปรดติดต่อร้าน`;
}

async function getPickupReadyNotificationBody(connection, merchantId, orderId) {
  const { rows } = await connection.query(
    `SELECT GREATEST(
       ms.selling_ends_at,
       mo.updated_at + INTERVAL '15 minutes'
     ) AS pickup_deadline
     FROM merchant_status ms
     JOIN merchant_orders mo
       ON mo.merchant_id = ms.merchant_id
     WHERE ms.merchant_id = $1
       AND mo.source_order_id = $2
       AND mo.merchant_status = 'รอรับสินค้า'
       AND ms.selling_ends_at IS NOT NULL
     LIMIT 1`,
    [merchantId, orderId]
  );

  return buildPickupReadyNotificationBody(
    orderId,
    rows[0]?.pickup_deadline
  );
}

module.exports = {
  buildPickupReadyNotificationBody,
  getPickupReadyNotificationBody,
  formatBangkokDeadline
};

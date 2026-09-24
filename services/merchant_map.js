const { pool } = require('../config/db');
const {
  sendCustomerPushNotifications
} = require('./customer_push_notification');
async function notifyFollowersOfStoreStatus(
  client,
  {
    merchantId,
    merchantName,
    previousStatus,
    currentStatus,
    scheduled,
    locationName
  }
) {
  if (scheduled || previousStatus === currentStatus) return;
  if (currentStatus !== 'เปิดร้าน' && currentStatus !== 'กำลังย้าย') return;
  const isMoving = currentStatus === 'กำลังย้าย';
  const title = isMoving
    ? 'ร้านที่คุณติดตามกำลังย้าย'
    : 'ร้านที่คุณติดตามเปิดขายแล้ว';
  const body = isMoving
    ? `ร้าน ${merchantName || ''} กำลังย้ายจุดขาย`
    : `ร้าน ${merchantName || ''} เปิดขายแล้วนะ 📍 อยู่ที่ ${locationName || 'จุดขาย'}`;
  const { rows } = await client.query(
    `INSERT INTO notifications (user_id,title,body)
     SELECT DISTINCT customer_id, $2, $3 FROM followed WHERE merchant_id = $1
     RETURNING user_id`,
    [merchantId, title, body]
  );
  return { customerIds: rows.map(row => row.user_id), title, body };
}

async function expireStores() {
  await pool.query(
    'SELECT public.expire_merchant_sessions_and_cancel_uncollected_orders()'
  );
  await pool.query(`UPDATE merchant_status SET status = 'เปิดร้าน', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'ปิดร้าน' AND selling_started_at <= CURRENT_TIMESTAMP
      AND selling_ends_at > CURRENT_TIMESTAMP`);
}
function installMerchantMap(router) {
  router.get('/map-pins', async (req, res) => {
    try {
      await expireStores();
      const { rows } = await pool.query(`SELECT m.id, m.name, s.latitude, s.longitude,
        s.location_name, s.status, s.selling_ends_at FROM merchant_status s
        JOIN merchant m ON m.id = s.merchant_id
        WHERE s.status IN ('เปิดร้าน','กำลังย้าย') AND s.selling_ends_at > CURRENT_TIMESTAMP
        AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL`);
      res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({success:false, message:'โหลดหมุดร้านไม่สำเร็จ'}); }
  });
  router.get('/:id/selling-location', async (req, res) => {
    try {
      await expireStores();
      const { rows } = await pool.query('SELECT * FROM merchant_status WHERE merchant_id = $1', [req.params.id]);
      res.json({success:true, data:rows[0] || null});
    } catch (e) { res.status(500).json({success:false, message:'โหลดจุดขายไม่สำเร็จ'}); }
  });
  router.put('/:id/status', async (req, res) => {
    const {status, latitude, longitude, location_name, selling_started_at, selling_ends_at} = req.body;
    if (!['เปิดร้าน','กำลังย้าย','ปิดร้าน'].includes(status)) return res.status(400).json({success:false,message:'สถานะร้านไม่ถูกต้อง'});
    const hasPoint = latitude !== undefined || longitude !== undefined;
    if (hasPoint && (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude)>90 || Math.abs(longitude)>180)) return res.status(400).json({success:false,message:'พิกัดไม่ถูกต้อง'});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const merchant = await client.query('SELECT id, name FROM merchant WHERE id=$1 FOR UPDATE',[req.params.id]);
      if (!merchant.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({success:false,message:'ไม่พบร้านค้า'}); }
      await client.query(`UPDATE merchant_status SET status='ปิดร้าน', updated_at=CURRENT_TIMESTAMP WHERE merchant_id=$1 AND selling_ends_at<=CURRENT_TIMESTAMP`,[req.params.id]);
      const {rows} = await client.query('SELECT * FROM merchant_status WHERE merchant_id=$1',[req.params.id]);
      const previous = rows[0];
      let ends = selling_ends_at ? new Date(selling_ends_at) : previous?.selling_ends_at;
      let starts = selling_started_at ? new Date(selling_started_at) : previous?.selling_started_at;
      const now = new Date();
      if (status === 'เปิดร้าน' && (selling_started_at || selling_ends_at) &&
          (!selling_started_at || !selling_ends_at || !Number.isFinite(starts.getTime()) ||
            !Number.isFinite(ends.getTime()) || ends <= starts || ends <= now)) {
        await client.query('ROLLBACK');
        return res.status(400).json({success:false,message:'เวลาเริ่มและเวลาปิดรอบขายไม่ถูกต้อง'});
      }
      if (status === 'เปิดร้าน') {
        if (!hasPoint && (previous?.latitude == null || previous?.longitude == null)) {
          await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาปักหมุดจุดขายก่อนเปิดร้าน'});
        }
        // Moving the pin never extends the current selling session.
        if (!selling_started_at && (!previous || previous.status === 'ปิดร้าน' || !ends || new Date(ends) <= now)) {
          const schedule = await client.query(`SELECT
            CASE WHEN close_time > open_time THEN
              ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date + close_time) AT TIME ZONE 'Asia/Bangkok'
            ELSE
              ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date + close_time +
                CASE WHEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::time >= open_time THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END)
              AT TIME ZONE 'Asia/Bangkok' END AS ends_at
            FROM merchant_hours WHERE merchant_id=$1`,[req.params.id]);
          ends = schedule.rows[0]?.ends_at;
          if (!ends || new Date(ends) <= new Date()) {
            await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาตั้งเวลาเปิด–ปิดร้านให้ครอบคลุมเวลาขายปัจจุบัน'});
          }
          starts = now;
        }
      } else if (status === 'กำลังย้าย' && (!previous || previous.status === 'ปิดร้าน' || !ends)) {
        await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาปักหมุดเปิดร้านก่อนเปลี่ยนเป็นกำลังย้าย'});
      }
      const scheduled = status === 'เปิดร้าน' && starts > now;
      const effectiveStatus = scheduled ? 'ปิดร้าน' : status;
      await client.query(`INSERT INTO merchant_status (merchant_id,status,latitude,longitude,location_name,selling_started_at,selling_ends_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
        ON CONFLICT (merchant_id) DO UPDATE SET status=EXCLUDED.status,latitude=EXCLUDED.latitude,
        longitude=EXCLUDED.longitude,location_name=EXCLUDED.location_name,selling_started_at=EXCLUDED.selling_started_at,
        selling_ends_at=EXCLUDED.selling_ends_at,updated_at=CURRENT_TIMESTAMP`,
        [req.params.id,effectiveStatus,status==='เปิดร้าน'&&hasPoint?latitude:previous?.latitude??null,
          status==='เปิดร้าน'&&hasPoint?longitude:previous?.longitude??null,
          status==='เปิดร้าน'&&hasPoint?String(location_name||'จุดขาย'):previous?.location_name??null,
          starts??null,status==='ปิดร้าน'?null:ends]);
      const pushNotification = await notifyFollowersOfStoreStatus(client, {
        merchantId: req.params.id,
        merchantName: merchant.rows[0]?.name,
        previousStatus: previous?.status,
        currentStatus: effectiveStatus,
        scheduled,
        locationName: location_name || previous?.location_name
      });
      await client.query('COMMIT');
      if (pushNotification) {
        await sendCustomerPushNotifications(
          pushNotification.customerIds,
          pushNotification.title,
          pushNotification.body
        );
      }
      res.json({success:true,status:effectiveStatus,scheduled_open:scheduled,message:'บันทึกรอบขายสำเร็จ'});
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({success:false,message:'บันทึกจุดขายไม่สำเร็จ'}); }
    finally { client.release(); }
  });
}
module.exports = {installMerchantMap, expireStores};

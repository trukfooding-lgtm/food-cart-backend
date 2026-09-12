const { pool } = require('../config/db');
async function expireStores() {
  await pool.query('SELECT public.process_merchant_selling_sessions()');
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
    const explicitTimes = selling_started_at !== undefined || selling_ends_at !== undefined;
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
      let ends = previous?.selling_ends_at;
      let starts = previous?.selling_started_at;
      const now = new Date();
      let notify = false;
      let pending = false;
      let savedStatus = status;
      if (status === 'เปิดร้าน') {
        if (!hasPoint && (previous?.latitude == null || previous?.longitude == null)) {
          await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาปักหมุดจุดขายก่อนเปิดร้าน'});
        }
        if (explicitTimes) {
          starts = new Date(selling_started_at);
          ends = new Date(selling_ends_at);
          if (typeof selling_started_at !== 'string' || typeof selling_ends_at !== 'string' ||
              !/(Z|[+-]\d{2}:\d{2})$/.test(selling_started_at) || !/(Z|[+-]\d{2}:\d{2})$/.test(selling_ends_at) ||
              !Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts || ends <= now) {
            await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาระบุเวลาเริ่มและเวลาปิดรอบขายให้ถูกต้อง'});
          }
        } else if (!starts || !ends || new Date(ends) <= now || previous?.status === 'ปิดร้าน') {
          await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาเลือกเวลาเริ่มขายและเวลาปิดตอนปักหมุด'});
        }
        pending = new Date(starts) > now;
        savedStatus = pending ? 'ปิดร้าน' : 'เปิดร้าน';
        const pointChanged = hasPoint && (Number(previous?.latitude) !== latitude || Number(previous?.longitude) !== longitude);
        notify = !previous || previous.status !== 'เปิดร้าน' || pointChanged ||
          new Date(previous.selling_started_at).getTime() !== new Date(starts).getTime();
      } else if (status === 'กำลังย้าย' && (!previous || previous.status === 'ปิดร้าน' || !ends || new Date(ends) <= now)) {
        await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'กรุณาเปิดรอบขายก่อนเปลี่ยนเป็นกำลังย้าย'});
      }
      await client.query(`INSERT INTO merchant_status (merchant_id,status,latitude,longitude,location_name,selling_started_at,selling_ends_at,scheduled_open,opening_notified,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)
        ON CONFLICT (merchant_id) DO UPDATE SET status=EXCLUDED.status,latitude=EXCLUDED.latitude,
        longitude=EXCLUDED.longitude,location_name=EXCLUDED.location_name,selling_started_at=EXCLUDED.selling_started_at,
        selling_ends_at=EXCLUDED.selling_ends_at,scheduled_open=EXCLUDED.scheduled_open,opening_notified=EXCLUDED.opening_notified,updated_at=CURRENT_TIMESTAMP`,
        [req.params.id,savedStatus,status==='เปิดร้าน'&&hasPoint?latitude:previous?.latitude??null,
          status==='เปิดร้าน'&&hasPoint?longitude:previous?.longitude??null,
          status==='เปิดร้าน'&&hasPoint?String(location_name||'จุดขาย'):previous?.location_name??null,
          starts??null,status==='ปิดร้าน'?null:ends,pending, status==='เปิดร้าน' ? !notify && !pending : true]);
      await client.query('SELECT public.process_merchant_selling_sessions()');
      await client.query('COMMIT');
      res.json({success:true,status:savedStatus,scheduled_open:pending,message:'บันทึกรอบขายสำเร็จ'});
    } catch(e) { await client.query('ROLLBACK'); res.status(500).json({success:false,message:'บันทึกจุดขายไม่สำเร็จ'}); }
    finally { client.release(); }
  });
}
module.exports = {installMerchantMap, expireStores};

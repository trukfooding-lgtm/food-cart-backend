const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('✅ เชื่อมต่อ Supabase PostgreSQL สำเร็จ');
    client.release();
  } catch (error) {
    console.error('❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้:', error.message);
  }
};

module.exports = { pool, testConnection };
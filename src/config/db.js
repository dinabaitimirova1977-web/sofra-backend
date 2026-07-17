const { Pool } = require('pg');
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { host: 'localhost', port: 5432, database: 'sofra_db', user: 'sofra', password: 'sofra123' }
);
pool.on('error', (err) => { console.error('DB error:', err.message); });
const query = (t, p) => pool.query(t, p);
const getClient = () => pool.connect();

// Миграция: добавляем координаты повара, если их ещё нет
query(`
  ALTER TABLE users ADD COLUMN IF NOT EXISTS lat DECIMAL(10, 8);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS lng DECIMAL(11, 8);
`).then(() => console.log('✅ Migration: lat/lng columns ready'))
  .catch((err) => console.error('❌ Migration error:', err.message));

module.exports = { query, getClient, pool };


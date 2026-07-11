const { Pool } = require('pg');
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { host: 'localhost', port: 5432, database: 'sofra_db', user: 'sofra', password: 'sofra123' }
);
pool.on('error', (err) => { console.error('DB error:', err.message); });
const query = (t, p) => pool.query(t, p);
const getClient = () => pool.connect();
module.exports = { query, getClient, pool };
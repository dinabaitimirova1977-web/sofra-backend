// src/__tests__/setup.js
const { pool } = require('../config/db');

// Очищаем БД перед каждым набором тестов
const clearDB = async () => {
  await pool.query(`
    TRUNCATE TABLE
      order_items, payments, orders, dishes,
      cook_profiles, courier_profiles, admin_logs,
      notifications, client_addresses, courier_locations,
      users
    RESTART IDENTITY CASCADE
  `);
};

// Закрываем пул соединений после всех тестов
afterAll(async () => {
  await pool.end();
});

module.exports = { clearDB };

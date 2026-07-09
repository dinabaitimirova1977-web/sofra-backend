// src/__tests__/helpers.js
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const db       = require('../config/db');

// ── Создание тестовых пользователей ──────────────────────
const createUser = async (overrides = {}) => {
  const defaults = {
    phone:    `+7999${Math.floor(Math.random() * 9000000 + 1000000)}`,
    name:     'Test User',
    role:     'client',
    password: 'password123',
  };
  const data = { ...defaults, ...overrides };
  const hash = await bcrypt.hash(data.password, 4); // быстрый hash для тестов

  const { rows: [user] } = await db.query(
    `INSERT INTO users (phone, name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, phone, name, role`,
    [data.phone, data.name, data.role, hash]
  );

  if (data.role === 'cook') {
    await db.query('INSERT INTO cook_profiles (user_id) VALUES ($1)', [user.id]);
  }
  if (data.role === 'courier') {
    await db.query('INSERT INTO courier_profiles (user_id) VALUES ($1)', [user.id]);
  }

  return user;
};

// ── JWT токен для пользователя ────────────────────────────
const getToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, phone: user.phone },
    process.env.JWT_SECRET || 'test_secret',
    { expiresIn: '1h' }
  );

// ── Auth заголовок ────────────────────────────────────────
const authHeader = (user) => ({ Authorization: `Bearer ${getToken(user)}` });

// ── Создание тестового блюда ──────────────────────────────
const createDish = async (cookId, overrides = {}) => {
  const { rows: [dish] } = await db.query(
    `INSERT INTO dishes (cook_id, name, price, category, cook_time_minutes, is_available)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [
      cookId,
      overrides.name     || 'Тестовый плов',
      overrides.price    || 490,
      overrides.category || 'plov',
      overrides.cook_time_minutes || 30,
    ]
  );
  return dish;
};

// ── Создание тестового заказа ─────────────────────────────
const createOrder = async (clientId, cookId, overrides = {}) => {
  const { rows: [order] } = await db.query(
    `INSERT INTO orders (client_id, cook_id, total_price, delivery_address, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      clientId, cookId,
      overrides.total_price       || 490,
      overrides.delivery_address  || 'ул. Тестовая 1',
      overrides.status            || 'pending',
    ]
  );
  return order;
};

module.exports = { createUser, getToken, authHeader, createDish, createOrder };

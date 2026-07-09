const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const redis = require('../config/redis');

// Генерация токенов
const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );

// ─── POST /api/auth/register ───────────────────────────────────────────────
// Регистрация: клиент, повар, или курьер
router.post(
  '/register',
  [
    body('phone').matches(/^\+?[0-9]{10,15}$/).withMessage('Неверный формат телефона'),
    body('name').trim().notEmpty().withMessage('Имя обязательно'),
    body('password').isLength({ min: 6 }).withMessage('Пароль минимум 6 символов'),
    body('role').isIn(['client', 'cook', 'courier']).withMessage('Неверная роль'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { phone, name, password, role } = req.body;

    try {
      // Проверяем дубли
      const exists = await db.query(
        'SELECT id FROM users WHERE phone = $1', [phone]
      );
      if (exists.rows.length)
        return res.status(409).json({ error: 'Телефон уже зарегистрирован' });

      const hash = await bcrypt.hash(password, 12);

      const { rows } = await db.query(
        `INSERT INTO users (phone, name, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, phone, name, role, created_at`,
        [phone, name, hash, role]
      );
      const user = rows[0];

      // Если повар — создаём профиль повара
      if (role === 'cook') {
        await db.query(
          'INSERT INTO cook_profiles (user_id) VALUES ($1)', [user.id]
        );
      }

      const token = signToken(user);
      res.status(201).json({ token, user });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── POST /api/auth/login ──────────────────────────────────────────────────
router.post(
  '/login',
  [
    body('phone').notEmpty(),
    body('password').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { phone, password } = req.body;

    try {
      const { rows } = await db.query(
        `SELECT id, phone, name, role, password_hash, is_active
         FROM users WHERE phone = $1`,
        [phone]
      );
      const user = rows[0];

      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return res.status(401).json({ error: 'Неверный телефон или пароль' });

      if (!user.is_active)
        return res.status(403).json({ error: 'Аккаунт заблокирован' });

      const token = signToken(user);
      const { password_hash, ...safeUser } = user;

      res.json({ token, user: safeUser });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── GET /api/auth/me ──────────────────────────────────────────────────────
const { auth } = require('../middleware/auth');

router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, phone, name, role, avatar_url, rating, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── POST /api/auth/logout ─────────────────────────────────────────────────
router.post('/logout', auth, async (req, res) => {
  // Добавляем токен в чёрный список в Redis до истечения срока
  const token = req.headers.authorization.split(' ')[1];
  const decoded = jwt.decode(token);
  const ttl = decoded.exp - Math.floor(Date.now() / 1000);
  if (ttl > 0) await redis.set(`blacklist:${token}`, '1', ttl);
  res.json({ message: 'Вы вышли из системы' });
});

module.exports = router;

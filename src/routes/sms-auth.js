const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { sendOTP, verifyOTP } = require('../services/sms');
const { auth } = require('../middleware/auth');

// Генерация JWT
const signToken = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, phone: user.phone },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );

// ─── POST /api/auth/sms/send ──────────────────────────────────────────────
// Шаг 1: отправить OTP на номер
router.post(
  '/send',
  [
    body('phone')
      .trim()
      .matches(/^\+?[0-9]{10,15}$/)
      .withMessage('Укажите корректный номер телефона'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const phone = normalizePhone(req.body.phone);

    try {
      // Проверяем — зарегистрирован ли номер
      const { rows } = await db.query(
        'SELECT id, role FROM users WHERE phone = $1',
        [phone]
      );
      const isExisting = rows.length > 0;

      const result = await sendOTP(phone);

      res.json({
        message: `Код отправлен на ${maskPhone(phone)}`,
        is_new_user: !isExisting,  // фронт знает — показать форму регистрации или нет
        expires_in: result.expires_in,
        sends_left: result.sends_left,
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Не удалось отправить SMS' });
    }
  }
);

// ─── POST /api/auth/sms/verify ────────────────────────────────────────────
// Шаг 2: проверить код
// Если пользователь новый — принять name и role
// Если существующий — просто выдать токен
router.post(
  '/verify',
  [
    body('phone').trim().matches(/^\+?[0-9]{10,15}$/),
    body('code').isLength({ min: 6, max: 6 }).withMessage('Код должен быть 6 цифр'),
    // Для новых пользователей
    body('name').if(body('is_new_user').equals('true')).trim().notEmpty().withMessage('Укажите имя'),
    body('role')
      .if(body('is_new_user').equals('true'))
      .isIn(['client', 'cook', 'courier'])
      .withMessage('Укажите роль'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { code, name, role, is_new_user } = req.body;
    const phone = normalizePhone(req.body.phone);

    try {
      // Проверяем OTP
      await verifyOTP(phone, code);

      // Ищем пользователя
      const { rows } = await db.query(
        'SELECT id, phone, name, role, is_active FROM users WHERE phone = $1',
        [phone]
      );

      let user = rows[0];

      if (!user) {
        // Новый пользователь — регистрируем
        if (!name || !role) {
          return res.status(400).json({
            error: 'Для регистрации укажите имя и роль',
            is_new_user: true,
          });
        }

        const dbClient = await db.getClient();
        try {
          await dbClient.query('BEGIN');

          const { rows: [created] } = await dbClient.query(
            `INSERT INTO users (phone, name, role, password_hash)
             VALUES ($1, $2, $3, '')
             RETURNING id, phone, name, role, is_active`,
            [phone, name.trim(), role]
          );
          user = created;

          // Создаём профиль роли
          if (role === 'cook') {
            await dbClient.query(
              'INSERT INTO cook_profiles (user_id) VALUES ($1)', [user.id]
            );
          } else if (role === 'courier') {
            await dbClient.query(
              'INSERT INTO courier_profiles (user_id) VALUES ($1)', [user.id]
            );
          }

          await dbClient.query('COMMIT');
        } catch (e) {
          await dbClient.query('ROLLBACK');
          throw e;
        } finally {
          dbClient.release();
        }
      }

      if (!user.is_active) {
        return res.status(403).json({ error: 'Аккаунт заблокирован' });
      }

      const token = signToken(user);
      res.json({
        token,
        user: {
          id:    user.id,
          phone: user.phone,
          name:  user.name,
          role:  user.role,
        },
        is_new_user: !rows.length,
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message, attempts_left: err.attempts_left });
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── POST /api/auth/sms/resend ────────────────────────────────────────────
// Повторная отправка (с учётом лимитов в sms.js)
router.post(
  '/resend',
  [body('phone').trim().matches(/^\+?[0-9]{10,15}$/)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const phone = normalizePhone(req.body.phone);

    try {
      const result = await sendOTP(phone);
      res.json({
        message: `Новый код отправлен на ${maskPhone(phone)}`,
        expires_in: result.expires_in,
        sends_left: result.sends_left,
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Не удалось отправить SMS' });
    }
  }
);

// ─── POST /api/auth/sms/change-phone ─────────────────────────────────────
// Смена номера для авторизованного пользователя
router.post(
  '/change-phone',
  auth,
  [
    body('new_phone').trim().matches(/^\+?[0-9]{10,15}$/),
    body('code').isLength({ min: 6, max: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const newPhone = normalizePhone(req.body.new_phone);

    try {
      // Проверяем OTP для нового номера
      await verifyOTP(newPhone, req.body.code);

      // Проверяем что номер не занят
      const { rows } = await db.query(
        'SELECT id FROM users WHERE phone = $1', [newPhone]
      );
      if (rows.length) {
        return res.status(409).json({ error: 'Номер уже используется' });
      }

      await db.query(
        'UPDATE users SET phone = $1, updated_at = NOW() WHERE id = $2',
        [newPhone, req.user.id]
      );

      res.json({ message: 'Номер телефона изменён', phone: maskPhone(newPhone) });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── Helpers ──────────────────────────────────────────────

// +7 (999) 123-45-67 → +79991234567
const normalizePhone = (phone) => {
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('8') && p.length === 11) p = '7' + p.slice(1);
  return '+' + p;
};

// +79991234567 → +7 (999) ***-**-67
const maskPhone = (phone) => {
  const p = phone.replace(/\D/g, '');
  return `+${p[0]} (${p.slice(1,4)}) ***-**-${p.slice(-2)}`;
};

module.exports = router;

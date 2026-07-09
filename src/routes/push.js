// src/routes/push.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db   = require('../config/db');
const { auth, role } = require('../middleware/auth');
const push = require('../services/push');

// ─── POST /api/push/token ─────────────────────────────────
// Регистрация FCM токена устройства
router.post(
  '/token',
  auth,
  [body('token').notEmpty().withMessage('FCM токен обязателен')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      await db.query(
        'UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2',
        [req.body.token, req.user.id]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── DELETE /api/push/token ───────────────────────────────
// Удалить токен при выходе
router.delete('/token', auth, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET fcm_token = NULL WHERE id = $1', [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── POST /api/push/send ──────────────────────────────────
// Ручная рассылка от администратора
router.post(
  '/send',
  auth, role('admin'),
  [
    body('user_ids').isArray({ min: 1 }),
    body('title').notEmpty(),
    body('body').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { user_ids, title, body: msgBody, data } = req.body;

    try {
      const result = await push.sendToMultiple(
        user_ids,
        { title, body: msgBody },
        data || {}
      );
      res.json({ sent: result?.successCount || 0, failed: result?.failureCount || 0 });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка отправки' });
    }
  }
);

// ─── POST /api/push/broadcast ─────────────────────────────
// Рассылка по роли
router.post(
  '/broadcast',
  auth, role('admin'),
  [
    body('role').isIn(['client', 'cook', 'courier']),
    body('title').notEmpty(),
    body('body').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { role: targetRole, title, body: msgBody, data } = req.body;

    try {
      const { rows } = await db.query(
        'SELECT id FROM users WHERE role = $1 AND fcm_token IS NOT NULL AND is_active = true',
        [targetRole]
      );
      const ids = rows.map(r => r.id);

      if (!ids.length) return res.json({ sent: 0 });

      const result = await push.sendToMultiple(ids, { title, body: msgBody }, data || {});
      res.json({
        total:  ids.length,
        sent:   result?.successCount  || 0,
        failed: result?.failureCount  || 0,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка рассылки' });
    }
  }
);

module.exports = router;

const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const db = require('../config/db');
const redis = require('../config/redis');
const { auth, role } = require('../middleware/auth');
const { publishEvent } = require('../services/queue');

// Все роуты только для admin
router.use(auth, role('admin'));

// ─── ДАШБОРД ─────────────────────────────────────────────────────────────

// GET /api/admin/dashboard
// Главные метрики в реальном времени
router.get('/dashboard', async (req, res) => {
  try {
    // Кэш на 60 сек — дашборд запрашивают часто
    const cached = await redis.get('admin:dashboard');
    if (cached) return res.json({ ...cached, _cached: true });

    const [orders, users, revenue, active] = await Promise.all([
      // Заказы
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)                AS today_total,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE
                           AND status = 'delivered')                              AS today_delivered,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE
                           AND status = 'cancelled')                              AS today_cancelled,
          COUNT(*) FILTER (WHERE status IN ('pending','confirmed','cooking','ready','picked_up')) AS active_now,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')        AS week_total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')       AS month_total
        FROM orders`),

      // Пользователи
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE role = 'client')  AS clients,
          COUNT(*) FILTER (WHERE role = 'cook')    AS cooks,
          COUNT(*) FILTER (WHERE role = 'courier') AS couriers,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS new_today
        FROM users WHERE is_active = true`),

      // Выручка
      db.query(`
        SELECT
          COALESCE(SUM(total_price) FILTER (
            WHERE DATE(created_at) = CURRENT_DATE AND status = 'delivered'), 0)  AS today,
          COALESCE(SUM(total_price) FILTER (
            WHERE created_at >= NOW() - INTERVAL '7 days'
            AND status = 'delivered'), 0)                                        AS week,
          COALESCE(SUM(total_price) FILTER (
            WHERE created_at >= NOW() - INTERVAL '30 days'
            AND status = 'delivered'), 0)                                        AS month,
          ROUND(AVG(total_price) FILTER (WHERE status = 'delivered'), 2)         AS avg_order
        FROM orders`),

      // Онлайн прямо сейчас
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM cook_profiles    WHERE is_online = true) AS cooks_online,
          (SELECT COUNT(*) FROM courier_profiles WHERE is_online = true) AS couriers_online`),
    ]);

    // Среднее время доставки сегодня
    const { rows: [timing] } = await db.query(`
      SELECT ROUND(AVG(
        EXTRACT(EPOCH FROM (delivered_at - created_at)) / 60
      )) AS avg_delivery_minutes
      FROM orders
      WHERE DATE(created_at) = CURRENT_DATE AND status = 'delivered'`);

    const data = {
      orders:   orders.rows[0],
      users:    users.rows[0],
      revenue:  revenue.rows[0],
      active:   active.rows[0],
      timing:   timing,
      updated_at: new Date(),
    };

    await redis.set('admin:dashboard', data, 60);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/admin/analytics
// Аналитика за период (для графиков)
router.get('/analytics', async (req, res) => {
  const { period = '7d' } = req.query;

  const intervals = {
    '7d':  { interval: '7 days',  trunc: 'day' },
    '30d': { interval: '30 days', trunc: 'day' },
    '3m':  { interval: '90 days', trunc: 'week' },
    '1y':  { interval: '1 year',  trunc: 'month' },
  };

  const { interval, trunc } = intervals[period] || intervals['7d'];

  try {
    const [byTime, byCategory, byHour, conversion] = await Promise.all([
      // Заказы и выручка по дням/неделям/месяцам
      db.query(`
        SELECT
          DATE_TRUNC($1, created_at) AS period,
          COUNT(*)                   AS orders,
          COUNT(*) FILTER (WHERE status = 'delivered')  AS delivered,
          COUNT(*) FILTER (WHERE status = 'cancelled')  AS cancelled,
          COALESCE(SUM(total_price) FILTER (WHERE status = 'delivered'), 0) AS revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '${interval}'
        GROUP BY DATE_TRUNC($1, created_at)
        ORDER BY period ASC`, [trunc]),

      // Топ категорий блюд
      db.query(`
        SELECT d.category, COUNT(oi.id) AS ordered, SUM(oi.quantity) AS qty
        FROM order_items oi
        JOIN dishes d ON d.id = oi.dish_id
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'delivered'
          AND o.created_at >= NOW() - INTERVAL '${interval}'
        GROUP BY d.category
        ORDER BY qty DESC
        LIMIT 10`),

      // Распределение заказов по часам
      db.query(`
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*) AS orders
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '${interval}'
        GROUP BY hour ORDER BY hour ASC`),

      // Конверсия: pending → delivered
      db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'delivered')  AS delivered,
          COUNT(*) FILTER (WHERE status = 'cancelled')  AS cancelled,
          ROUND(COUNT(*) FILTER (WHERE status = 'delivered')::numeric
                / NULLIF(COUNT(*), 0) * 100, 1)         AS conversion_rate
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '${interval}'`),
    ]);

    res.json({
      period,
      by_time:    byTime.rows,
      by_category: byCategory.rows,
      by_hour:    byHour.rows,
      conversion: conversion.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── ПОЛЬЗОВАТЕЛИ ─────────────────────────────────────────────────────────

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const {
    role: filterRole, search, is_active,
    limit = 20, offset = 0, sort = 'created_at', order = 'DESC',
  } = req.query;

  try {
    const conditions = [];
    const params = [];

    if (filterRole) {
      params.push(filterRole);
      conditions.push(`u.role = $${params.length}`);
    }
    if (is_active !== undefined) {
      params.push(is_active === 'true');
      conditions.push(`u.is_active = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const allowedSort  = ['created_at', 'name', 'rating'];
    const allowedOrder = ['ASC', 'DESC'];
    const safeSort  = allowedSort.includes(sort)   ? sort  : 'created_at';
    const safeOrder = allowedOrder.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';

    params.push(Number(limit), Number(offset));

    const { rows } = await db.query(`
      SELECT
        u.id, u.phone, u.name, u.role, u.avatar_url,
        u.rating, u.is_active, u.created_at,
        CASE u.role
          WHEN 'cook'    THEN (SELECT row_to_json(cp) FROM cook_profiles    cp WHERE cp.user_id = u.id)
          WHEN 'courier' THEN (SELECT row_to_json(cr) FROM courier_profiles cr WHERE cr.user_id = u.id)
          ELSE NULL
        END AS profile,
        (SELECT COUNT(*) FROM orders
         WHERE CASE u.role
           WHEN 'client'  THEN client_id = u.id
           WHEN 'cook'    THEN cook_id   = u.id
           WHEN 'courier' THEN courier_id = u.id
           ELSE false END
        ) AS total_orders
      FROM users u
      ${where}
      ORDER BY u.${safeSort} ${safeOrder}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Общее число для пагинации
    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM users u ${where}`,
      params.slice(0, -2)
    );

    res.json({ total: Number(count), users: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.*,
        CASE u.role
          WHEN 'cook'    THEN (SELECT row_to_json(cp) FROM cook_profiles    cp WHERE cp.user_id = u.id)
          WHEN 'courier' THEN (SELECT row_to_json(cr) FROM courier_profiles cr WHERE cr.user_id = u.id)
          ELSE NULL
        END AS profile
      FROM users u WHERE u.id = $1`, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });

    // Последние 5 заказов
    const { rows: orders } = await db.query(`
      SELECT id, status, total_price, created_at
      FROM orders
      WHERE client_id = $1 OR cook_id = $1 OR courier_id = $1
      ORDER BY created_at DESC LIMIT 5`, [req.params.id]);

    res.json({ ...rows[0], recent_orders: orders });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/admin/users/:id
// Заблокировать / разблокировать / изменить роль
router.patch(
  '/users/:id',
  [
    body('is_active').optional().isBoolean(),
    body('role').optional().isIn(['client', 'cook', 'courier', 'admin']),
    body('reason').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { is_active, role: newRole, reason } = req.body;

    try {
      // Нельзя заблокировать самого себя
      if (String(req.params.id) === String(req.user.id))
        return res.status(400).json({ error: 'Нельзя изменить собственный аккаунт' });

      const fields = [];
      const params = [];

      if (is_active !== undefined) {
        params.push(is_active);
        fields.push(`is_active = $${params.length}`);
      }
      if (newRole) {
        params.push(newRole);
        fields.push(`role = $${params.length}`);
      }

      if (!fields.length)
        return res.status(400).json({ error: 'Нет данных для обновления' });

      params.push(req.params.id);
      const { rows } = await db.query(
        `UPDATE users SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length} RETURNING id, name, role, is_active`,
        params
      );

      if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });

      // Логируем действие
      await db.query(
        `INSERT INTO admin_logs (admin_id, action, target_id, target_type, reason)
         VALUES ($1, $2, $3, 'user', $4)`,
        [req.user.id, is_active === false ? 'block_user' : 'update_user', req.params.id, reason]
      );

      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── ЗАКАЗЫ ───────────────────────────────────────────────────────────────

// GET /api/admin/orders
router.get('/orders', async (req, res) => {
  const { status, cook_id, courier_id, date_from, date_to, limit = 30, offset = 0 } = req.query;

  try {
    const conditions = [];
    const params = [];

    if (status) {
      const statuses = status.split(',');
      params.push(statuses);
      conditions.push(`o.status = ANY($${params.length})`);
    }
    if (cook_id)    { params.push(cook_id);    conditions.push(`o.cook_id = $${params.length}`); }
    if (courier_id) { params.push(courier_id); conditions.push(`o.courier_id = $${params.length}`); }
    if (date_from)  { params.push(date_from);  conditions.push(`o.created_at >= $${params.length}`); }
    if (date_to)    { params.push(date_to);    conditions.push(`o.created_at <= $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(Number(limit), Number(offset));

    const { rows } = await db.query(`
      SELECT
        o.id, o.status, o.total_price, o.delivery_address,
        o.created_at, o.updated_at, o.delivered_at, o.rating,
        uc.name AS client_name,  uc.phone AS client_phone,
        uk.name AS cook_name,
        uu.name AS courier_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS items_count
      FROM orders o
      JOIN users uc ON o.client_id = uc.id
      JOIN users uk ON o.cook_id   = uk.id
      LEFT JOIN users uu ON o.courier_id = uu.id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM orders o ${where}`,
      params.slice(0, -2)
    );

    res.json({ total: Number(count), orders: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /api/admin/orders/:id/cancel
// Принудительная отмена заказа
router.patch(
  '/orders/:id/cancel',
  [body('reason').notEmpty().withMessage('Укажите причину отмены')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const { rows } = await db.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('delivered', 'cancelled')
         RETURNING *`,
        [req.params.id]
      );

      if (!rows.length)
        return res.status(400).json({ error: 'Заказ нельзя отменить' });

      await db.query(
        `INSERT INTO admin_logs (admin_id, action, target_id, target_type, reason)
         VALUES ($1, 'cancel_order', $2, 'order', $3)`,
        [req.user.id, req.params.id, req.body.reason]
      );

      await publishEvent('order.status_changed', {
        order_id:  rows[0].id,
        status:    'cancelled',
        client_id: rows[0].client_id,
        cook_id:   rows[0].cook_id,
        by_admin:  true,
        reason:    req.body.reason,
      });

      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── ПОВАРА ───────────────────────────────────────────────────────────────

// GET /api/admin/cooks
// Список поваров с рейтингом, выручкой, статусом
router.get('/cooks', async (req, res) => {
  const { is_online, min_rating, limit = 20, offset = 0 } = req.query;

  try {
    const conditions = ["u.role = 'cook'"];
    const params = [];

    if (is_online !== undefined) {
      params.push(is_online === 'true');
      conditions.push(`cp.is_online = $${params.length}`);
    }
    if (min_rating) {
      params.push(Number(min_rating));
      conditions.push(`u.rating >= $${params.length}`);
    }

    params.push(Number(limit), Number(offset));

    const { rows } = await db.query(`
      SELECT
        u.id, u.name, u.phone, u.avatar_url, u.rating, u.is_active, u.created_at,
        cp.is_online, cp.speciality, cp.total_orders, cp.total_earned,
        (SELECT COUNT(*) FROM orders
         WHERE cook_id = u.id AND status IN ('pending','confirmed','cooking','ready')) AS active_orders,
        (SELECT COUNT(*) FROM dishes WHERE cook_id = u.id AND is_available = true) AS active_dishes
      FROM users u
      JOIN cook_profiles cp ON cp.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cp.is_online DESC, u.rating DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── КУРЬЕРЫ ──────────────────────────────────────────────────────────────

// GET /api/admin/couriers
router.get('/couriers', async (req, res) => {
  const { is_online, limit = 20, offset = 0 } = req.query;

  try {
    const conditions = ["u.role = 'courier'"];
    const params = [];

    if (is_online !== undefined) {
      params.push(is_online === 'true');
      conditions.push(`cr.is_online = $${params.length}`);
    }

    params.push(Number(limit), Number(offset));

    const { rows } = await db.query(`
      SELECT
        u.id, u.name, u.phone, u.avatar_url, u.rating, u.is_active,
        cr.is_online, cr.total_deliveries, cr.total_earned, cr.vehicle_type,
        cl.lat, cl.lng, cl.updated_at AS location_updated_at,
        (SELECT COUNT(*) FROM orders
         WHERE courier_id = u.id AND status = 'picked_up') AS active_deliveries
      FROM users u
      JOIN courier_profiles cr ON cr.user_id = u.id
      LEFT JOIN courier_locations cl ON cl.courier_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY cr.is_online DESC, cr.total_deliveries DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── ЖАЛОБЫ / ПРОБЛЕМЫ ────────────────────────────────────────────────────

// GET /api/admin/issues
// Заказы с низким рейтингом или требующие внимания
router.get('/issues', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        o.id, o.status, o.total_price, o.rating, o.rating_comment,
        o.created_at, o.delivered_at,
        uc.name AS client_name, uc.phone AS client_phone,
        uk.name AS cook_name,
        uu.name AS courier_name,
        EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 60 AS minutes_since_created
      FROM orders o
      JOIN users uc ON o.client_id = uc.id
      JOIN users uk ON o.cook_id   = uk.id
      LEFT JOIN users uu ON o.courier_id = uu.id
      WHERE
        -- Низкий рейтинг
        (o.rating <= 2 AND o.rating IS NOT NULL)
        -- Зависший заказ (pending > 15 мин)
        OR (o.status = 'pending' AND o.created_at < NOW() - INTERVAL '15 minutes')
        -- Долгая доставка (picked_up > 60 мин)
        OR (o.status = 'picked_up' AND o.updated_at < NOW() - INTERVAL '60 minutes')
      ORDER BY o.created_at DESC
      LIMIT 50`);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── ЛОГИ ДЕЙСТВИЙ АДМИНИСТРАТОРОВ ───────────────────────────────────────

// GET /api/admin/logs
router.get('/logs', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const { rows } = await db.query(`
      SELECT
        al.id, al.action, al.target_id, al.target_type,
        al.reason, al.created_at,
        u.name AS admin_name
      FROM admin_logs al
      JOIN users u ON al.admin_id = u.id
      ORDER BY al.created_at DESC
      LIMIT $1 OFFSET $2`,
      [Number(limit), Number(offset)]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;

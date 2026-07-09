const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const redis = require('../config/redis');
const { auth, role } = require('../middleware/auth');
const { publishEvent } = require('../services/queue');

// ─── GET /api/cook/profile ────────────────────────────────────────────────
// Профиль повара (публичный + приватный)
router.get('/profile', auth, role('cook'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         u.id, u.name, u.phone, u.avatar_url, u.rating, u.created_at,
         cp.bio, cp.speciality, cp.is_online,
         cp.work_start, cp.work_end,
         cp.total_orders, cp.total_earned
       FROM users u
       JOIN cook_profiles cp ON cp.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Профиль не найден' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── PATCH /api/cook/profile ──────────────────────────────────────────────
// Обновить профиль повара
router.patch(
  '/profile',
  auth, role('cook'),
  [
    body('name').optional().trim().notEmpty(),
    body('bio').optional().isString().isLength({ max: 500 }),
    body('speciality').optional().isString().isLength({ max: 200 }),
    body('work_start').optional().matches(/^\d{2}:\d{2}$/),
    body('work_end').optional().matches(/^\d{2}:\d{2}$/),
    body('avatar_url').optional().isURL(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const dbClient = await db.getClient();
    try {
      await dbClient.query('BEGIN');

      const { name, bio, speciality, work_start, work_end, avatar_url } = req.body;

      // Обновляем users
      if (name || avatar_url) {
        const userFields = [];
        const userParams = [];
        if (name) { userParams.push(name); userFields.push(`name = $${userParams.length}`); }
        if (avatar_url) { userParams.push(avatar_url); userFields.push(`avatar_url = $${userParams.length}`); }
        userParams.push(req.user.id);
        await dbClient.query(
          `UPDATE users SET ${userFields.join(', ')}, updated_at = NOW() WHERE id = $${userParams.length}`,
          userParams
        );
      }

      // Обновляем cook_profiles
      const cpFields = [];
      const cpParams = [];
      if (bio !== undefined)        { cpParams.push(bio);        cpFields.push(`bio = $${cpParams.length}`); }
      if (speciality !== undefined) { cpParams.push(speciality); cpFields.push(`speciality = $${cpParams.length}`); }
      if (work_start)               { cpParams.push(work_start); cpFields.push(`work_start = $${cpParams.length}`); }
      if (work_end)                 { cpParams.push(work_end);   cpFields.push(`work_end = $${cpParams.length}`); }

      if (cpFields.length) {
        cpParams.push(req.user.id);
        await dbClient.query(
          `UPDATE cook_profiles SET ${cpFields.join(', ')} WHERE user_id = $${cpParams.length}`,
          cpParams
        );
      }

      await dbClient.query('COMMIT');
      res.json({ message: 'Профиль обновлён' });
    } catch (err) {
      await dbClient.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    } finally {
      dbClient.release();
    }
  }
);

// ─── PATCH /api/cook/status ───────────────────────────────────────────────
// Повар включает / выключает приём заказов
router.patch(
  '/status',
  auth, role('cook'),
  [body('is_online').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      await db.query(
        `UPDATE cook_profiles SET is_online = $1 WHERE user_id = $2`,
        [req.body.is_online, req.user.id]
      );

      // Кэшируем статус в Redis (для быстрой проверки клиентами)
      await redis.set(`cook:online:${req.user.id}`, req.body.is_online, 3600);

      res.json({ is_online: req.body.is_online });
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── GET /api/cook/orders ─────────────────────────────────────────────────
// Входящие заказы повара с фильтром по статусу
router.get('/orders', auth, role('cook'), async (req, res) => {
  const { status, limit = 20, offset = 0 } = req.query;

  try {
    const conditions = ['o.cook_id = $1'];
    const params = [req.user.id];

    if (status) {
      // Можно передать несколько: ?status=pending,confirmed
      const statuses = status.split(',').map(s => s.trim());
      params.push(statuses);
      conditions.push(`o.status = ANY($${params.length})`);
    }

    params.push(Number(limit), Number(offset));

    const { rows } = await db.query(
      `SELECT
         o.id, o.status, o.total_price, o.delivery_address,
         o.comment, o.created_at, o.updated_at,
         u.name AS client_name, u.phone AS client_phone,
         json_agg(
           json_build_object(
             'dish_id',  oi.dish_id,
             'name',     d.name,
             'quantity', oi.quantity,
             'price',    oi.price_at_order
           ) ORDER BY oi.id
         ) AS items
       FROM orders o
       JOIN users u ON o.client_id = u.id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN dishes d ON d.id = oi.dish_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY o.id, u.name, u.phone
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── PATCH /api/cook/orders/:id/status ───────────────────────────────────
// Повар меняет статус заказа
const COOK_TRANSITIONS = {
  confirmed:  ['pending'],
  cooking:    ['confirmed'],
  ready:      ['cooking'],
  cancelled:  ['pending', 'confirmed'],
};

router.patch(
  '/orders/:id/status',
  auth, role('cook'),
  [
    body('status').isIn(Object.keys(COOK_TRANSITIONS)).withMessage('Недопустимый статус'),
    body('estimated_minutes').optional().isInt({ min: 1, max: 180 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { status, estimated_minutes } = req.body;

    try {
      const { rows } = await db.query(
        'SELECT * FROM orders WHERE id = $1 AND cook_id = $2',
        [req.params.id, req.user.id]
      );
      const order = rows[0];

      if (!order) return res.status(404).json({ error: 'Заказ не найден' });

      if (!COOK_TRANSITIONS[status].includes(order.status)) {
        return res.status(400).json({
          error: `Нельзя перейти в "${status}" из "${order.status}"`,
        });
      }

      const updates = ['status = $1', 'updated_at = NOW()'];
      const params  = [status];

      if (estimated_minutes) {
        params.push(estimated_minutes);
        updates.push(`estimated_time = $${params.length}`);
      }

      params.push(order.id);
      const { rows: [updated] } = await db.query(
        `UPDATE orders SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );

      await publishEvent('order.status_changed', {
        order_id:   order.id,
        status,
        client_id:  order.client_id,
        cook_id:    req.user.id,
        courier_id: order.courier_id,
        estimated_minutes,
      });

      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── GET /api/cook/menu ───────────────────────────────────────────────────
// Всё меню повара (включая недоступные блюда)
router.get('/menu', auth, role('cook'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT *, 
         (SELECT COUNT(*) FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.dish_id = d.id AND o.status = 'delivered') AS times_ordered
       FROM dishes d
       WHERE cook_id = $1
       ORDER BY category, name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── PATCH /api/cook/menu/bulk-availability ───────────────────────────────
// Массово включить/выключить блюда (например, на выходные)
router.patch(
  '/menu/bulk-availability',
  auth, role('cook'),
  [
    body('dish_ids').isArray({ min: 1 }),
    body('is_available').isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { dish_ids, is_available } = req.body;

    try {
      const { rowCount } = await db.query(
        `UPDATE dishes SET is_available = $1, updated_at = NOW()
         WHERE id = ANY($2) AND cook_id = $3`,
        [is_available, dish_ids, req.user.id]
      );
      res.json({ updated: rowCount });
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── GET /api/cook/stats ──────────────────────────────────────────────────
// Статистика повара: сегодня / неделя / месяц
router.get('/stats', auth, role('cook'), async (req, res) => {
  try {
    const { rows: [stats] } = await db.query(
      `SELECT
         -- Сегодня
         COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)               AS today_orders,
         COALESCE(SUM(total_price) FILTER (
           WHERE DATE(created_at) = CURRENT_DATE AND status = 'delivered'), 0)  AS today_earned,

         -- Неделя
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')        AS week_orders,
         COALESCE(SUM(total_price) FILTER (
           WHERE created_at >= NOW() - INTERVAL '7 days' AND status = 'delivered'), 0) AS week_earned,

         -- Месяц
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')       AS month_orders,
         COALESCE(SUM(total_price) FILTER (
           WHERE created_at >= NOW() - INTERVAL '30 days' AND status = 'delivered'), 0) AS month_earned,

         -- Активные (сейчас в работе)
         COUNT(*) FILTER (
           WHERE status IN ('pending','confirmed','cooking','ready'))             AS active_orders,

         -- Средний рейтинг
         ROUND(AVG(rating) FILTER (WHERE rating IS NOT NULL), 2)                AS avg_rating,
         COUNT(*) FILTER (WHERE rating IS NOT NULL)                             AS total_reviews
       FROM orders
       WHERE cook_id = $1`,
      [req.user.id]
    );

    // Топ блюд за месяц
    const { rows: top_dishes } = await db.query(
      `SELECT d.name, d.image_url, SUM(oi.quantity) AS total_sold,
              SUM(oi.quantity * oi.price_at_order) AS revenue
       FROM order_items oi
       JOIN dishes d ON d.id = oi.dish_id
       JOIN orders o ON o.id = oi.order_id
       WHERE d.cook_id = $1
         AND o.status = 'delivered'
         AND o.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY d.id, d.name, d.image_url
       ORDER BY total_sold DESC
       LIMIT 5`,
      [req.user.id]
    );

    // Выручка по дням (последние 7 дней для графика)
    const { rows: daily_revenue } = await db.query(
      `SELECT
         DATE(created_at) AS date,
         COUNT(*)         AS orders,
         COALESCE(SUM(total_price), 0) AS revenue
       FROM orders
       WHERE cook_id = $1
         AND status = 'delivered'
         AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [req.user.id]
    );

    res.json({ ...stats, top_dishes, daily_revenue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/cook/reviews ────────────────────────────────────────────────
// Отзывы клиентов о поваре
router.get('/reviews', auth, role('cook'), async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;

  try {
    const { rows } = await db.query(
      `SELECT
         o.id AS order_id, o.rating, o.rating_comment,
         o.created_at AS order_date,
         u.name AS client_name, u.avatar_url AS client_avatar,
         json_agg(json_build_object('name', d.name, 'quantity', oi.quantity)) AS items
       FROM orders o
       JOIN users u ON o.client_id = u.id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN dishes d ON d.id = oi.dish_id
       WHERE o.cook_id = $1 AND o.rating IS NOT NULL
       GROUP BY o.id, u.name, u.avatar_url
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const { rows: [summary] } = await db.query(
      `SELECT
         ROUND(AVG(rating), 2) AS avg,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE rating = 5) AS five,
         COUNT(*) FILTER (WHERE rating = 4) AS four,
         COUNT(*) FILTER (WHERE rating = 3) AS three,
         COUNT(*) FILTER (WHERE rating <= 2) AS low
       FROM orders WHERE cook_id = $1 AND rating IS NOT NULL`,
      [req.user.id]
    );

    res.json({ summary, reviews: rows });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/cook/earnings ───────────────────────────────────────────────
// Детализация выплат (для раздела "Мои доходы")
router.get('/earnings', auth, role('cook'), async (req, res) => {
  const { year, month } = req.query;
  const now = new Date();
  const y = year  || now.getFullYear();
  const m = month || now.getMonth() + 1;

  try {
    // Детализация по дням выбранного месяца
    const { rows: daily } = await db.query(
      `SELECT
         DATE(created_at)      AS date,
         COUNT(*)              AS orders,
         SUM(total_price)      AS gross,
         SUM(total_price) * 0.85 AS net   -- комиссия платформы 15%
       FROM orders
       WHERE cook_id = $1
         AND status = 'delivered'
         AND EXTRACT(YEAR  FROM created_at) = $2
         AND EXTRACT(MONTH FROM created_at) = $3
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [req.user.id, y, m]
    );

    // Итог месяца
    const { rows: [totals] } = await db.query(
      `SELECT
         COUNT(*)                  AS orders,
         COALESCE(SUM(total_price), 0)          AS gross,
         COALESCE(SUM(total_price) * 0.85, 0)   AS net,
         COALESCE(SUM(total_price) * 0.15, 0)   AS platform_fee
       FROM orders
       WHERE cook_id = $1
         AND status = 'delivered'
         AND EXTRACT(YEAR  FROM created_at) = $2
         AND EXTRACT(MONTH FROM created_at) = $3`,
      [req.user.id, y, m]
    );

    res.json({ period: `${y}-${String(m).padStart(2,'0')}`, totals, daily });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/cook/public/:id ─────────────────────────────────────────────
// Публичный профиль повара (для клиентов)
router.get('/public/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         u.id, u.name, u.avatar_url, u.rating, u.created_at,
         cp.bio, cp.speciality, cp.is_online, cp.work_start, cp.work_end,
         cp.total_orders,
         (SELECT json_agg(d ORDER BY d.total_ordered DESC)
          FROM (SELECT id, name, description, price, category,
                       cook_time_minutes, image_url, is_available, total_ordered
                FROM dishes WHERE cook_id = u.id AND is_available = true
                LIMIT 20) d
         ) AS menu
       FROM users u
       JOIN cook_profiles cp ON cp.user_id = u.id
       WHERE u.id = $1 AND u.role = 'cook'`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Повар не найден' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;

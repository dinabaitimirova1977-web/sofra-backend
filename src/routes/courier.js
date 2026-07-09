const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const db = require('../config/db');
const redis = require('../config/redis');
const { auth, role } = require('../middleware/auth');
const { publishEvent } = require('../services/queue');
const { getIO } = require('../services/socket');

// ─── GET /api/courier/available-orders ────────────────────────────────────
// Список заказов со статусом 'ready' рядом с курьером
router.get('/available-orders', auth, role('courier'), async (req, res) => {
  try {
    const { lat, lng, radius_km = 5 } = req.query;

    let query;
    let params;

    if (lat && lng) {
      // Фильтр по радиусу через PostGIS
      query = `
        SELECT o.*,
          uc.name  AS client_name,
          uk.name  AS cook_name,
          uk.phone AS cook_phone,
          uk.avatar_url AS cook_avatar,
          ST_Distance(
            ST_MakePoint(o.delivery_lng, o.delivery_lat)::geography,
            ST_MakePoint($2, $1)::geography
          ) / 1000 AS distance_km,
          json_agg(json_build_object(
            'name', d.name, 'quantity', oi.quantity
          )) AS items
        FROM orders o
        JOIN users uc ON o.client_id = uc.id
        JOIN users uk ON o.cook_id   = uk.id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN dishes d ON d.id = oi.dish_id
        WHERE o.status = 'ready'
          AND o.courier_id IS NULL
          AND ST_DWithin(
            ST_MakePoint(o.delivery_lng, o.delivery_lat)::geography,
            ST_MakePoint($2, $1)::geography,
            $3 * 1000
          )
        GROUP BY o.id, uc.name, uk.name, uk.phone, uk.avatar_url
        ORDER BY distance_km ASC
        LIMIT 20`;
      params = [lat, lng, radius_km];
    } else {
      // Без геофильтра
      query = `
        SELECT o.*,
          uc.name AS client_name,
          uk.name AS cook_name, uk.phone AS cook_phone,
          json_agg(json_build_object(
            'name', d.name, 'quantity', oi.quantity
          )) AS items
        FROM orders o
        JOIN users uc ON o.client_id = uc.id
        JOIN users uk ON o.cook_id   = uk.id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN dishes d ON d.id = oi.dish_id
        WHERE o.status = 'ready' AND o.courier_id IS NULL
        GROUP BY o.id, uc.name, uk.name, uk.phone
        ORDER BY o.created_at ASC
        LIMIT 20`;
      params = [];
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── POST /api/courier/orders/:id/accept ──────────────────────────────────
// Курьер берёт заказ
router.post('/orders/:id/accept', auth, role('courier'), async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Блокируем строку (SELECT FOR UPDATE) — чтобы два курьера не взяли одно
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    const order = rows[0];

    if (!order)
      return res.status(404).json({ error: 'Заказ не найден' });
    if (order.courier_id)
      return res.status(409).json({ error: 'Заказ уже взят другим курьером' });
    if (order.status !== 'ready')
      return res.status(400).json({ error: `Заказ в статусе "${order.status}", нельзя взять` });

    const { rows: [updated] } = await client.query(
      `UPDATE orders
       SET courier_id = $1, status = 'picked_up', updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, order.id]
    );

    await client.query('COMMIT');

    // Сообщаем клиенту и повару через сокет + очередь
    await publishEvent('order.status_changed', {
      order_id: order.id,
      status: 'picked_up',
      courier_id: req.user.id,
      client_id: order.client_id,
      cook_id: order.cook_id,
    });

    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

// ─── POST /api/courier/orders/:id/deliver ─────────────────────────────────
// Курьер подтверждает доставку
router.post(
  '/orders/:id/deliver',
  auth, role('courier'),
  [body('proof_photo_url').optional().isURL()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const { rows } = await db.query(
        `SELECT * FROM orders WHERE id = $1 AND courier_id = $2`,
        [req.params.id, req.user.id]
      );
      const order = rows[0];

      if (!order)
        return res.status(404).json({ error: 'Заказ не найден' });
      if (order.status !== 'picked_up')
        return res.status(400).json({ error: 'Можно завершить только заказ в статусе picked_up' });

      const { rows: [updated] } = await db.query(
        `UPDATE orders
         SET status = 'delivered',
             proof_photo_url = $1,
             delivered_at = NOW(),
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [req.body.proof_photo_url || null, order.id]
      );

      // Начисляем заработок курьеру
      await db.query(
        `UPDATE courier_profiles
         SET total_deliveries = total_deliveries + 1,
             total_earned = total_earned + $1
         WHERE user_id = $2`,
        [order.delivery_fee || 0, req.user.id]
      );

      await publishEvent('order.status_changed', {
        order_id: order.id,
        status: 'delivered',
        client_id: order.client_id,
        cook_id: order.cook_id,
        courier_id: req.user.id,
      });

      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── PATCH /api/courier/location ──────────────────────────────────────────
// Обновить геопозицию курьера (вызывается каждые ~5 сек с телефона)
router.patch(
  '/location',
  auth, role('courier'),
  [
    body('lat').isFloat({ min: -90,  max: 90  }).withMessage('Неверная широта'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Неверная долгота'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { lat, lng } = req.body;
    const courierId = req.user.id;

    try {
      // Сохраняем в Redis (быстро, TTL 60 сек)
      await redis.set(`courier:location:${courierId}`, { lat, lng, ts: Date.now() }, 60);

      // Сохраняем в PostgreSQL (для аналитики и последней позиции)
      await db.query(
        `INSERT INTO courier_locations (courier_id, lat, lng, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (courier_id)
         DO UPDATE SET lat = $2, lng = $3, updated_at = NOW()`,
        [courierId, lat, lng]
      );

      // Рассылаем через Socket.io всем, кто отслеживает этого курьера
      const io = getIO();
      if (io) {
        io.to(`courier_tracking:${courierId}`).emit('courier:moved', {
          courier_id: courierId,
          lat, lng,
          ts: Date.now(),
        });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── GET /api/courier/location/:courier_id ────────────────────────────────
// Получить текущую позицию курьера (клиент спрашивает)
router.get('/location/:courier_id', auth, async (req, res) => {
  try {
    // Сначала из Redis (актуально)
    const cached = await redis.get(`courier:location:${req.params.courier_id}`);
    if (cached) return res.json({ ...cached, source: 'live' });

    // Если нет в Redis — из БД (последняя известная)
    const { rows } = await db.query(
      `SELECT lat, lng, updated_at FROM courier_locations WHERE courier_id = $1`,
      [req.params.courier_id]
    );
    if (!rows.length)
      return res.status(404).json({ error: 'Позиция курьера неизвестна' });

    res.json({ ...rows[0], source: 'last_known' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── PATCH /api/courier/status ────────────────────────────────────────────
// Курьер включает/выключает режим "онлайн"
router.patch(
  '/status',
  auth, role('courier'),
  [body('is_online').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      await db.query(
        `INSERT INTO courier_profiles (user_id, is_online)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET is_online = $2, updated_at = NOW()`,
        [req.user.id, req.body.is_online]
      );

      // Если уходит офлайн — убираем из Redis
      if (!req.body.is_online) {
        await redis.del(`courier:location:${req.user.id}`);
      }

      res.json({ is_online: req.body.is_online });
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── GET /api/courier/stats ───────────────────────────────────────────────
// Статистика курьера (сегодня, неделя, месяц)
router.get('/stats', auth, role('courier'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE DATE(delivered_at) = CURRENT_DATE)    AS today_deliveries,
        COUNT(*) FILTER (WHERE delivered_at >= NOW() - INTERVAL '7 days') AS week_deliveries,
        COUNT(*) FILTER (WHERE delivered_at >= NOW() - INTERVAL '30 days') AS month_deliveries,
        COALESCE(SUM(delivery_fee) FILTER (WHERE DATE(delivered_at) = CURRENT_DATE), 0)   AS today_earned,
        COALESCE(SUM(delivery_fee) FILTER (WHERE delivered_at >= NOW() - INTERVAL '7 days'), 0) AS week_earned,
        COALESCE(SUM(delivery_fee) FILTER (WHERE delivered_at >= NOW() - INTERVAL '30 days'), 0) AS month_earned,
        AVG(rating) FILTER (WHERE rating IS NOT NULL) AS avg_rating
       FROM orders
       WHERE courier_id = $1 AND status = 'delivered'`,
      [req.user.id]
    );

    const profile = await db.query(
      `SELECT total_deliveries, total_earned, is_online
       FROM courier_profiles WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({ ...rows[0], ...profile.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/courier/history ─────────────────────────────────────────────
// История доставок курьера с пагинацией
router.get('/history', auth, role('courier'), async (req, res) => {
  const { limit = 20, offset = 0, date_from, date_to } = req.query;

  try {
    const conditions = ['o.courier_id = $1', "o.status = 'delivered'"];
    const params = [req.user.id];

    if (date_from) {
      params.push(date_from);
      conditions.push(`o.delivered_at >= $${params.length}`);
    }
    if (date_to) {
      params.push(date_to);
      conditions.push(`o.delivered_at <= $${params.length}`);
    }

    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT
         o.id, o.status, o.total_price, o.delivery_fee,
         o.delivery_address, o.delivered_at, o.rating,
         uc.name AS client_name,
         uk.name AS cook_name,
         json_agg(json_build_object(
           'name', d.name, 'quantity', oi.quantity
         )) AS items
       FROM orders o
       JOIN users uc ON o.client_id = uc.id
       JOIN users uk ON o.cook_id   = uk.id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN dishes d ON d.id = oi.dish_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY o.id, uc.name, uk.name
       ORDER BY o.delivered_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/courier/active ──────────────────────────────────────────────
// Текущий активный заказ курьера
router.get('/active', auth, role('courier'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*,
         uc.name AS client_name, uc.phone AS client_phone,
         uk.name AS cook_name,  uk.phone AS cook_phone,
         uk.avatar_url AS cook_avatar,
         json_agg(json_build_object(
           'name', d.name, 'quantity', oi.quantity, 'image_url', d.image_url
         )) AS items
       FROM orders o
       JOIN users uc ON o.client_id = uc.id
       JOIN users uk ON o.cook_id   = uk.id
       JOIN order_items oi ON oi.order_id = o.id
       JOIN dishes d ON d.id = oi.dish_id
       WHERE o.courier_id = $1
         AND o.status IN ('picked_up')
       GROUP BY o.id, uc.name, uc.phone, uk.name, uk.phone, uk.avatar_url
       LIMIT 1`,
      [req.user.id]
    );

    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;

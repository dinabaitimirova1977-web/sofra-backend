const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const db = require('../config/db');
const { auth, role } = require('../middleware/auth');
const { publishEvent } = require('../services/queue');

// ─── POST /api/orders ── Создать заказ (клиент) ───────────────────────────
router.post(
  '/',
  auth, role('client'),
  [
    body('cook_id').isInt().withMessage('Укажите повара'),
    body('items').isArray({ min: 1 }).withMessage('Добавьте блюда'),
    body('items.*.dish_id').isInt(),
    body('items.*.quantity').isInt({ min: 1 }),
    body('delivery_address').notEmpty().withMessage('Укажите адрес доставки'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { cook_id, items, delivery_address, comment } = req.body;
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Считаем сумму и проверяем блюда
      let total = 0;
      const dishIds = items.map(i => i.dish_id);
      const { rows: dishes } = await client.query(
        `SELECT id, price, name, is_available
         FROM dishes WHERE id = ANY($1) AND cook_id = $2`,
        [dishIds, cook_id]
      );

      if (dishes.length !== dishIds.length)
        throw new Error('Некоторые блюда недоступны');

      const dishMap = Object.fromEntries(dishes.map(d => [d.id, d]));
      for (const item of items) {
        const dish = dishMap[item.dish_id];
        if (!dish.is_available) throw new Error(`Блюдо "${dish.name}" недоступно`);
        total += dish.price * item.quantity;
      }

      // Создаём заказ
      const { rows: [order] } = await client.query(
        `INSERT INTO orders
           (client_id, cook_id, total_price, delivery_address, comment, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [req.user.id, cook_id, total, delivery_address, comment]
      );

      // Добавляем позиции
      for (const item of items) {
        const dish = dishMap[item.dish_id];
        await client.query(
          `INSERT INTO order_items (order_id, dish_id, quantity, price_at_order)
           VALUES ($1, $2, $3, $4)`,
          [order.id, item.dish_id, item.quantity, dish.price]
        );
      }

      await client.query('COMMIT');

      // Публикуем событие → повар получает push/сокет
      await publishEvent('order.created', {
        order_id: order.id,
        cook_id,
        total,
        client_id: req.user.id,
      });

      res.status(201).json(order);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// ─── GET /api/orders ── Список заказов (по роли) ──────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    let query, params;
    const { status, limit = 20, offset = 0 } = req.query;

    const statusFilter = status ? 'AND o.status = $2' : '';

    if (req.user.role === 'client') {
      query = `
        SELECT o.*, 
          u.name AS cook_name, u.avatar_url AS cook_avatar,
          u2.name AS courier_name,
          json_agg(json_build_object(
            'dish_id', oi.dish_id, 'name', d.name,
            'quantity', oi.quantity, 'price', oi.price_at_order
          )) AS items
        FROM orders o
        JOIN users u ON o.cook_id = u.id
        LEFT JOIN users u2 ON o.courier_id = u2.id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN dishes d ON d.id = oi.dish_id
        WHERE o.client_id = $1 ${statusFilter}
        GROUP BY o.id, u.name, u.avatar_url, u2.name
        ORDER BY o.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      params = status ? [req.user.id, status] : [req.user.id];

    } else if (req.user.role === 'cook') {
      query = `
        SELECT o.*,
          u.name AS client_name, u.phone AS client_phone,
          json_agg(json_build_object(
            'dish_id', oi.dish_id, 'name', d.name,
            'quantity', oi.quantity, 'price', oi.price_at_order
          )) AS items
        FROM orders o
        JOIN users u ON o.client_id = u.id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN dishes d ON d.id = oi.dish_id
        WHERE o.cook_id = $1 ${statusFilter}
        GROUP BY o.id, u.name, u.phone
        ORDER BY o.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      params = status ? [req.user.id, status] : [req.user.id];

    } else if (req.user.role === 'courier') {
      query = `
        SELECT o.*,
          u.name AS client_name,
          u2.name AS cook_name,
          uc.phone AS client_phone
        FROM orders o
        JOIN users u ON o.client_id = u.id
        JOIN users uc ON o.client_id = uc.id
        JOIN users u2 ON o.cook_id = u2.id
        WHERE (o.courier_id = $1 OR (o.courier_id IS NULL AND o.status = 'ready')) ${statusFilter}
        ORDER BY o.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      params = status ? [req.user.id, status] : [req.user.id];
    } else if (req.user.role === 'admin') {
        query = `
          SELECT o.*,
            uc.name AS client_name, uc.phone AS client_phone,
            ucook.name AS cook_name,
            ucourier.name AS courier_name,
            json_agg(json_build_object(
              'dish_id', oi.dish_id, 'name', d.name,
              'quantity', oi.quantity, 'price', oi.price_at_order
            )) AS items
          FROM orders o
          JOIN users uc ON o.client_id = uc.id
          JOIN users ucook ON o.cook_id = ucook.id
          LEFT JOIN users ucourier ON o.courier_id = ucourier.id
          JOIN order_items oi ON oi.order_id = o.id
          JOIN dishes d ON d.id = oi.dish_id
          ${status ? 'WHERE o.status = $1' : ''}
          GROUP BY o.id, uc.name, uc.phone, ucook.name, ucourier.name
          ORDER BY o.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`;
        params = status ? [status] : [];
      }



    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/orders/:id ───────────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*,
        uc.name AS client_name, uc.phone AS client_phone,
        uk.name AS cook_name, uk.avatar_url AS cook_avatar,
        uu.name AS courier_name, uu.phone AS courier_phone,
        json_agg(json_build_object(
          'dish_id', oi.dish_id, 'name', d.name,
          'quantity', oi.quantity, 'price', oi.price_at_order,
          'image_url', d.image_url
        )) AS items
      FROM orders o
      JOIN users uc ON o.client_id = uc.id
      JOIN users uk ON o.cook_id = uk.id
      LEFT JOIN users uu ON o.courier_id = uu.id
      JOIN order_items oi ON oi.order_id = o.id
      JOIN dishes d ON d.id = oi.dish_id
      WHERE o.id = $1
      GROUP BY o.id, uc.name, uc.phone, uk.name, uk.avatar_url, uu.name, uu.phone`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Заказ не найден' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── PATCH /api/orders/:id/status ── Обновить статус ─────────────────────
const STATUS_TRANSITIONS = {
  client:  { pending: [], confirmed: [], cancelled: ['pending'] },
  cook:    { confirmed: ['pending'], cooking: ['confirmed'], ready: ['cooking'], cancelled: ['pending', 'confirmed'] },
  courier: { picked_up: ['ready'], delivered: ['picked_up'] },
  admin:   null, // может всё
};

router.patch(
  '/:id/status',
  auth,
  [body('status').notEmpty()],
  async (req, res) => {
    const { status } = req.body;
    try {
      const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Заказ не найден' });

      const order = rows[0];
      const allowed = STATUS_TRANSITIONS[req.user.role];

      // Проверяем разрешение перехода
      if (allowed !== null) {
        const validFrom = allowed[status];
        if (!validFrom || !validFrom.includes(order.status))
          return res.status(400).json({ error: `Нельзя перейти в статус "${status}" из "${order.status}"` });
      }

      let updated;
      if (status === 'picked_up' && req.user.role === 'courier') {
        ({ rows: [updated] } = await db.query(
          `UPDATE orders SET status = $1, courier_id = $2, updated_at = NOW()
           WHERE id = $3 RETURNING *`,
          [status, req.user.id, order.id]
        ));
      } else {
        ({ rows: [updated] } = await db.query(
          `UPDATE orders SET status = $1, updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [status, order.id]
        ));
      }


      // Публикуем событие для сокетов и push
      await publishEvent('order.status_changed', {
        order_id: order.id,
        status,
        client_id: order.client_id,
        cook_id: order.cook_id,
        courier_id: order.courier_id,
      });

      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── POST /api/orders/:id/rate ── Оценить заказ (клиент) ─────────────────
router.post(
  '/:id/rate',
  auth, role('client'),
  [
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().isString(),
  ],
  async (req, res) => {
    const { rating, comment } = req.body;
    try {
      const { rows } = await db.query(
        'SELECT * FROM orders WHERE id = $1 AND client_id = $2',
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Заказ не найден' });
      if (rows[0].status !== 'delivered')
        return res.status(400).json({ error: 'Можно оценить только доставленный заказ' });

      await db.query(
        `UPDATE orders SET rating = $1, rating_comment = $2 WHERE id = $3`,
        [rating, comment, req.params.id]
      );

      // Пересчитываем рейтинг повара
      await db.query(
        `UPDATE users SET rating = (
          SELECT AVG(rating) FROM orders
          WHERE cook_id = $1 AND rating IS NOT NULL
        ) WHERE id = $1`,
        [rows[0].cook_id]
      );

      res.json({ message: 'Оценка сохранена' });
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

module.exports = router;

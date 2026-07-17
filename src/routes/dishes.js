const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { auth, role } = require('../middleware/auth');

// ─── GET /api/dishes ── Список блюд (с фильтрами + геолокация) ────────────
router.get('/', async (req, res) => {
  try {
    const { category, cook_id, search, limit = 20, offset = 0, lat, lng } = req.query;

    let conditions = ['d.is_available = true'];
    const params = [];

    if (category) {
      params.push(category);
      conditions.push(`d.category = $${params.length}`);
    }
    if (cook_id) {
      params.push(cook_id);
      conditions.push(`d.cook_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(d.name ILIKE $${params.length} OR d.description ILIKE $${params.length})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Если переданы координаты клиента — считаем расстояние по формуле Haversine (км)
    let distanceSelect = '';
    let orderBy = 'ORDER BY d.created_at DESC';

    if (lat && lng) {
      params.push(parseFloat(lat), parseFloat(lng));
      const latIdx = params.length - 1;
      const lngIdx = params.length;
      distanceSelect = `,
        (6371 * acos(
          cos(radians($${latIdx})) * cos(radians(u.lat)) *
          cos(radians(u.lng) - radians($${lngIdx})) +
          sin(radians($${latIdx})) * sin(radians(u.lat))
        )) AS distance_km`;
      orderBy = 'ORDER BY distance_km ASC NULLS LAST';
    }

    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT d.*, u.name AS cook_name, u.rating AS cook_rating, u.avatar_url AS cook_avatar,
              u.lat AS cook_lat, u.lng AS cook_lng
              ${distanceSelect}
       FROM dishes d
       JOIN users u ON d.cook_id = u.id
       ${where}
       ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── POST /api/dishes ── Создать блюдо (повар) ────────────────────────────
router.post(
  '/',
  auth, role('cook'),
  [
    body('name').trim().notEmpty().withMessage('Название обязательно'),
    body('price').isFloat({ min: 1 }).withMessage('Укажите цену'),
    body('category').notEmpty().withMessage('Укажите категорию'),
    body('cook_time_minutes').isInt({ min: 5 }).withMessage('Укажите время приготовления'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { name, description, price, category, cook_time_minutes, image_url } = req.body;

    try {
      const { rows: [dish] } = await db.query(
        `INSERT INTO dishes
           (cook_id, name, description, price, category, cook_time_minutes, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [req.user.id, name, description, price, category, cook_time_minutes, image_url]
      );
      res.status(201).json(dish);
    } catch (err) {
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ─── PATCH /api/dishes/:id ── Обновить блюдо ──────────────────────────────
router.patch('/:id', auth, role('cook'), async (req, res) => {
  const allowed = ['name', 'description', 'price', 'category',
                   'cook_time_minutes', 'image_url', 'is_available'];
  const updates = [];
  const params = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      updates.push(`${key} = $${params.length}`);
    }
  }

  if (!updates.length)
    return res.status(400).json({ error: 'Нет данных для обновления' });

  params.push(req.params.id, req.user.id);

  try {
    const { rows } = await db.query(
      `UPDATE dishes SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND cook_id = $${params.length}
       RETURNING *`,
      params
    );
    if (!rows.length)
      return res.status(404).json({ error: 'Блюдо не найдено' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── DELETE /api/dishes/:id ────────────────────────────────────────────────
router.delete('/:id', auth, role('cook'), async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM dishes WHERE id = $1 AND cook_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.json({ message: 'Блюдо удалено' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;


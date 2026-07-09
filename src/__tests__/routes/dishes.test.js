// src/__tests__/routes/dishes.test.js
const request = require('supertest');
const app     = require('../../app');
const { clearDB } = require('../setup');
const { createUser, createDish, authHeader } = require('../helpers');

let cook, client, dish;

beforeEach(async () => {
  await clearDB();
  cook   = await createUser({ role: 'cook',   name: 'Тест Повар' });
  client = await createUser({ role: 'client', name: 'Тест Клиент' });
  dish   = await createDish(cook.id);
});

describe('GET /api/dishes', () => {
  it('возвращает список доступных блюд', async () => {
    const res = await request(app).get('/api/dishes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('cook_name');
  });

  it('фильтрует по категории', async () => {
    await createDish(cook.id, { name: 'Манты', category: 'manti' });
    const res = await request(app).get('/api/dishes?category=plov');
    expect(res.status).toBe(200);
    res.body.forEach((d) => expect(d.category).toBe('plov'));
  });

  it('фильтрует по cook_id', async () => {
    const cook2 = await createUser({ role: 'cook' });
    await createDish(cook2.id, { name: 'Чужое блюдо' });

    const res = await request(app).get(`/api/dishes?cook_id=${cook.id}`);
    expect(res.status).toBe(200);
    res.body.forEach((d) => expect(d.cook_id).toBe(cook.id));
  });

  it('ищет по названию', async () => {
    const res = await request(app).get('/api/dishes?search=плов');
    expect(res.status).toBe(200);
    expect(res.body.some((d) => d.name.toLowerCase().includes('плов'))).toBe(true);
  });
});

describe('POST /api/dishes', () => {
  const validDish = {
    name:              'Новый плов',
    price:             550,
    category:          'plov',
    cook_time_minutes: 40,
  };

  it('повар создаёт блюдо', async () => {
    const res = await request(app)
      .post('/api/dishes')
      .set(authHeader(cook))
      .send(validDish);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Новый плов');
    expect(res.body.cook_id).toBe(cook.id);
    expect(res.body.is_available).toBe(true);
  });

  it('клиент не может создать блюдо', async () => {
    const res = await request(app)
      .post('/api/dishes')
      .set(authHeader(client))
      .send(validDish);
    expect(res.status).toBe(403);
  });

  it('отклоняет блюдо без названия', async () => {
    const res = await request(app)
      .post('/api/dishes')
      .set(authHeader(cook))
      .send({ price: 500, category: 'plov', cook_time_minutes: 30 });
    expect(res.status).toBe(400);
  });

  it('отклоняет отрицательную цену', async () => {
    const res = await request(app)
      .post('/api/dishes')
      .set(authHeader(cook))
      .send({ ...validDish, price: -100 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/dishes/:id', () => {
  it('повар обновляет своё блюдо', async () => {
    const res = await request(app)
      .patch(`/api/dishes/${dish.id}`)
      .set(authHeader(cook))
      .send({ price: 600, is_available: false });

    expect(res.status).toBe(200);
    expect(Number(res.body.price)).toBe(600);
    expect(res.body.is_available).toBe(false);
  });

  it('повар не может изменить чужое блюдо', async () => {
    const cook2 = await createUser({ role: 'cook' });
    const res   = await request(app)
      .patch(`/api/dishes/${dish.id}`)
      .set(authHeader(cook2))
      .send({ price: 999 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/dishes/:id', () => {
  it('повар удаляет своё блюдо', async () => {
    const res = await request(app)
      .delete(`/api/dishes/${dish.id}`)
      .set(authHeader(cook));
    expect(res.status).toBe(200);

    // Блюдо больше не возвращается
    const check = await request(app).get('/api/dishes');
    expect(check.body.find((d) => d.id === dish.id)).toBeUndefined();
  });

  it('клиент не может удалить блюдо', async () => {
    const res = await request(app)
      .delete(`/api/dishes/${dish.id}`)
      .set(authHeader(client));
    expect(res.status).toBe(403);
  });
});

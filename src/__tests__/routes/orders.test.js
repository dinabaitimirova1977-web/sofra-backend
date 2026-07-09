// src/__tests__/routes/orders.test.js
const request = require('supertest');
const app     = require('../../app');
const db      = require('../../config/db');
const { clearDB } = require('../setup');
const { createUser, createDish, createOrder, authHeader } = require('../helpers');

// Мокаем очередь
jest.mock('../../services/queue', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  connect:      jest.fn().mockResolvedValue(undefined),
  consume:      jest.fn().mockResolvedValue(undefined),
}));

let client, cook, courier, admin, dish;

beforeEach(async () => {
  await clearDB();
  client  = await createUser({ role: 'client'  });
  cook    = await createUser({ role: 'cook'    });
  courier = await createUser({ role: 'courier' });
  admin   = await createUser({ role: 'admin'   });
  dish    = await createDish(cook.id, { price: 490 });
});

describe('POST /api/orders', () => {
  const validOrder = () => ({
    cook_id:          null, // заполняется в тесте
    items:            [{ dish_id: null, quantity: 2 }],
    delivery_address: 'ул. Абая 1, кв. 5',
  });

  it('клиент создаёт заказ', async () => {
    const payload = {
      cook_id:          cook.id,
      items:            [{ dish_id: dish.id, quantity: 2 }],
      delivery_address: 'ул. Абая 1, кв. 5',
    };
    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(client))
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(Number(res.body.total_price)).toBe(980); // 490 × 2
    expect(res.body.client_id).toBe(client.id);
  });

  it('отклоняет пустой список блюд', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(client))
      .send({ cook_id: cook.id, items: [], delivery_address: 'Адрес' });
    expect(res.status).toBe(400);
  });

  it('повар не может создать заказ', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(cook))
      .send({
        cook_id: cook.id,
        items: [{ dish_id: dish.id, quantity: 1 }],
        delivery_address: 'Адрес',
      });
    expect(res.status).toBe(403);
  });

  it('отклоняет блюдо от другого повара', async () => {
    const cook2  = await createUser({ role: 'cook' });
    const dish2  = await createDish(cook2.id);

    const res = await request(app)
      .post('/api/orders')
      .set(authHeader(client))
      .send({
        cook_id: cook.id,
        items:   [{ dish_id: dish2.id, quantity: 1 }], // блюдо от cook2
        delivery_address: 'Адрес',
      });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/orders', () => {
  it('клиент видит только свои заказы', async () => {
    const client2 = await createUser({ role: 'client' });
    await createOrder(client.id,  cook.id);
    await createOrder(client2.id, cook.id);

    const res = await request(app)
      .get('/api/orders')
      .set(authHeader(client));

    expect(res.status).toBe(200);
    res.body.forEach((o) => expect(o.client_id).toBe(client.id));
  });

  it('повар видит только свои заказы', async () => {
    const cook2 = await createUser({ role: 'cook' });
    await createOrder(client.id, cook.id);
    await createOrder(client.id, cook2.id);

    const res = await request(app)
      .get('/api/orders')
      .set(authHeader(cook));

    expect(res.status).toBe(200);
    res.body.forEach((o) => expect(o.cook_id).toBe(cook.id));
  });

  it('фильтрует по статусу', async () => {
    await createOrder(client.id, cook.id, { status: 'pending' });
    await createOrder(client.id, cook.id, { status: 'delivered' });

    const res = await request(app)
      .get('/api/orders?status=pending')
      .set(authHeader(client));

    expect(res.status).toBe(200);
    res.body.forEach((o) => expect(o.status).toBe('pending'));
  });
});

describe('PATCH /api/orders/:id/status', () => {
  let order;
  beforeEach(async () => {
    order = await createOrder(client.id, cook.id, { status: 'pending' });
  });

  it('повар подтверждает заказ', async () => {
    const res = await request(app)
      .patch(`/api/orders/${order.id}/status`)
      .set(authHeader(cook))
      .send({ status: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
  });

  it('недопустимый переход статуса отклоняется', async () => {
    const res = await request(app)
      .patch(`/api/orders/${order.id}/status`)
      .set(authHeader(cook))
      .send({ status: 'delivered' }); // нельзя из pending

    expect(res.status).toBe(400);
  });

  it('клиент не может менять статус заказа повара', async () => {
    const res = await request(app)
      .patch(`/api/orders/${order.id}/status`)
      .set(authHeader(client))
      .send({ status: 'confirmed' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/orders/:id/rate', () => {
  it('клиент оценивает доставленный заказ', async () => {
    const order = await createOrder(client.id, cook.id, { status: 'delivered' });

    const res = await request(app)
      .post(`/api/orders/${order.id}/rate`)
      .set(authHeader(client))
      .send({ rating: 5, comment: 'Отличная еда!' });

    expect(res.status).toBe(200);

    // Проверяем обновление рейтинга повара
    const { rows } = await db.query('SELECT rating FROM users WHERE id = $1', [cook.id]);
    expect(Number(rows[0].rating)).toBe(5);
  });

  it('нельзя оценить не доставленный заказ', async () => {
    const order = await createOrder(client.id, cook.id, { status: 'cooking' });
    const res   = await request(app)
      .post(`/api/orders/${order.id}/rate`)
      .set(authHeader(client))
      .send({ rating: 4 });
    expect(res.status).toBe(400);
  });

  it('оценка должна быть от 1 до 5', async () => {
    const order = await createOrder(client.id, cook.id, { status: 'delivered' });
    const res   = await request(app)
      .post(`/api/orders/${order.id}/rate`)
      .set(authHeader(client))
      .send({ rating: 6 });
    expect(res.status).toBe(400);
  });
});

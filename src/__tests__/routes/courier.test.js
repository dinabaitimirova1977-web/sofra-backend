// src/__tests__/routes/courier.test.js
const request = require('supertest');
const app     = require('../../app');
const { clearDB } = require('../setup');
const { createUser, createDish, createOrder, authHeader } = require('../helpers');

jest.mock('../../services/queue', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  connect:      jest.fn().mockResolvedValue(undefined),
  consume:      jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/socket', () => ({
  getIO: jest.fn().mockReturnValue(null),
  init:  jest.fn(),
}));

jest.mock('../../config/redis', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  set:     jest.fn().mockResolvedValue(true),
  get:     jest.fn().mockResolvedValue(null),
  del:     jest.fn().mockResolvedValue(true),
  client:  { ttl: jest.fn().mockResolvedValue(60) },
}));

let client, cook, courier, order;

beforeEach(async () => {
  await clearDB();
  client  = await createUser({ role: 'client'  });
  cook    = await createUser({ role: 'cook'    });
  courier = await createUser({ role: 'courier' });
  order   = await createOrder(client.id, cook.id, { status: 'ready' });
});

describe('GET /api/courier/available-orders', () => {
  it('курьер видит заказы со статусом ready', async () => {
    const res = await request(app)
      .get('/api/courier/available-orders')
      .set(authHeader(courier));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((o) => o.id === order.id)).toBe(true);
  });

  it('клиент не может получить доступные заказы', async () => {
    const res = await request(app)
      .get('/api/courier/available-orders')
      .set(authHeader(client));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/courier/orders/:id/accept', () => {
  it('курьер берёт заказ', async () => {
    const res = await request(app)
      .post(`/api/courier/orders/${order.id}/accept`)
      .set(authHeader(courier));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('picked_up');
    expect(res.body.courier_id).toBe(courier.id);
  });

  it('два курьера не могут взять один заказ', async () => {
    const courier2 = await createUser({ role: 'courier' });

    await request(app)
      .post(`/api/courier/orders/${order.id}/accept`)
      .set(authHeader(courier));

    const res = await request(app)
      .post(`/api/courier/orders/${order.id}/accept`)
      .set(authHeader(courier2));

    expect(res.status).toBe(409);
  });

  it('нельзя взять заказ не в статусе ready', async () => {
    const pendingOrder = await createOrder(client.id, cook.id, { status: 'pending' });
    const res = await request(app)
      .post(`/api/courier/orders/${pendingOrder.id}/accept`)
      .set(authHeader(courier));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/courier/location', () => {
  it('курьер обновляет геопозицию', async () => {
    const res = await request(app)
      .patch('/api/courier/location')
      .set(authHeader(courier))
      .send({ lat: 43.238949, lng: 76.889709 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('отклоняет некорректные координаты', async () => {
    const res = await request(app)
      .patch('/api/courier/location')
      .set(authHeader(courier))
      .send({ lat: 999, lng: 76.889709 }); // широта > 90

    expect(res.status).toBe(400);
  });

  it('клиент не может обновить геопозицию', async () => {
    const res = await request(app)
      .patch('/api/courier/location')
      .set(authHeader(client))
      .send({ lat: 43.238949, lng: 76.889709 });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/courier/status', () => {
  it('курьер переходит в онлайн', async () => {
    const res = await request(app)
      .patch('/api/courier/status')
      .set(authHeader(courier))
      .send({ is_online: true });

    expect(res.status).toBe(200);
    expect(res.body.is_online).toBe(true);
  });

  it('курьер уходит офлайн', async () => {
    const res = await request(app)
      .patch('/api/courier/status')
      .set(authHeader(courier))
      .send({ is_online: false });

    expect(res.status).toBe(200);
    expect(res.body.is_online).toBe(false);
  });
});

describe('GET /api/courier/stats', () => {
  it('возвращает статистику курьера', async () => {
    const res = await request(app)
      .get('/api/courier/stats')
      .set(authHeader(courier));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('today_deliveries');
    expect(res.body).toHaveProperty('today_earned');
    expect(res.body).toHaveProperty('week_deliveries');
  });
});

describe('POST /api/courier/orders/:id/deliver', () => {
  it('курьер подтверждает доставку', async () => {
    // Сначала берём заказ
    await request(app)
      .post(`/api/courier/orders/${order.id}/accept`)
      .set(authHeader(courier));

    const res = await request(app)
      .post(`/api/courier/orders/${order.id}/deliver`)
      .set(authHeader(courier));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('delivered');
  });

  it('нельзя завершить чужую доставку', async () => {
    const courier2 = await createUser({ role: 'courier' });
    await request(app)
      .post(`/api/courier/orders/${order.id}/accept`)
      .set(authHeader(courier));

    const res = await request(app)
      .post(`/api/courier/orders/${order.id}/deliver`)
      .set(authHeader(courier2));

    expect(res.status).toBe(404);
  });
});

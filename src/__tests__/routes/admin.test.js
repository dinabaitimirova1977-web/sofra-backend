// src/__tests__/routes/admin.test.js
const request = require('supertest');
const app     = require('../../app');
const { clearDB } = require('../setup');
const { createUser, createOrder, authHeader } = require('../helpers');

jest.mock('../../services/queue', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
  connect:      jest.fn().mockResolvedValue(undefined),
  consume:      jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../config/redis', () => ({
  connect: jest.fn(),
  set:     jest.fn(),
  get:     jest.fn().mockResolvedValue(null),
  del:     jest.fn(),
  client:  {},
}));

let admin, client, cook;

beforeEach(async () => {
  await clearDB();
  admin  = await createUser({ role: 'admin',  name: 'Администратор' });
  client = await createUser({ role: 'client', name: 'Клиент' });
  cook   = await createUser({ role: 'cook',   name: 'Повар' });
});

describe('GET /api/admin/dashboard', () => {
  it('админ получает дашборд', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('orders');
    expect(res.body).toHaveProperty('users');
    expect(res.body).toHaveProperty('revenue');
    expect(res.body).toHaveProperty('active');
  });

  it('клиент не может получить дашборд', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set(authHeader(client));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/users', () => {
  it('возвращает список пользователей', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('users');
    expect(res.body.total).toBeGreaterThanOrEqual(3); // admin + client + cook
  });

  it('фильтрует по роли', async () => {
    const res = await request(app)
      .get('/api/admin/users?role=cook')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    res.body.users.forEach((u) => expect(u.role).toBe('cook'));
  });

  it('ищет по имени', async () => {
    const res = await request(app)
      .get('/api/admin/users?search=Клиент')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.users.some((u) => u.name.includes('Клиент'))).toBe(true);
  });
});

describe('PATCH /api/admin/users/:id', () => {
  it('блокирует пользователя', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${client.id}`)
      .set(authHeader(admin))
      .send({ is_active: false, reason: 'Нарушение правил' });

    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it('разблокирует пользователя', async () => {
    // Сначала блокируем
    await request(app)
      .patch(`/api/admin/users/${client.id}`)
      .set(authHeader(admin))
      .send({ is_active: false });

    const res = await request(app)
      .patch(`/api/admin/users/${client.id}`)
      .set(authHeader(admin))
      .send({ is_active: true });

    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(true);
  });

  it('нельзя заблокировать самого себя', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${admin.id}`)
      .set(authHeader(admin))
      .send({ is_active: false });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/orders', () => {
  it('возвращает все заказы', async () => {
    await createOrder(client.id, cook.id);
    await createOrder(client.id, cook.id, { status: 'delivered' });

    const res = await request(app)
      .get('/api/admin/orders')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body).toHaveProperty('orders');
  });

  it('фильтрует по статусу', async () => {
    await createOrder(client.id, cook.id, { status: 'pending'   });
    await createOrder(client.id, cook.id, { status: 'delivered' });

    const res = await request(app)
      .get('/api/admin/orders?status=pending')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    res.body.orders.forEach((o) => expect(o.status).toBe('pending'));
  });
});

describe('PATCH /api/admin/orders/:id/cancel', () => {
  it('принудительно отменяет заказ', async () => {
    const order = await createOrder(client.id, cook.id, { status: 'cooking' });

    const res = await request(app)
      .patch(`/api/admin/orders/${order.id}/cancel`)
      .set(authHeader(admin))
      .send({ reason: 'Технический сбой' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('нельзя отменить доставленный заказ', async () => {
    const order = await createOrder(client.id, cook.id, { status: 'delivered' });

    const res = await request(app)
      .patch(`/api/admin/orders/${order.id}/cancel`)
      .set(authHeader(admin))
      .send({ reason: 'Тест' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/issues', () => {
  it('возвращает проблемные заказы', async () => {
    const res = await request(app)
      .get('/api/admin/issues')
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

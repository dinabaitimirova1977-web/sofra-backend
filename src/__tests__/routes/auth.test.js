// src/__tests__/routes/auth.test.js
const request = require('supertest');
const app     = require('../../app');
const { clearDB, createUser, authHeader } = require('../helpers');
const { clearDB: clear } = require('../setup');

// Мокаем SMS
jest.mock('../../services/sms', () => ({
  sendOTP:   jest.fn().mockResolvedValue({ expires_in: 120, sends_left: 4 }),
  verifyOTP: jest.fn().mockResolvedValue(true),
}));

beforeEach(clear);

describe('POST /api/auth/sms/send', () => {
  it('отправляет OTP на корректный номер', async () => {
    const res = await request(app)
      .post('/api/auth/sms/send')
      .send({ phone: '+77001234567' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('expires_in');
    expect(res.body).toHaveProperty('is_new_user');
  });

  it('возвращает is_new_user=false для существующего пользователя', async () => {
    await createUser({ phone: '+77009876543' });

    const res = await request(app)
      .post('/api/auth/sms/send')
      .send({ phone: '+77009876543' });

    expect(res.status).toBe(200);
    expect(res.body.is_new_user).toBe(false);
  });

  it('отклоняет некорректный номер', async () => {
    const res = await request(app)
      .post('/api/auth/sms/send')
      .send({ phone: '123' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/sms/verify', () => {
  it('регистрирует нового пользователя', async () => {
    const res = await request(app)
      .post('/api/auth/sms/verify')
      .send({
        phone:        '+77001112233',
        code:         '123456',
        name:         'Иван Иванов',
        role:         'client',
        is_new_user:  'true',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.role).toBe('client');
    expect(res.body.is_new_user).toBe(true);
  });

  it('авторизует существующего пользователя', async () => {
    await createUser({ phone: '+77005556677' });

    const res = await request(app)
      .post('/api/auth/sms/verify')
      .send({ phone: '+77005556677', code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.is_new_user).toBe(false);
  });

  it('требует имя и роль для нового пользователя', async () => {
    const res = await request(app)
      .post('/api/auth/sms/verify')
      .send({ phone: '+77001234000', code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/auth/me', () => {
  it('возвращает текущего пользователя', async () => {
    const user = await createUser();
    const res  = await request(app)
      .get('/api/auth/me')
      .set(authHeader(user));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body).not.toHaveProperty('password_hash');
  });

  it('отклоняет без токена', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('отклоняет невалидный токен', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid_token');
    expect(res.status).toBe(401);
  });
});

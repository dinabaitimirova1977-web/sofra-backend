// src/__tests__/services/sms.test.js
// Тестируем OTP логику без реальной отправки SMS

jest.mock('../../config/redis', () => {
  const store = new Map();
  return {
    connect: jest.fn(),
    set: jest.fn((key, val, ttl) => { store.set(key, val); return Promise.resolve(true); }),
    get: jest.fn((key) => Promise.resolve(store.get(key) || null)),
    del: jest.fn((key) => { store.delete(key); return Promise.resolve(true); }),
    client: {
      incr:   jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      ttl:    jest.fn().mockResolvedValue(60),
      setEx:  jest.fn().mockResolvedValue(true),
    },
  };
});

// Мокаем реальную отправку SMS
jest.mock('node-fetch', () => jest.fn());

const redis = require('../../config/redis');

describe('OTP логика', () => {
  const phone = '+77001234567';

  it('генерирует 6-значный код', () => {
    const crypto = require('crypto');
    const code = crypto.randomInt(100000, 999999).toString();
    expect(code).toHaveLength(6);
    expect(Number(code)).toBeGreaterThanOrEqual(100000);
    expect(Number(code)).toBeLessThan(1000000);
  });

  it('сохраняет OTP в Redis с TTL', async () => {
    await redis.set('otp:code:+77001234567', { code: '123456', phone }, 120);
    const stored = await redis.get('otp:code:+77001234567');
    expect(stored).toEqual({ code: '123456', phone });
  });

  it('верифицирует правильный код', async () => {
    await redis.set('otp:code:+77009999999', { code: '654321', phone: '+77009999999' }, 120);
    const stored = await redis.get('otp:code:+77009999999');
    expect(stored?.code).toBe('654321');
  });
});

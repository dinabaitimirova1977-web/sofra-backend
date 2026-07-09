// src/services/payments/index.js
// Единый интерфейс для всех платёжных систем
const kaspi = require('./kaspi');
const halyk = require('./halyk');

const PROVIDERS = { kaspi, halyk };

// ─── Создать платёж ───────────────────────────────────────
const createPayment = async (provider, params) => {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Неизвестный провайдер: ${provider}`);
  return p.createPayment(params);
};

// ─── Проверить статус ─────────────────────────────────────
const checkPayment = async (provider, paymentId) => {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Неизвестный провайдер: ${provider}`);
  return p.checkPayment(paymentId);
};

// ─── Сделать возврат ──────────────────────────────────────
const refundPayment = async (provider, paymentId, amount, reason) => {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Неизвестный провайдер: ${provider}`);
  return p.refundPayment(paymentId, amount, reason);
};

// ─── Верифицировать callback ──────────────────────────────
const verifyCallback = (provider, body, signature) => {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Неизвестный провайдер: ${provider}`);
  return p.verifyCallback(body, signature);
};

// ─── Нормализация статусов ────────────────────────────────
// Разные провайдеры → единые статусы Sofra
const normalizeStatus = (provider, rawStatus) => {
  const maps = {
    kaspi: {
      PAID:    'paid',
      PENDING: 'pending',
      FAILED:  'failed',
      EXPIRED: 'expired',
    },
    halyk: {
      CHARGED:    'paid',
      AUTHORIZED: 'pending',
      NEW:        'pending',
      FAILED:     'failed',
      REFUND:     'refunded',
    },
  };
  return maps[provider]?.[rawStatus] || 'unknown';
};

module.exports = { createPayment, checkPayment, refundPayment, verifyCallback, normalizeStatus };

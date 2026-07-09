// src/services/payments/kaspi.js
// Kaspi Pay — основной платёжный метод Казахстана
const crypto = require('crypto');

const BASE_URL = 'https://api.kaspi.kz/payments/v1';

// ─── Создание платежа ─────────────────────────────────────
const createPayment = async ({ orderId, amount, description, returnUrl }) => {
  const merchantId  = process.env.KASPI_MERCHANT_ID;
  const secretKey   = process.env.KASPI_SECRET_KEY;
  const timestamp   = Date.now().toString();

  // Подпись запроса
  const signStr = `${merchantId}${orderId}${amount}${timestamp}${secretKey}`;
  const signature = crypto.createHash('sha256').update(signStr).digest('hex');

  const payload = {
    merchant_id:  merchantId,
    order_id:     `SOFRA-${orderId}`,
    amount:       Math.round(amount * 100), // в тиынах
    currency:     'KZT',
    description,
    return_url:   returnUrl || process.env.KASPI_RETURN_URL,
    callback_url: `${process.env.APP_URL}/api/payments/kaspi/callback`,
    timestamp,
    signature,
  };

  const resp = await fetch(`${BASE_URL}/create`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Merchant-Id': merchantId },
    body:    JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok || data.status !== 'success') {
    throw new Error(data.message || 'Kaspi Pay: ошибка создания платежа');
  }

  return {
    payment_id:  data.payment_id,
    payment_url: data.payment_url, // QR или диплинк для Kaspi
    qr_code:     data.qr_code,     // base64 QR-изображение
    expires_at:  data.expires_at,
  };
};

// ─── Проверка статуса платежа ─────────────────────────────
const checkPayment = async (paymentId) => {
  const merchantId = process.env.KASPI_MERCHANT_ID;
  const secretKey  = process.env.KASPI_SECRET_KEY;
  const timestamp  = Date.now().toString();
  const signature  = crypto
    .createHash('sha256')
    .update(`${merchantId}${paymentId}${timestamp}${secretKey}`)
    .digest('hex');

  const resp = await fetch(
    `${BASE_URL}/status?payment_id=${paymentId}&merchant_id=${merchantId}&timestamp=${timestamp}&signature=${signature}`
  );
  const data = await resp.json();
  return data; // { status: 'PAID' | 'PENDING' | 'FAILED' | 'EXPIRED' }
};

// ─── Верификация callback-подписи ─────────────────────────
const verifyCallback = (body, receivedSign) => {
  const { merchant_id, payment_id, order_id, amount, timestamp } = body;
  const expected = crypto
    .createHash('sha256')
    .update(`${merchant_id}${payment_id}${order_id}${amount}${timestamp}${process.env.KASPI_SECRET_KEY}`)
    .digest('hex');
  return expected === receivedSign;
};

// ─── Возврат платежа ──────────────────────────────────────
const refundPayment = async (paymentId, amount, reason) => {
  const merchantId = process.env.KASPI_MERCHANT_ID;
  const timestamp  = Date.now().toString();
  const signature  = crypto
    .createHash('sha256')
    .update(`${merchantId}${paymentId}${amount}${timestamp}${process.env.KASPI_SECRET_KEY}`)
    .digest('hex');

  const resp = await fetch(`${BASE_URL}/refund`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      merchant_id: merchantId,
      payment_id:  paymentId,
      amount:      Math.round(amount * 100),
      reason,
      timestamp,
      signature,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Kaspi Pay: ошибка возврата');
  return data;
};

module.exports = { createPayment, checkPayment, verifyCallback, refundPayment };

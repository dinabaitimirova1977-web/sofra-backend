// src/services/payments/halyk.js
// Halyk Bank eCommerce / HalykPay — второй по популярности в Казахстане
const crypto = require('crypto');

const BASE_URL = 'https://epay.halykbank.kz';

// ─── Генерация токена доступа ─────────────────────────────
let _token = null;
let _tokenExp = 0;

const getToken = async () => {
  if (_token && Date.now() < _tokenExp) return _token;

  const resp = await fetch(`${BASE_URL}/auth/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.HALYK_CLIENT_ID,
      client_secret: process.env.HALYK_CLIENT_SECRET,
      scope:         'payment',
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Halyk auth error: ${data.error}`);

  _token    = data.access_token;
  _tokenExp = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
};

// ─── Создание инвойса / платежа ───────────────────────────
const createPayment = async ({ orderId, amount, description, backUrl }) => {
  const token = await getToken();
  const invoiceId = `SOFRA-${orderId}-${Date.now()}`;

  const payload = {
    amount:      amount,           // в тенге (не тиынах)
    currency:    'KZT',
    invoiceId,
    description: description || `Заказ Sofra #${orderId}`,
    terminal:    process.env.HALYK_TERMINAL_ID,
    backLink:    backUrl || process.env.HALYK_RETURN_URL,
    failureBackLink: `${process.env.APP_URL}/payment/failed`,
    callbackUrl: `${process.env.APP_URL}/api/payments/halyk/callback`,
    language:    'rus',
  };

  const resp = await fetch(`${BASE_URL}/api/create-payment`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok || !data.id)
    throw new Error(data.message || 'Halyk: ошибка создания платежа');

  // Ссылка для редиректа или встраивания
  const paymentUrl = `${BASE_URL}/payment?invoiceId=${data.id}&back=${encodeURIComponent(backUrl)}`;

  return {
    payment_id:  data.id,
    invoice_id:  invoiceId,
    payment_url: paymentUrl,
    expires_at:  new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 мин
  };
};

// ─── Проверка статуса ─────────────────────────────────────
const checkPayment = async (invoiceId) => {
  const token = await getToken();

  const resp = await fetch(`${BASE_URL}/api/check-status/payment/${invoiceId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await resp.json();
  // status: 'NEW' | 'AUTHORIZED' | 'CHARGED' | 'FAILED' | 'REFUND'
  return {
    status:     data.status,
    amount:     data.amount,
    invoice_id: data.invoiceId,
    paid_at:    data.chargedAt,
  };
};

// ─── Верификация webhook ──────────────────────────────────
const verifyCallback = (body, signature) => {
  const hmac = crypto.createHmac('sha256', process.env.HALYK_CLIENT_SECRET);
  hmac.update(JSON.stringify(body));
  return hmac.digest('hex') === signature;
};

// ─── Возврат ──────────────────────────────────────────────
const refundPayment = async (invoiceId, amount, reason) => {
  const token = await getToken();

  const resp = await fetch(`${BASE_URL}/api/refund`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ invoiceId, amount, reason }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Halyk: ошибка возврата');
  return data;
};

module.exports = { createPayment, checkPayment, verifyCallback, refundPayment };

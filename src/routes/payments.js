// src/routes/payments.js
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const { auth, role } = require('../middleware/auth');
const payments = require('../services/payments');
const push     = require('../services/push');

// ─── POST /api/payments/create ────────────────────────────
// Клиент инициирует оплату заказа
router.post(
  '/create',
  auth, role('client'),
  [
    body('order_id').isInt().withMessage('Укажите заказ'),
    body('provider').isIn(['kaspi', 'halyk']).withMessage('Укажите провайдера'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    const { order_id, provider } = req.body;

    try {
      // Проверяем заказ
      const { rows } = await db.query(
        `SELECT o.*, u.name AS cook_name
         FROM orders o JOIN users u ON u.id = o.cook_id
         WHERE o.id = $1 AND o.client_id = $2`,
        [order_id, req.user.id]
      );
      const order = rows[0];
      if (!order) return res.status(404).json({ error: 'Заказ не найден' });
      if (order.payment_status === 'paid')
        return res.status(400).json({ error: 'Заказ уже оплачен' });

      // Создаём платёж у провайдера
      const result = await payments.createPayment(provider, {
        orderId:     order.id,
        amount:      Number(order.total_price),
        description: `Sofra: заказ у ${order.cook_name}`,
        returnUrl:   `${process.env.APP_URL}/payment/success`,
      });

      // Сохраняем в БД
      const { rows: [payment] } = await db.query(
        `INSERT INTO payments
           (order_id, provider, provider_id, invoice_id, amount, payment_url, qr_code, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          order.id, provider,
          result.payment_id, result.invoice_id,
          order.total_price,
          result.payment_url, result.qr_code,
          result.expires_at,
        ]
      );

      // Обновляем заказ
      await db.query(
        `UPDATE orders SET payment_method = $1, payment_id = $2 WHERE id = $3`,
        [provider, payment.id, order.id]
      );

      res.json({
        payment_id:  payment.id,
        provider,
        payment_url: result.payment_url,
        qr_code:     result.qr_code,
        expires_at:  result.expires_at,
        amount:      order.total_price,
      });
    } catch (err) {
      console.error('Payment create error:', err);
      res.status(500).json({ error: err.message || 'Ошибка создания платежа' });
    }
  }
);

// ─── GET /api/payments/:id/status ─────────────────────────
// Клиент проверяет статус оплаты (polling)
router.get('/:id/status', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, o.client_id FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    const payment = rows[0];
    if (!payment) return res.status(404).json({ error: 'Платёж не найден' });

    // Только участники заказа
    if (payment.client_id !== req.user.id && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Доступ запрещён' });

    // Если ещё pending — проверяем у провайдера
    if (payment.status === 'pending') {
      const providerStatus = await payments.checkPayment(
        payment.provider,
        payment.provider_id || payment.invoice_id
      );
      const normalized = payments.normalizeStatus(payment.provider, providerStatus.status);

      if (normalized !== 'pending') {
        await db.query(
          `UPDATE payments SET status = $1, paid_at = $2, raw_response = $3,
            updated_at = NOW() WHERE id = $4`,
          [normalized, normalized === 'paid' ? new Date() : null,
           JSON.stringify(providerStatus), payment.id]
        );
        if (normalized === 'paid') {
          await handlePaymentSuccess(payment.order_id);
        }
        payment.status = normalized;
      }
    }

    res.json({ status: payment.status, amount: payment.amount, provider: payment.provider });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка проверки платежа' });
  }
});

// ─── POST /api/payments/kaspi/callback ────────────────────
// Webhook от Kaspi Pay
router.post('/kaspi/callback', async (req, res) => {
  const signature = req.headers['x-kaspi-signature'];
  if (!payments.verifyCallback('kaspi', req.body, signature)) {
    return res.status(400).json({ error: 'Неверная подпись' });
  }

  const { order_id: rawOrderId, payment_id, status } = req.body;
  const orderId = parseInt(rawOrderId.replace('SOFRA-', ''));
  const normalized = payments.normalizeStatus('kaspi', status);

  await processCallback(orderId, payment_id, normalized, req.body);
  res.json({ ok: true });
});

// ─── POST /api/payments/halyk/callback ────────────────────
// Webhook от Halyk Bank
router.post('/halyk/callback', async (req, res) => {
  const signature = req.headers['x-halyk-signature'];
  if (!payments.verifyCallback('halyk', req.body, signature)) {
    return res.status(400).json({ error: 'Неверная подпись' });
  }

  const { invoiceId, status } = req.body;
  const orderId = parseInt(invoiceId.split('-')[1]);
  const normalized = payments.normalizeStatus('halyk', status);

  await processCallback(orderId, invoiceId, normalized, req.body);
  res.json({ resultCode: '00' }); // Halyk ждёт именно этот ответ
});

// ─── POST /api/payments/:id/refund ────────────────────────
// Возврат (только admin или при отмене заказа)
router.post(
  '/:id/refund',
  auth,
  [body('reason').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ errors: errors.array() });

    try {
      const { rows } = await db.query(
        `SELECT p.*, o.client_id FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.id = $1 AND p.status = 'paid'`,
        [req.params.id]
      );
      const payment = rows[0];
      if (!payment) return res.status(404).json({ error: 'Оплаченный платёж не найден' });

      if (req.user.role !== 'admin' && payment.client_id !== req.user.id)
        return res.status(403).json({ error: 'Доступ запрещён' });

      await payments.refundPayment(
        payment.provider,
        payment.provider_id || payment.invoice_id,
        Number(payment.amount),
        req.body.reason
      );

      await db.query(
        `UPDATE payments SET status = 'refunded', refunded_at = NOW() WHERE id = $1`,
        [payment.id]
      );
      await db.query(
        `UPDATE orders SET payment_status = 'refunded' WHERE id = $1`,
        [payment.order_id]
      );

      res.json({ ok: true, message: 'Возврат выполнен' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Вспомогательные функции ──────────────────────────────

// Обработка успешного callback от провайдера
const processCallback = async (orderId, providerId, status, rawBody) => {
  const dbClient = await db.getClient();
  try {
    await dbClient.query('BEGIN');

    await dbClient.query(
      `UPDATE payments
       SET status = $1, paid_at = $2, raw_response = $3, updated_at = NOW()
       WHERE order_id = $4 AND status = 'pending'`,
      [status, status === 'paid' ? new Date() : null, JSON.stringify(rawBody), orderId]
    );

    if (status === 'paid') await handlePaymentSuccess(orderId, dbClient);

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    console.error('Callback processing error:', err);
  } finally {
    dbClient.release();
  }
};

// Действия после успешной оплаты
const handlePaymentSuccess = async (orderId, dbClient = db) => {
  await dbClient.query(
    `UPDATE orders SET payment_status = 'paid' WHERE id = $1`,
    [orderId]
  );

  // Уведомляем клиента
  const { rows } = await db.query(
    'SELECT client_id, cook_id FROM orders WHERE id = $1', [orderId]
  );
  if (rows[0]) {
    await push.sendToUser(rows[0].client_id, {
      title: '💳 Оплата прошла!',
      body:  `Заказ #${orderId} оплачен — повар уже начинает готовить`,
    });
  }
};

module.exports = router;

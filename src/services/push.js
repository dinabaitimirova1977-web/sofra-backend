// src/services/push.js
let messaging = null;

const init = () => {
  try {
    if (!process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID === 'sofra') {
      console.warn('⚠️ Firebase not configured, push disabled');
      return;
    }
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    const app = initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    messaging = getMessaging(app);
    console.log('✅ Firebase push initialized');
  } catch (err) {
    console.warn('⚠️ Firebase init error:', err.message);
  }
};

const sendToUser = async (userId, notification, data = {}) => {
  if (!messaging) return null;
  try {
    const db = require('../config/db');
    const { rows } = await db.query(
      'SELECT fcm_token FROM users WHERE id = $1 AND fcm_token IS NOT NULL', [userId]
    );
    if (!rows.length) return null;
    return await sendToToken(rows[0].fcm_token, notification, data);
  } catch (err) {
    console.error('Push error:', err.message);
    return null;
  }
};

const sendToToken = async (token, { title, body }, data = {}) => {
  if (!messaging) return null;
  try {
    return await messaging.send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
  } catch (err) {
    console.error('Push send error:', err.message);
    return null;
  }
};

const sendToMultiple = async (userIds, notification, data = {}) => {
  if (!messaging) return null;
  return null;
};

const handleOrderEvent = async (event) => {
  if (!messaging) return;
  const { order_id, status, client_id, cook_id, courier_id, cook_name, courier_name, total } = event;
  
  try {
    if (status === 'confirmed') await sendToUser(client_id, { title: '✅ Заказ принят!', body: `Повар начинает готовить заказ #${order_id}` });
    if (status === 'picked_up') await sendToUser(client_id, { title: '🛵 Курьер едет!', body: `Заказ #${order_id} уже в пути` });
    if (status === 'delivered') await sendToUser(client_id, { title: '🎉 Доставлено!', body: `Заказ #${order_id} доставлен` });
    if (!status && event.type === 'order.created') await sendToUser(cook_id, { title: '🔔 Новый заказ!', body: `${total} ₸` });
  } catch (e) {
    console.error('Push event error:', e.message);
  }
};

module.exports = { init, sendToUser, sendToToken, sendToMultiple, handleOrderEvent };

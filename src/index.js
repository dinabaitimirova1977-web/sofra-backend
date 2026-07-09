require('dotenv').config();
const http   = require('http');
const app    = require('./app');
const redis  = require('./config/redis');
const db     = require('./config/db');

const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

const start = async () => {
  try {
    // PostgreSQL — обязательно
    await db.query('SELECT 1');
    console.log('✅ PostgreSQL connected');

    // Redis — обязательно
    await redis.connect();
    console.log('✅ Redis connected');

    // RabbitMQ — необязательно, не останавливаем если нет
    try {
      const queue = require('./services/queue');
      await queue.connect();
      console.log('✅ RabbitMQ connected');

      // Socket.io
      const socket = require('./services/socket');
      socket.init(server);

      // Push уведомления
      try {
        const push = require('./services/push');
        push.init();
        queue.consume('orders', push.handleOrderEvent);
        console.log('✅ Push notifications ready');
      } catch (e) {
        console.warn('⚠️ Push notifications disabled:', e.message);
      }

    } catch (e) {
      console.warn('⚠️ RabbitMQ not available, continuing without queue:', e.message);
    }

    server.listen(PORT, () =>
      console.log(`🚀 Sofra API запущена на http://localhost:${PORT}`)
    );

  } catch (err) {
    console.error('❌ Startup error:', err);
    process.exit(1);
  }
};

start();

let io = null;

const init = (server) => {
  try {
    const { Server } = require('socket.io');
    const jwt = require('jsonwebtoken');

    io = new Server(server, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
    });

    io.use((socket, next) => {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('Токен не предоставлен'));
      try {
        socket.user = jwt.verify(token, process.env.JWT_SECRET || 'sofra_secret_key_2026');
        next();
      } catch {
        next(new Error('Недействительный токен'));
      }
    });

    io.on('connection', (socket) => {
      const { id, role } = socket.user;
      socket.join(`user:${id}`);

      if (role === 'courier') {
        socket.join('couriers');
        socket.on('location:update', async (coords) => {
          try {
            const redis = require('../config/redis');
            await redis.set(`courier:location:${id}`, coords, 30);
            socket.to(`courier_tracking:${id}`).emit('courier:moved', { courier_id: id, ...coords });
          } catch (e) {}
        });
      }

      socket.on('track:courier', (courier_id) => {
        socket.join(`courier_tracking:${courier_id}`);
      });
    });

    console.log('✅ Socket.io ready');
  } catch (e) {
    console.warn('⚠️ Socket.io error:', e.message);
  }
  return io;
};

const getIO = () => io;

module.exports = { init, getIO };

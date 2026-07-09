require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Слишком много запросов, попробуйте позже' },
}));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/auth/sms', require('./routes/sms-auth'));
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/dishes',   require('./routes/dishes'));
app.use('/api/courier',  require('./routes/courier'));
app.use('/api/cook',     require('./routes/cook'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/push',     require('./routes/push'));
app.use('/api/payments', require('./routes/payments'));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  time:   new Date().toISOString(),
  env:    process.env.NODE_ENV,
}));

app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

module.exports = app;

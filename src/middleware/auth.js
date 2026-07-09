const jwt = require('jsonwebtoken');

// Проверка JWT токена
const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, phone }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
};

// Проверка роли: auth, role('cook'), role('admin') и т.д.
const role = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
};

module.exports = { auth, role };

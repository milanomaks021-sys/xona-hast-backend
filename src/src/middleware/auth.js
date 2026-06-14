const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');

const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Токен не найден' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query('SELECT * FROM users WHERE id = $1 AND is_blocked = FALSE', [decoded.id]);
    if (!result.rows.length) {
      return res.status(401).json({ success: false, message: 'Пользователь не найден' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Неверный токен' });
  }
};

const adminMiddleware = async (req, res, next) => {
  await authMiddleware(req, res, async () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Только для администраторов' });
    }
    next();
  });
};

const optionalAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      const token = header.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query('SELECT * FROM users WHERE id = $1', [decoded.id]);
      if (result.rows.length) req.user = result.rows[0];
    }
  } catch (_) {}
  next();
};

module.exports = { authMiddleware, adminMiddleware, optionalAuth };

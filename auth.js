const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET saknas — sätt miljövariabeln JWT_SECRET (se .env.example) innan servern startas.');
  process.exit(1);
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Inte inloggad' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user     = decoded;
    req.tenantId = decoded.tenantId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Ogiltig session — logga in igen' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Kräver admin-behörighet' });
  next();
}

module.exports = { authMiddleware, adminOnly, JWT_SECRET };

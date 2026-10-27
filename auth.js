const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET saknas — sätt miljövariabeln JWT_SECRET (se .env.example) innan servern startas.');
  process.exit(1);
}
if (!process.env.ADMIN_SECRET) {
  console.error('VARNING: ADMIN_SECRET saknas — superadmin och create-tenant nekas tills variabeln är satt.');
}

// Tom eller saknad ADMIN_SECRET nekas. Lika långa värden jämförs tidsäkert.
function adminAuthorized(header) {
  const expected = process.env.ADMIN_SECRET;
  if (!expected || typeof expected !== 'string') return false;
  const providedRaw = Array.isArray(header) ? '' : header;
  const provided = Buffer.from(String(providedRaw ?? ''), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (provided.length !== wanted.length) return false;
  return crypto.timingSafeEqual(provided, wanted);
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

module.exports = { authMiddleware, adminOnly, adminAuthorized, JWT_SECRET };

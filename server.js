require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path       = require('path');
const cors       = require('cors');

const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const { Tenant, User, Product, Order, Vehicle, Log, InventoryReport } = require('./models');
const ALLOWED_ORIGINS = ['https://scanny.se', 'https://www.scanny.se', 'http://localhost:3001'];
const { authMiddleware, adminOnly, JWT_SECRET } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error('CORS blockerad'));
  },
  credentials: true
}));
// Tvinga HTTPS i produktion
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

app.use(helmet({
  contentSecurityPolicy: false, // Stängs av för att inte bryta inline-scripts
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '10kb' }));
app.use(mongoSanitize());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ──
const loginLimiter = rateLimit({
  handler: (req, res) => {
    console.warn(`[SECURITY] Rate limit: för många inloggningsförsök från ${req.ip}`);
    res.status(429).json({ error: 'För många inloggningsförsök. Försök igen om 15 minuter.' });
  },
  windowMs: 15 * 60 * 1000, // 15 minuter
  max: 10, // max 10 försök per IP
  message: { error: 'För många inloggningsförsök. Försök igen om 15 minuter.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minut
  max: 200, // max 200 anrop per minut per IP
  message: { error: 'För många anrop. Försök igen om en stund.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const kioskLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minut
  max: 20, // max 20 token-förfrågningar per IP
  message: { error: 'För många försök. Försök igen om en stund.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Blockera pausade konton på alla API-routes (utom undantagen nedan)
const PAUSE_EXEMPT = ['/api/auth/login', '/api/auth/me', '/api/kiosk/token', '/api/admin/create-tenant', '/api/export/products.csv'];
app.use('/api/', async (req, res, next) => {
  const p = req.originalUrl.split('?')[0];
  if (PAUSE_EXEMPT.includes(p) || p.startsWith('/api/superadmin')) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next(); // låt route-nivåns auth returnera 401
  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); } catch { return next(); }
  try {
    const tenant = await Tenant.findById(decoded.tenantId);
    if (tenant?.status === 'paused') return res.status(403).json({ error: 'ACCOUNT_PAUSED' });
  } catch { /* vid DB-fel, låt route hantera */ }
  next();
});

// ── MongoDB ──
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/scanny')
  .then(() => console.log('✅  MongoDB ansluten'))
  .catch(err => { console.error('MongoDB-fel:', err.message); process.exit(1); });

// ── Hjälpfunktioner ──
function addLog(tenantId, msg, type = 'normal') {
  const now = new Date();
  return Log.create({
    tenantId,
    time: now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }),
    date: now.toLocaleDateString('sv-SE'),
    msg, type
  }).catch(() => {});
}

// Cachad, poolad SMTP-transporter per unik SMTP-konfiguration (återanvänds mellan anrop)
const transporterCache = new Map();
function getTransporter(s) {
  const host = s.smtpHost || 'smtp.gmail.com';
  const port = s.smtpPort || 587;
  const key = `${host}:${port}:${s.smtpUser}:${s.smtpPass}`;
  let tr = transporterCache.get(key);
  if (!tr) {
    tr = nodemailer.createTransport({
      host, port, secure: false,
      pool: true, maxConnections: 3, maxMessages: 100,
      auth: { user: s.smtpUser, pass: s.smtpPass }
    });
    transporterCache.set(key, tr);
  }
  return tr;
}

async function sendOrderEmail(settings, pendingOrders) {
  const { email, workshop, smtpUser, smtpPass } = settings;
  if (!smtpUser || !smtpPass) throw new Error('SMTP-uppgifter saknas');
  const transporter = getTransporter(settings);
  const today = new Date().toLocaleDateString('sv-SE');
  const lines = pendingOrders.map((o, i) =>
    `${i+1}. ${o.name}\n   Antal: ${o.orderQty} st\n   Art.nr/info: ${o.supplier || '—'}\n   Streckkod: ${o.code}`
  ).join('\n\n');
  await transporter.sendMail({
    from: `"Scanny" <${smtpUser}>`, to: email,
    subject: `Beställningsorder — ${workshop} ${today}`,
    text: `Hej,\n\nFöljande artiklar behöver beställas till ${workshop}:\n\n${lines}\n\nTotalt ${pendingOrders.length} artikel${pendingOrders.length > 1 ? 'er' : ''} att beställa.\n\nVänliga hälsningar,\nScanny — ${workshop}`
  });
}

// Enkel CSV-parser: hanterar citattecken, samt , eller ; som avgränsare
function parseCSV(text) {
  const clean = String(text).replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/)[0] || '';
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQ) {
      if (c === '"') { if (clean[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Mappning från kolumnrubriker (svenska/engelska) till produktfält
const CSV_COLS = {
  name:      ['namn', 'name', 'produkt', 'beskrivning'],
  code:      ['streckkod', 'kod', 'code', 'barcode', 'ean'],
  qty:       ['antal', 'qty', 'lager', 'saldo'],
  min:       ['min', 'miniminivå', 'minnivå', 'minimum'],
  critical:  ['kritisk', 'kritisk nivå', 'critical'],
  orderQty:  ['best.antal', 'beställningsantal', 'orderqty', 'beställ', 'beställningsmängd'],
  articleNo: ['artikelnummer', 'art.nr', 'artikelnr', 'articleno', 'art nr', 'artnr'],
  supplier:  ['leverantör', 'supplier', 'lev']
};

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      console.warn(`[SECURITY] Misslyckad inloggning: ${email} från ${req.ip} - användare finns inte`);
      return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      console.warn(`[SECURITY] Misslyckad inloggning: ${email} från ${req.ip} - fel lösenord`);
      return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    }
    const loginTenant = await Tenant.findById(user.tenantId);
    if (loginTenant?.status === 'paused') return res.status(403).json({ error: 'ACCOUNT_PAUSED' });
    const token = jwt.sign({ userId: user._id, tenantId: user.tenantId, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    const tenant = await Tenant.findById(user.tenantId);
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role }, tenant: { name: tenant?.name, slug: tenant?.slug } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Middleware som kollar om tenant är pausad
async function checkTenantActive(req, res, next) {
  try {
    const tenant = await Tenant.findById(req.tenantId);
    if (tenant?.status === 'paused') return res.status(403).json({ error: 'ACCOUNT_PAUSED' });
    next();
  } catch(err) { next(); }
}

// Hämta agerande användare: inloggad (userId i token) eller kiosk-vald (actorId i body)
async function getActor(req) {
  const actorId = req.user?.userId || req.body?.actorId;
  if (!actorId) return null;
  try { return await User.findOne({ _id: actorId, tenantId: req.tenantId }); }
  catch (_) { return null; }
}

// Behörighetskontroll. Blockerar endast om behörigheten explicit satts till false.
// Admin har alltid full behörighet. Stödjer både nya (canScan) och gamla (scan) fältnamn.
function hasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const p = user.permissions || {};
  const map = {
    scan:      p.canScan      ?? p.scan,
    add:       p.canAdd       ?? p.add,
    inventory: p.canInventory ?? p.inventory,
  };
  return map[key] !== false;
}

// Middleware-fabrik: kräver en viss behörighet för agerande användare
function requirePermission(key, label) {
  return async (req, res, next) => {
    const actor = await getActor(req);
    if (!actor) return res.status(403).json({ error: 'Kunde inte identifiera användare — välj användare igen' });
    if (!hasPermission(actor, key)) return res.status(403).json({ error: `Saknar behörighet för ${label}` });
    req.actor = actor;
    next();
  };
}

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    const tenant = await Tenant.findById(req.tenantId);
    res.json({ user, tenant });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Intern route — du skapar verkstäder manuellt
app.post('/api/admin/create-tenant', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Obehörig' });
  try {
    const { tenantName, adminEmail, adminPassword, adminName } = req.body;
    const slug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const tenant = await Tenant.create({ name: tenantName, slug, settings: { workshop: tenantName } });
    const hashed = await bcrypt.hash(adminPassword, 10);
    const user = await User.create({ tenantId: tenant._id, name: adminName, email: adminEmail.toLowerCase(), password: hashed, role: 'admin' });
    res.json({ ok: true, tenantId: tenant._id, userId: user._id, slug });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  PRODUKTER
// ══════════════════════════════════════════

app.get('/api/products', authMiddleware, async (req, res) => {
  res.json(await Product.find({ tenantId: req.tenantId }).sort({ name: 1 }));
});

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const { name, code, qty, min, critical, orderQty, articleNo, supplier } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Namn och streckkod krävs' });
    if (await Product.findOne({ tenantId: req.tenantId, code })) return res.status(409).json({ error: 'Streckkod finns redan' });
    const product = await Product.create({ tenantId: req.tenantId, name, code, qty: qty||0, min: min||5, critical: critical||2, orderQty: orderQty||10, articleNo: articleNo||'', supplier: supplier||'' });
    await addLog(req.tenantId, `Ny produkt tillagd: ${name}`);
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const { name, code, qty, min, critical, orderQty, articleNo, supplier } = req.body;
    const allowed = {};
    if (name !== undefined) allowed.name = name;
    if (code !== undefined) allowed.code = code;
    if (qty !== undefined) allowed.qty = parseInt(qty);
    if (min !== undefined) allowed.min = parseInt(min);
    if (critical !== undefined) allowed.critical = parseInt(critical);
    if (orderQty !== undefined) allowed.orderQty = parseInt(orderQty);
    if (articleNo !== undefined) allowed.articleNo = articleNo;
    if (supplier !== undefined) allowed.supplier = supplier;
    const product = await Product.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, allowed, { new: true });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    await addLog(req.tenantId, `Produkt borttagen: ${product.name}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  SKANNING
// ══════════════════════════════════════════

app.post('/api/scan', authMiddleware, checkTenantActive, requirePermission('scan', 'Uttag'), async (req, res) => {
  try {
    const { code } = req.body;
    const p = await Product.findOne({ tenantId: req.tenantId, code: code?.trim() });
    if (!p) { await addLog(req.tenantId, `Okänd streckkod: ${code}`, 'warn'); return res.status(404).json({ error: `Okänd streckkod: ${code}` }); }
    if (p.qty <= 0) return res.status(400).json({ error: `${p.name} är slut på lager` });
    p.qty--;
    await p.save();
    await addLog(req.tenantId, `Uttag: ${p.name} (kvar: ${p.qty})${req.actor ? ` — ${req.actor.name}` : ''}`);
    let orderCreated = false;
    if (p.qty <= p.min) {
      const exists = await Order.findOne({ tenantId: req.tenantId, productId: p._id, sent: false });
      if (!exists) {
        await Order.create({ tenantId: req.tenantId, productId: p._id, name: p.name, code: p.code, orderQty: p.orderQty, supplier: p.supplier, articleNo: p.articleNo });
        await addLog(req.tenantId, `BESTÄLLNING skapad: ${p.name}`, 'order');
        orderCreated = true;
      }
    }
    if (p.qty <= p.critical) {
      const tc = await Tenant.findById(req.tenantId);
      if (tc?.settings?.smtpUser && tc?.settings?.smtpPass) {
        const s = tc.settings;
        const tr = getTransporter(s);
        const now = new Date().toLocaleString('sv-SE');
        const text = `KRITISK LAGERVARNING — ${s.workshop}\n${now}\n\nProdukten "${p.name}" har nått kritisk lagernivå!\n\n  Aktuellt antal:    ${p.qty} st\n  Kritisk nivå:      ${p.critical} st\n  Artikelnummer:  ${p.articleNo||'—'}\n  Leverantör:       ${p.supplier||'—'}\n  Streckkod:        ${p.code}\n\nÅtgärd krävs omgående!\n\nVänliga hälsningar,\nScanny — ${s.workshop}`;
        tr.sendMail({ from: `"Scanny" <${s.smtpUser}>`, to: s.email, subject: `⚠️ KRITISKT: ${p.name} — ${s.workshop}`, text })
          .then(() => addLog(req.tenantId, `KRITISK — e-post skickad: ${p.name}`, 'order'))
          .catch(err => addLog(req.tenantId, `E-post misslyckades: ${err.message}`, 'warn'));
      }
    }
    res.json({ product: p, orderCreated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/add', authMiddleware, checkTenantActive, requirePermission('add', 'Addera'), async (req, res) => {
  try {
    const { code } = req.body;
    const p = await Product.findOne({ tenantId: req.tenantId, code: code?.trim() });
    if (!p) { await addLog(req.tenantId, `Okänd streckkod: ${code}`, 'warn'); return res.status(404).json({ error: `Okänd streckkod: ${code}` }); }
    p.qty++;
    await p.save();
    await addLog(req.tenantId, `Påfyllning: ${p.name} (nu ${p.qty})${req.actor ? ` — ${req.actor.name}` : ''}`);
    res.json({ product: p });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  BESTÄLLNINGAR
// ══════════════════════════════════════════

app.get('/api/orders', authMiddleware, async (req, res) => {
  res.json(await Order.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }));
});

app.post('/api/orders/send', authMiddleware, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.tenantId);
    const pending = await Order.find({ tenantId: req.tenantId, sent: false });
    if (!pending.length) return res.status(400).json({ error: 'Inga aktiva beställningar' });
    await sendOrderEmail(tenant.settings, pending);
    await Order.updateMany({ tenantId: req.tenantId, sent: false }, { sent: true });
    await addLog(req.tenantId, `Beställning skickad (${pending.length} artiklar)`, 'order');
    res.json({ ok: true, sent: pending.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/mark-sent', authMiddleware, async (req, res) => {
  try {
    const result = await Order.updateMany({ tenantId: req.tenantId, sent: false }, { sent: true });
    await addLog(req.tenantId, `${result.modifiedCount} beställningar markerade som skickade`, 'order');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/orders/:id/sent', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { sent: true }, { new: true });
    if (!order) return res.status(404).json({ error: 'Order hittades inte' });
    await addLog(req.tenantId, `Order markerad som skickad: ${order.name}`, 'order');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  INVENTERING
// ══════════════════════════════════════════

app.post('/api/inventory-report', authMiddleware, checkTenantActive, requirePermission('inventory', 'Inventering'), async (req, res) => {
  try {
    const { entries } = req.body;
    const diffs = entries.filter(e => e.scanned !== e.previous);
    await addLog(req.tenantId, `Inventering: ${entries.length} artiklar, ${diffs.length} differenser${req.actor ? ` — ${req.actor.name}` : ''}`, 'order');
    // Spara rapport i historiken
    const rNow = new Date();
    await InventoryReport.create({
      tenantId:  req.tenantId,
      date:      rNow.toLocaleDateString('sv-SE'),
      time:      rNow.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }),
      total:     entries.length,
      diffCount: diffs.length,
      actorName: req.actor?.name || '',
      entries
    }).catch(() => {});
    const tenant = await Tenant.findById(req.tenantId);
    if (!tenant?.settings?.smtpUser) return res.json({ ok: true, sent: false });
    const s = tenant.settings;
    const transporter = getTransporter(s);
    const now = new Date().toLocaleString('sv-SE');
    const diffRows = diffs.map(e => { const d = e.scanned-e.previous; return `  ${d>0?'↑':'↓'} ${e.name}: System ${e.previous} → Räknat ${e.scanned} (${d>0?'+':''}${d})`; }).join('\n');
    const okRows = entries.filter(e => e.scanned===e.previous).map(e => `  ✓ ${e.name}: ${e.scanned} st`).join('\n');
    await transporter.sendMail({ from: `"Scanny" <${s.smtpUser}>`, to: s.email, subject: `Inventeringsrapport — ${s.workshop} ${now}`, text: `Inventeringsrapport — ${s.workshop}\n${now}\n\nTotalt: ${entries.length} artiklar\nMed differens: ${diffs.length}\n\n${diffs.length>0?`DIFFERENSER\n${diffRows}\n\n`:''}UTAN DIFFERENS\n${okRows||'  (inga)'}\n\nVänliga hälsningar,\nScanny` });
    res.json({ ok: true, sent: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  ANVÄNDARE
// ══════════════════════════════════════════

app.get('/api/users', authMiddleware, async (req, res) => {
  res.json(await User.find({ tenantId: req.tenantId }).select('-password').sort({ name: 1 }));
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, color, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Namn krävs' });
    // Kiosk-användare behöver inget e-post eller lösenord
    const fakeEmail = name.toLowerCase().replace(/[^a-z0-9]/g,'.') + '.' + Date.now() + '@kiosk.scanny.internal';
    const hashed = await bcrypt.hash(Math.random().toString(36), 10);
    const user = await User.create({
      tenantId: req.tenantId, name,
      email: fakeEmail, password: hashed,
      role: 'staff', color: color || randomColor(), initials: name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2),
      permissions: permissions ? {
        canScan: permissions.canScan ?? permissions.scan ?? true,
        canAdd: permissions.canAdd ?? permissions.add ?? false,
        canInventory: permissions.canInventory ?? permissions.inventory ?? false,
      } : { canScan: true, canAdd: false, canInventory: false }
    });
    await addLog(req.tenantId, `Ny användare: ${name}`);
    res.json({ id: user._id, name: user.name, color: user.color, permissions: user.permissions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function randomColor() {
  const colors = ['#0f6e56','#7c3aed','#b45309','#1d4ed8','#be185d','#0369a1','#b91c1c','#047857'];
  return colors[Math.floor(Math.random() * colors.length)];
}

app.patch('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.password) { update.password = await bcrypt.hash(update.password, 10); }
    const user = await User.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, update, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'Användare hittades inte' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!user) return res.status(404).json({ error: 'Användare hittades inte' });
    await addLog(req.tenantId, `Användare borttagen: ${user.name}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  FORDON
// ══════════════════════════════════════════

app.get('/api/vehicles', authMiddleware, async (req, res) => {
  res.json(await Vehicle.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }));
});

app.post('/api/vehicles', authMiddleware, async (req, res) => {
  try {
    const { regNr, make, model, color, customerName, customerContact } = req.body;
    if (!regNr) return res.status(400).json({ error: 'Reg-nr krävs' });
    const vehicle = await Vehicle.create({ tenantId: req.tenantId, regNr: regNr.toUpperCase(), make, model, color, customerName, customerContact });
    await addLog(req.tenantId, `Fordon tillagt: ${regNr}`);
    res.json(vehicle);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vehicles/:id', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    await addLog(req.tenantId, `Fordon borttaget: ${v.regNr}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/kiosk/users/:id/last-vehicle', authMiddleware, async (req, res) => {
  try {
    const { lastVehicleId } = req.body;
    await User.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { lastVehicleId });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vehicles/:id/log', authMiddleware, async (req, res) => {
  try {
    const { productName, qty, userName, articleNo, supplier } = req.body;
    const v = await Vehicle.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    if (v.archived) return res.status(400).json({ error: 'Fordonet är arkiverat' });
    v.history.unshift({ time: new Date().toLocaleString('sv-SE'), productName, qty: qty||1, userName: userName||'—', articleNo: articleNo||'—', supplier: supplier||'—' });
    if (v.history.length > 500) v.history = v.history.slice(0, 500);
    await v.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/vehicles/:id/archive', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { archived: true, archivedAt: new Date().toLocaleString('sv-SE') }, { new: true });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    await addLog(req.tenantId, `Fordon arkiverat: ${v.regNr}`, 'order');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/vehicles/:id/unarchive', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { archived: false, $unset: { archivedAt: '' } }, { new: true });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    await addLog(req.tenantId, `Fordon återöppnat: ${v.regNr}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  INSTÄLLNINGAR
// ══════════════════════════════════════════

app.get('/api/settings', authMiddleware, async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant hittades inte' });
  const s = { ...tenant.settings.toObject() };
  delete s.smtpPass;
  res.json(s);
});

app.put('/api/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.tenantId);
    const body = { ...req.body };
    if (!body.smtpPass) delete body.smtpPass; // behåll befintligt lösenord om fältet lämnas tomt
    Object.assign(tenant.settings, body);
    tenant.markModified('settings');
    await tenant.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  LOGG & CSV
// ══════════════════════════════════════════

app.get('/api/logs', authMiddleware, async (req, res) => {
  res.json(await Log.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(100));
});

app.get('/api/inventory-reports', authMiddleware, async (req, res) => {
  res.json(await InventoryReport.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(50));
});

app.get('/api/vehicles/:id/export', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    const since = req.query.since;
    let history = v.history || [];
    if (since && since !== 'all') {
      const sinceDate = new Date(parseInt(since));
      history = history.filter(h => new Date(h.time) >= sinceDate);
    }
    const rows = history.map(h =>
      `<tr><td>${h.time}</td><td>${h.productName}</td><td>${h.qty}</td><td>${h.articleNo||'—'}</td><td>${h.supplier||'—'}</td><td>${h.userName||'—'}</td></tr>`
    ).join('');
    const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8"><title>Export — ${v.regNr}</title>
    <style>body{font-family:sans-serif;padding:2rem;color:#111}h1{font-size:20px}h2{font-size:15px;color:#555;margin-top:0}table{width:100%;border-collapse:collapse;margin-top:1.5rem;font-size:13px}th{background:#f0f0f0;padding:8px;text-align:left;border-bottom:2px solid #ccc}td{padding:7px 8px;border-bottom:1px solid #e0e0e0}@media print{button{display:none}}</style>
    </head><body>
    <button onclick="window.print()" style="margin-bottom:1rem;padding:8px 16px;background:#222;color:#fff;border:none;border-radius:6px;cursor:pointer">🖨 Skriv ut / Spara PDF</button>
    <h1>${v.regNr} — ${v.make||''} ${v.model||''}</h1>
    <h2>Kund: ${v.customerName||'—'} &nbsp;|&nbsp; Kontakt: ${v.customerContact||'—'}</h2>
    <p style="font-size:12px;color:#888">Exporterad: ${new Date().toLocaleString('sv-SE')}</p>
    <table><thead><tr><th>Tid</th><th>Produkt</th><th>Antal</th><th>Art.nr</th><th>Leverantör</th><th>Användare</th></tr></thead>
    <tbody>${rows||'<tr><td colspan="6" style="color:#888;text-align:center">Inga uttag registrerade</td></tr>'}</tbody></table>
    </body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/export/products.csv', authMiddleware, async (req, res) => {
  const products = await Product.find({ tenantId: req.tenantId }).sort({ name: 1 });
  const header = 'Namn,Streckkod,Antal,Artikelnummer,Leverantör\n';
  const rows = products.map(p => [p.name, p.code, p.qty, p.articleNo||'', p.supplier||''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lager.csv"');
  res.send('\uFEFF' + header + rows);
});

// Importera produkter fr\u00E5n CSV (skickas som text/plain, egen parser med st\u00F6rre gr\u00E4ns)
app.post('/api/products/import', authMiddleware, adminOnly, express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'Tom eller ogiltig fil' });
    const rows = parseCSV(text);
    if (rows.length < 2) return res.status(400).json({ error: 'Ingen data hittades (beh\u00F6ver rubrikrad + minst en produkt)' });

    const header = rows[0].map(h => h.trim().toLowerCase());
    const colIdx = {};
    for (const [field, aliases] of Object.entries(CSV_COLS)) {
      colIdx[field] = header.findIndex(h => aliases.includes(h));
    }
    if (colIdx.name === -1 || colIdx.code === -1) {
      return res.status(400).json({ error: 'CSV m\u00E5ste inneh\u00E5lla kolumnerna "Namn" och "Streckkod"' });
    }

    const cell = (row, field) => (colIdx[field] >= 0 ? (row[colIdx[field]] || '').trim() : '');
    const num = (v, def) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : def; };

    let created = 0, updated = 0, skipped = 0;
    const errors = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row.length || row.every(c => !String(c).trim())) continue; // tom rad
      const name = cell(row, 'name');
      const code = cell(row, 'code');
      if (!name || !code) { skipped++; errors.push(`Rad ${i + 1}: saknar namn eller streckkod`); continue; }

      const fields = {
        name,
        qty:       num(cell(row, 'qty'), 0),
        articleNo: cell(row, 'articleNo'),
        supplier:  cell(row, 'supplier'),
      };
      if (colIdx.min >= 0)      fields.min      = num(cell(row, 'min'), 5);
      if (colIdx.critical >= 0) fields.critical = num(cell(row, 'critical'), 2);
      if (colIdx.orderQty >= 0) fields.orderQty = num(cell(row, 'orderQty'), 10);

      try {
        const existing = await Product.findOne({ tenantId: req.tenantId, code });
        if (existing) { Object.assign(existing, fields); await existing.save(); updated++; }
        else { await Product.create({ tenantId: req.tenantId, code, ...fields }); created++; }
      } catch (e) { skipped++; errors.push(`Rad ${i + 1} (${code}): ${e.message}`); }
    }
    await addLog(req.tenantId, `CSV-import: ${created} nya, ${updated} uppdaterade, ${skipped} \u00F6verhoppade`);
    res.json({ ok: true, created, updated, skipped, errors: errors.slice(0, 20) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  DB (samlad data för frontend)
// ══════════════════════════════════════════

app.get('/api/db', authMiddleware, checkTenantActive, async (req, res) => {
  try {
    const [products, orders, users, vehicles, logs, tenant, inventoryReports] = await Promise.all([
      Product.find({ tenantId: req.tenantId }).sort({ name: 1 }),
      Order.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }),
      User.find({ tenantId: req.tenantId }).select('-password').sort({ name: 1 }),
      Vehicle.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }),
      Log.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(100),
      Tenant.findById(req.tenantId),
      InventoryReport.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(50)
    ]);
    const settings = { ...tenant?.settings?.toObject() };
    delete settings.smtpPass;
    res.json({ products, orders, users, vehicles, logs, settings, inventoryReports });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Superadmin middleware ──
function superAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
    console.warn(`[SECURITY] Obehörig superadmin-åtkomst från ${req.ip} till ${req.path}`);
    return res.status(403).json({ error: 'Obehörig' });
  }
  console.log(`[SUPERADMIN] Åtkomst från ${req.ip} till ${req.path}`);
  next();
}

// ══════════════════════════════════════════
//  SUPERADMIN ROUTES
// ══════════════════════════════════════════

// Hämta alla tenants
app.get('/api/superadmin/tenants', superAdmin, async (req, res) => {
  try {
    const tenants = await Tenant.find().sort({ createdAt: -1 });
    const result = await Promise.all(tenants.map(async t => {
      const userCount    = await User.countDocuments({ tenantId: t._id });
      const productCount = await Product.countDocuments({ tenantId: t._id });
      const adminUser    = await User.findOne({ tenantId: t._id, role: 'admin' }).select('email name');
      return { ...t.toObject(), userCount, productCount, adminEmail: adminUser?.email, adminName: adminUser?.name };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Skapa ny tenant
app.post('/api/superadmin/tenants', superAdmin, async (req, res) => {
  try {
    const { tenantName, adminEmail, adminPassword, adminName, plan } = req.body;
    if (!tenantName || !adminEmail || !adminPassword) return res.status(400).json({ error: 'Namn, e-post och lösenord krävs' });
    const slug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString(36);
    const tenant = await Tenant.create({ name: tenantName, slug, plan: plan || 'bas', settings: { workshop: tenantName } });
    const hashed = await bcrypt.hash(adminPassword, 10);
    const user = await User.create({ tenantId: tenant._id, name: adminName || tenantName, email: adminEmail.toLowerCase(), password: hashed, role: 'admin' });
    res.json({ ok: true, tenantId: tenant._id, userId: user._id, slug });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Uppdatera tenant (pausa, byt plan, byt e-post)
app.patch('/api/superadmin/tenants/:id', superAdmin, async (req, res) => {
  try {
    const { status, plan, adminEmail, adminPassword, name } = req.body;
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Kund hittades inte' });
    if (status) tenant.status = status;
    if (plan)   tenant.plan   = plan;
    if (name)   tenant.name   = name;
    await tenant.save();
    if (adminEmail || adminPassword) {
      const admin = await User.findOne({ tenantId: tenant._id, role: 'admin' });
      if (admin) {
        if (adminEmail)   admin.email    = adminEmail.toLowerCase();
        if (adminPassword) admin.password = await bcrypt.hash(adminPassword, 10);
        await admin.save();
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ta bort tenant
app.delete('/api/superadmin/tenants/:id', superAdmin, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'Kund hittades inte' });
    await Promise.all([
      User.deleteMany({ tenantId: tenant._id }),
      Product.deleteMany({ tenantId: tenant._id }),
      Order.deleteMany({ tenantId: tenant._id }),
      Vehicle.deleteMany({ tenantId: tenant._id }),
      Log.deleteMany({ tenantId: tenant._id }),
      Tenant.findByIdAndDelete(tenant._id)
    ]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Statistik
app.get('/api/superadmin/stats', superAdmin, async (req, res) => {
  try {
    const [total, active, paused, bas, standard, pro] = await Promise.all([
      Tenant.countDocuments(),
      Tenant.countDocuments({ status: 'active' }),
      Tenant.countDocuments({ status: 'paused' }),
      Tenant.countDocuments({ plan: 'bas' }),
      Tenant.countDocuments({ plan: 'standard' }),
      Tenant.countDocuments({ plan: 'pro' })
    ]);
    res.json({ total, active, paused, cancelled: total - active - paused, plans: { bas, standard, pro } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Rena URL:er ──
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'superadmin.html')));
app.get('/app',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/kiosk/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.get('/kiosk',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));

// ── Kiosk token — hämta JWT via slug (ingen inloggning krävs) ──
app.post('/api/kiosk/token', kioskLimiter, async (req, res) => {
  try {
    const slug = req.body.slug || req.query.slug;
    if (!slug) return res.status(400).json({ error: 'Slug krävs' });
    const tenant = await Tenant.findOne({ slug });
    if (!tenant) return res.status(404).json({ error: 'Verkstad hittades inte' });
    if (tenant.status !== 'active') return res.status(403).json({ error: 'Kontot är pausat' });
    const token = jwt.sign(
      { tenantId: tenant._id, role: 'kiosk', name: 'Kiosk' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, tenantName: tenant.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tenant slug routing ──
app.get('/:slug', async (req, res, next) => {
  const reserved = ['login','superadmin','app','kiosk','api','favicon.svg'];
  if (reserved.includes(req.params.slug)) return next();
  try {
    const tenant = await Tenant.findOne({ slug: req.params.slug });
    if (!tenant) return next();
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } catch(err) { next(); }
});

// ══════════════════════════════════════════
//  SCHEMALAGD BESTÄLLNING (körs varje minut)
// ══════════════════════════════════════════
const WEEKDAY_NUM = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
const SCHEDULE_TZ = 'Europe/Stockholm';

async function runScheduledOrders() {
  try {
    const weekdayName = new Date().toLocaleDateString('en-US', { timeZone: SCHEDULE_TZ, weekday: 'long' });
    const nowDay = WEEKDAY_NUM[weekdayName];
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const hh = parts.find(p => p.type === 'hour').value;
    const mm = parts.find(p => p.type === 'minute').value;
    const nowTime = `${hh}:${mm}`;

    const tenants = await Tenant.find({ status: 'active' });
    for (const t of tenants) {
      const s = t.settings || {};
      if (!s.smtpUser || !s.smtpPass || !s.scheduleTime) continue;
      if (s.scheduleDay === undefined || s.scheduleDay === null) continue;
      if (Number(s.scheduleDay) !== nowDay || s.scheduleTime !== nowTime) continue;

      const pending = await Order.find({ tenantId: t._id, sent: false });
      if (!pending.length) { await addLog(t._id, 'Schemalagd beställning: inga aktiva beställningar att skicka'); continue; }
      try {
        await sendOrderEmail(s, pending);
        await Order.updateMany({ tenantId: t._id, sent: false }, { sent: true });
        await addLog(t._id, `Schemalagd beställning skickad (${pending.length} artiklar)`, 'order');
      } catch (err) {
        await addLog(t._id, `Schemalagd beställning misslyckades: ${err.message}`, 'warn');
      }
    }
  } catch (err) {
    console.error('[SCHEMALÄGGARE] fel:', err.message);
  }
}
setInterval(runScheduledOrders, 60 * 1000);

// ── Start ──
app.listen(PORT, () => console.log(`
✅  Scanny körs på http://localhost:${PORT}
`));

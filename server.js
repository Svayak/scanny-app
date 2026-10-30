require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const cors       = require('cors');

const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const { Tenant, User, Product, Order, Vehicle, Log, InventoryReport, PrintJob } = require('./models');
const mail = require('./mail');
const allowTestAlert = mail.createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
const ALLOWED_ORIGINS = ['https://scanny.se', 'https://www.scanny.se', 'http://localhost:3001'];
const { authMiddleware, adminOnly, adminAuthorized, JWT_SECRET } = require('./auth');
const redact = require('./redact');
const { blockSensitivePaths, staticOptions } = require('./serve-policy');
const { sendManifest } = require('./pwa');
// Etikettmodulen kräver bwip-js + sharp (valfria beroenden). Ladda skyddat så att
// servern startar även om de saknas i miljön (t.ex. molndrift utan skrivare).
let generateLabelPng, printLabel;
try { ({ generateLabelPng, printLabel } = require('./label')); }
catch (err) { console.warn('Etikettmodul ej tillgänglig (bwip-js/sharp saknas?):', mail.safeErrorMessage(err)); }
const { createPrintFeature, respondPrintError } = require('./print-api');

// ── Paketnivåer (matchar priserna på landningssidan) ──
const PLAN_LIMITS = {
  bas:      { maxUsers: 10,       scheduledOrders: false, inventoryReports: false, pdfExport: false, api: false },
  standard: { maxUsers: 25,       scheduledOrders: true,  inventoryReports: true,  pdfExport: true,  api: false },
  pro:      { maxUsers: Infinity, scheduledOrders: true,  inventoryReports: true,  pdfExport: true,  api: true  },
};
function planOf(tenant) { return PLAN_LIMITS[tenant?.plan] || PLAN_LIMITS.bas; }
// Serialiserbar version (Infinity → null = obegränsat) för frontend
function planLimitsPublic(tenant) {
  const p = planOf(tenant);
  return { maxUsers: p.maxUsers === Infinity ? null : p.maxUsers, scheduledOrders: p.scheduledOrders, inventoryReports: p.inventoryReports, pdfExport: p.pdfExport, api: p.api };
}

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
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' krävs pga inline-scripts/onclick i HTML; övriga direktiv härdar ändå
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      // script-src-attr/style-src-attr styr inline onclick/onsubmit/style="" och är 'none' som standard
      // i helmet — måste tillåtas explicit annars slutar alla knappar (inkl. inloggning) fungera.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'https://formspree.io'],
      formAction: ["'self'", 'https://formspree.io'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      workerSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));
app.use(express.json({ limit: '10kb' }));
app.use(mongoSanitize());
app.use(blockSensitivePaths);
app.use(express.static(path.join(__dirname, 'public'), {
  ...staticOptions(),
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
  }
}));

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

// Striktare gräns för superadmin (skyddar x-admin-secret mot brute force)
const superadminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  handler: (req, res) => { console.warn(`[SECURITY] Rate limit superadmin från ${req.ip}`); res.status(429).json({ error: 'För många försök.' }); },
  standardHeaders: true, legacyHeaders: false,
});

// Gräns för CSV-import (resurskrävande)
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { error: 'För många importer. Försök igen senare.' },
  standardHeaders: true, legacyHeaders: false,
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
  .catch(err => { console.error('MongoDB-fel:', mail.safeErrorMessage(err, [process.env.MONGODB_URI])); process.exit(1); });

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

// Skrivarkö. Påverkar inte webbläsarens utskrift. Köas bara när verkstaden aktiverat bryggan.
const printing = createPrintFeature({ Tenant, PrintJob, addLog });

// Loggar felet internt men returnerar ett generiskt meddelande till klienten
function serverError(res, err) {
  console.error('[FEL]', mail.safeErrorMessage(err, [
    process.env.MONGODB_URI,
    process.env.ACS_EMAIL_CONNECTION_STRING,
    process.env.JWT_SECRET,
    process.env.ADMIN_SECRET
  ]));
  return res.status(500).json({ error: 'Internt serverfel' });
}

// Escapar värden för säker inbäddning i HTML (används i serverrenderad export)
function escHtml(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendOrderEmail(settings, pendingOrders) {
  const { email, workshop } = settings;
  const today = new Date().toLocaleDateString('sv-SE');
  const lines = pendingOrders.map((o, i) =>
    `${i+1}. ${o.name}\n   Antal: ${o.orderQty} st\n   Art.nr/info: ${o.supplier || '—'}\n   Streckkod: ${o.code}`
  ).join('\n\n');
  await mail.sendTenantMail(settings, {
    to: email,
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
  supplier:  ['leverantör', 'supplier', 'lev'],
  price:     ['a-pris', 'apris', 'pris', 'price', 'styckpris', 'utpris']
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
  } catch (err) { serverError(res, err); }
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
  // Agerande användare hämtas ENDAST från den signerade token (aldrig från request-body)
  const actorId = req.user?.userId;
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
    if (!req.user?.userId) return res.status(401).json({ error: 'Inte inloggad' });
    const user = await User.findById(req.user.userId).select('-password');
    const tenant = await Tenant.findById(req.tenantId);
    const settings = tenant
      ? mail.publicSettings(tenant.settings?.toObject ? tenant.settings.toObject() : (tenant.settings || {}))
      : null;
    res.json(redact.publicAuthPayload(user, tenant, settings));
  } catch (err) { serverError(res, err); }
});

// Intern route — du skapar verkstäder manuellt
app.post('/api/admin/create-tenant', async (req, res) => {
  if (!adminAuthorized(req.headers['x-admin-secret'])) return res.status(403).json({ error: 'Obehörig' });
  try {
    const { tenantName, adminEmail, adminPassword, adminName } = req.body;
    const slug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString(36);
    const tenant = await Tenant.create({ name: tenantName, slug, settings: { workshop: tenantName } });
    const hashed = await bcrypt.hash(adminPassword, 12);
    const user = await User.create({ tenantId: tenant._id, name: adminName, email: adminEmail.toLowerCase(), password: hashed, role: 'admin' });
    res.json({ ok: true, tenantId: tenant._id, userId: user._id, slug });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  PRODUKTER
// ══════════════════════════════════════════

app.get('/api/products', authMiddleware, async (req, res) => {
  res.json(await Product.find({ tenantId: req.tenantId }).sort({ name: 1 }).limit(10000));
});

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const { name, code, qty, min, critical, orderQty, articleNo, supplier, price } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Namn och streckkod krävs' });
    if (await Product.findOne({ tenantId: req.tenantId, code })) return res.status(409).json({ error: 'Streckkod finns redan' });
    const cleanPrice = Math.max(0, parseFloat(price) || 0);
    const product = await Product.create({ tenantId: req.tenantId, name, code, qty: qty||0, min: min||5, critical: critical||2, orderQty: orderQty||10, articleNo: articleNo||'', supplier: supplier||'', price: cleanPrice });
    await addLog(req.tenantId, `Ny produkt tillagd: ${name}`);
    res.json(product);
  } catch (err) { serverError(res, err); }
});

app.patch('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const { name, code, qty, min, critical, orderQty, articleNo, supplier, price } = req.body;
    const allowed = {};
    if (name !== undefined) allowed.name = name;
    if (code !== undefined) allowed.code = code;
    const nonNeg = v => Math.max(0, parseInt(v) || 0);
    if (qty !== undefined) allowed.qty = nonNeg(qty);
    if (min !== undefined) allowed.min = nonNeg(min);
    if (critical !== undefined) allowed.critical = nonNeg(critical);
    if (orderQty !== undefined) allowed.orderQty = nonNeg(orderQty);
    if (articleNo !== undefined) allowed.articleNo = articleNo;
    if (supplier !== undefined) allowed.supplier = supplier;
    if (price !== undefined) allowed.price = Math.max(0, parseFloat(price) || 0);
    const product = await Product.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, allowed, { new: true });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    res.json(product);
  } catch (err) { serverError(res, err); }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    await addLog(req.tenantId, `Produkt borttagen: ${product.name}`);
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// ── Etikett: förhandsvisning (PNG) ──
app.get('/api/products/:id/label.png', authMiddleware, async (req, res) => {
  try {
    if (!generateLabelPng) return res.status(503).json({ error: 'Etikettfunktionen är inte tillgänglig på denna server.' });
    const product = await Product.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const tenant = await Tenant.findById(req.tenantId);
    const png = await generateLabelPng(product, tenant?.settings?.labelSize || '62');
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) { serverError(res, err); }
});

// Köa en etikett till den lokala bryggan. Webbläsarens utskrift (window.print) är oförändrad.
app.post('/api/products/:id/queue-label', authMiddleware, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const result = await printing.service.queueProduct(req.tenantId, product);
    res.json(result);
  } catch (err) {
    if (respondPrintError(res, err)) return;
    serverError(res, err);
  }
});

// ── Etikett: skriv ut till Brother QL-810W ──
app.post('/api/products/:id/print-label', authMiddleware, async (req, res) => {
  try {
    if (!printLabel) return res.status(503).json({ error: 'Etikettutskrift är inte tillgänglig på denna server.' });
    const product = await Product.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const tenant = await Tenant.findById(req.tenantId);
    await printLabel(product, tenant?.settings || {});
    await addLog(req.tenantId, `Etikett utskriven: ${product.name}`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: mail.safeErrorMessage(err) || 'Utskrift misslyckades' }); }
});

// ══════════════════════════════════════════
//  SKANNING
// ══════════════════════════════════════════

app.post('/api/scan', authMiddleware, checkTenantActive, requirePermission('scan', 'Uttag'), async (req, res) => {
  try {
    const { code } = req.body;
    const trimmed = code?.trim();
    const existing = await Product.findOne({ tenantId: req.tenantId, code: trimmed });
    if (!existing) { await addLog(req.tenantId, `Okänd streckkod: ${code}`, 'warn'); return res.status(404).json({ error: `Okänd streckkod: ${code}` }); }
    // Atomisk minskning — förhindrar race condition och negativt lager
    const p = await Product.findOneAndUpdate(
      { tenantId: req.tenantId, code: trimmed, qty: { $gt: 0 } },
      { $inc: { qty: -1 } },
      { new: true }
    );
    if (!p) return res.status(400).json({ error: `${existing.name} är slut på lager` });
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
    let criticalAlert = false;
    const previousQty = p.qty + 1;
    if (mail.crossedCriticalThreshold(previousQty, p.qty, p.critical)) {
      const tc = await Tenant.findById(req.tenantId);
      const decision = mail.planCriticalAlert({
        previousQty, newQty: p.qty, critical: p.critical, settings: tc?.settings
      });
      criticalAlert = decision.criticalAlert;
      if (criticalAlert) {
        const s = tc.settings;
        const recipients = mail.alertRecipients(s);
        const now = new Date().toLocaleString('sv-SE');
        const text = `KRITISK LAGERVARNING — ${s.workshop}\n${now}\n\nProdukten "${p.name}" har nått kritisk lagernivå!\n\n  Aktuellt antal:    ${p.qty} st\n  Kritisk nivå:      ${p.critical} st\n  Artikelnummer:  ${p.articleNo||'—'}\n  Leverantör:       ${p.supplier||'—'}\n  Streckkod:        ${p.code}\n\nÅtgärd krävs omgående!\n\nVänliga hälsningar,\nScanny — ${s.workshop}`;
        mail.sendTenantMail(s, { to: recipients.join(', '), subject: `⚠️ KRITISKT: ${p.name} — ${s.workshop}`, text })
          .then(() => addLog(req.tenantId, `KRITISK — e-post skickad: ${p.name}`, 'order'))
          .catch(err => addLog(req.tenantId, `E-post misslyckades: ${mail.safeErrorMessage(err, [s.smtpPass, process.env.ACS_EMAIL_CONNECTION_STRING, process.env.MONGODB_URI])}`, 'warn'));
      }
    }
    res.json({ product: p, orderCreated, criticalAlert });
  } catch (err) { serverError(res, err); }
});

app.post('/api/add', authMiddleware, checkTenantActive, requirePermission('add', 'Addera'), async (req, res) => {
  try {
    const { code } = req.body;
    // Atomisk ökning
    const p = await Product.findOneAndUpdate(
      { tenantId: req.tenantId, code: code?.trim() },
      { $inc: { qty: 1 } },
      { new: true }
    );
    if (!p) { await addLog(req.tenantId, `Okänd streckkod: ${code}`, 'warn'); return res.status(404).json({ error: `Okänd streckkod: ${code}` }); }
    await addLog(req.tenantId, `Påfyllning: ${p.name} (nu ${p.qty})${req.actor ? ` — ${req.actor.name}` : ''}`);
    // Automatisk etikett är ett tillägg. Svaret skickas som tidigare, utan att vänta på kön.
    // Ett fel i kön får inte ändra inleveransen.
    try {
      Promise.resolve(printing.enqueueForGoodsReceipt(req.tenantId, p)).catch(err => {
        console.warn('[print] Kunde inte köa etikett vid inleverans:', mail.safeErrorMessage(err));
      });
    } catch (err) {
      console.warn('[print] Kunde inte köa etikett vid inleverans:', mail.safeErrorMessage(err));
    }
    res.json({ product: p });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  BESTÄLLNINGAR
// ══════════════════════════════════════════

app.get('/api/orders', authMiddleware, async (req, res) => {
  res.json(await Order.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(10000));
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
  } catch (err) { serverError(res, err); }
});

app.post('/api/orders/mark-sent', authMiddleware, async (req, res) => {
  try {
    const result = await Order.updateMany({ tenantId: req.tenantId, sent: false }, { sent: true });
    await addLog(req.tenantId, `${result.modifiedCount} beställningar markerade som skickade`, 'order');
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

app.patch('/api/orders/:id/sent', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { sent: true }, { new: true });
    if (!order) return res.status(404).json({ error: 'Order hittades inte' });
    await addLog(req.tenantId, `Order markerad som skickad: ${order.name}`, 'order');
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  INVENTERING
// ══════════════════════════════════════════

app.post('/api/inventory-report', authMiddleware, checkTenantActive, requirePermission('inventory', 'Inventering'), async (req, res) => {
  try {
    const { entries } = req.body;
    // Inventeringsrapport (spara + maila) kräver Standard+; själva räkningen/uppdateringen sker på klienten
    const planTenant = await Tenant.findById(req.tenantId);
    if (!planOf(planTenant).inventoryReports) return res.json({ ok: true, sent: false, note: 'Inventeringsrapport ingår inte i din plan' });
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
    const s = tenant?.settings || {};
    if (!mail.resolveSender(s) && !s.smtpUser) return res.json({ ok: true, sent: false });
    const now = new Date().toLocaleString('sv-SE');
    const diffRows = diffs.map(e => { const d = e.scanned-e.previous; return `  ${d>0?'↑':'↓'} ${e.name}: System ${e.previous} → Räknat ${e.scanned} (${d>0?'+':''}${d})`; }).join('\n');
    const okRows = entries.filter(e => e.scanned===e.previous).map(e => `  ✓ ${e.name}: ${e.scanned} st`).join('\n');
    await mail.sendTenantMail(s, { to: s.email, subject: `Inventeringsrapport — ${s.workshop} ${now}`, text: `Inventeringsrapport — ${s.workshop}\n${now}\n\nTotalt: ${entries.length} artiklar\nMed differens: ${diffs.length}\n\n${diffs.length>0?`DIFFERENSER\n${diffRows}\n\n`:''}UTAN DIFFERENS\n${okRows||'  (inga)'}\n\nVänliga hälsningar,\nScanny` }, { allowPartialSmtp: true });
    res.json({ ok: true, sent: true });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  ANVÄNDARE
// ══════════════════════════════════════════

app.get('/api/users', authMiddleware, async (req, res) => {
  const users = await User.find({ tenantId: req.tenantId }).select('-password').sort({ name: 1 });
  res.json(users.map(redact.sanitizeUser));
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, color, permissions, pin } = req.body;
    if (!name) return res.status(400).json({ error: 'Namn krävs' });
    let pinHash = '';
    if (pin) {
      if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN måste vara 4 siffror' });
      pinHash = await bcrypt.hash(String(pin), 12);
    }
    // Kvot per paketnivå
    const tenantForLimit = await Tenant.findById(req.tenantId);
    const maxUsers = planOf(tenantForLimit).maxUsers;
    const userCount = await User.countDocuments({ tenantId: req.tenantId });
    if (userCount >= maxUsers) return res.status(403).json({ error: `Din plan (${tenantForLimit?.plan || 'bas'}) tillåter max ${maxUsers} användare. Uppgradera för fler.` });
    // Kiosk-användare behöver inget e-post eller lösenord
    const fakeEmail = name.toLowerCase().replace(/[^a-z0-9]/g,'.') + '.' + Date.now() + '@kiosk.scanny.internal';
    const hashed = await bcrypt.hash(Math.random().toString(36), 12);
    const user = await User.create({
      tenantId: req.tenantId, name,
      email: fakeEmail, password: hashed, pin: pinHash,
      role: 'staff', color: color || randomColor(), initials: name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2),
      permissions: permissions ? {
        canScan: permissions.canScan ?? permissions.scan ?? true,
        canAdd: permissions.canAdd ?? permissions.add ?? false,
        canInventory: permissions.canInventory ?? permissions.inventory ?? false,
      } : { canScan: true, canAdd: false, canInventory: false }
    });
    await addLog(req.tenantId, `Ny användare: ${name}`);
    res.json({ id: user._id, name: user.name, color: user.color, permissions: user.permissions, hasPin: !!user.pin });
  } catch (err) { serverError(res, err); }
});

function randomColor() {
  const colors = ['#0f6e56','#7c3aed','#b45309','#1d4ed8','#be185d','#0369a1','#b91c1c','#047857'];
  return colors[Math.floor(Math.random() * colors.length)];
}

app.patch('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.password) { update.password = await bcrypt.hash(update.password, 12); }
    if (update.pin !== undefined) {
      if (update.pin === '' || update.pin === null) {
        update.pin = '';   // ta bort PIN
      } else if (/^\d{4}$/.test(String(update.pin))) {
        update.pin = await bcrypt.hash(String(update.pin), 12);
      } else {
        return res.status(400).json({ error: 'PIN måste vara 4 siffror' });
      }
    }
    const user = await User.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, update, { new: true });
    if (!user) return res.status(404).json({ error: 'Användare hittades inte' });
    res.json(redact.sanitizeUser(user));
  } catch (err) { serverError(res, err); }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await User.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!user) return res.status(404).json({ error: 'Användare hittades inte' });
    await addLog(req.tenantId, `Användare borttagen: ${user.name}`);
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  FORDON
// ══════════════════════════════════════════

app.get('/api/vehicles', authMiddleware, async (req, res) => {
  res.json(await Vehicle.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(10000));
});

app.post('/api/vehicles', authMiddleware, async (req, res) => {
  try {
    const { regNr, make, model, color, customerName, customerContact } = req.body;
    if (!regNr) return res.status(400).json({ error: 'Reg-nr krävs' });
    const vehicle = await Vehicle.create({ tenantId: req.tenantId, regNr: regNr.toUpperCase(), make, model, color, customerName, customerContact });
    await addLog(req.tenantId, `Fordon tillagt: ${regNr}`);
    res.json(vehicle);
  } catch (err) { serverError(res, err); }
});

app.delete('/api/vehicles/:id', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    await addLog(req.tenantId, `Fordon borttaget: ${v.regNr}`);
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

app.patch('/api/kiosk/users/:id/last-vehicle', authMiddleware, async (req, res) => {
  try {
    const { lastVehicleId } = req.body;
    await User.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { lastVehicleId });
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
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
  } catch (err) { serverError(res, err); }
});

app.patch('/api/vehicles/:id/archive', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { archived: true, archivedAt: new Date().toLocaleString('sv-SE') }, { new: true });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    await addLog(req.tenantId, `Fordon arkiverat: ${v.regNr}`, 'order');
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

app.patch('/api/vehicles/:id/unarchive', authMiddleware, async (req, res) => {
  try {
    const v = await Vehicle.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, { archived: false, $unset: { archivedAt: '' } }, { new: true });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    await addLog(req.tenantId, `Fordon återöppnat: ${v.regNr}`);
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  INSTÄLLNINGAR
// ══════════════════════════════════════════

app.get('/api/settings', authMiddleware, async (req, res) => {
  const tenant = await Tenant.findById(req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant hittades inte' });
  res.json(mail.publicSettings(tenant.settings.toObject()));
});

app.put('/api/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.tenantId);
    const body = mail.applySettingsPatch({ ...req.body });
    Object.assign(tenant.settings, body);
    tenant.markModified('settings');
    await tenant.save();
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
});

// Status får läsas av inloggad personal (ingen nyckel lämnas ut). Ändringar kräver admin.
app.get('/api/print/status', authMiddleware, async (req, res) => {
  try {
    res.json(await printing.service.statusFor(req.tenantId));
  } catch (err) {
    if (respondPrintError(res, err)) return;
    serverError(res, err);
  }
});
app.use('/api/print/v1', printing.bridgeRouter);
app.use('/api/print', authMiddleware, adminOnly, printing.userRouter);

app.post('/api/settings/test-alert', authMiddleware, adminOnly, async (req, res) => {
  let smtpPass = '';
  try {
    const tenant = await Tenant.findById(req.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant hittades inte' });
    const s = tenant.settings?.toObject ? tenant.settings.toObject() : (tenant.settings || {});
    smtpPass = s.smtpPass || '';
    const decision = mail.resolveTestRecipients(s, req.body?.to);
    if (decision.error) return res.status(400).json({ error: decision.error });
    if (!mail.resolveSender(s)) return res.status(400).json({ error: 'Ingen avsändare är konfigurerad' });
    if (!allowTestAlert(String(req.tenantId))) {
      return res.status(429).json({ error: 'För många testmejl. Försök igen om en stund.' });
    }
    const workshop = s.workshop || tenant.name || '';
    await mail.sendTenantMail(s, {
      to: decision.recipients.join(', '),
      subject: 'Testmejl från Scanny — lagerlarm',
      text: `Det här är ett test av lagerlarm från Scanny${workshop ? ` (${workshop})` : ''}.\n\nOm du läser det här når kritiska lagervarningar den här adressen.\n\nVänliga hälsningar,\nScanny`
    });
    await addLog(req.tenantId, 'Testmejl för lagerlarm skickat', 'order');
    res.json({ ok: true, sent: decision.recipients.length });
  } catch (err) {
    console.error('[FEL] testmejl:', mail.safeErrorMessage(err, [smtpPass, process.env.ACS_EMAIL_CONNECTION_STRING]));
    res.status(502).json({ error: 'Kunde inte skicka testmejl' });
  }
});

// ══════════════════════════════════════════
//  LOGG & CSV
// ══════════════════════════════════════════

app.get('/api/logs', authMiddleware, async (req, res) => {
  const logs = await Log.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(100);
  res.json(logs.map(redact.publicLog));
});

app.get('/api/inventory-reports', authMiddleware, async (req, res) => {
  res.json(await InventoryReport.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(50));
});

app.get('/api/vehicles/:id/export', authMiddleware, async (req, res) => {
  try {
    const exportTenant = await Tenant.findById(req.tenantId);
    if (!planOf(exportTenant).pdfExport) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send('<!DOCTYPE html><html lang="sv"><body style="font-family:sans-serif;padding:2rem;text-align:center"><h2>PDF-export ingår inte i din plan</h2><p>Uppgradera till Standard eller Pro för fordonsexport.</p></body></html>');
    }
    const v = await Vehicle.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!v) return res.status(404).json({ error: 'Fordon hittades inte' });
    const since = req.query.since;
    let history = v.history || [];
    if (since && since !== 'all') {
      const sinceDate = new Date(parseInt(since));
      history = history.filter(h => new Date(h.time) >= sinceDate);
    }

    // Aktuella priser för att räkna materialkostnad (matcha på art.nr, annars namn)
    const products = await Product.find({ tenantId: req.tenantId }).limit(10000);
    const priceOf = (h) => {
      const art = (h.articleNo || '').trim();
      let p = null;
      if (art && art !== '—') p = products.find(x => (x.articleNo || '').trim() === art);
      if (!p) p = products.find(x => x.name === h.productName);
      return p ? (p.price || 0) : 0;
    };
    const fmt = n => (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let total = 0;
    const rows = history.map(h => {
      const price = priceOf(h);
      const qty = Number(h.qty) || 0;
      const line = price * qty;
      total += line;
      return `<tr><td>${escHtml(h.time)}</td><td>${escHtml(h.productName)}</td><td style="text-align:right">${escHtml(h.qty)}</td><td>${escHtml(h.articleNo||'—')}</td><td>${escHtml(h.supplier||'—')}</td><td>${escHtml(h.userName||'—')}</td><td style="text-align:right">${fmt(price)}</td><td style="text-align:right">${fmt(line)}</td></tr>`;
    }).join('');
    const totalRow = `<tr><td colspan="7" style="text-align:right;font-weight:700;border-top:2px solid #ccc">Total materialkostnad</td><td style="text-align:right;font-weight:700;border-top:2px solid #ccc">${fmt(total)} kr</td></tr>`;
    const html = `<!DOCTYPE html><html lang="sv"><head><meta charset="UTF-8"><title>Export — ${escHtml(v.regNr)}</title>
    <style>body{font-family:sans-serif;padding:2rem;color:#111}h1{font-size:20px}h2{font-size:15px;color:#555;margin-top:0}table{width:100%;border-collapse:collapse;margin-top:1.5rem;font-size:13px}th{background:#f0f0f0;padding:8px;text-align:left;border-bottom:2px solid #ccc}td{padding:7px 8px;border-bottom:1px solid #e0e0e0}@media print{button{display:none}}</style>
    </head><body>
    <button onclick="window.print()" style="margin-bottom:1rem;padding:8px 16px;background:#222;color:#fff;border:none;border-radius:6px;cursor:pointer">🖨 Skriv ut / Spara PDF</button>
    <h1>${escHtml(v.regNr)} — ${escHtml(v.make||'')} ${escHtml(v.model||'')}</h1>
    <h2>Kund: ${escHtml(v.customerName||'—')} &nbsp;|&nbsp; Kontakt: ${escHtml(v.customerContact||'—')}</h2>
    <p style="font-size:12px;color:#888">Exporterad: ${escHtml(new Date().toLocaleString('sv-SE'))}</p>
    <table><thead><tr><th>Tid</th><th>Produkt</th><th style="text-align:right">Antal</th><th>Art.nr</th><th>Leverantör</th><th>Användare</th><th style="text-align:right">A-pris</th><th style="text-align:right">Radkostnad</th></tr></thead>
    <tbody>${rows||'<tr><td colspan="8" style="color:#888;text-align:center">Inga uttag registrerade</td></tr>'}${history.length?totalRow:''}</tbody></table>
    <p style="font-size:11px;color:#aaa;margin-top:1rem">A-pris avser utpris till kund (aktuellt pris per artikel).</p>
    </body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) { serverError(res, err); }
});

app.get('/api/export/products.csv', authMiddleware, async (req, res) => {
  const products = await Product.find({ tenantId: req.tenantId }).sort({ name: 1 }).limit(10000);
  const header = 'Namn,Streckkod,Antal,Artikelnummer,Leverantör,A-pris\n';
  const csvSafe = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g,'""') + '"'; };
  const rows = products.map(p => [p.name, p.code, p.qty, p.articleNo||'', p.supplier||'', (p.price||0)].map(csvSafe).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lager.csv"');
  res.send('\uFEFF' + header + rows);
});

// Importera produkter fr\u00E5n CSV (skickas som text/plain, egen parser med st\u00F6rre gr\u00E4ns)
app.post('/api/products/import', authMiddleware, adminOnly, importLimiter, express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
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
    const num = (v, def) => { const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n >= 0 ? n : def; };
    const price = (v) => { const n = parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };

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
      if (colIdx.price >= 0)    fields.price    = price(cell(row, 'price'));

      try {
        const existing = await Product.findOne({ tenantId: req.tenantId, code });
        if (existing) { Object.assign(existing, fields); await existing.save(); updated++; }
        else { await Product.create({ tenantId: req.tenantId, code, ...fields }); created++; }
      } catch (e) { skipped++; errors.push(`Rad ${i + 1} (${code}): ${mail.safeErrorMessage(e, [process.env.MONGODB_URI])}`); }
    }
    await addLog(req.tenantId, `CSV-import: ${created} nya, ${updated} uppdaterade, ${skipped} \u00F6verhoppade`);
    res.json({ ok: true, created, updated, skipped, errors: errors.slice(0, 20) });
  } catch (err) { serverError(res, err); }
});

// ══════════════════════════════════════════
//  DB (samlad data för frontend)
// ══════════════════════════════════════════

app.get('/api/db', authMiddleware, checkTenantActive, async (req, res) => {
  try {
    const [products, orders, users, vehicles, logs, tenant, inventoryReports] = await Promise.all([
      Product.find({ tenantId: req.tenantId }).sort({ name: 1 }).limit(10000),
      Order.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(10000),
      User.find({ tenantId: req.tenantId }).select('-password').sort({ name: 1 }),
      Vehicle.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(10000),
      Log.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(100),
      Tenant.findById(req.tenantId),
      InventoryReport.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(50)
    ]);
    const settings = mail.publicSettings(tenant?.settings?.toObject());
    res.json({ products, orders, users: users.map(redact.sanitizeUser), vehicles, logs: logs.map(redact.publicLog), settings, inventoryReports,
      plan: tenant?.plan || 'bas', planLimits: planLimitsPublic(tenant), usage: { users: users.length } });
  } catch (err) { serverError(res, err); }
});

// ── Superadmin middleware ──
app.use('/api/superadmin/', superadminLimiter);
function superAdmin(req, res, next) {
  if (!adminAuthorized(req.headers['x-admin-secret'])) {
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
      return redact.publicSuperadminTenant(t, {
        userCount, productCount, adminEmail: adminUser?.email, adminName: adminUser?.name
      });
    }));
    res.json(result);
  } catch (err) { serverError(res, err); }
});

// Skapa ny tenant
app.post('/api/superadmin/tenants', superAdmin, async (req, res) => {
  try {
    const { tenantName, adminEmail, adminPassword, adminName, plan } = req.body;
    if (!tenantName || !adminEmail || !adminPassword) return res.status(400).json({ error: 'Namn, e-post och lösenord krävs' });
    const slug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString(36);
    const tenant = await Tenant.create({ name: tenantName, slug, plan: plan || 'bas', settings: { workshop: tenantName } });
    const hashed = await bcrypt.hash(adminPassword, 12);
    const user = await User.create({ tenantId: tenant._id, name: adminName || tenantName, email: adminEmail.toLowerCase(), password: hashed, role: 'admin' });
    res.json({ ok: true, tenantId: tenant._id, userId: user._id, slug });
  } catch (err) { serverError(res, err); }
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
        if (adminPassword) admin.password = await bcrypt.hash(adminPassword, 12);
        await admin.save();
      }
    }
    res.json({ ok: true });
  } catch (err) { serverError(res, err); }
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
  } catch (err) { serverError(res, err); }
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
  } catch (err) { serverError(res, err); }
});


// ── Rena URL:er ──
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'superadmin.html')));
app.get('/app',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/kiosk/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.get('/kiosk',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.get('/manifest.webmanifest', (req, res) => sendManifest(req.query.start, res));

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
  } catch (err) { serverError(res, err); }
});

// Kiosk: byt device-token mot en användarspecifik token (agerande användare bäddas in i token)
app.post('/api/kiosk/user-token', authMiddleware, kioskLimiter, async (req, res) => {
  try {
    if (req.user.role !== 'kiosk') return res.status(403).json({ error: 'Endast kiosk' });
    const tenant = await Tenant.findById(req.tenantId);
    if (tenant?.status !== 'active') return res.status(403).json({ error: 'Kontot är pausat' });
    const user = await User.findOne({ _id: req.body.userId, tenantId: req.tenantId });
    if (!user) return res.status(404).json({ error: 'Användare hittades inte' });
    // Kräv PIN om användaren har en satt
    if (user.pin) {
      const pin = String(req.body.pin || '');
      if (!pin) return res.status(401).json({ error: 'PIN krävs', needPin: true });
      const okPin = await bcrypt.compare(pin, user.pin);
      if (!okPin) return res.status(401).json({ error: 'Fel PIN', needPin: true });
    }
    const token = jwt.sign(
      { tenantId: req.tenantId, userId: user._id, role: 'kiosk', name: user.name },
      JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token });
  } catch (err) { serverError(res, err); }
});

// ── Tenant slug routing ──
app.get('/:slug', async (req, res, next) => {
  const reserved = ['login','superadmin','app','kiosk','api','favicon.svg','manifest.webmanifest','sw.js','icons'];
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
      if (!mail.shouldSendScheduled(s, planOf(t).scheduledOrders, nowDay, nowTime)) continue;

      const pending = await Order.find({ tenantId: t._id, sent: false });
      if (!pending.length) { await addLog(t._id, 'Schemalagd beställning: inga aktiva beställningar att skicka'); continue; }
      try {
        await sendOrderEmail(s, pending);
        await Order.updateMany({ tenantId: t._id, sent: false }, { sent: true });
        await addLog(t._id, `Schemalagd beställning skickad (${pending.length} artiklar)`, 'order');
      } catch (err) {
        const detail = mail.safeErrorMessage(err, [s.smtpPass, process.env.ACS_EMAIL_CONNECTION_STRING, process.env.MONGODB_URI]);
        await addLog(t._id, `Schemalagd beställning misslyckades: ${detail}`, 'warn');
      }
    }
  } catch (err) {
    console.error('[SCHEMALÄGGARE] fel:', mail.safeErrorMessage(err, [process.env.MONGODB_URI, process.env.ACS_EMAIL_CONNECTION_STRING]));
  }
}
setInterval(runScheduledOrders, 60 * 1000);

// ── Start ──
app.listen(PORT, () => console.log(`
✅  Scanny körs på http://localhost:${PORT}
`));

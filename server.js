require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path       = require('path');
const cors       = require('cors');

const { Tenant, User, Product, Order, Vehicle, Log } = require('./models');
const { authMiddleware, adminOnly, JWT_SECRET } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

async function sendOrderEmail(settings, pendingOrders) {
  const { email, workshop, smtpHost, smtpPort, smtpUser, smtpPass } = settings;
  if (!smtpUser || !smtpPass) throw new Error('SMTP-uppgifter saknas');
  const transporter = nodemailer.createTransport({
    host: smtpHost || 'smtp.gmail.com', port: smtpPort || 587, secure: false,
    auth: { user: smtpUser, pass: smtpPass }
  });
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

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const token = jwt.sign({ userId: user._id, tenantId: user.tenantId, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    const tenant = await Tenant.findById(user.tenantId);
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role }, tenant: { name: tenant?.name, slug: tenant?.slug } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const product = await Product.findOneAndUpdate({ _id: req.params.id, tenantId: req.tenantId }, req.body, { new: true });
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

app.post('/api/scan', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const p = await Product.findOne({ tenantId: req.tenantId, code: code?.trim() });
    if (!p) { await addLog(req.tenantId, `Okänd streckkod: ${code}`, 'warn'); return res.status(404).json({ error: `Okänd streckkod: ${code}` }); }
    if (p.qty <= 0) return res.status(400).json({ error: `${p.name} är slut på lager` });
    p.qty--;
    await p.save();
    await addLog(req.tenantId, `Uttag: ${p.name} (kvar: ${p.qty})`);
    let orderCreated = false;
    if (p.qty <= p.min) {
      const exists = await Order.findOne({ tenantId: req.tenantId, productId: p._id, sent: false });
      if (!exists) {
        await Order.create({ tenantId: req.tenantId, productId: p._id, name: p.name, code: p.code, orderQty: p.orderQty, supplier: p.supplier, articleNo: p.articleNo });
        await addLog(req.tenantId, `BESTÄLLNING skapad: ${p.name}`, 'order');
        orderCreated = true;
      }
    }
    res.json({ product: p, orderCreated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/add', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const p = await Product.findOne({ tenantId: req.tenantId, code: code?.trim() });
    if (!p) { await addLog(req.tenantId, `Okänd streckkod: ${code}`, 'warn'); return res.status(404).json({ error: `Okänd streckkod: ${code}` }); }
    p.qty++;
    await p.save();
    await addLog(req.tenantId, `Påfyllning: ${p.name} (nu ${p.qty})`);
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

app.post('/api/inventory-report', authMiddleware, async (req, res) => {
  try {
    const { entries } = req.body;
    const diffs = entries.filter(e => e.scanned !== e.previous);
    await addLog(req.tenantId, `Inventering: ${entries.length} artiklar, ${diffs.length} differenser`, 'order');
    const tenant = await Tenant.findById(req.tenantId);
    if (!tenant?.settings?.smtpUser) return res.json({ ok: true, sent: false });
    const s = tenant.settings;
    const transporter = nodemailer.createTransport({ host: s.smtpHost||'smtp.gmail.com', port: s.smtpPort||587, secure: false, auth: { user: s.smtpUser, pass: s.smtpPass } });
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
    const { name, email, password, role, color, permissions } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Namn, e-post och lösenord krävs' });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: 'E-post finns redan' });
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ tenantId: req.tenantId, name, email: email.toLowerCase(), password: hashed, role: role||'staff', color: color||'#0f6e56', permissions: permissions||{} });
    await addLog(req.tenantId, `Ny användare: ${name}`);
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role, color: user.color });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    Object.assign(tenant.settings, req.body);
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

app.get('/api/export/products.csv', authMiddleware, async (req, res) => {
  const products = await Product.find({ tenantId: req.tenantId }).sort({ name: 1 });
  const header = 'Namn,Streckkod,Antal,Artikelnummer,Leverantör\n';
  const rows = products.map(p => [p.name, p.code, p.qty, p.articleNo||'', p.supplier||''].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lager.csv"');
  res.send('\uFEFF' + header + rows);
});

// ══════════════════════════════════════════
//  DB (samlad data för frontend)
// ══════════════════════════════════════════

app.get('/api/db', authMiddleware, async (req, res) => {
  try {
    const [products, orders, users, vehicles, logs, tenant] = await Promise.all([
      Product.find({ tenantId: req.tenantId }).sort({ name: 1 }),
      Order.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }),
      User.find({ tenantId: req.tenantId }).select('-password').sort({ name: 1 }),
      Vehicle.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }),
      Log.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(100),
      Tenant.findById(req.tenantId)
    ]);
    const settings = { ...tenant?.settings?.toObject() };
    delete settings.smtpPass;
    res.json({ products, orders, users, vehicles, logs, settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Superadmin middleware ──
function superAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Obehörig' });
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


// ── Start ──
app.listen(PORT, () => console.log(`
✅  Scanny körs på http://localhost:${PORT}
`));

const mongoose = require('mongoose');

// ── Tenant (verkstad) ──
const tenantSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  slug:      { type: String, required: true, unique: true },
  status:    { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
  plan:      { type: String, enum: ['bas', 'standard', 'pro'], default: 'bas' },
  createdAt: { type: Date, default: Date.now },
  settings: {
    email:    { type: String, default: '' },
    workshop: { type: String, default: '' },
    smtpHost: { type: String, default: 'smtp.gmail.com' },
    smtpPort: { type: Number, default: 587 },
    smtpUser: { type: String, default: '' },
    smtpPass: { type: String, default: '' },
    scheduleDay:  { type: Number, default: 1 },
    scheduleHour: { type: Number, default: 8 },
    scheduleTime: { type: String, default: '' },
    printerIp:    { type: String, default: '' },
    printerModel: { type: String, default: 'QL-810W' },
    labelSize:    { type: String, default: '29x90' },
    printerQueue: { type: String, default: '_192_168_10_164' },
    pageSize:     { type: String, default: 'DC03' }
  }
});

// ── Användare ──
const userSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:      { type: String, required: true },
  email:     { type: String, required: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['admin', 'staff'], default: 'staff' },
  color:     { type: String, default: '#0f6e56' },
  pin:       { type: String, default: '' },   // bcrypt-hash av 4-siffrig PIN (kiosk-profilval)
  permissions: {
    canScan:      { type: Boolean, default: true },
    canAdd:       { type: Boolean, default: true },
    canInventory: { type: Boolean, default: false }
  },
  createdAt: { type: Date, default: Date.now }
});

// ── Produkt ──
const productSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:      { type: String, required: true },
  code:      { type: String, required: true },
  qty:       { type: Number, default: 0 },
  min:       { type: Number, default: 5 },
  critical:  { type: Number, default: 2 },
  orderQty:  { type: Number, default: 10 },
  articleNo: { type: String, default: '' },
  supplier:  { type: String, default: '' },
  price:     { type: Number, default: 0 },   // A-pris (utpris till kund), SEK
  createdAt: { type: Date, default: Date.now }
});
productSchema.index({ tenantId: 1, code: 1 }, { unique: true });

// ── Order ──
const orderSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  productId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:       String,
  code:       String,
  orderQty:   Number,
  supplier:   String,
  articleNo:  String,
  sent:       { type: Boolean, default: false },
  createdAt:  { type: Date, default: Date.now }
});

// ── Fordon ──
const vehicleSchema = new mongoose.Schema({
  tenantId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  regNr:         { type: String, required: true },
  make:          String,
  model:         String,
  color:         String,
  customerName:  String,
  customerContact: String,
  archived:      { type: Boolean, default: false },
  archivedAt:    String,
  lastExportAt:  String,
  history:       [{ type: mongoose.Schema.Types.Mixed }],
  createdAt:     { type: Date, default: Date.now }
});

// ── Logg ──
const logSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  time:     String,
  date:     String,
  msg:      String,
  type:     { type: String, default: 'normal' },
  createdAt: { type: Date, default: Date.now }
});

// ── Inventeringsrapport ──
const inventoryReportSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  date:      String,
  time:      String,
  total:     Number,
  diffCount: Number,
  actorName: { type: String, default: '' },
  entries:   [{ type: mongoose.Schema.Types.Mixed }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = {
  Tenant:  mongoose.model('Tenant',  tenantSchema),
  User:    mongoose.model('User',    userSchema),
  Product: mongoose.model('Product', productSchema),
  Order:   mongoose.model('Order',   orderSchema),
  Vehicle: mongoose.model('Vehicle', vehicleSchema),
  Log:     mongoose.model('Log',     logSchema),
  InventoryReport: mongoose.model('InventoryReport', inventoryReportSchema)
};

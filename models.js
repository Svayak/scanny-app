const mongoose = require('mongoose');

// ── Tenant (verkstad) ──
const tenantSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  slug:      { type: String, required: true, unique: true },
  status:    { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
  plan:      { type: String, enum: ['bas', 'standard', 'pro'], default: 'bas' },
  createdAt: { type: Date, default: Date.now },
  settings: {
    email:      { type: String, default: '' },
    alertEmail: { type: String, default: '' },
    workshop:   { type: String, default: '' },
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
    pageSize:     { type: String, default: 'DC03' },
    // Automatisk utskrift är av tills en admin skapar en bryggnyckel och slår på den.
    // Saknade fält hos befintliga verkstäder betyder avstängt.
    printBridge: {
      enabled:          { type: Boolean, default: false },
      keyHash:          { type: String, default: '' },
      keyPrefix:        { type: String, default: '' },
      keyCreatedAt:     { type: Date },
      lastHeartbeatAt:  { type: Date },
      printerStatus:    { type: String, default: '' },
      printerDetail:    { type: String, default: '' },
      printerName:      { type: String, default: '' }
    }
  }
});
tenantSchema.index({ 'settings.printBridge.keyHash': 1 });

// ── Användare ──
const userSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  name:      { type: String, required: true },
  email:     { type: String, required: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['admin', 'staff'], default: 'staff' },
  color:     { type: String, default: '#0f6e56' },
  initials:  { type: String, default: '' },
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
  articleNo: {
    type: String,
    default: '',
    set(v) { return v == null ? '' : String(v).trim(); }
  },
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
  // history[]: time, productName, qty, userName (ögonblicksbild), userId, legacyActorName, articleNo, supplier
  history:       [{ type: mongoose.Schema.Types.Mixed }],
  createdAt:     { type: Date, default: Date.now }
});

// ── Logg ──
// msg och actorName är textögonblicksbilder. userId pekar på användaren.
// legacyActorName sätts av migreringen när namnet inte kan kopplas unikt.
const logSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  time:     String,
  date:     String,
  msg:      String,
  type:     { type: String, default: 'normal' },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorName: { type: String, default: '' },
  legacyActorName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
logSchema.index({ tenantId: 1, userId: 1 });

// ── Inventeringsrapport ──
const inventoryReportSchema = new mongoose.Schema({
  tenantId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  date:      String,
  time:      String,
  total:     Number,
  diffCount: Number,
  actorName: { type: String, default: '' },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  legacyActorName: { type: String, default: '' },
  entries:   [{ type: mongoose.Schema.Types.Mixed }],
  createdAt: { type: Date, default: Date.now }
});
inventoryReportSchema.index({ tenantId: 1, userId: 1 });

// ── Utskriftskö (hämtas av den lokala bryggan) ──
const printJobSchema = new mongoose.Schema({
  tenantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  productId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  name:       { type: String, default: '' },
  code:       { type: String, default: '' },
  articleNo:  { type: String, default: '' },
  labelSize:  { type: String, default: '62x29' },
  source:     { type: String, enum: ['inleverans', 'manual', 'test'], default: 'manual' },
  status:     { type: String, enum: ['pending', 'claimed', 'printed', 'failed', 'expired'], default: 'pending' },
  error:      { type: String, default: '' },
  createdAt:  { type: Date, default: Date.now },
  claimedAt:  { type: Date },
  finishedAt: { type: Date }
});
printJobSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
printJobSchema.index({ tenantId: 1, createdAt: 1 });

module.exports = {
  Tenant:  mongoose.model('Tenant',  tenantSchema),
  User:    mongoose.model('User',    userSchema),
  Product: mongoose.model('Product', productSchema),
  Order:   mongoose.model('Order',   orderSchema),
  Vehicle: mongoose.model('Vehicle', vehicleSchema),
  Log:     mongoose.model('Log',     logSchema),
  InventoryReport: mongoose.model('InventoryReport', inventoryReportSchema),
  PrintJob: mongoose.model('PrintJob', printJobSchema, 'print_jobs')
};

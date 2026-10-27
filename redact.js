// Tar bort hemligheter ur API-svar, loggar och felmeddelanden.
// Klienten får aldrig lösenord, PIN-hashar, SMTP-lösen, anslutningssträngar eller nycklar.

const SENSITIVE_KEYS = new Set([
  'password', 'pass', 'pin', 'secret', 'token', 'apikey', 'privatekey',
  'smtppass', 'connectionstring', 'mongodburi', 'jwtsecret', 'adminsecret',
  'accesstoken', 'refreshtoken', 'clientsecret', 'accountkey', 'authorization'
]);

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return /(password|smtppass|apikey|privatekey|connectionstring|accesstoken|refreshtoken|clientsecret|accountkey)$/.test(normalized);
}

function redactText(value, secrets = []) {
  let msg = String(value ?? '');
  const list = Array.isArray(secrets) ? secrets : [secrets];
  for (const secret of list) {
    const known = String(secret || '');
    if (known.length >= 8) msg = msg.split(known).join('***');
  }
  return msg
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'")]+/gi, 'mongodb://***')
    .replace(/accesskey=[^;\s'"]+/gi, 'accesskey=***')
    .replace(/AccountKey=[^;\s'"]+/gi, 'AccountKey=***')
    .replace(/SharedAccessKey=[^;\s'"]+/gi, 'SharedAccessKey=***')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***');
}

function stripSensitive(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map(item => stripSensitive(item, depth + 1));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value) : value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    out[key] = stripSensitive(item, depth + 1);
  }
  return out;
}

function plain(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  return { ...doc };
}

// Tillåtna fält för en användare. password och pin lämnar aldrig servern.
function sanitizeUser(user) {
  const o = plain(user);
  if (!o) return null;
  return {
    _id: o._id,
    id: o.id || o._id,
    tenantId: o.tenantId,
    name: o.name,
    email: o.email,
    role: o.role,
    color: o.color,
    initials: o.initials,
    permissions: o.permissions,
    hasPin: !!o.pin,
    lastVehicleId: o.lastVehicleId,
    createdAt: o.createdAt
  };
}

function publicAuthPayload(user, tenant, settingsPublic) {
  const t = plain(tenant);
  return {
    user: sanitizeUser(user),
    tenant: t ? {
      _id: t._id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      plan: t.plan,
      settings: stripSensitive(settingsPublic || {})
    } : null
  };
}

// Superadmin-listan behöver kundkortet, inte SMTP-lösen eller hela settings-dokumentet.
function publicSuperadminTenant(tenant, extra = {}) {
  const o = plain(tenant) || {};
  return {
    _id: o._id,
    name: o.name,
    slug: o.slug,
    status: o.status,
    plan: o.plan,
    createdAt: o.createdAt,
    userCount: extra.userCount,
    productCount: extra.productCount,
    adminEmail: extra.adminEmail,
    adminName: extra.adminName
  };
}

function publicLog(log) {
  const o = plain(log);
  if (!o) return o;
  if (Object.prototype.hasOwnProperty.call(o, 'msg')) o.msg = redactText(o.msg);
  return o;
}

module.exports = {
  isSensitiveKey,
  redactText,
  stripSensitive,
  sanitizeUser,
  publicAuthPayload,
  publicSuperadminTenant,
  publicLog
};

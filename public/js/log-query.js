// Frågor mot händelseloggen. Sortering sker på indexerade fält.
// Sökning är vanlig $regex (Cosmos DB stödjer inte $regexMatch här).
const userLink = require('./user-link');

const ACTIVITY_TYPES = ['uttag', 'addera', 'inventering', 'admin', 'ovrigt'];
const ACTIVITY_LABELS = {
  uttag: 'Uttag',
  addera: 'Addera',
  inventering: 'Inventering',
  admin: 'Admin',
  ovrigt: 'Övrigt'
};

// API-nyckel → fält som har ett eget index och ett tenantId-index.
const SORT_FIELDS = {
  date: 'createdAt',
  articleNo: 'articleNo',
  product: 'productName',
  person: 'actorName',
  type: 'activityType',
  qty: 'qty'
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CSV_HEADERS = ['Datum', 'Tid', 'Artikelnummer', 'Produkt', 'Streckkod', 'Person', 'Typ', 'Antal', 'Händelse'];

function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function activityLabel(type) {
  return ACTIVITY_LABELS[type] || '';
}

function logFields(input) {
  const src = input || {};
  const out = {};
  if (ACTIVITY_TYPES.includes(src.activityType)) out.activityType = src.activityType;
  if (src.productId) out.productId = src.productId;
  if (src.articleNo != null && src.articleNo !== '') out.articleNo = String(src.articleNo).slice(0, 200);
  if (src.productName != null && src.productName !== '') out.productName = String(src.productName).slice(0, 300);
  if (src.code != null && src.code !== '') out.code = String(src.code).slice(0, 80);
  if (src.qty != null && src.qty !== '' && Number.isFinite(Number(src.qty))) out.qty = Number(src.qty);
  return out;
}

function fromProduct(product, activityType, qty) {
  const item = product || {};
  return logFields({
    activityType,
    productId: item._id || item.id,
    articleNo: item.articleNo,
    productName: item.name,
    code: item.code,
    qty
  });
}

function stockholmParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) map[part.type] = part.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

// Tolkar YYYY-MM-DD som dygnsgräns i Europe/Stockholm.
function stockholmBoundary(dateStr, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const hour = end ? 23 : 0;
  const minute = end ? 59 : 0;
  const second = end ? 59 : 0;
  const ms = end ? 999 : 0;
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  const seen = stockholmParts(utc);
  const asUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, ms);
  return new Date(utc.getTime() - (asUtc - utc.getTime()));
}

function normalizeTypes(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  for (const item of list) {
    const key = String(item || '').trim().toLowerCase();
    if (ACTIVITY_TYPES.includes(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function buildLogQuery(opts) {
  const options = opts || {};
  const filter = {};
  if (options.tenantId != null) filter.tenantId = options.tenantId;

  const createdAt = {};
  const from = stockholmBoundary(options.from, false);
  const to = stockholmBoundary(options.to, true);
  if (from) createdAt.$gte = from;
  if (to) createdAt.$lte = to;
  if (createdAt.$gte || createdAt.$lte) filter.createdAt = createdAt;

  const userId = String(options.userId || '').trim();
  if (userId === 'unknown') {
    filter.userId = { $nin: (options.knownUserIds || []).filter(Boolean) };
  } else if (/^[a-fA-F0-9]{24}$/.test(userId)) {
    filter.userId = userId;
  }

  const types = normalizeTypes(options.type);
  if (types.length) filter.activityType = { $in: types };

  const q = String(options.q || '').trim();
  if (q) {
    const pattern = escapeRegex(q);
    filter.$or = ['productName', 'articleNo', 'code', 'msg'].map(field => ({
      [field]: { $regex: pattern, $options: 'i' }
    }));
  }

  const sortKey = Object.prototype.hasOwnProperty.call(SORT_FIELDS, options.sort) ? options.sort : 'date';
  let dir;
  if (options.dir === 'asc') dir = 1;
  else if (options.dir === 'desc') dir = -1;
  else dir = sortKey === 'date' ? -1 : 1;
  const sort = { [SORT_FIELDS[sortKey]]: dir };

  let pageSize = parseInt(options.pageSize, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  pageSize = Math.min(pageSize, MAX_PAGE_SIZE);
  let page = parseInt(options.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;

  return {
    filter,
    sort,
    sortKey,
    dir: dir === 1 ? 'asc' : 'desc',
    page,
    pageSize,
    skip: (page - 1) * pageSize
  };
}

function presentLogItem(doc, users) {
  const entry = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...(doc || {}) };
  const snapshot = entry.actorName || userLink.parseLogActorName(entry.msg);
  const qty = entry.qty == null || entry.qty === '' ? null : Number(entry.qty);
  return {
    id: entry._id || entry.id || null,
    createdAt: entry.createdAt || null,
    date: entry.date || '',
    time: entry.time || '',
    msg: userLink.displayLogMessage(entry, users || []),
    severity: entry.type || 'normal',
    activityType: entry.activityType || '',
    activityLabel: activityLabel(entry.activityType),
    productId: entry.productId || null,
    articleNo: entry.articleNo || '',
    productName: entry.productName || '',
    code: entry.code || '',
    qty: Number.isFinite(qty) ? qty : null,
    userId: entry.userId || null,
    person: userLink.displayUserName(entry.userId, snapshot, users || [])
  };
}

function csvSafe(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function csvLine(item) {
  const row = presentLogItem(item.person ? item : item, item.users);
  const cells = [
    row.date,
    row.time,
    row.articleNo,
    row.productName,
    row.code,
    row.person,
    row.activityLabel,
    row.qty == null ? '' : row.qty,
    row.msg
  ];
  return cells.map(csvSafe).join(',');
}

function csvDocument(items, users) {
  const lines = [CSV_HEADERS.join(',')];
  for (const item of items || []) {
    lines.push(csvLine({ ...item, users }));
  }
  return '\uFEFF' + lines.join('\n') + '\n';
}

// Bästa tolkning av äldre fritext. Returnerar bara fält som är säkra.
function parseLegacyLog(msg) {
  const text = String(msg || '');
  let match = text.match(/^Uttag: (.+?) \(kvar: -?\d+\)/);
  if (match) return { activityType: 'uttag', productName: match[1].trim(), qty: 1 };
  match = text.match(/^Påfyllning: (.+?) \(nu -?\d+\)/);
  if (match) return { activityType: 'addera', productName: match[1].trim(), qty: 1 };
  if (/^Inventering: \d+ artiklar/.test(text)) return { activityType: 'inventering' };
  match = text.match(/^(?:Ny produkt tillagd|Produkt borttagen): (.+)$/);
  if (match) return { activityType: 'admin', productName: match[1].trim() };
  if (/^(Ny användare: |Användare borttagen: |Användare ändrad: |CSV-import: |Fordon |Etikett utskriven: |Testmejl )/.test(text)) {
    return { activityType: 'admin' };
  }
  if (/^(BESTÄLLNING |Beställning |Order |Okänd streckkod: |KRITISK |E-post misslyckades: |Schemalagd )/.test(text)) {
    return { activityType: 'ovrigt' };
  }
  return null;
}

function structurePatch(log) {
  const entry = log || {};
  if (entry.activityType) return null;
  const parsed = parseLegacyLog(entry.msg);
  if (!parsed) return null;
  const set = {};
  if (parsed.activityType) set.activityType = parsed.activityType;
  if (parsed.productName && !String(entry.productName || '').trim()) set.productName = parsed.productName;
  if (parsed.qty != null && (entry.qty == null || entry.qty === '')) set.qty = parsed.qty;
  return set;
}

function planLogStructure(logs) {
  const bucket = { examined: 0, parsed: 0, skipped: 0, updates: [] };
  for (const log of logs || []) {
    bucket.examined += 1;
    const set = structurePatch(log);
    if (!set) {
      bucket.skipped += 1;
      continue;
    }
    bucket.parsed += 1;
    bucket.updates.push({ id: log._id || log.id, tenantId: log.tenantId, set });
  }
  return bucket;
}

function valueMatches(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    if (Object.prototype.hasOwnProperty.call(cond, '$regex')) {
      const flags = String(cond.$options || '').includes('i') ? 'i' : '';
      return new RegExp(cond.$regex, flags).test(value == null ? '' : String(value));
    }
    if (cond.$in) return cond.$in.some(item => String(item) === String(value));
    if (cond.$nin) {
      if (value == null || value === '') return true;
      return !cond.$nin.some(item => String(item) === String(value));
    }
    if (cond.$gte != null && !(value >= cond.$gte)) return false;
    if (cond.$lte != null && !(value <= cond.$lte)) return false;
    if (cond.$gte != null || cond.$lte != null) return true;
  }
  if (value == null || cond == null) return value == null && cond == null;
  return String(value) === String(cond);
}

function matchesFilter(doc, filter) {
  const query = filter || {};
  if (Array.isArray(query.$or) && !query.$or.some(part => matchesFilter(doc, part))) return false;
  if (Array.isArray(query.$and) && !query.$and.every(part => matchesFilter(doc, part))) return false;
  for (const [key, cond] of Object.entries(query)) {
    if (key === '$or' || key === '$and') continue;
    if (!valueMatches(doc[key], cond)) return false;
  }
  return true;
}

function compareSort(a, b, sort) {
  const [field, dir] = Object.entries(sort || { createdAt: -1 })[0];
  const left = a[field];
  const right = b[field];
  const empty = value => value == null || value === '';
  if (empty(left) && empty(right)) return 0;
  if (empty(left)) return 1;
  if (empty(right)) return -1;
  if (left > right) return dir;
  if (left < right) return -dir;
  const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return bTime - aTime;
}

function runLogQuery(rows, opts) {
  const query = buildLogQuery(opts);
  const matched = (rows || []).filter(row => matchesFilter(row, query.filter));
  matched.sort((a, b) => compareSort(a, b, query.sort));
  const items = matched.slice(query.skip, query.skip + query.pageSize);
  return { items, total: matched.length, page: query.page, pageSize: query.pageSize, query };
}

module.exports = {
  ACTIVITY_TYPES,
  ACTIVITY_LABELS,
  SORT_FIELDS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  CSV_HEADERS,
  escapeRegex,
  activityLabel,
  logFields,
  fromProduct,
  stockholmBoundary,
  normalizeTypes,
  buildLogQuery,
  presentLogItem,
  csvSafe,
  csvDocument,
  parseLegacyLog,
  structurePatch,
  planLogStructure,
  matchesFilter,
  runLogQuery
};

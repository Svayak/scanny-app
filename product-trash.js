// Mjuk borttagning av produkter (papperskorg, 30 dagar).
//
// Cosmos DB (Mongo API) kan inte antas ha partiella unika index
// (EnablePartialUniqueIndex) eller TTL på ett eget datumfält
// (EnableTtlOnCustomPath). Ett TTL-index på _ts skulle radera levande
// produkter. Därför:
//   - det vanliga unika indexet { tenantId, code } ligger kvar
//   - en mjuk borttagning flyttar streckkoden till archivedCode och
//     sätter code till en gravsten, så samma kod kan användas igen
//   - återställning nekas med ett tydligt fel om koden är upptagen
//   - produkter med deletedAt äldre än 30 dagar rensas av ett dygnsjobb
const express = require('express');

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BULK_LIMIT = 200;

const ACTIVITY = {
  deleted: 'product_deleted',
  restored: 'product_restored',
  permanent: 'product_permanently_deleted',
  tenant: 'tenant_deleted'
};

const ERRORS = {
  notFound: 'Produkt hittades inte',
  barcodeTaken: 'Streckkod finns redan',
  restoreBlocked: 'Streckkoden används redan av en annan produkt. Återställningen avbröts.',
  bulkEmpty: 'Inga produkter valda',
  bulkTooMany: 'För många produkter på en gång'
};

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

function idOf(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object') {
    if (value._id != null && value._id !== value) return idOf(value._id);
    if (typeof value.toHexString === 'function') return value.toHexString();
  }
  return String(value);
}

function sameId(a, b) {
  const left = idOf(a);
  const right = idOf(b);
  return !!left && left === right;
}

function isDeleted(product) {
  if (!product || product.deletedAt == null || product.deletedAt === '') return false;
  const time = new Date(product.deletedAt).getTime();
  return Number.isFinite(time) && time > 0;
}

function barcodeOf(product) {
  if (!product) return '';
  if (isDeleted(product)) {
    const archived = text(product.archivedCode);
    if (archived) return archived;
  }
  return text(product.code);
}

function tombstoneCode(id) {
  return '~deleted:' + idOf(id);
}

function actorSnapshot(actor) {
  if (!actor) return { userId: null, name: '' };
  const userId = actor._id || actor.id || actor.userId || null;
  return { userId: userId || null, name: actor.name || '' };
}

function plain(doc) {
  if (!doc) return null;
  const src = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return { ...src, _id: src._id != null ? src._id : doc._id };
}

// Aktiva produkter: deletedAt saknas eller är null.
// Cosmos DB behandlar inte saknade fält som null, därför båda villkoren.
function activeFilter(tenantId, extra) {
  const alive = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  const more = extra && typeof extra === 'object' ? extra : {};
  if (!Object.keys(more).length) return { tenantId, ...alive };
  return { tenantId, $and: [alive, more] };
}

function deletedFilter(tenantId) {
  const filter = { deletedAt: { $gt: new Date(0) } };
  if (tenantId != null) filter.tenantId = tenantId;
  return filter;
}

// Ordrar vars produkt ligger i papperskorgen ska inte synas.
// Cosmos: $ne träffar inte alltid dokument där fältet saknas.
function visibleOrderFilter(tenantId, extra) {
  const visible = {
    $or: [
      { productDeleted: { $exists: false } },
      { productDeleted: null },
      { productDeleted: false }
    ]
  };
  const filter = { tenantId, $and: [visible] };
  if (extra && typeof extra === 'object' && Object.keys(extra).length) filter.$and.push(extra);
  return filter;
}

function activeProducts(products, tenantId) {
  return (products || []).filter(product => sameId(product.tenantId, tenantId) && !isDeleted(product));
}

function visibleProducts(products, tenantId, query, productMatches) {
  const match = typeof productMatches === 'function' ? productMatches : () => true;
  return activeProducts(products, tenantId)
    .filter(product => match(product, query))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'sv'));
}

function findScannable(products, tenantId, code) {
  const want = text(code);
  if (!want) return null;
  return activeProducts(products, tenantId).find(product => text(product.code) === want) || null;
}

function lowStockProducts(products, tenantId) {
  return activeProducts(products, tenantId).filter(product => Number(product.qty) <= Number(product.min));
}

function visibleOrders(orders, tenantId, extra) {
  const sent = extra && Object.prototype.hasOwnProperty.call(extra, 'sent') ? extra.sent : undefined;
  return (orders || []).filter(order => {
    if (!sameId(order.tenantId, tenantId)) return false;
    if (order.productDeleted === true) return false;
    if (sent !== undefined && !!order.sent !== !!sent) return false;
    return true;
  });
}

function claimablePrintJobs(jobs, products) {
  const deleted = new Set((products || []).filter(isDeleted).map(product => idOf(product._id || product.id)));
  return (jobs || []).filter(job => job.status === 'pending' && !deleted.has(idOf(job.productId)));
}

function dueForPurge(product, now, retentionMs = RETENTION_MS) {
  if (!isDeleted(product)) return false;
  return new Date(now).getTime() - new Date(product.deletedAt).getTime() >= retentionMs;
}

function presentTrashItem(product, retentionMs = RETENTION_MS) {
  const deletedAt = new Date(product.deletedAt);
  const who = product.deletedBy || {};
  return {
    id: idOf(product._id || product.id),
    name: product.name || '',
    code: barcodeOf(product),
    articleNo: product.articleNo == null ? '' : String(product.articleNo),
    qty: product.qty,
    supplier: product.supplier || '',
    deletedAt: deletedAt.toISOString(),
    deletedByName: who.name || '',
    deletedByUserId: who.userId ? idOf(who.userId) : '',
    purgeAt: new Date(deletedAt.getTime() + retentionMs).toISOString()
  };
}

function logFields(product, activityType) {
  return {
    activityType,
    productId: product._id || product.id,
    articleNo: product.articleNo == null ? '' : String(product.articleNo).slice(0, 200),
    productName: String(product.name || '').slice(0, 300),
    code: String(barcodeOf(product)).slice(0, 80)
  };
}

function tenantDeletedLog(tenant) {
  return {
    msg: `Kund borttagen: ${tenant && tenant.name ? tenant.name : ''}`,
    type: 'warn',
    activityType: ACTIVITY.tenant,
    actorName: 'superadmin'
  };
}

function duplicateKey(err) {
  return !!(err && (err.code === 11000 || err.code === 11001));
}

function notFound() {
  return { ok: false, status: 404, error: ERRORS.notFound };
}

function conflict(error) {
  return { ok: false, status: 409, error };
}

async function softDelete(store, { tenantId, id, actor, now }) {
  const product = plain(await store.findProduct(tenantId, id));
  if (!product || !sameId(product.tenantId, tenantId) || isDeleted(product)) return notFound();
  const when = new Date(now || Date.now());
  const patch = {
    archivedCode: barcodeOf(product),
    code: tombstoneCode(product._id || product.id),
    deletedAt: when,
    deletedBy: actorSnapshot(actor)
  };
  await store.updateProduct(tenantId, product._id || product.id, patch);
  await store.markOrdersDeleted(tenantId, product._id || product.id);
  await store.expirePrintJobs(tenantId, product._id || product.id, when);
  const updated = { ...product, ...patch };
  await store.addLog(tenantId, `Produkt borttagen: ${product.name}`, 'normal', actor, logFields(updated, ACTIVITY.deleted));
  return { ok: true, product: updated };
}

async function softDeleteMany(store, input) {
  const raw = Array.isArray(input.ids) ? input.ids : [];
  const unique = [...new Set(raw.map(id => idOf(id)).filter(Boolean))];
  if (!unique.length) return { ok: false, status: 400, error: ERRORS.bulkEmpty };
  if (unique.length > BULK_LIMIT) return { ok: false, status: 400, error: ERRORS.bulkTooMany };
  const deleted = [];
  const missing = [];
  for (const id of unique) {
    const result = await softDelete(store, { ...input, id });
    if (result.ok) deleted.push(id);
    else missing.push(id);
  }
  return { ok: true, deleted, missing };
}

async function restore(store, { tenantId, id, actor, now }) {
  const product = plain(await store.findProduct(tenantId, id));
  if (!product || !sameId(product.tenantId, tenantId) || !isDeleted(product)) return notFound();
  const code = barcodeOf(product);
  const taken = plain(await store.findActiveByCode(tenantId, code, product._id || product.id));
  if (taken) return conflict(ERRORS.restoreBlocked);
  const patch = {
    code,
    archivedCode: '',
    deletedAt: null,
    deletedBy: { userId: null, name: '' }
  };
  try {
    await store.updateProduct(tenantId, product._id || product.id, patch);
  } catch (err) {
    if (duplicateKey(err)) return conflict(ERRORS.restoreBlocked);
    throw err;
  }
  await store.markOrdersRestored(tenantId, product._id || product.id);
  const updated = { ...product, ...patch };
  await store.addLog(tenantId, `Produkt återställd: ${product.name}`, 'normal', actor, logFields(updated, ACTIVITY.restored));
  return { ok: true, product: updated };
}

async function permanentDelete(store, { tenantId, id, actor, now, automatic }) {
  const product = plain(await store.findProduct(tenantId, id));
  if (!product || !sameId(product.tenantId, tenantId) || !isDeleted(product)) return notFound();
  const when = new Date(now || Date.now());
  const msg = automatic
    ? `Produkt raderad permanent efter 30 dagar: ${product.name}`
    : `Produkt raderad permanent: ${product.name}`;
  const who = automatic ? { name: 'System' } : actor;
  await store.addLog(tenantId, msg, 'normal', who, logFields(product, ACTIVITY.permanent));
  await store.expirePrintJobs(tenantId, product._id || product.id, when);
  await store.removeUnsentOrders(tenantId, product._id || product.id);
  await store.releaseSentOrders(tenantId, product._id || product.id);
  await store.removeProduct(tenantId, product._id || product.id);
  return { ok: true, product };
}

async function purgeExpired(store, options = {}) {
  const when = new Date(options.now || Date.now());
  const retention = options.retentionMs || RETENTION_MS;
  const products = (await store.listDeleted(options.tenantId)).map(plain).filter(Boolean);
  const removed = [];
  for (const product of products) {
    if (!dueForPurge(product, when, retention)) continue;
    if (options.tenantId != null && !sameId(product.tenantId, options.tenantId)) continue;
    const result = await permanentDelete(store, {
      tenantId: product.tenantId,
      id: product._id || product.id,
      now: when,
      automatic: true
    });
    if (result.ok) removed.push(idOf(product._id || product.id));
  }
  return removed;
}

async function listTrash(store, tenantId) {
  const products = (await store.listDeleted(tenantId))
    .map(plain)
    .filter(product => product && sameId(product.tenantId, tenantId) && isDeleted(product));
  products.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  return products.map(product => presentTrashItem(product));
}

function createTrashRouter(deps) {
  const router = express.Router();
  const auth = deps.authMiddleware || ((req, res, next) => next());
  const adminOnly = deps.adminOnly;
  const store = deps.store;
  const getActor = deps.getActor || (async () => null);
  const clock = () => (deps.now ? deps.now() : new Date());

  async function guard(res, fn) {
    try {
      await fn();
    } catch (err) {
      if (res.headersSent) return;
      if (deps.onError) return deps.onError(res, err);
      res.status(500).json({ error: 'Internt serverfel' });
    }
  }

  function send(res, result, body) {
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json(body);
  }

  router.get('/trash', auth, adminOnly, (req, res) => guard(res, async () => {
    res.json(await listTrash(store, req.tenantId));
  }));

  router.post('/bulk-delete', auth, adminOnly, (req, res) => guard(res, async () => {
    const actor = req.actor || await getActor(req);
    const result = await softDeleteMany(store, {
      tenantId: req.tenantId,
      ids: req.body && req.body.ids,
      actor,
      now: clock()
    });
    send(res, result, { ok: true, deleted: result.deleted, missing: result.missing });
  }));

  router.post('/:id/restore', auth, adminOnly, (req, res) => guard(res, async () => {
    const actor = req.actor || await getActor(req);
    const result = await restore(store, {
      tenantId: req.tenantId,
      id: req.params.id,
      actor,
      now: clock()
    });
    send(res, result, { ok: true, product: result.ok ? result.product : undefined });
  }));

  router.delete('/:id/permanent', auth, adminOnly, (req, res) => guard(res, async () => {
    const actor = req.actor || await getActor(req);
    const result = await permanentDelete(store, {
      tenantId: req.tenantId,
      id: req.params.id,
      actor,
      now: clock()
    });
    send(res, result, { ok: true });
  }));

  router.delete('/:id', auth, adminOnly, (req, res) => guard(res, async () => {
    const actor = req.actor || await getActor(req);
    const result = await softDelete(store, {
      tenantId: req.tenantId,
      id: req.params.id,
      actor,
      now: clock()
    });
    send(res, result, { ok: true });
  }));

  return router;
}

function duplicateError() {
  const err = new Error('duplicate key');
  err.code = 11000;
  return err;
}

function createMemoryStore(seed = {}) {
  const products = (seed.products || []).map(product => ({
    ...product,
    deletedBy: product.deletedBy ? { ...product.deletedBy } : product.deletedBy
  }));
  const orders = (seed.orders || []).map(order => ({ ...order }));
  const jobs = (seed.jobs || []).map(job => ({ ...job }));
  const logs = [];

  function product(tenantId, id) {
    return products.find(item => sameId(item.tenantId, tenantId) && sameId(item._id, id)) || null;
  }

  return {
    products,
    orders,
    jobs,
    logs,
    async findProduct(tenantId, id) {
      return product(tenantId, id);
    },
    async findActiveByCode(tenantId, code, exceptId) {
      return products.find(item => (
        sameId(item.tenantId, tenantId) &&
        !isDeleted(item) &&
        text(item.code) === text(code) &&
        !sameId(item._id, exceptId)
      )) || null;
    },
    async updateProduct(tenantId, id, patch) {
      const current = product(tenantId, id);
      if (!current) return null;
      const nextCode = Object.prototype.hasOwnProperty.call(patch, 'code') ? patch.code : current.code;
      const clash = products.find(item => item !== current && sameId(item.tenantId, tenantId) && item.code === nextCode);
      if (clash) throw duplicateError();
      Object.assign(current, patch);
      return current;
    },
    async insertProduct(doc) {
      const clash = products.find(item => sameId(item.tenantId, doc.tenantId) && item.code === doc.code);
      if (clash) throw duplicateError();
      products.push({ ...doc });
      return doc;
    },
    async removeProduct(tenantId, id) {
      const index = products.findIndex(item => sameId(item.tenantId, tenantId) && sameId(item._id, id));
      if (index >= 0) products.splice(index, 1);
    },
    async listDeleted(tenantId) {
      return products.filter(item => isDeleted(item) && (tenantId == null || sameId(item.tenantId, tenantId)));
    },
    async markOrdersDeleted(tenantId, productId) {
      for (const order of orders) {
        if (sameId(order.tenantId, tenantId) && sameId(order.productId, productId)) order.productDeleted = true;
      }
    },
    async markOrdersRestored(tenantId, productId) {
      for (const order of orders) {
        if (sameId(order.tenantId, tenantId) && sameId(order.productId, productId)) order.productDeleted = false;
      }
    },
    async removeUnsentOrders(tenantId, productId) {
      for (let i = orders.length - 1; i >= 0; i--) {
        const order = orders[i];
        if (sameId(order.tenantId, tenantId) && sameId(order.productId, productId) && !order.sent) orders.splice(i, 1);
      }
    },
    async releaseSentOrders(tenantId, productId) {
      for (const order of orders) {
        if (sameId(order.tenantId, tenantId) && sameId(order.productId, productId) && order.sent) order.productDeleted = false;
      }
    },
    async expirePrintJobs(tenantId, productId, now) {
      for (const job of jobs) {
        if (!sameId(job.tenantId, tenantId) || !sameId(job.productId, productId)) continue;
        if (job.status === 'pending' || job.status === 'claimed') {
          job.status = 'expired';
          job.finishedAt = now;
          job.error = 'Produkten är borttagen';
        }
      }
    },
    async addLog(tenantId, msg, type, actor, fields) {
      const userId = actor && (actor._id || actor.id || actor.userId);
      const entry = {
        tenantId,
        msg,
        type: type || 'normal',
        ...(fields || {})
      };
      if (userId) {
        entry.userId = userId;
        entry.actorName = actor.name || '';
      } else if (actor && actor.name) {
        entry.actorName = actor.name;
      }
      logs.push(entry);
      return entry;
    }
  };
}

function createMongooseStore({ Product, Order, PrintJob, addLog }) {
  async function ignoreCast(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) return null;
      throw err;
    }
  }

  return {
    async findProduct(tenantId, id) {
      return ignoreCast(() => Product.findOne({ _id: id, tenantId }));
    },
    async findActiveByCode(tenantId, code, exceptId) {
      const extra = { code };
      if (exceptId) extra._id = { $ne: exceptId };
      return ignoreCast(() => Product.findOne(activeFilter(tenantId, extra)));
    },
    async updateProduct(tenantId, id, patch) {
      return Product.findOneAndUpdate({ _id: id, tenantId }, { $set: patch }, { new: true });
    },
    async removeProduct(tenantId, id) {
      await ignoreCast(() => Product.deleteOne({ _id: id, tenantId }));
    },
    async listDeleted(tenantId) {
      return Product.find(deletedFilter(tenantId)).sort({ deletedAt: -1 }).limit(10000);
    },
    async markOrdersDeleted(tenantId, productId) {
      await Order.updateMany({ tenantId, productId }, { $set: { productDeleted: true } });
    },
    async markOrdersRestored(tenantId, productId) {
      await Order.updateMany({ tenantId, productId }, { $set: { productDeleted: false } });
    },
    async removeUnsentOrders(tenantId, productId) {
      await Order.deleteMany({ tenantId, productId, sent: false });
    },
    async releaseSentOrders(tenantId, productId) {
      await Order.updateMany({ tenantId, productId, sent: true }, { $set: { productDeleted: false } });
    },
    async expirePrintJobs(tenantId, productId, now) {
      if (!PrintJob) return;
      await PrintJob.updateMany(
        { tenantId, productId, status: { $in: ['pending', 'claimed'] } },
        { $set: { status: 'expired', finishedAt: now, error: 'Produkten är borttagen' } }
      );
    },
    async addLog(tenantId, msg, type, actor, fields) {
      if (addLog) await addLog(tenantId, msg, type, actor, fields);
    }
  };
}

module.exports = {
  RETENTION_MS,
  PURGE_INTERVAL_MS,
  BULK_LIMIT,
  ACTIVITY,
  ERRORS,
  activeFilter,
  deletedFilter,
  visibleOrderFilter,
  isDeleted,
  barcodeOf,
  tombstoneCode,
  actorSnapshot,
  logFields,
  tenantDeletedLog,
  activeProducts,
  visibleProducts,
  findScannable,
  lowStockProducts,
  visibleOrders,
  claimablePrintJobs,
  dueForPurge,
  presentTrashItem,
  duplicateKey,
  softDelete,
  softDeleteMany,
  restore,
  permanentDelete,
  purgeExpired,
  listTrash,
  createTrashRouter,
  createMemoryStore,
  createMongooseStore
};

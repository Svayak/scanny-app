const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
const { adminOnly } = require('../auth');
const trash = require('../product-trash');
const search = require('../public/js/product-search');

const root = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const actor = { _id: 'admin-1', id: 'admin-1', name: 'Nils' };
const day = 24 * 60 * 60 * 1000;

function product(overrides) {
  return {
    qty: 2,
    min: 5,
    critical: 1,
    articleNo: 'A-1',
    supplier: 'Würth',
    ...overrides
  };
}

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function appFor(store) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.headers['x-role'] || 'staff';
    req.user = { role, userId: 'admin-1', name: 'Nils' };
    req.tenantId = req.headers['x-tenant'] || 'A';
    req.actor = { _id: 'admin-1', name: 'Nils' };
    next();
  });
  app.use('/api/products', trash.createTrashRouter({
    store,
    authMiddleware: (req, res, next) => next(),
    adminOnly,
    getActor: async req => req.actor,
    onError: (res, err) => res.status(500).json({ error: err.message })
  }));
  return app;
}

describe('papperskorg', () => {
  const when = new Date('2026-03-01T12:00:00.000Z');

  function seeded() {
    return trash.createMemoryStore({
      products: [
        product({ _id: 'a1', tenantId: 'A', name: 'Borr', code: '111', articleNo: 'A-1', qty: 1, min: 5 }),
        product({ _id: 'a2', tenantId: 'A', name: 'Tejp', code: '222', articleNo: 'A-2', qty: 4, min: 2 }),
        product({ _id: 'b1', tenantId: 'B', name: 'Borr', code: '111', articleNo: 'B-1', qty: 3, min: 1 })
      ],
      orders: [
        { _id: 'o1', tenantId: 'A', productId: 'a1', name: 'Borr', sent: false },
        { _id: 'o2', tenantId: 'A', productId: 'a1', name: 'Borr', sent: true },
        { _id: 'o3', tenantId: 'B', productId: 'b1', name: 'Borr', sent: false }
      ],
      jobs: [
        { _id: 'j1', tenantId: 'A', productId: 'a1', status: 'pending' },
        { _id: 'j2', tenantId: 'A', productId: 'a2', status: 'pending' }
      ]
    });
  }

  it('admin delete becomes a soft delete with actor, barcode and product fields', async () => {
    const store = seeded();
    const result = await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    assert.equal(result.ok, true);
    const saved = store.products.find(item => item._id === 'a1');
    assert.equal(trash.isDeleted(saved), true);
    assert.equal(saved.archivedCode, '111');
    assert.equal(saved.code, '~deleted:a1');
    assert.equal(saved.deletedAt.toISOString(), when.toISOString());
    assert.equal(saved.deletedBy.userId, 'admin-1');
    assert.equal(saved.deletedBy.name, 'Nils');
    const log = store.logs.find(entry => entry.activityType === 'product_deleted');
    assert.equal(log.msg, 'Produkt borttagen: Borr');
    assert.equal(log.userId, 'admin-1');
    assert.equal(log.actorName, 'Nils');
    assert.equal(log.productId, 'a1');
    assert.equal(log.articleNo, 'A-1');
    assert.equal(log.productName, 'Borr');
    assert.equal(log.code, '111');
  });

  it('hides a deleted product from lists, search, scanning, orders, low stock, print queue and export', async () => {
    const store = seeded();
    await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    assert.deepEqual(trash.visibleProducts(store.products, 'A', '', search.productMatches).map(item => item._id), ['a2']);
    assert.deepEqual(trash.visibleProducts(store.products, 'A', 'borr', search.productMatches).map(item => item._id), []);
    assert.equal(trash.findScannable(store.products, 'A', '111'), null);
    assert.equal(trash.findScannable(store.products, 'A', '222')._id, 'a2');
    assert.deepEqual(trash.lowStockProducts(store.products, 'A').map(item => item._id), []);
    assert.deepEqual(trash.visibleOrders(store.orders, 'A', { sent: false }).map(item => item._id), []);
    assert.deepEqual(trash.visibleOrders(store.orders, 'A').map(item => item._id), []);
    assert.equal(store.jobs.find(job => job._id === 'j1').status, 'expired');
    assert.deepEqual(trash.claimablePrintJobs(store.jobs, store.products).map(job => job._id), ['j2']);
    assert.deepEqual(trash.activeProducts(store.products, 'A').map(item => item._id), ['a2']);
    const listed = await trash.listTrash(store, 'A');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].deletedByName, 'Nils');
    assert.equal(listed[0].code, '111');
    assert.equal(listed[0].deletedAt, when.toISOString());
  });

  it('restores a product and its orders', async () => {
    const store = seeded();
    await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    const result = await trash.restore(store, { tenantId: 'A', id: 'a1', actor, now: when });
    assert.equal(result.ok, true);
    const saved = store.products.find(item => item._id === 'a1');
    assert.equal(trash.isDeleted(saved), false);
    assert.equal(saved.code, '111');
    assert.equal(saved.archivedCode, '');
    assert.equal(trash.findScannable(store.products, 'A', '111').name, 'Borr');
    assert.equal(store.orders.find(order => order._id === 'o1').productDeleted, false);
    const log = store.logs.find(entry => entry.activityType === 'product_restored');
    assert.equal(log.userId, 'admin-1');
    assert.equal(log.actorName, 'Nils');
    assert.equal(log.productId, 'a1');
    assert.equal(log.code, '111');
    assert.equal(log.productName, 'Borr');
  });

  it('refuses to restore a barcode that has been reused', async () => {
    const store = seeded();
    await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    await store.insertProduct(product({ _id: 'a3', tenantId: 'A', name: 'Ny borr', code: '111', articleNo: 'A-3' }));
    assert.equal(trash.findScannable(store.products, 'A', '111')._id, 'a3');
    const blocked = await trash.restore(store, { tenantId: 'A', id: 'a1', actor, now: when });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.match(blocked.error, /Streckkoden används redan/);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'a1')), true);
    assert.equal(trash.findScannable(store.products, 'A', '111')._id, 'a3');

    const raced = trash.createMemoryStore({
      products: [product({ _id: 'p1', tenantId: 'A', name: 'Borr', code: '~deleted:p1', archivedCode: '111', deletedAt: when, deletedBy: { userId: 'admin-1', name: 'Nils' } })]
    });
    raced.findActiveByCode = async () => null;
    raced.updateProduct = async () => {
      const err = new Error('duplicate key');
      err.code = 11000;
      throw err;
    };
    const fromIndex = await trash.restore(raced, { tenantId: 'A', id: 'p1', actor, now: when });
    assert.equal(fromIndex.status, 409);
    assert.match(fromIndex.error, /Streckkoden används redan/);
    assert.equal(trash.isDeleted(raced.products[0]), true);
    assert.equal(raced.products[0].code, '~deleted:p1');
  });

  it('permanently deletes from the trash and keeps the audit entry', async () => {
    const store = seeded();
    await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    const result = await trash.permanentDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    assert.equal(result.ok, true);
    assert.equal(store.products.find(item => item._id === 'a1'), undefined);
    assert.equal(store.orders.find(order => order._id === 'o1'), undefined);
    assert.equal(store.orders.find(order => order._id === 'o2').productDeleted, false);
    const log = store.logs.find(entry => entry.activityType === 'product_permanently_deleted');
    assert.equal(log.msg, 'Produkt raderad permanent: Borr');
    assert.equal(log.userId, 'admin-1');
    assert.equal(log.actorName, 'Nils');
    assert.equal(log.productId, 'a1');
    assert.equal(log.articleNo, 'A-1');
    assert.equal(log.productName, 'Borr');
    assert.equal(log.code, '111');
  });

  it('purges only products older than 30 days on a fake clock', async () => {
    const store = seeded();
    await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    await trash.softDelete(store, { tenantId: 'B', id: 'b1', actor, now: new Date(when.getTime() + day) });
    const early = await trash.purgeExpired(store, { now: new Date(when.getTime() + trash.RETENTION_MS - 1) });
    assert.deepEqual(early, []);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'a1')), true);
    const removed = await trash.purgeExpired(store, { now: new Date(when.getTime() + trash.RETENTION_MS) });
    assert.deepEqual(removed, ['a1']);
    assert.equal(store.products.find(item => item._id === 'a1'), undefined);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'b1')), true);
    const log = store.logs.find(entry => entry.activityType === 'product_permanently_deleted' && entry.productId === 'a1');
    assert.equal(log.actorName, 'System');
    assert.equal(log.userId, undefined);
    assert.match(log.msg, /30 dagar/);
    assert.equal(log.code, '111');
  });

  it('keeps tenants apart for trash, restore, scan and barcode reuse', async () => {
    const store = seeded();
    await trash.softDelete(store, { tenantId: 'A', id: 'a1', actor, now: when });
    assert.equal((await trash.listTrash(store, 'B')).length, 0);
    assert.equal((await trash.restore(store, { tenantId: 'B', id: 'a1', actor, now: when })).status, 404);
    assert.equal((await trash.permanentDelete(store, { tenantId: 'B', id: 'a1', actor, now: when })).status, 404);
    assert.equal(trash.findScannable(store.products, 'B', '111')._id, 'b1');
    assert.equal(trash.findScannable(store.products, 'A', '111'), null);
    assert.equal(trash.visibleOrders(store.orders, 'B', { sent: false }).length, 1);
    await store.insertProduct(product({ _id: 'a3', tenantId: 'A', name: 'Ny', code: '111' }));
    await store.insertProduct(product({ _id: 'b2', tenantId: 'B', name: 'Annan', code: '333' }));
    assert.equal(trash.findScannable(store.products, 'A', '111')._id, 'a3');
    assert.equal(trash.findScannable(store.products, 'B', '111')._id, 'b1');
  });

  it('builds a Cosmos-safe active filter and does not use TTL or a partial index', () => {
    const alive = trash.activeFilter('A');
    assert.equal(alive.tenantId, 'A');
    assert.equal(alive.$or.some(clause => clause.deletedAt === null), true);
    assert.equal(alive.$or.some(clause => clause.deletedAt && clause.deletedAt.$exists === false), true);
    const withCode = trash.activeFilter('A', { code: '111' });
    assert.equal(withCode.$and[1].code, '111');
    assert.equal(withCode.$and[0].$or.some(clause => clause.deletedAt === null), true);
    const orders = trash.visibleOrderFilter('A', { sent: false });
    assert.equal(orders.$and[0].$or.some(clause => clause.productDeleted && clause.productDeleted.$exists === false), true);
    assert.deepEqual(orders.$and[1], { sent: false });
    const models = read('models.js');
    assert.match(models, /tenantId: 1, code: 1 \}, \{ unique: true \}/);
    assert.match(models, /archivedCode/);
    assert.equal(models.includes('expireAfterSeconds'), false);
    assert.equal(models.includes('partialFilterExpression'), false);
    const tenantLog = trash.tenantDeletedLog({ name: 'Verkstad AB' });
    assert.equal(tenantLog.activityType, 'tenant_deleted');
    assert.equal(tenantLog.msg, 'Kund borttagen: Verkstad AB');
    assert.equal(tenantLog.actorName, 'superadmin');
  });
});

describe('papperskorg över HTTP', { concurrency: 1 }, () => {
  let server;
  let store;

  before(async () => {
    store = trash.createMemoryStore({
      products: [
        product({ _id: 'a1', tenantId: 'A', name: 'Borr', code: '111', articleNo: 'A-1' }),
        product({ _id: 'b1', tenantId: 'B', name: 'Mutter', code: '999', articleNo: 'B-9' })
      ]
    });
    server = await listen(appFor(store));
  });

  after(() => new Promise(resolve => server.close(resolve)));

  function headers(role, tenant = 'A') {
    return { 'x-role': role, 'x-tenant': tenant };
  }

  it('gives non-admins 403 on delete, bulk delete, restore, permanent delete and the trash list', async () => {
    const port = server.address().port;
    for (const role of ['staff', 'kiosk']) {
      const del = await request(port, 'DELETE', '/api/products/a1', { headers: headers(role) });
      assert.equal(del.status, 403, role);
      assert.match(del.json.error, /admin/);
      const bulk = await request(port, 'POST', '/api/products/bulk-delete', {
        headers: headers(role),
        body: { ids: ['a1'] }
      });
      assert.equal(bulk.status, 403, role);
      const restore = await request(port, 'POST', '/api/products/a1/restore', { headers: headers(role) });
      assert.equal(restore.status, 403, role);
      const wipe = await request(port, 'DELETE', '/api/products/a1/permanent', { headers: headers(role) });
      assert.equal(wipe.status, 403, role);
      const list = await request(port, 'GET', '/api/products/trash', { headers: headers(role) });
      assert.equal(list.status, 403, role);
    }
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'a1')), false);
    assert.equal(store.logs.length, 0);
  });

  it('lets an admin soft-delete, list, restore and permanently delete inside the tenant', async () => {
    const port = server.address().port;
    const foreign = await request(port, 'DELETE', '/api/products/b1', { headers: headers('admin', 'A') });
    assert.equal(foreign.status, 404);
    const deleted = await request(port, 'DELETE', '/api/products/a1', { headers: headers('admin') });
    assert.equal(deleted.status, 200);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'a1')), true);
    const log = store.logs.find(entry => entry.activityType === 'product_deleted');
    assert.equal(log.userId, 'admin-1');
    assert.equal(log.actorName, 'Nils');
    assert.equal(log.code, '111');
    const otherView = await request(port, 'GET', '/api/products/trash', { headers: headers('admin', 'B') });
    assert.equal(otherView.status, 200);
    assert.deepEqual(otherView.json, []);
    const mine = await request(port, 'GET', '/api/products/trash', { headers: headers('admin') });
    assert.equal(mine.json.length, 1);
    assert.equal(mine.json[0].name, 'Borr');
    assert.equal(mine.json[0].deletedByName, 'Nils');
    assert.equal(mine.json[0].code, '111');
    const restored = await request(port, 'POST', '/api/products/a1/restore', { headers: headers('admin') });
    assert.equal(restored.status, 200);
    assert.equal(store.products.find(item => item._id === 'a1').code, '111');
    await request(port, 'DELETE', '/api/products/a1', { headers: headers('admin') });
    const gone = await request(port, 'DELETE', '/api/products/a1/permanent', { headers: headers('admin') });
    assert.equal(gone.status, 200);
    assert.equal(store.products.find(item => item._id === 'a1'), undefined);
    assert.ok(store.logs.some(entry => entry.activityType === 'product_permanently_deleted' && entry.userId === 'admin-1'));
  });

  it('bulk delete is admin only and soft-deletes each id in the tenant', async () => {
    store.products.push(product({ _id: 'a4', tenantId: 'A', name: 'List', code: '444', articleNo: 'A-4' }));
    store.products.push(product({ _id: 'a5', tenantId: 'A', name: 'Skruv', code: '555', articleNo: 'A-5' }));
    const port = server.address().port;
    const denied = await request(port, 'POST', '/api/products/bulk-delete', {
      headers: headers('staff'),
      body: { ids: ['a4', 'a5'] }
    });
    assert.equal(denied.status, 403);
    const ok = await request(port, 'POST', '/api/products/bulk-delete', {
      headers: headers('admin'),
      body: { ids: ['a4', 'a5', 'b1'] }
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.deleted, ['a4', 'a5']);
    assert.deepEqual(ok.json.missing, ['b1']);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'a4')), true);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'a5')), true);
    assert.equal(trash.isDeleted(store.products.find(item => item._id === 'b1')), false);
    const logs = store.logs.filter(entry => entry.activityType === 'product_deleted' && (entry.productId === 'a4' || entry.productId === 'a5'));
    assert.equal(logs.length, 2);
  });
});

describe('papperskorg i servern och gränssnittet', () => {
  const server = read('server.js');
  const js = read('public/js/app.js');
  const html = read('public/admin.html');
  const kiosk = read('public/kiosk.html');

  it('wires admin routes, active queries, tenant hard-delete log and the daily purge', () => {
    assert.match(server, /createTrashRouter\(\{[\s\S]*authMiddleware,[\s\S]*adminOnly,/);
    assert.equal(server.includes('Product.findOneAndDelete'), false);
    assert.match(server, /activeFilter\(req\.tenantId, mongoProductFilter\(req\.query\.q\)\)/);
    assert.match(server, /activeFilter\(req\.tenantId, \{ code: trimmed \}\)/);
    assert.match(server, /activeFilter\(req\.tenantId, \{ code: code\?\.trim\(\) \}\)/);
    assert.match(server, /visibleOrderFilter\(req\.tenantId, \{ sent: false \}\)/);
    assert.match(server, /Product\.find\(productTrash\.activeFilter\(req\.tenantId\)\)/);
    assert.match(server, /countDocuments\(productTrash\.activeFilter\(t\._id\)\)/);
    assert.match(server, /Product\.deleteMany\(\{ tenantId: tenant\._id \}\)/);
    assert.match(server, /tenantDeletedLog\(tenant\)/);
    assert.match(server, /activityType: audit\.activityType/);
    assert.match(server, /async function runProductPurge\(/);
    assert.match(server, /setInterval\(runProductPurge, productTrash\.PURGE_INTERVAL_MS\)/);
    assert.equal(server.includes('expireAfterSeconds'), false);
  });

  it('hides delete from non-admins and shows the trash actions only for admins', () => {
    const button = js.slice(js.indexOf('function productDeleteButton'), js.indexOf('async function loadTrashQuiet'));
    assert.match(button, /currentRole\(\) !== 'admin'/);
    assert.match(button, /Ta bort/);
    const lager = js.slice(js.indexOf('function renderLager'), js.indexOf('function editQtyInline'));
    assert.match(lager, /productDeleteButton\(p\)/);
    assert.equal(lager.includes('>Ta bort<'), false);
    assert.match(js, /Flytta "[\s\S]*papperskorgen/);
    assert.match(js, /Återställ "/);
    assert.match(js, /Radera "/);
    assert.match(js, /Detta går inte att ångra/);
    assert.match(js, /\/api\/products\/' \+ id \+ '\/restore'/);
    assert.match(js, /\/api\/products\/' \+ id \+ '\/permanent'/);
    assert.match(html, /id="tab-trash"/);
    assert.match(html, /id="trash-tile" hidden/);
    assert.match(html, /id="trash-body"/);
    assert.match(html, /Papperskorg/);
    assert.match(html, /Borttagen av/);
    assert.match(js, /function renderTrash\(/);
    assert.match(js, /Återställ<\/button>/);
    assert.match(js, /Radera permanent<\/button>/);
    assert.equal(kiosk.includes('deleteProduct'), false);
    assert.equal(kiosk.includes('Radera permanent'), false);
    assert.equal(kiosk.includes('>Ta bort<'), false);
  });
});

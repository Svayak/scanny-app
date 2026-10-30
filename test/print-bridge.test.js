const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { applySettingsPatch, publicSettings } = require('../mail');
const redact = require('../redact');
const {
  hashBridgeKey,
  timingSafeEqualHex,
  publicPrintBridge,
  createPrintService,
  createBridgeRouter,
  createUserRouter,
  createMemoryStore,
  respondPrintError,
  JOB_TTL_MS,
  HEARTBEAT_FRESH_MS
} = require('../print-api');

const root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

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
        resolve({ status: res.statusCode, text, json });
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

function harness() {
  const store = createMemoryStore();
  const warnings = [];
  let clock = new Date('2026-10-30T12:00:00Z');
  const service = createPrintService(store, {
    now: () => clock,
    warn: message => warnings.push(message)
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = req.headers['x-tenant'] || '';
    next();
  });
  app.get('/api/print/status', async (req, res) => {
    try { res.json(await service.statusFor(req.tenantId)); }
    catch (err) { if (!respondPrintError(res, err)) res.status(500).json({ error: 'Internt serverfel' }); }
  });
  app.use('/api/print/v1', createBridgeRouter(service));
  app.use('/api/print', (req, res, next) => {
    if ((req.headers['x-role'] || 'admin') !== 'admin') {
      return res.status(403).json({ error: 'Kräver admin-behörighet' });
    }
    next();
  }, createUserRouter(service));
  return {
    store,
    service,
    app,
    warnings,
    at(date) { clock = date; },
    advance(ms) { clock = new Date(clock.getTime() + ms); }
  };
}

async function issueReadyBridge(h, server, tenantId) {
  h.store.tenants.push({ _id: tenantId, status: 'active', settings: {} });
  const created = await request(server.address().port, 'POST', '/api/print/key', { headers: { 'x-tenant': tenantId } });
  assert.equal(created.status, 200);
  const enabled = await request(server.address().port, 'PUT', '/api/print/settings', {
    headers: { 'x-tenant': tenantId },
    body: { enabled: true }
  });
  assert.equal(enabled.status, 200);
  const beat = await request(server.address().port, 'POST', '/api/print/v1/heartbeat', {
    headers: { 'x-bridge-key': created.json.key },
    body: { printerStatus: 'ok', printerName: 'Brother QL-810Wc' }
  });
  assert.equal(beat.status, 200);
  return created.json.key;
}

describe('print bridge API', { concurrency: 1 }, () => {
  let h;
  let server;

  before(async () => {
    h = harness();
    server = await listen(h.app);
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  it('rejects a bad key with 401 and never echoes or logs it', async () => {
    const key = 'scb_' + 'S'.repeat(40);
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.map(String).join(' '));
    try {
      const missing = await request(server.address().port, 'POST', '/api/print/v1/poll', {});
      const wrong = await request(server.address().port, 'POST', '/api/print/v1/poll', {
        headers: { 'x-bridge-key': key }
      });
      const queried = await request(server.address().port, 'POST', '/api/print/v1/poll?key=' + encodeURIComponent(key), {
        headers: { 'x-bridge-key': key }
      });
      assert.equal(missing.status, 401);
      assert.equal(wrong.status, 401);
      assert.equal(queried.status, 401);
      assert.equal(wrong.json.error, 'Ogiltig bryggnyckel');
      assert.equal(wrong.text.includes(key), false);
      assert.equal(queried.text.includes(key), false);
      assert.equal(lines.join('\n').includes(key), false);
    } finally {
      console.error = original;
    }
  });

  it('isolates tenants and only accepts the hashed key', async () => {
    const port = server.address().port;
    const keyA = await issueReadyBridge(h, server, 'tenant-a');
    const keyB = await issueReadyBridge(h, server, 'tenant-b');
    assert.notEqual(keyA, keyB);

    const tenantA = h.store.tenants.find(t => t._id === 'tenant-a');
    assert.equal(tenantA.settings.printBridge.keyHash, hashBridgeKey(keyA));
    assert.equal(JSON.stringify(tenantA).includes(keyA), false);

    await h.service.enqueue('tenant-a', { name: 'Borr', code: '111', articleNo: 'A-1' }, 'inleverans');
    await h.service.enqueue('tenant-b', { name: 'Mutter', code: '222', articleNo: 'B-2' }, 'manual');

    const pollA = await request(port, 'POST', '/api/print/v1/poll', { headers: { 'x-bridge-key': keyA } });
    assert.equal(pollA.status, 200);
    assert.equal(pollA.json.jobs.length, 1);
    assert.equal(pollA.json.jobs[0].product.name, 'Borr');
    assert.equal(pollA.json.jobs[0].label, '62x29');
    assert.equal(pollA.text.includes('Mutter'), false);
    assert.equal(pollA.text.includes(keyA), false);

    const stolen = await request(port, 'POST', '/api/print/v1/ack', {
      headers: { 'x-bridge-key': keyB },
      body: { id: pollA.json.jobs[0].id, status: 'printed' }
    });
    assert.equal(stolen.status, 409);

    const acked = await request(port, 'POST', '/api/print/v1/ack', {
      headers: { 'x-bridge-key': keyA },
      body: { id: pollA.json.jobs[0].id, status: 'printed' }
    });
    assert.equal(acked.status, 200);
    const job = h.store.jobs.find(j => j._id === pollA.json.jobs[0].id);
    assert.equal(job.status, 'printed');

    const status = await request(port, 'GET', '/api/print/status', { headers: { 'x-tenant': 'tenant-a' } });
    assert.equal(status.status, 200);
    assert.equal(status.json.configured, true);
    assert.equal(status.json.online, true);
    assert.equal(status.text.includes(keyA), false);
    assert.equal(status.text.includes(hashBridgeKey(keyA)), false);
    assert.equal(status.json.keyHash, undefined);
  });

  it('stops accepting a key when it is rotated or revoked', async () => {
    const port = server.address().port;
    const first = await issueReadyBridge(h, server, 'tenant-c');
    const rotated = await request(port, 'POST', '/api/print/key', { headers: { 'x-tenant': 'tenant-c' } });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.json.key, first);
    await request(port, 'PUT', '/api/print/settings', {
      headers: { 'x-tenant': 'tenant-c' },
      body: { enabled: true }
    });
    const oldKey = await request(port, 'POST', '/api/print/v1/poll', { headers: { 'x-bridge-key': first } });
    assert.equal(oldKey.status, 401);
    const beat = await request(port, 'POST', '/api/print/v1/heartbeat', {
      headers: { 'x-bridge-key': rotated.json.key },
      body: { printerStatus: 'ok' }
    });
    assert.equal(beat.status, 200);
    const revoked = await request(port, 'DELETE', '/api/print/key', { headers: { 'x-tenant': 'tenant-c' } });
    assert.equal(revoked.status, 200);
    const after = await request(port, 'POST', '/api/print/v1/poll', { headers: { 'x-bridge-key': rotated.json.key } });
    assert.equal(after.status, 401);
  });

  it('returns no jobs when the master switch is off, even with a valid key', async () => {
    const port = server.address().port;
    h.store.tenants.push({ _id: 'tenant-d', status: 'active', settings: {} });
    const created = await request(port, 'POST', '/api/print/key', { headers: { 'x-tenant': 'tenant-d' } });
    assert.equal(created.status, 200);
    const tenant = h.store.tenants.find(t => t._id === 'tenant-d');
    assert.equal(!!tenant.settings.printBridge.enabled, false);
    const status = await request(port, 'GET', '/api/print/status', { headers: { 'x-tenant': 'tenant-d' } });
    assert.equal(status.json.enabled, false);
    h.store.jobs.push({
      _id: 'd'.repeat(24),
      tenantId: 'tenant-d',
      status: 'pending',
      name: 'Ska inte skrivas',
      code: '444',
      articleNo: '',
      source: 'inleverans',
      createdAt: new Date('2026-10-30T12:00:00Z')
    });
    const poll = await request(port, 'POST', '/api/print/v1/poll', {
      headers: { 'x-bridge-key': created.json.key }
    });
    assert.equal(poll.status, 200);
    assert.deepEqual(poll.json.jobs, []);
    assert.equal(h.store.jobs.find(j => j._id === 'd'.repeat(24)).status, 'pending');
    const queued = await h.service.enqueue('tenant-d', { name: 'Inleverans', code: '445' }, 'inleverans');
    assert.deepEqual(queued, { queued: false, reason: 'inactive' });
    await assert.rejects(
      () => h.service.queueProduct('tenant-d', { name: 'Knapp', code: '446' }),
      err => err.status === 409
    );
    assert.equal(h.store.jobs.some(j => j.code === '445' || j.code === '446'), false);
  });

  it('compares key hashes in constant time and ignores length mismatches', () => {
    const hashed = hashBridgeKey('scb_example');
    assert.equal(timingSafeEqualHex(hashed, hashed), true);
    assert.equal(timingSafeEqualHex(hashed, hashBridgeKey('scb_other')), false);
    assert.equal(timingSafeEqualHex(hashed, 'short'), false);
  });
});

describe('print safeguards', { concurrency: 1 }, () => {
  it('does not enqueue when the tenant has no active bridge', async () => {
    const h = harness();
    h.store.tenants.push({ _id: 'plain', status: 'active', settings: { workshop: 'Limo' } });
    const result = await h.service.enqueue('plain', { name: 'Bricka', code: '999' }, 'inleverans');
    assert.deepEqual(result, { queued: false, reason: 'inactive' });
    assert.equal(h.store.jobs.length, 0);
    assert.deepEqual(h.warnings, []);
  });

  it('keeps goods receipt successful when enqueue throws', async () => {
    const h = harness();
    const hash = hashBridgeKey('scb_secretvalue');
    h.store.tenants.push({
      _id: 'boom',
      status: 'active',
      settings: { printBridge: { enabled: true, keyHash: hash, lastHeartbeatAt: new Date('2026-10-30T12:00:00Z') } }
    });
    h.store.createJob = async () => { throw new Error('databas nere ' + hash); };
    const result = await h.service.enqueue('boom', { name: 'Bricka', code: '999' }, 'inleverans');
    assert.equal(result.queued, false);
    assert.equal(result.reason, 'error');
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0].includes(hash), false);
    assert.match(h.warnings[0], /Kunde inte köa etikett/);
  });

  it('enqueues from goods receipt and the button when the switch is on and a key exists', async () => {
    const h = harness();
    h.store.tenants.push({
      _id: 'quiet',
      status: 'active',
      settings: { printBridge: { enabled: true, keyHash: hashBridgeKey('scb_offlinekey') } }
    });
    const receipt = await h.service.enqueue('quiet', { name: 'A', code: '1' }, 'inleverans');
    const manual = await h.service.queueProduct('quiet', { name: 'A', code: '1' });
    assert.equal(receipt.queued, true);
    assert.equal(manual.ok, true);
    assert.equal(h.store.jobs.length, 2);
    assert.deepEqual(h.warnings, []);
  });

  it('keeps the master switch off by default, rejects på without a key, and only lets an admin change it', async () => {
    const h = harness();
    const server = await listen(h.app);
    try {
      const port = server.address().port;
      h.store.tenants.push({ _id: 'switch', status: 'active', settings: {} });
      const blocked = await request(port, 'PUT', '/api/print/settings', {
        headers: { 'x-tenant': 'switch' },
        body: { enabled: true }
      });
      assert.equal(blocked.status, 400);
      assert.match(blocked.json.error, /Skapa en bryggnyckel innan du slår på automatisk etikettutskrift/);
      assert.equal(!!h.store.tenants[0].settings.printBridge?.enabled, false);

      const staff = await request(port, 'PUT', '/api/print/settings', {
        headers: { 'x-tenant': 'switch', 'x-role': 'staff' },
        body: { enabled: true }
      });
      assert.equal(staff.status, 403);
      assert.equal(staff.json.error, 'Kräver admin-behörighet');

      const key = await request(port, 'POST', '/api/print/key', { headers: { 'x-tenant': 'switch' } });
      assert.equal(key.status, 200);
      const on = await request(port, 'PUT', '/api/print/settings', {
        headers: { 'x-tenant': 'switch' },
        body: { enabled: true }
      });
      assert.equal(on.status, 200);
      assert.equal(on.json.enabled, true);
      const saved = await request(port, 'GET', '/api/print/status', { headers: { 'x-tenant': 'switch' } });
      assert.equal(saved.json.enabled, true);
      assert.equal(h.store.tenants[0].settings.printBridge.enabled, true);

      const off = await request(port, 'PUT', '/api/print/settings', {
        headers: { 'x-tenant': 'switch' },
        body: { enabled: false }
      });
      assert.equal(off.status, 200);
      assert.equal(off.json.enabled, false);
      const again = await request(port, 'GET', '/api/print/status', { headers: { 'x-tenant': 'switch' } });
      assert.equal(again.json.enabled, false);
    } finally {
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });

  it('expires pending jobs older than 24 hours and does not hand them out', async () => {
    const h = harness();
    const key = 'ignored';
    h.store.tenants.push({
      _id: 'old',
      status: 'active',
      settings: {
        printBridge: {
          enabled: true,
          keyHash: hashBridgeKey(key),
          lastHeartbeatAt: new Date('2026-10-30T12:00:00Z')
        }
      }
    });
    h.store.jobs.push({
      _id: 'a'.repeat(24),
      tenantId: 'old',
      status: 'pending',
      name: 'Gammal',
      code: '111',
      articleNo: '',
      source: 'inleverans',
      createdAt: new Date(Date.parse('2026-10-30T12:00:00Z') - JOB_TTL_MS - 1000)
    });
    h.store.jobs.push({
      _id: 'b'.repeat(24),
      tenantId: 'old',
      status: 'claimed',
      name: 'Fastnad',
      code: '222',
      articleNo: '',
      source: 'manual',
      createdAt: new Date(Date.parse('2026-10-30T12:00:00Z') - JOB_TTL_MS - 1000),
      claimedAt: new Date('2026-10-30T11:00:00Z')
    });
    const fresh = await h.service.enqueue('old', { name: 'Ny', code: '333', articleNo: 'N' }, 'inleverans');
    assert.equal(fresh.queued, true);
    const polled = await h.service.poll(h.store.tenants[0]);
    assert.equal(polled.jobs.length, 1);
    assert.equal(polled.jobs[0].product.name, 'Ny');
    assert.equal(h.store.jobs.find(j => j.name === 'Gammal').status, 'expired');
    assert.equal(h.store.jobs.find(j => j.name === 'Fastnad').status, 'expired');
    await assert.rejects(
      () => h.service.ack(h.store.tenants[0], { id: 'a'.repeat(24), status: 'printed' }),
      err => err.status === 409
    );
  });

  it('rejects ack of an expired job', async () => {
    const h = harness();
    h.store.tenants.push({ _id: 'old', status: 'active', settings: { printBridge: { enabled: true, keyHash: 'x' } } });
    h.store.jobs.push({
      _id: 'c'.repeat(24),
      tenantId: 'old',
      status: 'expired',
      createdAt: new Date(Date.parse('2026-10-29T00:00:00Z'))
    });
    await assert.rejects(
      () => h.service.ack(h.store.tenants[0], { id: 'c'.repeat(24), status: 'printed' }),
      err => err.status === 409
    );
  });

  it('logs a printer alarm when status changes and not on every heartbeat', async () => {
    const h = harness();
    h.store.tenants.push({
      _id: 'alarm',
      status: 'active',
      settings: { printBridge: { enabled: true, keyHash: hashBridgeKey('scb_alarmkeyvalue') } }
    });
    const tenant = h.store.tenants[0];
    await h.service.heartbeat(tenant, { printerStatus: 'paper_out', detail: 'slut på rulle', printerName: 'Brother QL-810Wc' });
    await h.service.heartbeat(tenant, { printerStatus: 'paper_out', detail: 'slut på rulle', printerName: 'Brother QL-810Wc' });
    await h.service.heartbeat(tenant, { printerStatus: 'ok', printerName: 'Brother QL-810Wc' });
    assert.equal(h.store.logs.length, 2);
    assert.match(h.store.logs[0].msg, /Skrivarlarm: paper_out/);
    assert.equal(h.store.logs[0].type, 'warn');
    assert.equal(h.store.logs[1].msg, 'Skrivaren är online igen');
    assert.equal(JSON.stringify(h.store.logs).includes('scb_alarmkeyvalue'), false);
    assert.equal(publicPrintBridge(tenant.settings.printBridge, new Date('2026-10-30T12:00:00Z')).online, true);
    assert.equal(HEARTBEAT_FRESH_MS, 90 * 1000);
  });

  it('hides the bridge key from public settings and ignores it on the normal settings save', () => {
    const key = 'scb_' + 'k'.repeat(40);
    const hash = hashBridgeKey(key);
    const pub = publicSettings({
      workshop: 'Verkstan',
      smtpPass: 'stored-smtp-password',
      printBridge: { enabled: true, keyHash: hash, keyPrefix: 'scb_kkkk', bridgeKey: key }
    });
    const json = JSON.stringify(pub);
    assert.equal(json.includes(key), false);
    assert.equal(json.includes(hash), false);
    assert.equal(pub.printBridge.configured, true);
    assert.equal(pub.printBridge.enabled, true);
    assert.equal(pub.printBridge.keyPrefix, 'scb_kkkk');
    assert.equal(pub.printBridge.keyHash, undefined);
    assert.equal(pub.smtpPass, undefined);
    assert.equal(redact.isSensitiveKey('keyHash'), true);
    assert.equal(redact.isSensitiveKey('bridgeKeyHash'), true);

    const patch = applySettingsPatch({
      workshop: 'Verkstan',
      printBridge: { enabled: true, keyHash: hash },
      bridgeKey: key,
      labelSize: '62x29'
    });
    assert.equal(patch.printBridge, undefined);
    assert.equal(patch.bridgeKey, undefined);
    assert.equal(patch.labelSize, '62x29');
    assert.equal(patch.workshop, 'Verkstan');
  });
});

describe('manual printing stays unchanged', () => {
  const labelBlock = `<!-- Utskriftsyta för etiketter (skrivs ut via webbläsaren till Brother QL-810W) -->
<div id="print-label" aria-hidden="true">
  <div class="pl-name"></div>
  <div class="pl-art"></div>
  <svg class="pl-bc"></svg>
</div>
<style>
  #print-label{position:fixed;left:-99999px;top:0;width:90mm;text-align:center;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
  #print-label .pl-name{font-size:10pt;font-weight:700;line-height:1.05;margin-top:1mm}
  #print-label .pl-art{font-size:7pt;color:#000;margin:0.4mm 0}
  #print-label .pl-bc{width:95%;height:13mm}
  /* DK-11209 (62×29): keep the name inside the die-cut. Other sizes stay on the rules above. */
  #print-label.dk11209{box-sizing:border-box;width:62mm;height:29mm;padding:2mm 3mm;display:flex;flex-direction:column;justify-content:center;align-items:center;overflow:hidden}
  #print-label.dk11209 .pl-name{font-size:9pt;line-height:1.15;margin:0;width:100%;min-width:0;align-self:stretch;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #print-label.dk11209 .pl-art{font-size:7pt;line-height:1.15;margin:0;width:100%;min-width:0;align-self:stretch;white-space:nowrap;overflow:hidden}
  #print-label.dk11209 .pl-bc{height:12mm;min-height:0;flex:0 0 12mm}
  @media print{
    body *{visibility:hidden !important}
    #print-label,#print-label *{visibility:visible !important}
    #print-label{left:0;top:0}
  }
</style>
<!-- Sätts dynamiskt i JS efter vald etikettstorlek -->
<style id="print-dims">@page{size:90mm 29mm;margin:0}</style>`;

  it('keeps the browser label markup and window.print path', () => {
    const html = read('public/admin.html');
    assert.equal(html.includes(labelBlock), true);
    assert.match(html, /Etiketter skrivs ut via webbläsaren/);
    const js = read('public/js/app.js');
    assert.match(js, /function printLabel\(id\) \{\n  const p = db\.products\.find\(x => x\.id === id\);\n  if \(!p\) return;\n  if \(renderLabel\(p\)\) setTimeout\(\(\) => window\.print\(\), 120\);\n\}/);
    const legacyButton = 'title="Skriv ut etikett">🏷 Etikett</button>';
    assert.equal(js.includes(legacyButton), true);
    const legacyAt = js.indexOf(legacyButton);
    assert.equal(js.slice(Math.max(0, legacyAt - 120), legacyAt).includes('printLabel'), true);
    assert.equal(js.slice(Math.max(0, legacyAt - 120), legacyAt).includes('bridgePrintReady'), false);
    assert.match(js, /function bridgePrintReady\(\) \{\n  const b = db\.settings && db\.settings\.printBridge;\n  return !!\(b && b\.enabled && b\.configured\);\n\}/);
    assert.match(js, /currentRole\(\) === 'admin'/);
    assert.match(js, /Skapa en bryggnyckel innan du slår på automatisk etikettutskrift/);
    assert.match(html, /<label for="pb-enabled">Automatisk etikettutskrift<\/label>/);
    assert.match(html, /<option value="off" selected>AV<\/option>/);
    assert.match(html, /<option value="on">PÅ<\/option>/);
    assert.match(html, /id="pb-key-hint"/);
    assert.match(js, /if \(!bridgePrintReady\(\)\) return '';/);
    assert.match(js, /Skriv ut etikett/);
    assert.equal(js.includes("mode === 'add' ? '/api/add' : '/api/scan'"), true);
    assert.equal(js.includes('queue-label'), true);
    const scanAt = js.indexOf("const endpoint = mode === 'add' ? '/api/add' : '/api/scan';");
    const scanTail = js.slice(scanAt, scanAt + 1800);
    assert.equal(scanTail.includes('queue-label'), false);
    assert.equal(scanTail.includes('queueLabel'), false);
  });

  it('keeps the existing label routes and leaves goods receipt response unchanged when printing is off', () => {
    const server = read('server.js');
    const preview = `app.get('/api/products/:id/label.png', authMiddleware, async (req, res) => {
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
});`;
    const browserPrint = `app.post('/api/products/:id/print-label', authMiddleware, async (req, res) => {
  try {
    if (!printLabel) return res.status(503).json({ error: 'Etikettutskrift är inte tillgänglig på denna server.' });
    const product = await Product.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!product) return res.status(404).json({ error: 'Produkt hittades inte' });
    const tenant = await Tenant.findById(req.tenantId);
    await printLabel(product, tenant?.settings || {});
    await addLog(req.tenantId, \`Etikett utskriven: \${product.name}\`);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: mail.safeErrorMessage(err) || 'Utskrift misslyckades' }); }
});`;
    assert.equal(server.includes(preview), true);
    assert.equal(server.includes(browserPrint), true);
    assert.equal(server.includes('err.message'), false);

    const add = server.slice(server.indexOf("app.post('/api/add'"), server.indexOf("app.get('/api/orders'"));
    assert.match(add, /res\.json\(\{ product: p \}\)/);
    assert.match(add, /enqueueForGoodsReceipt/);
    const enqueueAt = add.indexOf('enqueueForGoodsReceipt');
    const responseAt = add.indexOf('res.json({ product: p })');
    assert.ok(enqueueAt > 0 && enqueueAt < responseAt);
    assert.equal(add.slice(enqueueAt, responseAt).includes('res.status'), false);
    assert.match(add, /catch \(err\) \{\n\s+console\.warn\('\[print\] Kunde inte köa etikett vid inleverans:'/);

    const models = read('models.js');
    assert.match(models, /print_jobs/);
    assert.match(models, /tenantId: 1, status: 1, createdAt: 1/);
    assert.match(models, /'pending', 'claimed', 'printed', 'failed', 'expired'/);
    assert.ok(server.indexOf("app.use('/api/print/v1'") < server.indexOf("app.use('/api/print', authMiddleware, adminOnly"));
  });

  it('documents Windows queue printing and does not tell anyone to replace the Brother driver', () => {
    const readme = read('print_bridge/README.md');
    assert.equal(readme.includes('Zadig'), false);
    assert.match(readme, /Aktivitetsschemaläggaren/);
    assert.match(readme, /pywin32/);
    assert.match(readme, /Chrome/);
    assert.match(readme, /"backend": "windows"/);
    assert.match(readme, /62 × 29/);
    const example = JSON.parse(read('print_bridge/config.example.json'));
    assert.equal(example.bridge_key, '');
    assert.equal(example.backend, 'windows');
    assert.equal(read('.gitignore').includes('print_bridge/config.json'), true);
    const html = read('public/admin.html');
    assert.match(html, /Automatisk etikettskrivare/);
    assert.match(html, /Skapa bryggnyckel/);
    assert.match(html, /Testutskrift/);
    assert.match(html, /webbläsarens dialog fungerar som tidigare/);
  });
});

// Utskriftskö för den lokala bryggan på verkstadsdatorn.
// Avstängd tills verkstaden själv skapar en nyckel och aktiverar den.
// Nyckeln lagras bara som SHA-256. Klartexten loggas aldrig.

const crypto = require('crypto');
const express = require('express');

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_FRESH_MS = 90 * 1000;
const CLAIM_STALE_MS = 10 * 60 * 1000;
const MAX_CLAIM = 5;
const OFFLINE_WARN_MS = 10 * 60 * 1000;
const DUMMY_HASH = crypto.createHash('sha256').update('scanny-print-bridge-dummy-v1').digest('hex');
const KEY_PREFIX = 'scb_';

class PrintHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashBridgeKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(Buffer.from(DUMMY_HASH), Buffer.from(DUMMY_HASH));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function bridgeOf(tenant) {
  return (tenant && tenant.settings && tenant.settings.printBridge) || {};
}

function isBridgeActive(tenant, now) {
  const bridge = bridgeOf(tenant);
  if (!bridge.enabled || !bridge.keyHash) return false;
  if (!bridge.lastHeartbeatAt) return false;
  const seen = new Date(bridge.lastHeartbeatAt).getTime();
  if (!Number.isFinite(seen)) return false;
  const age = now.getTime() - seen;
  return age >= 0 && age <= HEARTBEAT_FRESH_MS;
}

function publicPrintBridge(raw, now = new Date()) {
  const bridge = raw && typeof raw.toObject === 'function' ? raw.toObject() : (raw || {});
  const seen = bridge.lastHeartbeatAt ? new Date(bridge.lastHeartbeatAt).getTime() : 0;
  const age = now.getTime() - seen;
  const online = Number.isFinite(seen) && seen > 0 && age >= 0 && age <= HEARTBEAT_FRESH_MS;
  return {
    enabled: !!bridge.enabled,
    configured: !!bridge.keyHash,
    keyPrefix: bridge.keyPrefix ? String(bridge.keyPrefix) : '',
    online,
    lastHeartbeatAt: bridge.lastHeartbeatAt || null,
    printerStatus: bridge.printerStatus ? String(bridge.printerStatus) : '',
    printerDetail: bridge.printerDetail ? String(bridge.printerDetail).slice(0, 200) : '',
    printerName: bridge.printerName ? String(bridge.printerName) : ''
  };
}

function scrubSecrets(message, tenant) {
  let text = String(message || 'okänt fel');
  const hash = bridgeOf(tenant).keyHash;
  if (hash && hash.length >= 8) text = text.split(hash).join('***');
  return text.slice(0, 300);
}

function validJobId(id) {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
}

function ensureBridge(tenant) {
  if (!tenant.settings) tenant.settings = {};
  if (!tenant.settings.printBridge) tenant.settings.printBridge = {};
  return tenant.settings.printBridge;
}

function jobPayload(job) {
  return {
    id: String(job._id),
    label: '62x29',
    widthMm: 62,
    heightMm: 29,
    dpi: 300,
    source: job.source,
    product: {
      name: job.name || '',
      code: job.code || '',
      articleNo: job.articleNo || ''
    }
  };
}

function createPrintService(store, opts = {}) {
  const nowFn = opts.now || (() => new Date());
  const warnLog = opts.warn || (msg => console.warn(msg));
  const offlineWarned = new Map();

  async function authenticate(rawKey) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    const hashed = hashBridgeKey(key);
    const tenant = key ? await store.findTenantByKeyHash(hashed) : null;
    const stored = (tenant && bridgeOf(tenant).keyHash) || DUMMY_HASH;
    const match = timingSafeEqualHex(hashed, stored);
    if (!key || !tenant || !match) return { tenant: null, reason: 'bad-key' };
    if (!bridgeOf(tenant).enabled) return { tenant, reason: 'disabled' };
    return { tenant, reason: 'ok' };
  }

  async function expireAndReclaim(tenantId, now) {
    const cutoff = new Date(now.getTime() - JOB_TTL_MS);
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
    await store.expireJobs(tenantId, cutoff, now);
    await store.reclaimStaleClaims(tenantId, cutoff, staleBefore);
  }

  async function poll(tenant) {
    const now = nowFn();
    await expireAndReclaim(tenant._id, now);
    const cutoff = new Date(now.getTime() - JOB_TTL_MS);
    const jobs = [];
    for (let i = 0; i < MAX_CLAIM; i++) {
      const job = await store.claimNext(tenant._id, cutoff, now);
      if (!job) break;
      jobs.push(jobPayload(job));
    }
    return { jobs };
  }

  async function ack(tenant, body) {
    const id = body && body.id;
    const status = body && body.status;
    if (!validJobId(id) || (status !== 'printed' && status !== 'failed')) {
      throw new PrintHttpError(400, 'Ogiltigt kvitto');
    }
    const error = status === 'failed' ? String((body && body.error) || '').slice(0, 300) : '';
    const job = await store.ackJob(tenant._id, id, {
      status,
      error,
      finishedAt: nowFn()
    });
    if (!job) throw new PrintHttpError(409, 'Jobbet kan inte kvitteras');
    return { ok: true };
  }

  async function heartbeat(tenant, body) {
    const now = nowFn();
    const bridge = ensureBridge(tenant);
    const status = String((body && body.printerStatus) || 'ok').slice(0, 40);
    const detail = String((body && body.detail) || '').slice(0, 200);
    const printerName = String((body && body.printerName) || '').slice(0, 120);
    const previous = bridge.printerStatus || '';
    bridge.lastHeartbeatAt = now;
    bridge.printerStatus = status;
    bridge.printerDetail = detail;
    if (printerName) bridge.printerName = printerName;
    await store.saveTenant(tenant);
    if (status !== 'ok' && status !== previous && store.addLog) {
      const text = detail ? `Skrivarlarm: ${status} — ${detail}` : `Skrivarlarm: ${status}`;
      await store.addLog(tenant._id, text, 'warn');
    } else if (status === 'ok' && previous && previous !== 'ok' && store.addLog) {
      await store.addLog(tenant._id, 'Skrivaren är online igen', 'normal');
    }
    return { ok: true };
  }

  function snapshot(tenantId, product, source, now) {
    return {
      tenantId,
      productId: product && (product._id || product.id) || undefined,
      name: String((product && product.name) || '').slice(0, 200),
      code: String((product && product.code) || '').slice(0, 80),
      articleNo: String((product && product.articleNo) || '').slice(0, 80),
      labelSize: '62x29',
      source,
      status: 'pending',
      createdAt: now
    };
  }

  async function enqueue(tenantId, product, source) {
    const now = nowFn();
    let tenant = null;
    try {
      tenant = await store.getTenant(tenantId);
      if (!tenant) return { queued: false, reason: 'no-tenant' };
      if (!isBridgeActive(tenant, now)) {
        const bridge = bridgeOf(tenant);
        if (bridge.enabled && bridge.keyHash) {
          const id = String(tenantId);
          const prev = offlineWarned.get(id) || 0;
          if (now.getTime() - prev >= OFFLINE_WARN_MS) {
            offlineWarned.set(id, now.getTime());
            warnLog(`[print] Inleverans köade ingen etikett: bryggan är inte online (${id})`);
          }
        }
        return { queued: false, reason: 'inactive' };
      }
      const job = await store.createJob(snapshot(tenantId, product, source || 'manual', now));
      return { queued: true, id: String(job._id) };
    } catch (err) {
      warnLog('[print] Kunde inte köa etikett: ' + scrubSecrets(err && err.message, tenant));
      return { queued: false, reason: 'error' };
    }
  }

  async function setEnabled(tenantId, enabled) {
    if (typeof enabled !== 'boolean') throw new PrintHttpError(400, 'enabled måste vara true eller false');
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw new PrintHttpError(404, 'Tenant hittades inte');
    const bridge = ensureBridge(tenant);
    bridge.enabled = enabled;
    await store.saveTenant(tenant);
    return publicPrintBridge(bridge, nowFn());
  }

  async function issueKey(tenantId) {
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw new PrintHttpError(404, 'Tenant hittades inte');
    const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    const bridge = ensureBridge(tenant);
    bridge.keyHash = hashBridgeKey(key);
    bridge.keyPrefix = key.slice(0, 8);
    bridge.keyCreatedAt = nowFn();
    await store.saveTenant(tenant);
    return { key, prefix: bridge.keyPrefix, message: 'Kopiera nyckeln nu. Den visas inte igen.' };
  }

  async function revokeKey(tenantId) {
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw new PrintHttpError(404, 'Tenant hittades inte');
    const bridge = ensureBridge(tenant);
    bridge.keyHash = '';
    bridge.keyPrefix = '';
    bridge.enabled = false;
    bridge.keyCreatedAt = null;
    await store.saveTenant(tenant);
    return { ok: true };
  }

  async function requireActive(tenantId) {
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw new PrintHttpError(404, 'Tenant hittades inte');
    if (!isBridgeActive(tenant, nowFn())) {
      throw new PrintHttpError(409, 'Automatisk utskrift är inte aktiverad eller bryggan är offline. Skriv ut via webbläsaren i stället.');
    }
    return tenant;
  }

  async function queueProduct(tenantId, product) {
    await requireActive(tenantId);
    try {
      const job = await store.createJob(snapshot(tenantId, product, 'manual', nowFn()));
      return { ok: true, id: String(job._id) };
    } catch (err) {
      warnLog('[print] Kunde inte köa etikett: ' + scrubSecrets(err && err.message, await store.getTenant(tenantId)));
      throw new PrintHttpError(500, 'Kunde inte köa etiketten. Skriv ut via webbläsaren i stället.');
    }
  }

  async function testPrint(tenantId) {
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw new PrintHttpError(404, 'Tenant hittades inte');
    if (!isBridgeActive(tenant, nowFn())) {
      throw new PrintHttpError(409, 'Bryggan är inte online. Starta den på verkstadsdatorn och försök igen.');
    }
    try {
      const job = await store.createJob(snapshot(tenantId, {
        name: 'Testetikett',
        code: 'SCANNY',
        articleNo: 'TEST'
      }, 'test', nowFn()));
      return { ok: true, id: String(job._id) };
    } catch (err) {
      warnLog('[print] Kunde inte köa testetikett: ' + scrubSecrets(err && err.message, tenant));
      throw new PrintHttpError(500, 'Kunde inte köa testetiketten.');
    }
  }

  async function statusFor(tenantId) {
    const tenant = await store.getTenant(tenantId);
    if (!tenant) throw new PrintHttpError(404, 'Tenant hittades inte');
    return publicPrintBridge(bridgeOf(tenant), nowFn());
  }

  return {
    authenticate,
    poll,
    ack,
    heartbeat,
    enqueue,
    setEnabled,
    issueKey,
    revokeKey,
    queueProduct,
    testPrint,
    statusFor
  };
}

function respondPrintError(res, err) {
  if (err && err.status) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

function sendErr(res, err) {
  if (respondPrintError(res, err)) return;
  console.error('[print] fel');
  return res.status(500).json({ error: 'Internt serverfel' });
}

function bridgeKeyFromRequest(req) {
  if (req.query && (req.query.key || req.query.bridge_key || req.query.bridgeKey || req.query.bridgekey)) {
    return { reject: true };
  }
  const header = req.headers['x-bridge-key'];
  if (Array.isArray(header) || typeof header !== 'string' || !header.trim()) return { reject: true };
  return { key: header.trim() };
}

function createBridgeRouter(service) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    const extracted = bridgeKeyFromRequest(req);
    if (extracted.reject) return res.status(401).json({ error: 'Ogiltig bryggnyckel' });
    try {
      const auth = await service.authenticate(extracted.key);
      if (auth.reason === 'disabled') return res.status(403).json({ error: 'Automatisk utskrift är avstängd' });
      if (!auth.tenant) return res.status(401).json({ error: 'Ogiltig bryggnyckel' });
      if (auth.tenant.status === 'paused' || auth.tenant.status === 'cancelled') {
        return res.status(403).json({ error: 'Kontot är pausat' });
      }
      req.printTenant = auth.tenant;
      next();
    } catch (err) {
      console.error('[print] auth fel');
      res.status(500).json({ error: 'Internt serverfel' });
    }
  });

  router.post('/poll', async (req, res) => {
    try { res.json(await service.poll(req.printTenant)); }
    catch (err) { sendErr(res, err); }
  });

  router.post('/ack', async (req, res) => {
    try { res.json(await service.ack(req.printTenant, req.body || {})); }
    catch (err) { sendErr(res, err); }
  });

  router.post('/heartbeat', async (req, res) => {
    try { res.json(await service.heartbeat(req.printTenant, req.body || {})); }
    catch (err) { sendErr(res, err); }
  });

  return router;
}

function createUserRouter(service) {
  const router = express.Router();

  router.put('/settings', async (req, res) => {
    try { res.json(await service.setEnabled(req.tenantId, req.body && req.body.enabled)); }
    catch (err) { sendErr(res, err); }
  });

  router.post('/key', async (req, res) => {
    try { res.json(await service.issueKey(req.tenantId)); }
    catch (err) { sendErr(res, err); }
  });

  router.delete('/key', async (req, res) => {
    try { res.json(await service.revokeKey(req.tenantId)); }
    catch (err) { sendErr(res, err); }
  });

  router.post('/test', async (req, res) => {
    try { res.json(await service.testPrint(req.tenantId)); }
    catch (err) { sendErr(res, err); }
  });

  return router;
}

function createMemoryStore() {
  const tenants = [];
  const jobs = [];
  const logs = [];
  let n = 1;
  const same = (a, b) => String(a) === String(b);

  return {
    tenants,
    jobs,
    logs,
    async findTenantByKeyHash(hash) {
      return tenants.find(t => bridgeOf(t).keyHash === hash) || null;
    },
    async getTenant(id) {
      return tenants.find(t => same(t._id, id)) || null;
    },
    async saveTenant() { return true; },
    async createJob(doc) {
      const job = { ...doc, _id: n.toString(16).padStart(24, '0') };
      n += 1;
      jobs.push(job);
      return job;
    },
    async expireJobs(tenantId, cutoff, now) {
      const limit = new Date(cutoff).getTime();
      for (const job of jobs) {
        if (!same(job.tenantId, tenantId)) continue;
        if (job.status !== 'pending' && job.status !== 'claimed') continue;
        if (new Date(job.createdAt).getTime() < limit) {
          job.status = 'expired';
          job.finishedAt = now;
        }
      }
    },
    async reclaimStaleClaims(tenantId, cutoff, staleBefore) {
      const oldest = new Date(cutoff).getTime();
      const stale = new Date(staleBefore).getTime();
      for (const job of jobs) {
        if (!same(job.tenantId, tenantId) || job.status !== 'claimed') continue;
        if (new Date(job.createdAt).getTime() < oldest) continue;
        if (job.claimedAt && new Date(job.claimedAt).getTime() < stale) {
          job.status = 'pending';
          delete job.claimedAt;
        }
      }
    },
    async claimNext(tenantId, cutoff, now) {
      const oldest = new Date(cutoff).getTime();
      const eligible = jobs
        .filter(j => same(j.tenantId, tenantId) && j.status === 'pending' && new Date(j.createdAt).getTime() >= oldest)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const job = eligible[0];
      if (!job) return null;
      job.status = 'claimed';
      job.claimedAt = now;
      return job;
    },
    async ackJob(tenantId, id, patch) {
      const job = jobs.find(j => j._id === id && same(j.tenantId, tenantId) && j.status === 'claimed');
      if (!job) return null;
      Object.assign(job, patch);
      return job;
    },
    async addLog(tenantId, msg, type) {
      logs.push({ tenantId, msg, type });
    }
  };
}

function createMongooseStore({ Tenant, PrintJob, addLog }) {
  const mongoose = require('mongoose');
  return {
    async findTenantByKeyHash(hash) {
      if (!hash) return null;
      return Tenant.findOne({ 'settings.printBridge.keyHash': hash });
    },
    async getTenant(id) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      return Tenant.findById(id);
    },
    async saveTenant(tenant) {
      tenant.markModified('settings');
      await tenant.save();
    },
    async createJob(doc) {
      return PrintJob.create(doc);
    },
    async expireJobs(tenantId, cutoff, now) {
      await PrintJob.updateMany(
        { tenantId, status: { $in: ['pending', 'claimed'] }, createdAt: { $lt: cutoff } },
        { $set: { status: 'expired', finishedAt: now } }
      );
    },
    async reclaimStaleClaims(tenantId, cutoff, staleBefore) {
      await PrintJob.updateMany(
        { tenantId, status: 'claimed', createdAt: { $gte: cutoff }, claimedAt: { $lt: staleBefore } },
        { $set: { status: 'pending' }, $unset: { claimedAt: '' } }
      );
    },
    async claimNext(tenantId, cutoff, now) {
      return PrintJob.findOneAndUpdate(
        { tenantId, status: 'pending', createdAt: { $gte: cutoff } },
        { $set: { status: 'claimed', claimedAt: now } },
        { sort: { createdAt: 1 }, new: true }
      );
    },
    async ackJob(tenantId, id, patch) {
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      return PrintJob.findOneAndUpdate(
        { _id: id, tenantId, status: 'claimed' },
        { $set: patch },
        { new: true }
      );
    },
    async addLog(tenantId, msg, type) {
      if (addLog) await addLog(tenantId, msg, type);
    }
  };
}

function createPrintFeature({ Tenant, PrintJob, addLog }) {
  const service = createPrintService(createMongooseStore({ Tenant, PrintJob, addLog }));
  return {
    service,
    bridgeRouter: createBridgeRouter(service),
    userRouter: createUserRouter(service),
    enqueueForGoodsReceipt(tenantId, product) {
      return service.enqueue(tenantId, product, 'inleverans');
    }
  };
}

module.exports = {
  JOB_TTL_MS,
  HEARTBEAT_FRESH_MS,
  PrintHttpError,
  hashBridgeKey,
  timingSafeEqualHex,
  publicPrintBridge,
  isBridgeActive,
  createPrintService,
  createBridgeRouter,
  createUserRouter,
  createMemoryStore,
  createMongooseStore,
  createPrintFeature,
  respondPrintError
};

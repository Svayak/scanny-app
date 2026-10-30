// Koppling mellan kiosk-användare och historik.
// Namnet är en ögonblicksbild. userId är användarens fasta id.
// Add-användare har varken maxlängd eller unikhet på namn inom verkstaden.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScannyUsers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const NAME_RULES = { maxLength: null, uniqueWithinTenant: false };
  const PLACEHOLDER_NAMES = new Set(['', '—', '-', '–']);

  function idOf(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'object') {
      if (value._id != null && value._id !== value) return idOf(value._id);
      if (value.id != null && value.id !== value) return idOf(value.id);
      if (typeof value.toHexString === 'function') return value.toHexString();
    }
    return String(value);
  }

  function trimName(name) {
    return String(name ?? '').trim();
  }

  function initialsOf(name) {
    return trimName(name).split(/\s+/).filter(Boolean).map(part => part[0]).join('').toUpperCase().slice(0, 2);
  }

  // Samma fält som när en användare skapas: canScan/canAdd/canInventory,
  // med de äldre nycklarna scan/add/inventory som reserv.
  function normalizePermissions(permissions) {
    const p = permissions && typeof permissions === 'object' ? permissions : {};
    return {
      canScan: !!(p.canScan ?? p.scan ?? true),
      canAdd: !!(p.canAdd ?? p.add ?? false),
      canInventory: !!(p.canInventory ?? p.inventory ?? false)
    };
  }

  function permissionLabel(permissions) {
    const p = normalizePermissions(permissions);
    const parts = [];
    if (p.canScan) parts.push('Uttag');
    if (p.canAdd) parts.push('Addera');
    if (p.canInventory) parts.push('Inventering');
    return parts.join(', ') || 'Inga behörigheter';
  }

  function hasPermission(user, key) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const p = user.permissions || {};
    const map = {
      scan: p.canScan ?? p.scan,
      add: p.canAdd ?? p.add,
      inventory: p.canInventory ?? p.inventory
    };
    return map[key] !== false;
  }

  function permissionDenied(actor, key, label) {
    if (!actor) return { status: 403, error: 'Kunde inte identifiera användare — välj användare igen' };
    if (!hasPermission(actor, key)) return { status: 403, error: `Saknar behörighet för ${label}` };
    return null;
  }

  // Samma grind som routerna använder. getActor läser användaren på nytt varje anrop.
  function createPermissionGate(getActor) {
    return function requirePermission(key, label) {
      return async function permissionGate(req, res, next) {
        const actor = await getActor(req);
        const denied = permissionDenied(actor, key, label);
        if (denied) {
          res.status(denied.status).json({ error: denied.error });
          return;
        }
        req.actor = actor;
        if (typeof next === 'function') next();
      };
    };
  }

  function checkboxOn(permissions, key) {
    return hasPermission({ role: 'staff', permissions: permissions || {} }, key);
  }

  function validateProfile(input) {
    const body = input || {};
    const name = trimName(body.name);
    if (!name) return { ok: false, status: 400, error: 'Namn krävs' };
    if (NAME_RULES.maxLength != null && name.length > NAME_RULES.maxLength) {
      return { ok: false, status: 400, error: 'Namnet är för långt' };
    }
    if (!body.permissions || typeof body.permissions !== 'object' || Array.isArray(body.permissions)) {
      return { ok: false, status: 400, error: 'Minst en behörighet måste väljas' };
    }
    const permissions = normalizePermissions(body.permissions);
    if (!permissions.canScan && !permissions.canAdd && !permissions.canInventory) {
      return { ok: false, status: 400, error: 'Minst en behörighet måste väljas' };
    }
    return { ok: true, name, initials: initialsOf(name), permissions };
  }

  // Profilsparning rör aldrig PIN. Unikhet kontrolleras inte — det gör inte skapa-användare heller.
  function applyProfile(user, body) {
    const profile = validateProfile(body);
    if (!profile.ok) return profile;
    return {
      ok: true,
      name: profile.name,
      initials: profile.initials,
      permissions: profile.permissions
    };
  }

  function isPinOnlyPatch(body) {
    if (!body || body.pin === undefined) return false;
    return body.name === undefined && body.permissions === undefined;
  }

  function changeMessage(oldName, newName, permissions, actor) {
    const base = `Användare ändrad: ${oldName} → ${newName}, behörigheter: ${permissionLabel(permissions)}`;
    const who = trimName(actor && actor.name);
    return who ? `${base} — av ${who}` : base;
  }

  function actorFields(actor) {
    const userId = actor && (actor._id || actor.id);
    if (!userId) return {};
    return { userId, actorName: actor.name || '' };
  }

  function indexUsers(users) {
    const map = new Map();
    for (const user of users || []) {
      const id = idOf(user && (user.id || user._id));
      if (id) map.set(id, user);
    }
    return map;
  }

  function userById(userId, users) {
    const id = idOf(userId);
    if (!id) return null;
    if (users instanceof Map) return users.get(id) || null;
    return (users || []).find(user => idOf(user && (user.id || user._id)) === id) || null;
  }

  function displayUserName(userId, snapshot, users) {
    const user = userById(userId, users);
    if (user && trimName(user.name)) return user.name;
    const stored = trimName(snapshot);
    return stored || '—';
  }

  function parseLogActorName(msg) {
    const text = String(msg || '');
    if (text.startsWith('Användare ändrad:')) {
      const byActor = text.match(/ — av (.+)$/);
      if (byActor) return trimName(byActor[1]);
    }
    if (/^(Uttag: |Påfyllning: |Inventering: )/.test(text)) {
      const idx = text.lastIndexOf(' — ');
      if (idx !== -1) return trimName(text.slice(idx + 3));
    }
    return '';
  }

  function displayLogMessage(log, users) {
    const entry = log || {};
    const msg = String(entry.msg || '');
    const snapshot = trimName(entry.actorName) || parseLogActorName(msg);
    const current = displayUserName(entry.userId, snapshot, users);
    if (!snapshot || !current || snapshot === current || current === '—') return msg;
    const suffix = ' — ' + snapshot;
    const bySuffix = ' — av ' + snapshot;
    if (msg.endsWith(bySuffix)) return msg.slice(0, -snapshot.length) + current;
    if (msg.endsWith(suffix)) return msg.slice(0, -snapshot.length) + current;
    return msg;
  }

  function snapshotName(record) {
    const entry = record || {};
    return trimName(entry.actorName || entry.userName || entry.legacyActorName || '');
  }

  function matchesUser(record, user) {
    if (!user) return true;
    const entry = record || {};
    const want = idOf(user.id || user._id);
    const got = idOf(entry.userId);
    if (got) return !!want && got === want;
    const snap = snapshotName(entry);
    if (!snap || PLACEHOLDER_NAMES.has(snap)) return false;
    return snap === trimName(user.name);
  }

  function statsForUser(user, data) {
    const source = data || {};
    const logs = (source.logs || []).filter(entry => matchesUser(entry, user));
    let withdrawals = 0;
    for (const vehicle of source.vehicles || []) {
      for (const entry of vehicle.history || []) {
        if (matchesUser(entry, user)) withdrawals += 1;
      }
    }
    const inventories = (source.inventoryReports || []).filter(entry => matchesUser(entry, user));
    return {
      events: logs.length,
      scans: logs.filter(entry => String(entry.msg || '').startsWith('Uttag:')).length,
      additions: logs.filter(entry => String(entry.msg || '').startsWith('Påfyllning:')).length,
      inventories: inventories.length,
      withdrawals
    };
  }

  function presentLog(log, users) {
    const entry = plain(log);
    if (!entry) return entry;
    entry.msg = displayLogMessage(entry, users);
    entry.actorDisplayName = displayUserName(entry.userId, entry.actorName || parseLogActorName(log && log.msg), users);
    return entry;
  }

  function presentVehicle(vehicle, users) {
    const entry = plain(vehicle);
    if (!entry) return entry;
    if (!entry.id && entry._id) entry.id = entry._id;
    entry.history = (entry.history || []).map(row => {
      const copy = { ...row };
      copy.userDisplayName = displayUserName(copy.userId, copy.userName, users);
      return copy;
    });
    return entry;
  }

  function presentInventoryReport(report, users) {
    const entry = plain(report);
    if (!entry) return entry;
    entry.actorDisplayName = displayUserName(entry.userId, entry.actorName, users);
    return entry;
  }

  function plain(doc) {
    if (!doc) return null;
    if (typeof doc.toObject === 'function') return doc.toObject();
    return { ...doc };
  }

  function candidateUsers(users, tenantId) {
    const tenant = idOf(tenantId);
    if (!tenant) return users || [];
    return (users || []).filter(user => idOf(user.tenantId) === tenant);
  }

  function matchName(name, users) {
    const key = trimName(name);
    if (!key || PLACEHOLDER_NAMES.has(key)) return { status: 'unmatched' };
    const list = users || [];
    const exact = list.filter(user => trimName(user.name) === key);
    if (exact.length === 1) return { status: 'matched', user: exact[0] };
    if (exact.length > 1) return { status: 'ambiguous' };
    const folded = list.filter(user => trimName(user.name).toLocaleLowerCase('sv') === key.toLocaleLowerCase('sv'));
    if (folded.length === 1) return { status: 'matched', user: folded[0] };
    if (folded.length > 1) return { status: 'ambiguous' };
    return { status: 'unmatched' };
  }

  function emptyBucket() {
    return { examined: 0, matched: 0, ambiguous: 0, unmatched: 0, already: 0, noActor: 0, updates: [], samples: [] };
  }

  function remember(bucket, kind, sample) {
    if (kind !== 'ambiguous' && kind !== 'unmatched') return;
    if (bucket.samples.length >= 100) return;
    bucket.samples.push(sample);
  }

  function classifyLink(record, name, users, tenantId) {
    if (idOf(record && record.userId)) return { kind: 'already' };
    if (trimName(record && record.legacyActorName)) return { kind: 'already' };
    const parsed = trimName(name);
    if (!parsed || PLACEHOLDER_NAMES.has(parsed)) return { kind: 'noActor' };
    const match = matchName(parsed, candidateUsers(users, tenantId));
    if (match.status === 'matched') {
      return { kind: 'matched', set: { userId: idOf(match.user._id || match.user.id) } };
    }
    return { kind: match.status, set: { userId: null, legacyActorName: parsed } };
  }

  function noteActorName(set, record, parsed) {
    if (!set || trimName(record && record.actorName) || !trimName(parsed)) return set;
    return { ...set, actorName: trimName(parsed) };
  }

  function planBackfill(input) {
    const source = input || {};
    const users = source.users || [];
    const logs = emptyBucket();
    const vehicles = emptyBucket();
    const inventoryReports = emptyBucket();
    vehicles.documents = (source.vehicles || []).length;

    for (const log of source.logs || []) {
      logs.examined += 1;
      const parsed = trimName(log.actorName) || parseLogActorName(log.msg);
      const result = classifyLink(log, parsed, users, log.tenantId);
      logs[result.kind] += 1;
      remember(logs, result.kind, { id: idOf(log._id || log.id), tenantId: idOf(log.tenantId), name: parsed, reason: result.kind });
      if (!result.set) continue;
      logs.updates.push({
        id: log._id || log.id,
        tenantId: log.tenantId,
        set: noteActorName(result.set, log, parsed)
      });
    }

    for (const vehicle of source.vehicles || []) {
      let changed = false;
      const history = (vehicle.history || []).map(row => {
        vehicles.examined += 1;
        const result = classifyLink(row, row.userName, users, vehicle.tenantId);
        vehicles[result.kind] += 1;
        remember(vehicles, result.kind, { id: idOf(vehicle._id || vehicle.id), tenantId: idOf(vehicle.tenantId), name: trimName(row.userName), reason: result.kind });
        if (!result.set) return { ...row };
        changed = true;
        return { ...row, ...result.set };
      });
      if (changed) {
        vehicles.updates.push({ id: vehicle._id || vehicle.id, tenantId: vehicle.tenantId, history });
      }
    }

    for (const report of source.inventoryReports || []) {
      inventoryReports.examined += 1;
      const result = classifyLink(report, report.actorName, users, report.tenantId);
      inventoryReports[result.kind] += 1;
      remember(inventoryReports, result.kind, { id: idOf(report._id || report.id), tenantId: idOf(report.tenantId), name: trimName(report.actorName), reason: result.kind });
      if (!result.set) continue;
      inventoryReports.updates.push({
        id: report._id || report.id,
        tenantId: report.tenantId,
        set: result.set
      });
    }

    return {
      logs,
      vehicles,
      inventoryReports,
      orders: {
        documents: (source.orders || []).length,
        examined: (source.orders || []).length,
        updated: 0,
        matched: 0,
        note: 'Order.name är produktnamn. Ordrar har ingen användarreferens och lämnas orörda.'
      }
    };
  }

  function applyBackfill(input, plan) {
    const source = input || {};
    const next = {
      users: (source.users || []).map(user => ({ ...user })),
      logs: (source.logs || []).map(log => ({ ...log })),
      vehicles: (source.vehicles || []).map(vehicle => ({
        ...vehicle,
        history: (vehicle.history || []).map(row => ({ ...row }))
      })),
      inventoryReports: (source.inventoryReports || []).map(report => ({ ...report })),
      orders: (source.orders || []).map(order => ({ ...order }))
    };
    const decided = plan || planBackfill(source);
    for (const update of decided.logs.updates) {
      const log = next.logs.find(entry => idOf(entry._id || entry.id) === idOf(update.id));
      if (!log) continue;
      const msg = log.msg;
      for (const [key, value] of Object.entries(update.set || {})) {
        if (key === 'msg' || key === 'userName') continue;
        if (key === 'actorName' && trimName(log.actorName)) continue;
        log[key] = value;
      }
      log.msg = msg;
    }
    for (const update of decided.vehicles.updates) {
      const vehicle = next.vehicles.find(entry => idOf(entry._id || entry.id) === idOf(update.id));
      if (!vehicle) continue;
      const previous = vehicle.history || [];
      vehicle.history = (update.history || []).map((row, index) => {
        const prior = previous[index] || {};
        const merged = { ...prior, ...row };
        if (prior.userName !== undefined) merged.userName = prior.userName;
        return merged;
      });
    }
    for (const update of decided.inventoryReports.updates) {
      const report = next.inventoryReports.find(entry => idOf(entry._id || entry.id) === idOf(update.id));
      if (!report) continue;
      const actorName = report.actorName;
      for (const [key, value] of Object.entries(update.set || {})) {
        if (key === 'actorName' || key === 'userName' || key === 'msg') continue;
        report[key] = value;
      }
      report.actorName = actorName;
    }
    return next;
  }

  function findTenantUser(users, id, tenantId) {
    const want = idOf(id);
    const tenant = idOf(tenantId);
    return (users || []).find(user => idOf(user._id || user.id) === want && idOf(user.tenantId) === tenant) || null;
  }

  return {
    NAME_RULES,
    idOf,
    trimName,
    initialsOf,
    normalizePermissions,
    permissionLabel,
    hasPermission,
    permissionDenied,
    createPermissionGate,
    checkboxOn,
    validateProfile,
    applyProfile,
    isPinOnlyPatch,
    changeMessage,
    actorFields,
    indexUsers,
    displayUserName,
    parseLogActorName,
    displayLogMessage,
    matchesUser,
    statsForUser,
    presentLog,
    presentVehicle,
    presentInventoryReport,
    matchName,
    planBackfill,
    applyBackfill,
    findTenantUser
  };
});

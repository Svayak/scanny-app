const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const users = require('../public/js/user-link');

const root = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

describe('redigera användare', () => {
  const perms = { canScan: true, canAdd: false, canInventory: true };

  it('sparar trimmat namn och behörigheter utan att röra PIN', () => {
    const user = { name: 'Anna', pin: 'hash-123', permissions: { canScan: true, canAdd: false, canInventory: false } };
    const applied = users.applyProfile(user, {
      name: '  Beatrice  ',
      permissions: perms,
      pin: '9999',
      password: 'nej',
      role: 'admin',
      tenantId: 'annan'
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.name, 'Beatrice');
    assert.deepEqual(applied.permissions, perms);
    assert.equal(Object.prototype.hasOwnProperty.call(applied, 'pin'), false);
    assert.equal(user.pin, 'hash-123');
    assert.equal(user.name, 'Anna');
  });

  it('följer samma namnregler som när en användare läggs till', () => {
    assert.equal(users.NAME_RULES.maxLength, null);
    assert.equal(users.NAME_RULES.uniqueWithinTenant, false);
    const longName = 'A'.repeat(300);
    const applied = users.applyProfile({}, { name: longName, permissions: { canScan: true, canAdd: false, canInventory: false } });
    assert.equal(applied.ok, true);
    assert.equal(applied.name, longName);
  });

  it('avvisar tomt namn och namn som bara är mellanslag', () => {
    for (const name of ['', '   ', null]) {
      const result = users.validateProfile({ name, permissions: { canScan: true } });
      assert.equal(result.ok, false);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'Namn krävs');
    }
  });

  it('avvisar när ingen behörighet är vald', () => {
    const result = users.validateProfile({
      name: 'Anna',
      permissions: { canScan: false, canAdd: false, canInventory: false }
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Minst en behörighet måste väljas');
    const missing = users.validateProfile({ name: 'Anna' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'Minst en behörighet måste väljas');
  });

  it('läser behörigheter med samma nycklar som skapa-användare', () => {
    const applied = users.applyProfile({}, {
      name: 'Anna',
      permissions: { scan: true, add: true, inventory: false }
    });
    assert.deepEqual(applied.permissions, { canScan: true, canAdd: true, canInventory: false });
  });

  it('skriver aktivitetsloggen med vem som ändrade och den personens id', () => {
    const actor = { _id: 'admin-1', name: 'Kalle' };
    const msg = users.changeMessage('Anna', 'Beatrice', { canScan: true, canAdd: true, canInventory: false }, actor);
    assert.equal(msg, 'Användare ändrad: Anna → Beatrice, behörigheter: Uttag, Addera — av Kalle');
    assert.deepEqual(users.actorFields(actor), { userId: 'admin-1', actorName: 'Kalle' });
    assert.deepEqual(users.actorFields(null), {});
  });

  it('PIN-anropet är skilt från redigering av namn och behörigheter', () => {
    assert.equal(users.isPinOnlyPatch({ pin: '1234' }), true);
    assert.equal(users.isPinOnlyPatch({ pin: '' }), true);
    assert.equal(users.isPinOnlyPatch({ pin: '1234', name: 'Anna' }), false);
    assert.equal(users.isPinOnlyPatch({ name: 'Anna', permissions: { canScan: true } }), false);
  });

  it('hittar inte en användare som tillhör en annan verkstad', () => {
    const list = [
      { _id: 'u1', tenantId: 'verkstad-a', name: 'Anna' },
      { _id: 'u1', tenantId: 'verkstad-b', name: 'Anna' }
    ];
    assert.equal(users.findTenantUser(list, 'u1', 'verkstad-b').name, 'Anna');
    assert.equal(users.findTenantUser(list, 'u1', 'verkstad-b').tenantId, 'verkstad-b');
    assert.equal(users.findTenantUser(list, 'saknas', 'verkstad-a'), null);
    const onlyA = users.findTenantUser(
      [{ _id: 'u2', tenantId: 'verkstad-a', name: 'Bea' }],
      'u2',
      'verkstad-b'
    );
    assert.equal(onlyA, null);
  });

  it('requirePermission läser om användaren och stoppar en borttagen behörighet', async () => {
    let stored = { _id: 'u1', role: 'staff', name: 'Anna', permissions: { canScan: true, canAdd: true, canInventory: false } };
    const requirePermission = users.createPermissionGate(async () => stored);
    const gate = requirePermission('add', 'Addera');
    const req = { user: { userId: 'u1' } };
    let next = 0;
    const ok = mockRes();
    await gate(req, ok, () => { next += 1; });
    assert.equal(next, 1);
    assert.equal(req.actor, stored);

    stored = { ...stored, permissions: { canScan: true, canAdd: false, canInventory: false } };
    const blocked = mockRes();
    await gate({ user: { userId: 'u1' } }, blocked, () => { next += 1; });
    assert.equal(next, 1);
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.body.error, /Addera/);

    const admin = mockRes();
    stored = { ...stored, role: 'admin', permissions: { canScan: false, canAdd: false, canInventory: false } };
    let adminNext = 0;
    await gate({}, admin, () => { adminNext += 1; });
    assert.equal(adminNext, 1);
  });
});

describe('redigera användare i servern och admin', () => {
  it('PATCH är admin, verkstadsbunden, och rör inte PIN-hashen i profilsparningen', () => {
    const server = read('server.js');
    const patch = server.slice(server.indexOf("app.patch('/api/users/:id'"), server.indexOf("app.delete('/api/users/:id'"));
    assert.match(patch, /adminOnly/);
    assert.match(patch, /_id: req\.params\.id, tenantId: req\.tenantId/);
    assert.match(patch, /Användare hittades inte/);
    assert.match(patch, /userLink\.applyProfile/);
    assert.match(patch, /userLink\.isPinOnlyPatch/);
    assert.match(patch, /serverError\(res, err\)/);
    assert.equal(patch.includes('...req.body'), false);
    const profile = patch.split('applyProfile')[1];
    assert.equal(profile.includes('user.pin'), false);
    assert.match(patch, /user\.pin = await bcrypt\.hash/);
    assert.match(server, /createPermissionGate\(getActor\)/);
    assert.match(server, /actorFields\(actor\)/);
    assert.equal(server.includes('backfill-user-ids'), false);
  });

  it('admin har Redigera-knappen och samma modalyta som övriga dialoger', () => {
    const html = read('public/admin.html');
    const js = read('public/js/app.js');
    const css = read('public/css/style.css');
    assert.match(html, /id="user-edit-modal"/);
    assert.match(html, /id="eu-name"/);
    assert.match(html, /id="eu-perm-scan"/);
    assert.match(html, /id="eu-perm-add"/);
    assert.match(html, /id="eu-perm-inv"/);
    assert.match(html, /> Uttag</);
    assert.match(html, /> Addera</);
    assert.match(html, /> Inventering</);
    assert.match(html, /class="modal-body"/);
    assert.match(html, /class="modal-actions"/);
    assert.match(html, /class="modal-grid-3"/);
    assert.match(css, /minmax\(0,1fr\)/);
    assert.match(css, /\.modal-body\{overflow-y:auto/);
    assert.match(css, /\.modal-actions\{position:sticky/);
    assert.match(js, /openEditUser\(/);
    assert.match(js, /Redigera/);
    assert.match(js, /Minst en behörighet måste väljas/);
    assert.match(js, /api\('PATCH', '\/api\/users\/' \+ id, \{ name, permissions \}\)/);
    assert.equal(js.includes("api('PATCH', '/api/users/' + id, { name, permissions, pin"), false);
  });

  it('kiosken hämtar användarlistan vid val och när datan laddas om', () => {
    const kiosk = read('public/kiosk.html');
    assert.match(kiosk, /function refreshCurrentUser\(/);
    assert.match(kiosk, /api\('GET', '\/api\/users'\)/);
    assert.match(kiosk, /applyPermissions\(fresh\)/);
    assert.match(kiosk, /applyPermissions\(u\)/);
  });
});

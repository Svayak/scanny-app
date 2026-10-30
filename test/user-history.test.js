const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const users = require('../public/js/user-link');
const migration = require('../scripts/backfill-user-ids');

const tenantA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const tenantB = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function anna() {
  return { _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', id: 'aaaaaaaaaaaaaaaaaaaaaaa1', tenantId: tenantA, name: 'Anna' };
}

describe('historik följer användarens id', () => {
  it('visar det nya namnet i logg, uttag, inventering, filter och statistik efter byte', () => {
    const user = { ...anna(), name: 'Beatrice' };
    const other = { _id: 'aaaaaaaaaaaaaaaaaaaaaaa2', id: 'aaaaaaaaaaaaaaaaaaaaaaa2', tenantId: tenantA, name: 'Kalle' };
    const data = {
      users: [user, other],
      logs: [
        { _id: 'l1', tenantId: tenantA, userId: user.id, actorName: 'Anna', msg: 'Uttag: Borr (kvar: 3) — Anna', type: 'normal' },
        { _id: 'l2', tenantId: tenantA, userId: user.id, actorName: 'Anna', msg: 'Påfyllning: Mutter (nu 4) — Anna', type: 'normal' },
        { _id: 'l3', tenantId: tenantA, userId: other.id, actorName: 'Kalle', msg: 'Uttag: Tejp (kvar: 1) — Kalle', type: 'normal' }
      ],
      vehicles: [{
        _id: 'v1',
        tenantId: tenantA,
        regNr: 'ABC123',
        history: [
          { time: '2026-01-01', productName: 'Borr', qty: 1, userName: 'Anna', userId: user.id },
          { time: '2026-01-02', productName: 'Tejp', qty: 1, userName: 'Kalle', userId: other.id }
        ]
      }],
      inventoryReports: [
        { _id: 'r1', tenantId: tenantA, actorName: 'Anna', userId: user.id, total: 2 },
        { _id: 'r2', tenantId: tenantA, actorName: 'Kalle', userId: other.id, total: 1 }
      ]
    };

    assert.equal(users.displayLogMessage(data.logs[0], data.users), 'Uttag: Borr (kvar: 3) — Beatrice');
    assert.equal(users.displayUserName(data.vehicles[0].history[0].userId, data.vehicles[0].history[0].userName, data.users), 'Beatrice');
    assert.equal(users.displayUserName(data.inventoryReports[0].userId, data.inventoryReports[0].actorName, data.users), 'Beatrice');
    assert.equal(users.displayLogMessage(data.logs[2], data.users), 'Uttag: Tejp (kvar: 1) — Kalle');

    const ownLogs = data.logs.filter(entry => users.matchesUser(entry, user));
    assert.deepEqual(ownLogs.map(entry => entry._id), ['l1', 'l2']);
    const stats = users.statsForUser(user, data);
    assert.equal(stats.events, 2);
    assert.equal(stats.scans, 1);
    assert.equal(stats.additions, 1);
    assert.equal(stats.inventories, 1);
    assert.equal(stats.withdrawals, 1);
    assert.equal(users.statsForUser(other, data).withdrawals, 1);

    const presented = users.presentVehicle(data.vehicles[0], users.indexUsers(data.users));
    assert.equal(presented.history[0].userDisplayName, 'Beatrice');
    assert.equal(presented.history[0].userName, 'Anna');
    const report = users.presentInventoryReport(data.inventoryReports[0], data.users);
    assert.equal(report.actorDisplayName, 'Beatrice');
    assert.equal(report.actorName, 'Anna');
  });

  it('faller tillbaka till det sparade namnet när användaren är borta', () => {
    const log = { userId: 'dddddddddddddddddddddddd', actorName: 'Raderad', msg: 'Uttag: Borr (kvar: 1) — Raderad' };
    assert.equal(users.displayLogMessage(log, []), 'Uttag: Borr (kvar: 1) — Raderad');
    assert.equal(users.displayUserName(null, 'Raderad', []), 'Raderad');
  });
});

describe('migrering av userId', () => {
  function fixture() {
    return {
      users: [anna(), { _id: 'aaaaaaaaaaaaaaaaaaaaaaa2', tenantId: tenantA, name: 'Kalle' }],
      logs: [
        { _id: 'l1', tenantId: tenantA, msg: 'Uttag: Borr (kvar: 3) — Anna' },
        { _id: 'l2', tenantId: tenantA, msg: 'Ny produkt tillagd: Borr' },
        { _id: 'l3', tenantId: tenantA, msg: 'Uttag: Tejp (kvar: 1) — Okänd' },
        { _id: 'l4', tenantId: tenantA, msg: 'Påfyllning: List (nu 2) — Anna' }
      ],
      vehicles: [{
        _id: 'v1',
        tenantId: tenantA,
        history: [
          { time: 't1', productName: 'Borr', qty: 1, userName: 'Anna', articleNo: '1' },
          { time: 't2', productName: 'Saknas', qty: 2, userName: 'Borta', articleNo: '2' }
        ]
      }],
      inventoryReports: [
        { _id: 'r1', tenantId: tenantA, actorName: 'Anna' },
        { _id: 'r2', tenantId: tenantA, actorName: 'Ingen sådan' }
      ],
      orders: [{ _id: 'o1', tenantId: tenantA, name: 'Anna', code: '123' }]
    };
  }

  it('kopplar unika namn, bevarar texten och är idempotent', () => {
    const input = fixture();
    const plan = users.planBackfill(input);
    assert.equal(plan.logs.matched, 2);
    assert.equal(plan.logs.noActor, 1);
    assert.equal(plan.logs.unmatched, 1);
    assert.equal(plan.vehicles.matched, 1);
    assert.equal(plan.vehicles.unmatched, 1);
    assert.equal(plan.inventoryReports.matched, 1);
    assert.equal(plan.inventoryReports.unmatched, 1);
    assert.equal(plan.orders.updated, 0);
    for (const update of plan.logs.updates) {
      assert.equal(update.set.msg, undefined);
      assert.equal(update.set.userName, undefined);
    }

    const once = users.applyBackfill(input, plan);
    assert.equal(once.logs[0].msg, input.logs[0].msg);
    assert.equal(once.logs[0].userId, anna()._id);
    assert.equal(once.logs[0].actorName, 'Anna');
    assert.equal(once.logs[2].userId, null);
    assert.equal(once.logs[2].legacyActorName, 'Okänd');
    assert.equal(once.logs[2].msg, 'Uttag: Tejp (kvar: 1) — Okänd');
    assert.equal(once.vehicles[0].history[0].userName, 'Anna');
    assert.equal(once.vehicles[0].history[0].userId, anna()._id);
    assert.equal(once.vehicles[0].history[0].productName, 'Borr');
    assert.equal(once.vehicles[0].history[1].userName, 'Borta');
    assert.equal(once.vehicles[0].history[1].userId, null);
    assert.equal(once.vehicles[0].history[1].legacyActorName, 'Borta');
    assert.equal(once.inventoryReports[0].actorName, 'Anna');
    assert.equal(once.inventoryReports[0].userId, anna()._id);
    assert.equal(once.inventoryReports[1].actorName, 'Ingen sådan');
    assert.equal(once.inventoryReports[1].userId, null);
    assert.deepEqual(once.orders, input.orders.map(order => ({ ...order })));

    const again = users.planBackfill(once);
    assert.equal(again.logs.updates.length, 0);
    assert.equal(again.vehicles.updates.length, 0);
    assert.equal(again.inventoryReports.updates.length, 0);
    const twice = users.applyBackfill(once, again);
    assert.equal(twice.logs[0].msg, input.logs[0].msg);
    assert.equal(twice.vehicles[0].history[1].userName, 'Borta');
    assert.equal(twice.logs[2].legacyActorName, 'Okänd');
  });

  it('dubbletter och andra verkstäder kopplas inte', () => {
    const input = {
      users: [
        anna(),
        { _id: 'aaaaaaaaaaaaaaaaaaaaaaa3', tenantId: tenantA, name: 'Anna' },
        { _id: 'bbbbbbbbbbbbbbbbbbbbbbb1', tenantId: tenantB, name: 'Kalle' }
      ],
      logs: [
        { _id: 'l1', tenantId: tenantA, msg: 'Uttag: Borr (kvar: 1) — Anna' },
        { _id: 'l2', tenantId: tenantA, msg: 'Uttag: Tejp (kvar: 1) — Kalle' }
      ],
      vehicles: [],
      inventoryReports: [],
      orders: []
    };
    const plan = users.planBackfill(input);
    assert.equal(plan.logs.ambiguous, 1);
    assert.equal(plan.logs.unmatched, 1);
    assert.equal(plan.logs.matched, 0);
    const done = users.applyBackfill(input, plan);
    assert.equal(done.logs[0].userId, null);
    assert.equal(done.logs[0].legacyActorName, 'Anna');
    assert.equal(done.logs[0].msg, input.logs[0].msg);
    assert.equal(done.logs[1].userId, null);
    assert.equal(done.logs[1].legacyActorName, 'Kalle');
  });

  it('byter man namn efter kopplingen följer historiken fortfarande id:t', () => {
    const input = fixture();
    const linked = users.applyBackfill(input, users.planBackfill(input));
    linked.users[0].name = 'Beatrice';
    const user = linked.users[0];
    assert.equal(users.displayLogMessage(linked.logs[0], linked.users), 'Uttag: Borr (kvar: 3) — Beatrice');
    assert.equal(users.matchesUser(linked.logs[0], user), true);
    assert.equal(users.matchesUser(linked.vehicles[0].history[0], user), true);
    assert.equal(users.matchesUser(linked.inventoryReports[0], user), true);
    assert.equal(users.displayUserName(linked.vehicles[0].history[1].userId, linked.vehicles[0].history[1].userName, linked.users), 'Borta');
    const stats = users.statsForUser(user, linked);
    assert.equal(stats.scans, 1);
    assert.equal(stats.withdrawals, 1);
    assert.equal(stats.inventories, 1);
  });

  it('skriptet skriver bara userId-fält och lämnar namn ifred', () => {
    const set = migration.linkSet({ userId: 'aaaaaaaaaaaaaaaaaaaaaaa1', legacyActorName: 'Anna', msg: 'ska bort', userName: 'Anna', actorName: 'Anna' });
    assert.deepEqual(Object.keys(set).sort(), ['actorName', 'legacyActorName', 'userId']);
    assert.equal(String(set.userId), 'aaaaaaaaaaaaaaaaaaaaaaa1');
    const before = [{ userName: 'Anna', productName: 'Borr', time: 't', qty: 1 }];
    const after = [{ userName: 'Anna', productName: 'Borr', time: 't', qty: 1, userId: 'x' }];
    assert.equal(migration.namesIntact(before, after), true);
    assert.equal(migration.namesIntact(before, [{ userName: 'Beatrice', productName: 'Borr', time: 't', qty: 1 }]), false);
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const pkg = fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8');
    assert.equal(server.includes('backfill-user-ids'), false);
    assert.equal(JSON.parse(pkg).scripts.start.includes('backfill'), false);
    const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
    assert.match(readme, /node scripts\/backfill-user-ids\.js/);
    assert.match(readme, /--apply/);
  });
});

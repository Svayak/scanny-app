const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const userLink = require('../public/js/user-link');
const { persistActor, withdrawalEntry } = require('../user-id-store');
const backfill = require('../scripts/backfill-user-ids');
const repair = require('../scripts/repair-invalid-user-ids');

function emptyTotals() {
  return { examined: 0, matched: 0, ambiguous: 0, unmatched: 0, already: 0, noActor: 0, updates: [], samples: [] };
}

describe('idOf och sparade userId', () => {
  it('läser ObjectId som 24 hex och inte de 12 råa byten', () => {
    const oid = new mongoose.Types.ObjectId();
    assert.equal(userLink.idOf(oid), oid.toHexString());
    assert.equal(userLink.idOf(oid), String(oid));
    assert.equal(userLink.idOf(oid.id), null);
    assert.notEqual(String(oid.id), oid.toHexString());
    assert.equal(userLink.idOf('inte-ett-id'), null);
    assert.equal(userLink.idOf(''), null);
    assert.equal(userLink.idOf({ _id: oid, name: 'Anna' }), oid.toHexString());
  });

  it('skriver ett riktigt ObjectId från agerande användare', () => {
    const oid = new mongoose.Types.ObjectId();
    const actor = { _id: oid, name: 'Anna' };
    const link = persistActor(actor);
    assert.ok(link.userId instanceof mongoose.Types.ObjectId);
    assert.equal(link.userId.toHexString(), oid.toHexString());
    assert.equal(link.actorName, 'Anna');
    assert.deepEqual(persistActor({ _id: oid.id, name: 'Anna' }), {});
    assert.equal(userLink.actorFields(actor).userId, oid.toHexString());
  });

  it('ett uttag följer användaren efter namnbyte', () => {
    const user = {
      _id: new mongoose.Types.ObjectId(),
      tenantId: new mongoose.Types.ObjectId(),
      name: 'Anna',
      role: 'staff'
    };
    const entry = withdrawalEntry(user, {
      productName: 'Borr',
      qty: 1,
      userName: 'fel namn från klienten',
      articleNo: 'A-1',
      supplier: 'Würth'
    });
    const log = {
      _id: new mongoose.Types.ObjectId(),
      tenantId: user.tenantId,
      msg: 'Uttag: Borr (kvar: 2) — Anna',
      actorName: 'Anna',
      userId: entry.userId,
      type: 'normal'
    };
    assert.equal(entry.userId.toHexString(), user._id.toHexString());
    assert.equal(entry.userName, 'Anna');
    assert.notEqual(entry.userId.toHexString(), String(user._id.id));

    user.name = 'Beatrice';
    const users = [user];
    assert.equal(userLink.displayUserName(entry.userId, entry.userName, users), 'Beatrice');
    assert.equal(userLink.displayLogMessage(log, users), 'Uttag: Borr (kvar: 2) — Beatrice');
    assert.equal(userLink.matchesUser(entry, user), true);
    assert.equal(userLink.matchesUser(log, user), true);
    assert.equal(entry.userName, 'Anna');
    assert.equal(log.actorName, 'Anna');
  });
});

describe('backfill skriver bara giltiga ObjectId', () => {
  it('kopplar ett riktigt ObjectId och vägrar skräp', () => {
    const userId = new mongoose.Types.ObjectId();
    const tenantId = new mongoose.Types.ObjectId();
    const plan = userLink.planBackfill({
      users: [{ _id: userId, tenantId, name: 'Anna' }],
      logs: [{ _id: new mongoose.Types.ObjectId(), tenantId, msg: 'Uttag: Borr (kvar: 3) — Anna' }],
      vehicles: [{
        _id: new mongoose.Types.ObjectId(),
        tenantId,
        history: [{ time: 't', productName: 'Borr', qty: 1, userName: 'Anna' }]
      }],
      inventoryReports: [{ _id: new mongoose.Types.ObjectId(), tenantId, actorName: 'Anna' }]
    });
    assert.equal(plan.logs.updates[0].set.userId, userId.toHexString());
    assert.notEqual(plan.logs.updates[0].set.userId, String(userId.id));
    const set = backfill.linkSet(plan.logs.updates[0].set);
    assert.equal(set.userId.toHexString(), userId.toHexString());
    assert.equal(backfill.linkSet({ userId: String(userId.id), actorName: 'Anna' }), null);

    const garbage = String(userId.id);
    const history = backfill.sanitizeHistory([
      { time: 't', productName: 'Borr', qty: 1, userName: 'Anna', userId: garbage }
    ]);
    assert.equal(history, null);
    const clean = backfill.sanitizeHistory([
      { time: 't', productName: 'Borr', qty: 1, userName: 'Anna', userId: userId }
    ]);
    assert.equal(clean[0].userName, 'Anna');
    assert.equal(clean[0].userId.toHexString(), userId.toHexString());
  });

  it('torrkörningens skrivningar räknar planerade uppdateringar', () => {
    const totals = emptyTotals();
    backfill.addBucket(totals, {
      examined: 2,
      matched: 2,
      updates: [{ id: new mongoose.Types.ObjectId() }, { id: new mongoose.Types.ObjectId() }],
      samples: [{ id: new mongoose.Types.ObjectId(), tenantId: new mongoose.Types.ObjectId(), name: 'Anna', reason: 'matched' }]
    });
    assert.equal(totals.updates.length, 2);
    assert.equal(backfill.formatId(totals.samples[0].id), totals.samples[0].id.toHexString());
  });
});

describe('reparation av ogiltiga userId', () => {
  it('tar bara bort trasiga id och är idempotent', () => {
    const tenantId = new mongoose.Types.ObjectId();
    const otherTenant = new mongoose.Types.ObjectId();
    const anna = new mongoose.Types.ObjectId();
    const kalle = new mongoose.Types.ObjectId();
    const garbage = String(anna.id);
    const state = {
      users: [
        { _id: anna, tenantId, name: 'Anna' },
        { _id: kalle, tenantId: otherTenant, name: 'Kalle' }
      ],
      logs: [
        { _id: 'log-ok', tenantId, userId: anna, actorName: 'Anna', msg: 'Uttag: Borr (kvar: 1) — Anna' },
        { _id: 'log-bad', tenantId, userId: garbage, actorName: 'Anna', msg: 'Uttag: Spik (kvar: 1) — Anna' },
        { _id: 'log-gone', tenantId, userId: new mongoose.Types.ObjectId(), actorName: 'Borta', msg: 'Uttag: List (kvar: 1) — Borta' },
        { _id: 'log-other', tenantId, userId: kalle, actorName: 'Kalle', msg: 'Uttag: Tejp (kvar: 1) — Kalle' }
      ],
      vehicles: [{
        _id: 'veh-1',
        tenantId,
        history: [
          { time: 't1', productName: 'Borr', qty: 1, userName: 'Anna', userId: anna },
          { time: 't2', productName: 'Spik', qty: 2, userName: 'Anna', userId: garbage }
        ]
      }],
      inventoryReports: [
        { _id: 'rep-ok', tenantId, userId: anna, actorName: 'Anna' },
        { _id: 'rep-bad', tenantId, userId: garbage, actorName: 'Anna' }
      ]
    };
    const plan = repair.planRepair(state);
    assert.equal(plan.logs.invalid, 1);
    assert.equal(plan.logs.missingUser, 2);
    assert.equal(plan.logs.kept, 1);
    assert.equal(plan.vehicles.invalid, 1);
    assert.equal(plan.vehicles.kept, 1);
    assert.equal(plan.inventoryReports.invalid, 1);
    assert.equal(plan.inventoryReports.kept, 1);

    const once = repair.commitRepair(state, plan);
    assert.equal(once.logs.find(log => log._id === 'log-ok').userId.toHexString(), anna.toHexString());
    assert.equal(once.logs.find(log => log._id === 'log-bad').userId, undefined);
    assert.equal(once.logs.find(log => log._id === 'log-bad').msg, state.logs[1].msg);
    assert.equal(once.logs.find(log => log._id === 'log-bad').actorName, 'Anna');
    assert.equal(once.logs.find(log => log._id === 'log-other').userId, undefined);
    assert.equal(once.vehicles[0].history[0].userId.toHexString(), anna.toHexString());
    assert.equal(once.vehicles[0].history[1].userId, undefined);
    assert.equal(once.vehicles[0].history[1].userName, 'Anna');
    assert.equal(once.vehicles[0].history[1].productName, 'Spik');
    assert.equal(once.vehicles[0].history[1].qty, 2);
    assert.equal(once.inventoryReports.find(report => report._id === 'rep-bad').userId, undefined);
    assert.equal(once.inventoryReports.find(report => report._id === 'rep-bad').actorName, 'Anna');

    const again = repair.planRepair(once);
    assert.equal(again.logs.unset, 0);
    assert.equal(again.vehicles.unset, 0);
    assert.equal(again.inventoryReports.unset, 0);
  });
});

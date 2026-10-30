#!/usr/bin/env node
// Fyller i userId på historik som bara har ett namn.
// Skriver inget utan --apply. Körs inte av servern eller vid deploy.
//
//   node scripts/backfill-user-ids.js
//   node scripts/backfill-user-ids.js --apply

require('dotenv').config();
const mongoose = require('mongoose');
const { User, Log, Vehicle, InventoryReport, Order, Product, PrintJob } = require('../models');
const userLink = require('../public/js/user-link');

const APPLY = process.argv.includes('--apply');

function asObjectId(id) {
  const text = String(id || '');
  if (!/^[a-fA-F0-9]{24}$/.test(text)) return null;
  return new mongoose.Types.ObjectId(text);
}

function linkSet(set) {
  const out = {};
  if (!set) return out;
  if (Object.prototype.hasOwnProperty.call(set, 'userId')) {
    out.userId = set.userId == null ? null : asObjectId(set.userId);
  }
  if (set.legacyActorName) out.legacyActorName = set.legacyActorName;
  if (set.actorName) out.actorName = set.actorName;
  return out;
}

function openFilter(id, tenantId) {
  const filter = {
    _id: id,
    $and: [
      { $or: [{ userId: { $exists: false } }, { userId: null }] },
      { $or: [{ legacyActorName: { $exists: false } }, { legacyActorName: null }, { legacyActorName: '' }] }
    ]
  };
  if (tenantId) filter.tenantId = tenantId;
  return filter;
}

function namesIntact(before, after) {
  if ((before || []).length !== (after || []).length) return false;
  return before.every((row, index) => {
    const next = after[index] || {};
    return row.userName === next.userName && row.productName === next.productName && row.time === next.time && row.qty === next.qty;
  });
}

async function applyPlan(plan) {
  const written = { logs: 0, vehicles: 0, inventoryReports: 0, skippedUnsafe: 0 };
  for (const update of plan.logs.updates) {
    const set = linkSet(update.set);
    if (set.userId === null && update.set.userId) {
      written.skippedUnsafe += 1;
      continue;
    }
    const actorName = set.actorName;
    delete set.actorName;
    const result = await Log.updateOne(openFilter(update.id, update.tenantId), { $set: set });
    if (actorName) {
      await Log.updateOne(
        { _id: update.id, tenantId: update.tenantId, $or: [{ actorName: { $exists: false } }, { actorName: null }, { actorName: '' }] },
        { $set: { actorName } }
      );
    }
    if (result.modifiedCount) written.logs += 1;
  }
  for (const update of plan.vehicles.updates) {
    const vehicle = await Vehicle.findOne({ _id: update.id, tenantId: update.tenantId });
    if (!vehicle) continue;
    const before = (vehicle.history || []).map(row => (typeof row.toObject === 'function' ? row.toObject() : { ...row }));
    if (!namesIntact(before, update.history)) {
      written.skippedUnsafe += 1;
      continue;
    }
    const history = update.history.map(row => {
      const copy = { ...row };
      if (copy.userId) {
        const id = asObjectId(copy.userId);
        if (!id) return row;
        copy.userId = id;
      }
      return copy;
    });
    if (!namesIntact(before, history)) {
      written.skippedUnsafe += 1;
      continue;
    }
    await Vehicle.updateOne({ _id: vehicle._id, tenantId: vehicle.tenantId }, { $set: { history } });
    written.vehicles += 1;
  }
  for (const update of plan.inventoryReports.updates) {
    const set = linkSet(update.set);
    delete set.actorName;
    if (set.userId === null && update.set.userId) {
      written.skippedUnsafe += 1;
      continue;
    }
    const result = await InventoryReport.updateOne(openFilter(update.id, update.tenantId), { $set: set });
    if (result.modifiedCount) written.inventoryReports += 1;
  }
  return written;
}

function printBucket(name, bucket) {
  console.log(`\n${name}`);
  console.log(`  granskade: ${bucket.examined}`);
  console.log(`  kopplas: ${bucket.matched}`);
  console.log(`  redan kopplade: ${bucket.already}`);
  console.log(`  ingen användare i texten: ${bucket.noActor}`);
  console.log(`  oklara (dubblett): ${bucket.ambiguous}`);
  console.log(`  utan träff: ${bucket.unmatched}`);
  console.log(`  skrivningar: ${bucket.updates.length}`);
  for (const sample of (bucket.samples || []).slice(0, 30)) {
    console.log(`  - ${sample.reason}: ${sample.name} (${sample.id || 'utan id'}, verkstad ${sample.tenantId || '—'})`);
  }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI saknas. Sätt variabeln och kör igen. Inget skrevs.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const totals = {
    logs: { examined: 0, matched: 0, ambiguous: 0, unmatched: 0, already: 0, noActor: 0, updates: [], samples: [] },
    vehicles: { examined: 0, matched: 0, ambiguous: 0, unmatched: 0, already: 0, noActor: 0, updates: [], samples: [], documents: 0 },
    inventoryReports: { examined: 0, matched: 0, ambiguous: 0, unmatched: 0, already: 0, noActor: 0, updates: [], samples: [] },
    orders: { documents: 0, updated: 0 }
  };
  const add = (target, bucket, key) => {
    for (const field of ['examined', 'matched', 'ambiguous', 'unmatched', 'already', 'noActor']) {
      target[field] += bucket[field] || 0;
    }
    if (key === 'updates') target.updates.push(...bucket.updates);
    target.samples.push(...(bucket.samples || []));
    if (bucket.documents) target.documents = (target.documents || 0) + bucket.documents;
  };

  const users = await User.find().select('name tenantId').lean();
  const logs = await Log.find().select('tenantId msg actorName userId legacyActorName').lean();
  const vehicles = await Vehicle.find().select('tenantId history').lean();
  const inventoryReports = await InventoryReport.find().select('tenantId actorName userId legacyActorName').lean();
  const [orders, products, printJobs] = await Promise.all([
    Order.countDocuments(),
    Product.countDocuments(),
    PrintJob.countDocuments()
  ]);

  const byTenant = new Map();
  const tenantOf = (row) => String(row.tenantId || '');
  for (const row of users) {
    const key = tenantOf(row);
    if (!byTenant.has(key)) byTenant.set(key, { users: [], logs: [], vehicles: [], inventoryReports: [] });
    byTenant.get(key).users.push(row);
  }
  for (const row of [...logs, ...vehicles, ...inventoryReports]) {
    const key = tenantOf(row);
    if (!byTenant.has(key)) byTenant.set(key, { users: [], logs: [], vehicles: [], inventoryReports: [] });
  }
  for (const row of logs) byTenant.get(tenantOf(row)).logs.push(row);
  for (const row of vehicles) byTenant.get(tenantOf(row)).vehicles.push(row);
  for (const row of inventoryReports) byTenant.get(tenantOf(row)).inventoryReports.push(row);

  const plans = [];
  for (const group of byTenant.values()) {
    const plan = userLink.planBackfill(group);
    plans.push(plan);
    add(totals.logs, plan.logs);
    add(totals.vehicles, plan.vehicles);
    add(totals.inventoryReports, plan.inventoryReports);
  }
  totals.orders.documents = orders;

  console.log(APPLY ? 'Läge: apply (skriver userId)' : 'Läge: torrkörning (skriver inget)');
  printBucket('Händelselogg', totals.logs);
  printBucket('Fordon, uttag i historiken', totals.vehicles);
  printBucket('Inventeringsrapporter', totals.inventoryReports);
  console.log('\nOrdrar');
  console.log(`  dokument: ${orders}`);
  console.log('  skrivningar: 0');
  console.log('  Order.name är produktnamn. Ordrar har ingen användarreferens och lämnas orörda.');
  console.log('\nÖvrigt utan användarreferens');
  console.log(`  produkter: ${products}, utskriftsjobb: ${printJobs} — orörda`);

  if (!APPLY) {
    console.log('\nInget skrevs. Kör med --apply när torrkörningen ser rätt ut.');
    await mongoose.disconnect();
    return;
  }

  let written = { logs: 0, vehicles: 0, inventoryReports: 0, skippedUnsafe: 0 };
  for (const plan of plans) {
    const part = await applyPlan(plan);
    written.logs += part.logs;
    written.vehicles += part.vehicles;
    written.inventoryReports += part.inventoryReports;
    written.skippedUnsafe += part.skippedUnsafe;
  }
  console.log('\nKlart.');
  console.log(`  loggar uppdaterade: ${written.logs}`);
  console.log(`  fordon uppdaterade: ${written.vehicles}`);
  console.log(`  inventeringar uppdaterade: ${written.inventoryReports}`);
  console.log(`  överhoppade osäkra: ${written.skippedUnsafe}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Migreringen avbröts. Inga namn eller texter tas bort av skriptet.');
    console.error(err && err.message ? err.message : err);
    mongoose.disconnect().finally(() => process.exit(1));
  });
}

module.exports = { applyPlan, linkSet, namesIntact, openFilter };

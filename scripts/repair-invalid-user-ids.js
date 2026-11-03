#!/usr/bin/env node
// Tar bort userId som inte är ett giltigt ObjectId, eller som inte pekar
// på en användare i samma verkstad. Namn och texter rörs inte.
// Skriver inget utan --apply. Körs inte vid deploy.
//
//   node scripts/repair-invalid-user-ids.js
//   node scripts/repair-invalid-user-ids.js --apply

require('dotenv').config();
const mongoose = require('mongoose');
const { User, Log, Vehicle, InventoryReport, Order, Product, PrintJob } = require('../models');
const userLink = require('../public/js/user-link');

const APPLY = process.argv.includes('--apply');

function plain(row) {
  if (!row) return row;
  return typeof row.toObject === 'function' ? row.toObject() : { ...row };
}

function userBelongs(userId, tenantId, users) {
  const hex = userLink.idOf(userId);
  const tenant = userLink.idOf(tenantId);
  if (!hex || !tenant) return false;
  return (users || []).some(user => userLink.idOf(user) === hex && userLink.idOf(user.tenantId) === tenant);
}

// Saknat userId är inget att laga. Ogiltigt id, eller id utan användare i verkstaden, ska bort.
function userIdProblem(userId, tenantId, users) {
  if (userId == null || userId === '') return null;
  const hex = userLink.idOf(userId);
  if (!hex) return 'ogiltigt';
  if (!userBelongs(userId, tenantId, users)) return 'saknar användare';
  return null;
}

function emptyBucket() {
  return { examined: 0, kept: 0, invalid: 0, missingUser: 0, unset: 0, updates: [] };
}

function planRepair(input) {
  const source = input || {};
  const users = source.users || [];
  const logs = emptyBucket();
  const vehicles = emptyBucket();
  const inventoryReports = emptyBucket();
  vehicles.documents = (source.vehicles || []).length;

  function note(bucket, problem) {
    if (problem === 'ogiltigt') bucket.invalid += 1;
    else bucket.missingUser += 1;
    bucket.unset += 1;
  }

  for (const log of source.logs || []) {
    logs.examined += 1;
    const problem = userIdProblem(log.userId, log.tenantId, users);
    if (!problem) {
      if (log.userId != null && log.userId !== '') logs.kept += 1;
      continue;
    }
    note(logs, problem);
    logs.updates.push({ id: log._id || log.id, tenantId: log.tenantId, reason: problem });
  }

  for (const vehicle of source.vehicles || []) {
    let changed = false;
    const history = (vehicle.history || []).map(row => {
      vehicles.examined += 1;
      const entry = plain(row);
      const problem = userIdProblem(entry.userId, vehicle.tenantId, users);
      if (!problem) {
        if (entry.userId != null && entry.userId !== '') vehicles.kept += 1;
        return entry;
      }
      note(vehicles, problem);
      changed = true;
      const copy = { ...entry };
      delete copy.userId;
      return copy;
    });
    if (changed) {
      vehicles.updates.push({
        id: vehicle._id || vehicle.id,
        tenantId: vehicle.tenantId,
        history,
        before: (vehicle.history || []).map(plain)
      });
    }
  }

  for (const report of source.inventoryReports || []) {
    inventoryReports.examined += 1;
    const problem = userIdProblem(report.userId, report.tenantId, users);
    if (!problem) {
      if (report.userId != null && report.userId !== '') inventoryReports.kept += 1;
      continue;
    }
    note(inventoryReports, problem);
    inventoryReports.updates.push({ id: report._id || report.id, tenantId: report.tenantId, reason: problem });
  }

  return { logs, vehicles, inventoryReports };
}

function namesIntact(before, after) {
  if ((before || []).length !== (after || []).length) return false;
  return before.every((row, index) => {
    const next = after[index] || {};
    return row.userName === next.userName
      && row.productName === next.productName
      && row.time === next.time
      && row.qty === next.qty
      && row.msg === next.msg
      && row.actorName === next.actorName;
  });
}

function commitRepair(state, plan) {
  const source = state || {};
  const decided = plan || planRepair(source);
  const next = {
    users: (source.users || []).map(user => ({ ...user })),
    logs: (source.logs || []).map(log => ({ ...log })),
    vehicles: (source.vehicles || []).map(vehicle => ({
      ...vehicle,
      history: (vehicle.history || []).map(row => ({ ...plain(row) }))
    })),
    inventoryReports: (source.inventoryReports || []).map(report => ({ ...report }))
  };
  for (const update of decided.logs.updates) {
    const log = next.logs.find(entry => String(entry._id || entry.id) === String(update.id));
    if (!log) continue;
    const msg = log.msg;
    const actorName = log.actorName;
    delete log.userId;
    log.msg = msg;
    log.actorName = actorName;
  }
  for (const update of decided.vehicles.updates) {
    const vehicle = next.vehicles.find(entry => String(entry._id || entry.id) === String(update.id));
    if (!vehicle || !namesIntact(update.before, update.history)) continue;
    vehicle.history = update.history.map(row => ({ ...row }));
  }
  for (const update of decided.inventoryReports.updates) {
    const report = next.inventoryReports.find(entry => String(entry._id || entry.id) === String(update.id));
    if (!report) continue;
    const actorName = report.actorName;
    delete report.userId;
    report.actorName = actorName;
  }
  return next;
}

function printBucket(name, bucket) {
  console.log(`\n${name}`);
  console.log(`  granskade: ${bucket.examined}`);
  console.log(`  behålls: ${bucket.kept}`);
  console.log(`  ogiltigt id: ${bucket.invalid}`);
  console.log(`  saknar användare i verkstaden: ${bucket.missingUser}`);
  console.log(`  userId tas bort: ${bucket.unset}`);
}

async function applyRepair(plan) {
  const written = { logs: 0, vehicles: 0, inventoryReports: 0, skippedUnsafe: 0 };
  for (const update of plan.logs.updates) {
    const result = await Log.updateOne(
      { _id: update.id, tenantId: update.tenantId },
      { $unset: { userId: '' } }
    );
    if (result.modifiedCount) written.logs += 1;
  }
  for (const update of plan.vehicles.updates) {
    const vehicle = await Vehicle.findOne({ _id: update.id, tenantId: update.tenantId });
    if (!vehicle) continue;
    const before = (vehicle.history || []).map(plain);
    if (!namesIntact(before, update.history)) {
      written.skippedUnsafe += 1;
      continue;
    }
    await Vehicle.updateOne({ _id: vehicle._id, tenantId: vehicle.tenantId }, { $set: { history: update.history } });
    written.vehicles += 1;
  }
  for (const update of plan.inventoryReports.updates) {
    const result = await InventoryReport.updateOne(
      { _id: update.id, tenantId: update.tenantId },
      { $unset: { userId: '' } }
    );
    if (result.modifiedCount) written.inventoryReports += 1;
  }
  return written;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI saknas. Sätt variabeln och kör igen. Inget skrevs.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await User.find().select('name tenantId').lean();
  const logs = await Log.find().select('tenantId msg actorName userId').lean();
  const vehicles = await Vehicle.find().select('tenantId history').lean();
  const inventoryReports = await InventoryReport.find().select('tenantId actorName userId').lean();
  const [orders, products, printJobs] = await Promise.all([
    Order.countDocuments(),
    Product.countDocuments(),
    PrintJob.countDocuments()
  ]);
  const plan = planRepair({ users, logs, vehicles, inventoryReports });
  console.log(APPLY ? 'Läge: apply (tar bara bort ogiltiga userId)' : 'Läge: torrkörning (skriver inget)');
  printBucket('Händelselogg', plan.logs);
  printBucket('Fordon, uttag i historiken', plan.vehicles);
  printBucket('Inventeringsrapporter', plan.inventoryReports);
  console.log('\nUtan userId-fält');
  console.log(`  ordrar: ${orders}, produkter: ${products}, utskriftsjobb: ${printJobs} — orörda`);
  if (!APPLY) {
    console.log('\nInget skrevs. Kör med --apply när torrkörningen ser rätt ut.');
    await mongoose.disconnect();
    return;
  }
  const written = await applyRepair(plan);
  console.log('\nKlart.');
  console.log(`  loggar: ${written.logs}`);
  console.log(`  fordon: ${written.vehicles}`);
  console.log(`  inventeringar: ${written.inventoryReports}`);
  console.log(`  överhoppade osäkra: ${written.skippedUnsafe}`);
  await mongoose.disconnect();
  if (written.skippedUnsafe) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Reparationen avbröts. Inga namn eller texter tas bort av skriptet.');
    console.error(err && err.message ? err.message : err);
    mongoose.disconnect().finally(() => process.exit(1));
  });
}

module.exports = { planRepair, commitRepair, userIdProblem, namesIntact, applyRepair };

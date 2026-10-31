const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const logQuery = require('../public/js/log-query');

const tenantA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const tenantB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const anna = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const kalle = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const gone = 'aaaaaaaaaaaaaaaaaaaaaaa3';

function row(extra) {
  return {
    tenantId: tenantA,
    createdAt: new Date('2026-03-01T12:00:00Z'),
    date: '2026-03-01',
    time: '13:00',
    msg: '',
    type: 'normal',
    actorName: '',
    ...extra
  };
}

describe('händelselogg API', () => {
  const users = [
    { _id: anna, id: anna, name: 'Beatrice' },
    { _id: kalle, id: kalle, name: 'Kalle' }
  ];
  const rows = [
    row({
      _id: 'l1', createdAt: new Date('2026-01-15T09:00:00Z'), date: '2026-01-15', time: '10:00',
      activityType: 'uttag', productName: 'Borr', articleNo: 'A-1', code: '111', qty: 1,
      userId: anna, actorName: 'Anna', msg: 'Uttag: Borr (kvar: 3) — Anna'
    }),
    row({
      _id: 'l2', createdAt: new Date('2026-07-15T10:00:00Z'), date: '2026-07-15', time: '12:00',
      activityType: 'addera', productName: 'Mutter', articleNo: 'B-2', code: '222', qty: 1,
      userId: kalle, actorName: 'Kalle', msg: 'Påfyllning: Mutter (nu 4) — Kalle'
    }),
    row({
      _id: 'l3', createdAt: new Date('2026-02-01T08:00:00Z'), date: '2026-02-01', time: '09:00',
      activityType: 'inventering', qty: 12, userId: anna, actorName: 'Anna',
      msg: 'Inventering: 12 artiklar, 1 differenser — Anna'
    }),
    row({
      _id: 'l4', createdAt: new Date('2026-02-02T08:00:00Z'), date: '2026-02-02', time: '09:00',
      activityType: 'admin', userId: kalle, actorName: 'Kalle', msg: 'Ny användare: Bea'
    }),
    row({
      _id: 'legacy', createdAt: new Date('2026-01-10T08:00:00Z'), date: '2026-01-10', time: '09:00',
      msg: 'Uttag: Spik (kvar: 9) — Anna'
    }),
    row({
      _id: 'other', tenantId: tenantB, createdAt: new Date('2026-01-15T09:00:00Z'),
      activityType: 'uttag', productName: 'Hemlig', articleNo: 'A-1', qty: 9, userId: anna,
      msg: 'Uttag: Hemlig (kvar: 1) — Anna'
    }),
    row({
      _id: 'deleted', createdAt: new Date('2026-01-20T09:00:00Z'), date: '2026-01-20', time: '10:00',
      activityType: 'uttag', productName: 'Bricka', articleNo: 'C-3', code: '333', qty: 1,
      userId: gone, actorName: 'Borta', msg: 'Uttag: Bricka (kvar: 1) — Borta'
    })
  ];

  function run(extra) {
    return logQuery.runLogQuery(rows, { tenantId: tenantA, knownUserIds: [anna, kalle], ...extra });
  }

  it('sorterar på vitlistade fält och byter håll', () => {
    const desc = run({ sort: 'date', dir: 'desc', pageSize: 20 });
    assert.deepEqual(desc.items.map(item => item._id), ['l2', 'l4', 'l3', 'deleted', 'l1', 'legacy']);
    const asc = run({ sort: 'articleNo', dir: 'asc', pageSize: 20 });
    assert.equal(asc.items[0].articleNo, 'A-1');
    assert.equal(asc.items.at(-1)._id, 'legacy');
    const qty = run({ sort: 'qty', dir: 'desc', pageSize: 20 });
    assert.equal(qty.items[0].qty, 12);
    assert.ok(qty.items.some(item => item._id === 'legacy'));
    const injected = logQuery.buildLogQuery({ tenantId: tenantA, sort: 'tenantId', dir: 'asc' });
    assert.deepEqual(injected.sort, { createdAt: 1 });
    assert.deepEqual(logQuery.buildLogQuery({ tenantId: tenantA, sort: 'nope' }).sort, { createdAt: -1 });
    assert.equal(JSON.stringify(injected).includes('$regexMatch'), false);
  });

  it('filtrerar datum i Europe/Stockholm, person via userId, typ och text', () => {
    const winter = logQuery.stockholmBoundary('2026-01-15', false);
    const summer = logQuery.stockholmBoundary('2026-07-15', false);
    assert.equal(winter.toISOString(), '2026-01-14T23:00:00.000Z');
    assert.equal(summer.toISOString(), '2026-07-14T22:00:00.000Z');

    const day = run({ from: '2026-01-15', to: '2026-01-15', pageSize: 20 });
    assert.deepEqual(day.items.map(item => item._id), ['l1']);

    const person = run({ userId: anna, pageSize: 20 });
    assert.deepEqual(person.items.map(item => item._id).sort(), ['l1', 'l3']);
    const renamed = logQuery.presentLogItem(person.items[0], users);
    assert.equal(renamed.person, 'Beatrice');

    const unknown = run({ userId: 'unknown', pageSize: 20 });
    assert.deepEqual(unknown.items.map(item => item._id).sort(), ['deleted', 'legacy']);

    const types = run({ type: ['uttag', 'admin'], pageSize: 20 });
    assert.deepEqual(types.items.map(item => item._id).sort(), ['deleted', 'l1', 'l4']);

    const text = run({ q: 'a.1', pageSize: 20 });
    assert.deepEqual(text.items.map(item => item._id), []);
    const found = run({ q: 'spik', pageSize: 20 });
    assert.deepEqual(found.items.map(item => item._id), ['legacy']);
    const code = run({ q: '222', pageSize: 20 });
    assert.deepEqual(code.items.map(item => item._id), ['l2']);
    const built = logQuery.buildLogQuery({ tenantId: tenantA, q: 'a.b' });
    assert.equal(built.filter.$or[0].productName.$regex, 'a\\.b');
    assert.equal(built.filter.$or[0].productName.$options, 'i');
    assert.equal(JSON.stringify(built.filter).includes('$regexMatch'), false);
  });

  it('paginerar med tak på pageSize och håller verkstäder isär', () => {
    const page = run({ sort: 'date', dir: 'asc', page: 2, pageSize: 2 });
    assert.equal(page.total, 6);
    assert.equal(page.page, 2);
    assert.equal(page.items.length, 2);
    const capped = logQuery.buildLogQuery({ tenantId: tenantA, pageSize: 5000, page: 0 });
    assert.equal(capped.pageSize, 100);
    assert.equal(capped.page, 1);
    const other = run({ pageSize: 20 });
    assert.equal(other.items.some(item => item.tenantId === tenantB), false);
    const query = logQuery.buildLogQuery({ tenantId: tenantA, userId: anna });
    assert.equal(String(query.filter.tenantId), tenantA);
    assert.equal(query.filter.userId, anna);
  });

  it('CSV följer samma filter och har svenska rubriker', () => {
    const matched = run({ userId: anna, sort: 'date', dir: 'asc', pageSize: 20 }).items;
    const csv = logQuery.csvDocument(matched, users);
    assert.match(csv, /^﻿Datum,Tid,Artikelnummer,Produkt,Streckkod,Person,Typ,Antal,Händelse/);
    assert.match(csv, /Beatrice/);
    assert.equal(csv.includes('Mutter'), false);
    assert.equal(csv.includes('Hemlig'), false);
    assert.match(csv, /Uttag/);
  });

  it('äldre rader utan struktur syns, sorteras på datum och träffas av textsök', () => {
    const all = run({ sort: 'date', dir: 'asc', pageSize: 20 });
    assert.equal(all.items[0]._id, 'legacy');
    assert.equal(all.items[0].activityType, undefined);
    const searched = run({ q: 'Spik', pageSize: 20 });
    assert.equal(searched.items.length, 1);
    assert.equal(searched.items[0]._id, 'legacy');
    const typed = run({ type: 'uttag', pageSize: 20 });
    assert.equal(typed.items.some(item => item._id === 'legacy'), false);
  });
});

describe('äldre loggtext och Cosmos-index', () => {
  it('tolkar tillförlitlig text utan att röra msg och är idempotent', () => {
    const logs = [
      { _id: 'a', tenantId: tenantA, msg: 'Uttag: Borr 6mm (kvar: 3) — Anna' },
      { _id: 'b', tenantId: tenantA, msg: 'Påfyllning: Mutter (nu 4) — Kalle' },
      { _id: 'c', tenantId: tenantA, msg: 'Inventering: 4 artiklar, 0 differenser — Anna' },
      { _id: 'd', tenantId: tenantA, msg: 'Ny användare: Bea' },
      { _id: 'e', tenantId: tenantA, msg: 'Något otydligt' },
      { _id: 'f', tenantId: tenantA, msg: 'Uttag: Redan (kvar: 1)', activityType: 'uttag', productName: 'Redan', qty: 1 }
    ];
    const plan = logQuery.planLogStructure(logs);
    assert.equal(plan.parsed, 4);
    assert.equal(plan.skipped, 2);
    const uttag = plan.updates.find(update => update.id === 'a');
    assert.deepEqual(uttag.set, { activityType: 'uttag', productName: 'Borr 6mm', qty: 1 });
    assert.equal(uttag.set.msg, undefined);
    const again = logs.map(log => {
      const update = plan.updates.find(item => item.id === log._id);
      return update ? { ...log, ...update.set } : log;
    });
    assert.equal(again[0].msg, logs[0].msg);
    assert.equal(logQuery.planLogStructure(again).updates.length, 0);
  });

  it('varje sorterbart fält har ett eget index och ett tenantId-index', () => {
    const models = fs.readFileSync(path.join(__dirname, '../models.js'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(models, /LOG_SORT_INDEXES = \['createdAt', 'articleNo', 'productName', 'actorName', 'activityType', 'qty'\]/);
    assert.match(models, /logSchema\.index\(\{ \[field\]: 1 \}\)/);
    assert.match(models, /logSchema\.index\(\{ tenantId: 1, \[field\]: 1 \}\)/);
    assert.match(models, /logSchema\.index\(\{ tenantId: 1, \[field\]: -1 \}\)/);
    for (const field of Object.values(logQuery.SORT_FIELDS)) {
      assert.match(models, new RegExp("'" + field + "'"));
    }
    assert.match(server, /app\.get\('\/api\/log',/);
    assert.match(server, /app\.get\('\/api\/log\.csv'/);
    assert.match(server, /logListQuery\(req, known\)/);
    assert.equal(server.includes('$regexMatch'), false);
    const builder = server.slice(server.indexOf('function logListQuery'), server.indexOf("app.get('/api/log.csv'"));
    assert.match(builder, /tenantId: req\.tenantId/);
    assert.equal(builder.includes('req.query.tenantId'), false);
    const route = server.slice(server.indexOf("app.get('/api/log',"), server.indexOf("app.get('/api/logs'"));
    assert.match(route, /serverError\(res, err\)/);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const search = require('../public/js/product-search');

const product = {
  name: 'Borrbit',
  articleNo: 3434,
  code: '7340060807564',
  supplier: 'Würth'
};

describe('product search', () => {
  it('matches article number stored as a number or a string, including substrings', () => {
    assert.equal(search.productMatches(product, '3434'), true);
    assert.equal(search.productMatches(product, '  3434  '), true);
    assert.equal(search.productMatches({ ...product, articleNo: '3434' }, '343'), true);
    assert.equal(search.productMatches({ ...product, articleNo: 'AB-3434' }, '3434'), true);
    assert.equal(search.productMatches(product, '9999'), false);
  });

  it('matches barcode and supplier, case-insensitively', () => {
    assert.equal(search.productMatches(product, '734006'), true);
    assert.equal(search.productMatches(product, '7340060807564'), true);
    assert.equal(search.productMatches(product, 'würth'), true);
    assert.equal(search.productMatches(product, 'WURTH'), false);
    assert.equal(search.productMatches(product, 'WÜRTH'), true);
    assert.equal(search.productMatches(product, 'borr'), true);
  });

  it('treats an empty search as match-all and ignores blank fields', () => {
    assert.equal(search.productMatches(product, '   '), true);
    assert.equal(search.productMatches({ name: 'A', articleNo: null, code: 12, supplier: undefined }, '12'), true);
    assert.equal(search.textField(3434), '3434');
    assert.equal(search.textField(null), '');
    assert.equal(search.textField('  x  '), 'x');
  });

  it('uses plain field regexes Cosmos accepts, and numeric equality for legacy article numbers', () => {
    const filter = search.mongoProductFilter('  34.34  ');
    assert.equal(filter.$expr, undefined);
    assert.equal(JSON.stringify(filter).includes('$regexMatch'), false);
    assert.equal(filter.$or.length, 4);
    for (const key of ['name', 'articleNo', 'code', 'supplier']) {
      const clause = filter.$or.find(item => item[key] && item[key].$regex);
      assert.ok(clause, key);
      assert.equal(clause[key].$regex, '34\\.34');
      assert.equal(clause[key].$options, 'i');
    }
    assert.deepEqual(search.mongoProductFilter('   '), {});

    const numeric = search.mongoProductFilter('3434');
    assert.equal(numeric.$or.length, 5);
    assert.deepEqual(numeric.$or.find(item => item.articleNo === 3434), { articleNo: 3434 });
    assert.equal(numeric.$or.find(item => item.articleNo && item.articleNo.$regex).articleNo.$regex, '3434');
    assert.equal(search.mongoProductFilter('034').$or.some(item => item.articleNo === 34), false);
    assert.equal(search.mongoProductFilter('würth').$or.some(item => typeof item.articleNo === 'number'), false);

    const html = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    assert.match(html, /ScannySearch\.productMatches/);
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(server, /mongoProductFilter\(req\.query\.q\)/);
    assert.match(server, /articleNo: textField\(articleNo\)/);
    assert.match(server, /articleNo: textField\(cell\(row, 'articleNo'\)\)/);
  });
});

describe('async routes do not leak rejections', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  function handlerBody(signature) {
    const start = server.indexOf(signature);
    assert.ok(start >= 0, signature);
    const next = server.indexOf('\napp.', start + signature.length);
    return server.slice(start, next === -1 ? start + 800 : next);
  }

  it('turns a rejected products query into serverError instead of an unhandled rejection', async () => {
    const body = handlerBody("app.get('/api/products'");
    assert.match(body, /try \{/);
    assert.match(body, /serverError\(res, err\)/);
    const seen = [];
    const res = { status() { return this; }, json(payload) { seen.push(payload); } };
    async function route() {
      try { throw new Error('The $regexMatch requires that the input parameter must be of type string'); }
      catch (err) { res.status(500).json({ error: 'Internt serverfel', detail: err.message }); }
    }
    await route();
    assert.equal(seen[0].error, 'Internt serverfel');
    assert.match(seen[0].detail, /\$regexMatch/);
  });

  it('guards the other async reads and logs unhandled rejections', () => {
    for (const signature of [
      "app.get('/api/orders'",
      "app.get('/api/users'",
      "app.get('/api/vehicles'",
      "app.get('/api/settings'",
      "app.get('/api/logs'",
      "app.get('/api/inventory-reports'",
      "app.get('/api/export/products.csv'"
    ]) {
      const body = handlerBody(signature);
      assert.match(body, /try \{/, signature);
      assert.match(body, /serverError\(res, err\)/, signature);
    }
    assert.match(server, /process\.on\('unhandledRejection'/);
  });
});

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

  it('escapes regex characters in the Mongo filter and searches every field as text', () => {
    const filter = search.mongoProductFilter('  34.34  ');
    const clauses = filter.$expr.$or;
    assert.equal(clauses.length, 4);
    for (const clause of clauses) {
      assert.equal(clause.$regexMatch.regex, '34\\.34');
      assert.equal(clause.$regexMatch.options, 'i');
      assert.ok(clause.$regexMatch.input.$toString);
    }
    assert.deepEqual(search.mongoProductFilter('   '), {});
    const html = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    assert.match(html, /ScannySearch\.productMatches/);
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(server, /mongoProductFilter\(req\.query\.q\)/);
    assert.match(server, /articleNo: textField\(articleNo\)/);
    assert.match(server, /articleNo: textField\(cell\(row, 'articleNo'\)\)/);
  });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const update = require('../public/js/kiosk-update');
const timer = require('../public/js/mode-timer');
const { assetVersion, injectAssetVersion } = require('../app-version');

const root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

describe('kiosk version reload', () => {
  const base = {
    version: 'bbb',
    seen: 'aaa',
    modalOpen: false,
    focusedTag: 'INPUT',
    focusedId: 'barcode-input',
    manualKeyboard: false,
    lastScanAt: 0,
    now: 120000,
    scanValue: ''
  };

  it('reloads only when the build changed and the kiosk is idle', () => {
    assert.equal(update.POLL_MS, 5 * 60 * 1000);
    assert.equal(update.SCAN_IDLE_MS, 60 * 1000);
    assert.equal(update.shouldReload(base), true);
    assert.equal(update.shouldReload({ ...base, version: 'aaa' }), false);
    assert.equal(update.shouldReload({ ...base, seen: '' }), false);
    assert.equal(update.shouldReload({ ...base, modalOpen: true }), false);
    assert.equal(update.shouldReload({ ...base, focusedId: 'unknown-name' }), false);
    assert.equal(update.shouldReload({ ...base, focusedId: 'vehicle-search' }), false);
    assert.equal(update.shouldReload({ ...base, manualKeyboard: true }), false);
    assert.equal(update.shouldReload({ ...base, scanValue: '7340' }), false);
    assert.equal(update.shouldReload({ ...base, lastScanAt: base.now - 59000 }), false);
    assert.equal(update.shouldReload({ ...base, lastScanAt: base.now - 60000 }), true);
  });

  it('keeps the scan field eligible for reload while it merely holds focus', () => {
    assert.equal(update.shouldReload({ ...base, focusedTag: 'INPUT', focusedId: 'barcode-input' }), true);
    assert.equal(update.shouldReload({ ...base, focusedTag: 'BUTTON', focusedId: 'btn-add' }), true);
  });
});

describe('single auto-reset timer', () => {
  it('keeps one interval when start is called again', () => {
    const active = new Set();
    let next = 1;
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    global.setInterval = () => {
      const id = next++;
      active.add(id);
      return id;
    };
    global.clearInterval = (id) => { active.delete(id); };
    try {
      const cd = timer.createCountdown();
      let ticks = 0;
      cd.start(10000, () => { ticks++; }, () => {});
      cd.start(10000, () => { ticks++; }, () => {});
      assert.equal(active.size, 1);
      assert.equal(cd.running(), true);
      cd.stop();
      assert.equal(active.size, 0);
      assert.equal(cd.running(), false);
      assert.equal(ticks, 2);
    } finally {
      global.setInterval = realSet;
      global.clearInterval = realClear;
    }
  });

  it('renders one timer bar and hides the mode line while it runs', () => {
    const html = read('public/kiosk.html');
    assert.equal((html.match(/id="timer-bar-wrap"/g) || []).length, 1);
    assert.equal((html.match(/id="timer-bar"/g) || []).length, 1);
    assert.match(html, /\.mode-section\.timer-on \.mode-indicator\{display:none\}/);
    assert.match(html, /modeCountdown\.stop\(\)/);
    assert.match(html, /classList\.add\('timer-on'\)/);
    assert.match(html, /classList\.remove\('timer-on'\)/);
  });
});

describe('asset version', () => {
  it('is stable for the same files and is injected into asset urls', () => {
    const a = assetVersion(root);
    const b = assetVersion(root);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{12}$/);
    const html = '<script src="/js/app.js?v=__APP_VERSION__"></script>';
    assert.equal(injectAssetVersion(html, a), `<script src="/js/app.js?v=${a}"></script>`);
    assert.match(read('server.js'), /\/api\/version/);
    assert.match(read('server.js'), /Cache-Control', 'no-store'/);
    assert.match(read('public/kiosk.html'), /\/js\/scan-wedge\.js\?v=__APP_VERSION__/);
    assert.match(read('public/kiosk.html'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(read('public/css/style.css'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(read('public/admin.html'), /class="modal-grid"/);
    assert.match(read('public/admin.html'), /class="modal-body"/);
    assert.match(read('public/admin.html'), /\/css\/style\.css\?v=__APP_VERSION__/);
    assert.match(read('public/admin.html'), /\/js\/app\.js\?v=__APP_VERSION__/);
    assert.match(read('public/js/app.js'), /bindModalViewport\(\)/);
    for (const file of ['public/js/mode-timer.js', 'public/js/kiosk-update.js', 'app-version.js']) {
      new vm.Script(read(file), { filename: file });
    }
  });
});

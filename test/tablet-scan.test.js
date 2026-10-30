const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scan = require('../public/js/scan-wedge');
const pwa = require('../pwa');

const root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

describe('scan buffer', () => {
  it('builds a code from rapid keystrokes and submits on Enter', () => {
    const buf = scan.createScanBuffer();
    for (const ch of 'ABC123') buf.applyKey(ch);
    assert.equal(buf.value(), 'ABC123');
    assert.deepEqual(buf.applyKey('Enter'), { type: 'submit', code: 'ABC123' });
    assert.equal(buf.value(), '');
    assert.deepEqual(buf.applyKey('Enter'), { type: 'submit', code: '' });
  });

  it('edits with Backspace, clears with Escape, and ignores control keys', () => {
    const buf = scan.createScanBuffer();
    buf.applyKey('1');
    buf.applyKey('2');
    buf.applyKey('Backspace');
    assert.equal(buf.value(), '1');
    assert.deepEqual(buf.applyKey('Escape'), { type: 'clear' });
    assert.equal(buf.value(), '');
    assert.deepEqual(buf.applyKey('Shift'), { type: 'ignore' });
    assert.deepEqual(buf.applyKey('NumpadEnter'), { type: 'submit', code: '' });
  });

  it('caps the buffer so a stuck key cannot grow without limit', () => {
    const buf = scan.createScanBuffer(4);
    '123456'.split('').forEach(ch => buf.applyKey(ch));
    assert.equal(buf.value(), '3456');
  });

  it('reads legacy keyCode when the browser reports Unidentified', () => {
    assert.equal(scan.keyFromEvent({ key: 'Unidentified', keyCode: 65 }), 'A');
    assert.equal(scan.keyFromEvent({ key: 'Unidentified', keyCode: 13 }), 'Enter');
    assert.equal(scan.keyFromEvent({ key: 'Enter', isComposing: true }), '');
    assert.equal(scan.keyFromEvent({ key: 'a' }), 'a');
  });
});

describe('duplicate scans', () => {
  it('ignores the same code within 300ms and accepts it afterwards', () => {
    assert.equal(scan.SCAN_DEDUPE_MS, 300);
    const d = scan.createScanDedupe();
    assert.equal(d.accept('  ABC  ', 1000), true);
    assert.equal(d.accept('ABC', 1299), false);
    assert.equal(d.accept('ABC', 1300), true);
  });

  it('lets a different code through immediately and rejects empty input', () => {
    const d = scan.createScanDedupe(300);
    assert.equal(d.accept('AAA', 0), true);
    assert.equal(d.accept('BBB', 0), true);
    assert.equal(d.accept('   ', 10), false);
    assert.equal(d.accept('', 10), false);
  });
});

describe('focus policy', () => {
  it('keeps the scan field focused unless a visible text field or a modal has it', () => {
    const scanField = { tagName: 'INPUT', getClientRects: () => [{}] };
    const search = { tagName: 'INPUT', getClientRects: () => [{}] };
    const hidden = { tagName: 'INPUT', getClientRects: () => [] };
    const button = { tagName: 'BUTTON', getClientRects: () => [{}] };

    const onScan = scan.contextFromActiveElement(button, scanField, true, false);
    assert.equal(scan.shouldCaptureScanKeys(onScan), true);
    assert.equal(scan.shouldRefocusScanField(onScan), true);

    const typing = scan.contextFromActiveElement(search, scanField, true, false);
    assert.equal(typing.activeIsRealTextField, true);
    assert.equal(scan.shouldCaptureScanKeys(typing), false);
    assert.equal(scan.shouldRefocusScanField(typing), false);

    const own = scan.contextFromActiveElement(scanField, scanField, true, false);
    assert.equal(own.activeIsScanField, true);
    assert.equal(scan.shouldRefocusScanField(own), false);
    assert.equal(scan.shouldCaptureScanKeys(own), true);

    const modal = scan.contextFromActiveElement(hidden, scanField, true, true);
    assert.equal(scan.shouldCaptureScanKeys(modal), false);
    assert.equal(scan.shouldRefocusScanField(modal), false);

    const hiddenLeft = scan.contextFromActiveElement(hidden, scanField, true, false);
    assert.equal(hiddenLeft.activeIsRealTextField, false);
    assert.equal(scan.shouldRefocusScanField(hiddenLeft), true);

    assert.equal(scan.shouldCaptureScanKeys({ scanActive: false }), false);
  });

  it('does not steal focus from the regnummer field while it is being typed in', () => {
    const scanField = { tagName: 'INPUT', id: 'barcode-input', getClientRects: () => [{}] };
    const reg = { tagName: 'INPUT', id: 'vehicle-search', getClientRects: () => [{}] };
    const typing = scan.contextFromActiveElement(reg, scanField, true, true);
    assert.equal(typing.activeIsRealTextField, true);
    assert.equal(scan.shouldRefocusScanField(typing), false);
    assert.equal(scan.shouldCaptureScanKeys(typing), false);
    const visibleWithoutModalFlag = scan.contextFromActiveElement(reg, scanField, true, false);
    assert.equal(scan.shouldRefocusScanField(visibleWithoutModalFlag), false);
    assert.equal(scan.shouldCaptureScanKeys(visibleWithoutModalFlag), false);
  });
});

describe('kiosk vehicle picker', () => {
  it('opens profile selection without focusing the regnummer field', () => {
    const html = read('public/kiosk.html');
    const tag = html.match(/<input[^>]*id="vehicle-search"[^>]*>/);
    assert.ok(tag, 'regnummer field missing');
    assert.equal(tag[0].includes('autofocus'), false);
    const start = html.indexOf('function showVehicleModal()');
    const end = html.indexOf('function filterVehicles()');
    assert.ok(start > 0 && end > start);
    const src = html.slice(start, end);
    assert.equal(/\.focus\s*\(/.test(src), false);

    let focused = null;
    const search = {
      id: 'vehicle-search',
      value: 'OLD',
      focus() { focused = search; }
    };
    const modal = { style: { display: 'none' } };
    const ctx = {
      document: {
        getElementById(id) {
          if (id === 'vehicle-search') return search;
          if (id === 'vehicle-modal') return modal;
          return null;
        },
        activeElement: null
      },
      filterVehicles() {}
    };
    vm.runInNewContext(src + '\nshowVehicleModal();', ctx);
    assert.equal(modal.style.display, 'flex');
    assert.equal(search.value, '');
    assert.equal(focused, null);
    assert.notEqual(ctx.document.activeElement, search);
  });
});

describe('kiosk scan card layout', () => {
  it('lets the status card shrink on short viewports and uses the dynamic viewport', () => {
    const html = read('public/kiosk.html');
    assert.match(html, /height:100dvh/);
    assert.match(html, /\.feedback-card\{[^}]*flex:1 1 auto;min-height:0/);
    assert.match(html, /@media \(max-height:700px\)/);
    assert.match(html, /@media \(max-height:560px\)/);
    const input = html.match(/<input[^>]*id="barcode-input"[^>]*>/);
    assert.ok(input);
    assert.match(input[0], /inputmode="none"/);
  });
});

describe('submit resolution and optimistic qty', () => {
  it('prefers the input while the on-screen keyboard is open, otherwise the wedge buffer', () => {
    assert.equal(scan.resolveScanCode({ bufferCode: '111', inputValue: '222', manual: false }), '111');
    assert.equal(scan.resolveScanCode({ bufferCode: '', inputValue: '222', manual: false }), '222');
    assert.equal(scan.resolveScanCode({ bufferCode: '111', inputValue: '222', manual: true }), '222');
    assert.equal(scan.resolveScanCode({ bufferCode: '111', inputValue: '  ', manual: true }), '111');
  });

  it('previews the next qty without waiting, and stacks in-flight scans of the same code', () => {
    const pending = scan.createPendingQty();
    const product = { code: 'A', name: 'Skruv', qty: 5 };
    const first = pending.preview(product, 'out');
    assert.equal(first.status, 'ok');
    assert.equal(first.qty, 4);
    assert.equal(product.qty, 5);
    const second = pending.preview(product, 'out');
    assert.equal(second.qty, 3);
    assert.equal(pending.preview({ code: 'B', name: 'Tom', qty: 0 }, 'out').status, 'empty');
    assert.equal(pending.preview(null, 'out').status, 'unknown');
    pending.settle('A', first.delta);
    pending.settle('A', second.delta);
    assert.equal(pending.get('A'), 0);
    assert.equal(pending.preview(product, 'add').qty, 6);
  });
});

describe('per-code scan queue', () => {
  it('runs the same code in order and lets other codes overlap', async () => {
    const q = scan.createScanQueue();
    const events = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = q.enqueue('A', async () => {
      events.push('A-start');
      await gate;
      events.push('A-end');
    });
    const other = q.enqueue('B', async () => { events.push('B'); });
    const second = q.enqueue('A', async () => { events.push('A2'); });
    await other;
    assert.deepEqual(events, ['A-start', 'B']);
    release();
    await first;
    await second;
    assert.deepEqual(events, ['A-start', 'B', 'A-end', 'A2']);
  });

  it('continues the queue after a failed request', async () => {
    const q = scan.createScanQueue();
    const seen = [];
    await q.enqueue('A', async () => { seen.push('fail'); throw new Error('nät'); }).catch(() => seen.push('caught'));
    await q.enqueue('A', async () => { seen.push('next'); });
    assert.deepEqual(seen, ['fail', 'caught', 'next']);
  });
});

describe('installable manifest', () => {
  it('builds a Scanny manifest pinned to a safe start path', () => {
    const body = pwa.buildWebManifest('/kiosk/verkstad');
    assert.equal(body.name, 'Scanny');
    assert.equal(body.short_name, 'Scanny');
    assert.equal(body.start_url, '/kiosk/verkstad');
    assert.equal(body.display, 'standalone');
    assert.deepEqual(body.display_override, ['fullscreen', 'standalone']);
    assert.equal(body.theme_color, '#0c0f0a');
    assert.equal(body.background_color, '#0c0f0a');
    const sizes = body.icons.map(icon => icon.sizes).sort();
    assert.ok(sizes.includes('192x192'));
    assert.ok(sizes.includes('512x512'));
    assert.equal(JSON.stringify(body).includes('accesskey'), false);
  });

  it('rejects off-site and traversal start URLs', () => {
    assert.equal(pwa.safeStartPath('/app'), '/app');
    assert.equal(pwa.safeStartPath('/kiosk/a?x=1'), '/kiosk/a?x=1');
    assert.equal(pwa.safeStartPath(['/kiosk/b']), '/kiosk/b');
    for (const bad of ['https://evil.example', '//evil', '/../secret', '/\\windows', 'kiosk', '', null]) {
      assert.equal(pwa.safeStartPath(bad), '/app');
    }
  });

  it('sends the manifest as non-cached JSON', () => {
    const headers = {};
    let payload = null;
    const res = {
      set(k, v) { headers[k] = v; return this; },
      json(body) { payload = body; return this; }
    };
    pwa.sendManifest('/app', res);
    assert.match(headers['Content-Type'], /application\/manifest\+json/);
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.equal(payload.start_url, '/app');
    assert.equal(payload.name, 'Scanny');
  });
});

describe('tablet shell', () => {
  it('ships png icons at the sizes Chrome requires', () => {
    for (const [file, size] of [['public/icons/icon-192.png', 192], ['public/icons/icon-512.png', 512], ['public/icons/icon-maskable-512.png', 512]]) {
      const buf = fs.readFileSync(path.join(root, file));
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
      assert.equal(buf.readUInt32BE(16), size);
      assert.equal(buf.readUInt32BE(20), size);
    }
  });

  it('registers a service worker that does not cache API data', () => {
    const sw = read('public/sw.js');
    assert.match(sw, /addEventListener\(\s*['"]fetch['"]/);
    assert.equal(sw.includes('caches'), false);
    assert.match(read('server.js'), /manifest\.webmanifest/);
    assert.match(read('server.js'), /sendManifest/);
    const server = read('server.js');
    assert.match(server, /base === 'sw\.js'/);
    assert.match(server, /\(js\|css\|html\)/);
    assert.match(server, /setHeader\('Cache-Control', 'no-cache'\)/);
  });

  it('hides the soft keyboard on both scan screens and links the PWA', () => {
    for (const file of ['public/kiosk.html', 'public/admin.html']) {
      const html = read(file);
      assert.match(html, /id="barcode-input"[^>]*inputmode="none"/);
      assert.match(html, /virtualkeyboardpolicy="manual"/);
      assert.match(html, /maximum-scale=1/);
      assert.match(html, /serviceWorker\.register\(\s*['"]\/sw\.js['"]\s*\)/);
      assert.match(html, /manifest\.webmanifest\?start=/);
      assert.match(html, /\/js\/scan-wedge\.js/);
      assert.match(html, />Tangentbord</);
      const inputTag = html.match(/<input[^>]*id="barcode-input"[^>]*>/);
      assert.ok(inputTag, 'scan input missing');
      assert.equal(inputTag[0].includes('left:'), false);
    }
    assert.match(read('public/kiosk.html') + read('public/js/app.js'), /Dölj tangentbord/);
  });

  it('compiles the scan scripts', () => {
    for (const file of ['public/js/scan-wedge.js', 'public/js/app.js', 'pwa.js', 'server.js', 'public/sw.js']) {
      new vm.Script(read(file), { filename: file });
    }
    const htmlFiles = ['public/kiosk.html', 'public/admin.html'];
    for (const file of htmlFiles) {
      const html = read(file);
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      let count = 0;
      while ((match = re.exec(html))) {
        new vm.Script(match[1], { filename: file + '#inline' });
        count++;
      }
      assert.ok(count >= 1, file + ' should contain an inline script');
    }
  });
});

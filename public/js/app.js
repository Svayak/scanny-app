// ═══════════════════════════════════════════════════════════════
//  Scanny — Frontend-logik
// ═══════════════════════════════════════════════════════════════

// ── Globalt tillstånd ──
let db = { products: [], orders: [], orderHistory: [], inventoryReports: [], logs: [], settings: {}, users: [], vehicles: [] };
let codeReader = null, cameraActive = false, currentCameraIndex = 0, availableCameras = [];
let lastCamScan = { code: null, t: 0 };   // kameran avkodar löpande — egen längre spärr per kod
let scanWedge = null;
const scanDedupe = (window.ScannyScan ? ScannyScan.createScanDedupe(ScannyScan.SCAN_DEDUPE_MS) : { accept: () => true });
const scanQueue = (window.ScannyScan ? ScannyScan.createScanQueue() : { enqueue: (_c, task) => task() });
const pendingQty = (window.ScannyScan ? ScannyScan.createPendingQty() : { get: () => 0, preview: () => ({ status: 'unknown' }), settle() {} });
let scanFeedbackGen = 0;
let _inflight = 0;   // antal pågående lager-anrop (för att synka först när allt landat)
let currentMode = 'out';
let inventory = {};
let autoResetTimer = null;
const AUTO_RESET_MS = 20 * 60 * 1000;

// Skanningsfokus sköts av scan-wedge (initScanWedge längst ned): fältet
// återfår fokus efter åtgärder, men inte när ett synligt textfält är aktivt.

// ═══════════════════════════════════════════════════════════════
//  Lägeshantering (Uttag / Addera / Inventering)
// ═══════════════════════════════════════════════════════════════
function startAutoReset() {
  clearTimeout(autoResetTimer);
  autoResetTimer = setTimeout(() => {
    if (currentMode === 'add') {
      setMode('out');
      toast('Läget återställt till Uttag (20 min inaktivitet)', 'warning');
    }
  }, AUTO_RESET_MS);
}

function setMode(mode) {
  if (currentMode === 'inv' && mode !== 'inv' && Object.keys(inventory).length > 0) {
    if (!confirm('Avbryta pågående inventering? All data går förlorad.')) return;
    inventory = {};
  }
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector('.mode-btn.mode-' + mode);
  if (activeBtn) activeBtn.classList.add('active');

  const ind    = document.getElementById('mode-indicator');
  const lbl    = document.getElementById('mode-label');
  const invSec = document.getElementById('inv-section');
  const qt     = document.getElementById('quick-title');

  if (ind) ind.className = 'mode-indicator ' + mode;
  if (invSec) invSec.style.display = mode === 'inv' ? 'block' : 'none';
  if (qt)  qt.style.display = mode === 'inv' ? 'none' : 'block';
  if (lbl) {
    const labels = {
      out: 'Uttag — varje skanning drar av en enhet',
      add: 'Addera — varje skanning lägger till en enhet',
      inv: 'Inventering — skanna det antal du ser, avsluta när klart'
    };
    lbl.textContent = labels[mode] || '';
  }

  if (mode === 'inv') renderInvList();
  if (mode === 'add') startAutoReset();
  else clearTimeout(autoResetTimer);

  focusScanField();
}

// ═══════════════════════════════════════════════════════════════
//  Inventering
// ═══════════════════════════════════════════════════════════════
function renderInvList() {
  const list    = document.getElementById('inv-list');
  const summary = document.getElementById('inv-summary');
  const entries = Object.values(inventory);
  if (!list || !summary) return;

  if (entries.length === 0) {
    list.innerHTML = '';
    summary.innerHTML = 'Skanna artiklar för att starta inventeringen.';
    return;
  }

  const diffs = entries.map(e => e.scanned - e.previous);
  const pos   = diffs.filter(d => d > 0).length;
  const neg   = diffs.filter(d => d < 0).length;
  const unch  = diffs.filter(d => d === 0).length;

  summary.innerHTML =
    '<strong>' + entries.length + ' artiklar</strong> skannade &nbsp;·&nbsp; ' +
    (pos > 0 ? '<span style="color:var(--accent)">+' + pos + ' över</span> &nbsp;·&nbsp; ' : '') +
    (neg > 0 ? '<span style="color:var(--danger)">' + neg + ' under</span> &nbsp;·&nbsp; ' : '') +
    unch + ' oförändrade';

  list.innerHTML = entries
    .sort((a, b) => a.name.localeCompare(b.name, 'sv'))
    .map(e => {
      const d  = e.scanned - e.previous;
      const ds = d > 0 ? '+' + d : '' + d;
      const dc = d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero';
      return '<div class="inv-row">' +
        '<div><div class="inv-name">' + esc(e.name) + '</div>' +
        '<div class="inv-diff ' + dc + '">System: ' + e.previous + ' st &nbsp;→&nbsp; Skannat: ' + e.scanned + ' st &nbsp;(' + ds + ')</div></div>' +
        '<div class="inv-qty">' + e.scanned + '</div></div>';
    }).join('');
}

function resetInventory(silent) {
  inventory = {};
  if (!silent) { renderInvList(); toast('Inventering återställd'); }
}

async function finishInventory() {
  const entries = Object.values(inventory);
  if (entries.length === 0) { toast('Inga artiklar skannade', 'warning'); return; }
  const diffs = entries.filter(e => e.scanned !== e.previous);
  if (diffs.length === 0) { toast('Ingen differens — lagret stämmer!', 'success'); resetInventory(true); return; }
  if (!confirm('Avsluta inventering och uppdatera lagret? (' + diffs.length + ' artiklar har differens)')) return;
  for (const e of entries) {
    try { await api('PATCH', '/api/products/' + e.id, { qty: e.scanned }); } catch (_) {}
  }
  try { await api('POST', '/api/inventory-report', { entries }); } catch (_) {}
  await loadAll();
  toast('Inventering klar!', 'success');
  resetInventory(true);
  setMode('out');
}

// ═══════════════════════════════════════════════════════════════
//  API-hjälpare
// ═══════════════════════════════════════════════════════════════
// ── Auth token ──
function getToken() { return localStorage.getItem('scanny_token'); }
function setToken(token) { localStorage.setItem('scanny_token', token); }
function clearToken() { localStorage.removeItem('scanny_token'); localStorage.removeItem('scanny_user'); }

async function api(method, path, body) {
  try {
    const token = getToken();
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res  = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { clearToken(); window.location.href = '/login'; return; }
    if (res.status === 403) {
      const d = await res.json().catch(() => ({}));
      if (d.error === 'ACCOUNT_PAUSED') {
        document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0c0f0a;font-family:sans-serif;text-align:center;padding:2rem"><div><div style="font-size:48px;margin-bottom:1rem">⏸</div><h1 style="color:#f0ede8;font-size:24px;margin-bottom:12px">Kontot är pausat</h1><p style="color:#9fa899;font-size:16px;margin-bottom:24px">Din prenumeration är pausad. Kontakta Scanny för att återaktivera.</p><a href="/api/export/products.csv" style="display:inline-block;padding:12px 24px;background:#4ade80;color:#0c0f0a;border-radius:8px;text-decoration:none;font-weight:700;margin-bottom:12px">Exportera lager som CSV</a><br><p style="color:#6b7265;font-size:13px;margin-top:16px">Kontakt: <a href="mailto:info@scanny.se" style="color:#4ade80">info@scanny.se</a></p></div></div>';
        return;
      }
      const denied = new Error(d.error || 'Saknar behörighet');
      denied.keepStatus = true;
      throw denied;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Serverfel');
    return data;
  } catch (err) {
    if (!err || !err.keepStatus) setStatus(false);
    throw err;
  }
}

// ── CSV-import ──
async function importCsv(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  inputEl.value = ''; // tillåt att samma fil väljs igen
  if (!file) return;
  try {
    const text = await file.text();
    const token = getToken();
    const res = await fetch('/api/products/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      body: text
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import misslyckades');
    let msg = `Import klar:\n${data.created} nya, ${data.updated} uppdaterade`;
    if (data.skipped) msg += `, ${data.skipped} överhoppade`;
    if (data.errors && data.errors.length) msg += `\n\nProblemrader:\n` + data.errors.join('\n');
    alert(msg);
    await loadAll();
  } catch (err) {
    alert('Fel vid import: ' + err.message);
  }
}

async function loadAll() {
  try {
    db = await api('GET', '/api/db');
    if (db.products) db.products.forEach(p => { if (!p.id) p.id = p._id; });
    if (db.orders)   db.orders.forEach(o   => { if (!o.id) o.id = o._id; });
    if (db.users)    db.users.forEach(u    => { if (!u.id) u.id = u._id; });
    if (db.vehicles) db.vehicles.forEach(v => { if (!v.id) v.id = v._id; });
    await loadTrashQuiet();
    setStatus(true);
    renderAll();
  } catch (_) {
    setStatus(false);
  }
}

// ── Snabb, lokal uppdatering (undviker full omladdning vid varje skanning) ──
// Uppdaterar en produkt i den lokala db:n från serverns svar.
function applyProductUpdate(p) {
  if (!p || !db.products) return;
  const key = p.id || p._id;
  let idx = db.products.findIndex(x => x.id === key || x._id === key);
  if (idx < 0 && p.code) idx = db.products.findIndex(x => x.code === p.code);
  if (idx >= 0) {
    const existingId = db.products[idx].id;
    db.products[idx] = { ...db.products[idx], ...p, id: existingId };
  }
}

// En full omladdning (beställningar, larm, historik) körs en gång när skanningen lugnat sig.
let _syncTimer = null;
function scheduleSync(delay = 900) {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { loadAll(); }, delay);
}

// ═══════════════════════════════════════════════════════════════
//  UI-hjälpare
// ═══════════════════════════════════════════════════════════════

// Enkel HTML-escaping för att undvika XSS
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Formatera ett belopp i SEK, t.ex. 49,50 kr
function kr(n) {
  return (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}
// Escapa värde för användning inuti en enkelciterad JS-sträng i ett HTML-attribut (onclick).
function escJs(str) {
  return String(str)
    .replace(/\\/g,'\\\\').replace(/'/g,"\\'")
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setStatus(ok) {
  ['status-dot', 'status-dot-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = 'status-dot' + (ok ? '' : ' error');
  });
  ['status-text', 'status-text-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = ok ? 'Ansluten' : 'Offline';
  });
}

let toastTimer;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function showTab(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.mobile-nav a').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  if (name !== 'scan') stopCamera();
  renderAll();
  if (name === 'scan') focusScanField();
  else if (scanWedge) scanWedge.clear();
}

// Navigera till en admin-undersida och markera Admin som aktiv i menyn
function showAdminSub(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === 'admin'));
  document.querySelectorAll('.mobile-nav a').forEach(el => el.classList.toggle('active', el.dataset.tab === 'admin'));
  document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  renderAll();
}

document.querySelectorAll('.nav-item, .mobile-nav a').forEach(el => {
  el.addEventListener('click', e => { if (el.id === 'kiosk-link') return; e.preventDefault(); showTab(el.dataset.tab); });
});

// ═══════════════════════════════════════════════════════════════
//  Modal: Okänd streckkod
// ═══════════════════════════════════════════════════════════════
function showAddUnknown(code) {
  document.getElementById('unknown-code-display').textContent = code;
  document.getElementById('unknown-code-value').value = code;
  ['unknown-name', 'unknown-article', 'unknown-supplier'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('unknown-qty').value = '1';
  document.getElementById('unknown-min').value = '5';
  document.getElementById('unknown-critical').value = '2';
  document.getElementById('unknown-order-qty').value = '10';
  document.getElementById('unknown-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('unknown-name').focus(), 100);
}

function closeUnknownModal() {
  document.getElementById('unknown-modal').style.display = 'none';
  if (scanWedge) scanWedge.clear();
  else {
    const inp = document.getElementById('barcode-input');
    if (inp) inp.value = '';
  }
  focusScanField();
}

async function saveUnknownProduct() {
  const body = {
    name:      document.getElementById('unknown-name').value.trim(),
    code:      document.getElementById('unknown-code-value').value.trim(),
    qty:       parseInt(document.getElementById('unknown-qty').value) || 0,
    min:       parseInt(document.getElementById('unknown-min').value) || 5,
    critical:  parseInt(document.getElementById('unknown-critical').value) || 2,
    orderQty:  parseInt(document.getElementById('unknown-order-qty').value) || 10,
    articleNo: document.getElementById('unknown-article').value.trim(),
    supplier:  document.getElementById('unknown-supplier').value.trim()
  };
  if (!body.name) { document.getElementById('unknown-name').focus(); return; }
  try {
    await api('POST', '/api/products', body);
    toast('Produkt tillagd: ' + body.name);
    closeUnknownModal();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

const unknownModal = document.getElementById('unknown-modal');
unknownModal.addEventListener('click', e => { if (e.target === unknownModal) closeUnknownModal(); });
unknownModal.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveUnknownProduct();
  if (e.key === 'Escape') closeUnknownModal();
});

// ═══════════════════════════════════════════════════════════════
//  Modal: Redigera produkt
// ═══════════════════════════════════════════════════════════════
function showEditModal(id) {
  const p = db.products.find(x => x.id === id);
  if (!p) return;
  document.getElementById('edit-id').value = p.id;
  document.getElementById('edit-name').value = p.name;
  document.getElementById('edit-code').value = p.code;
  document.getElementById('edit-qty').value = p.qty;
  document.getElementById('edit-min').value = p.min;
  document.getElementById('edit-critical').value = p.critical ?? 2;
  document.getElementById('edit-order-qty').value = p.orderQty;
  document.getElementById('edit-article').value = p.articleNo || '';
  document.getElementById('edit-supplier').value = p.supplier || '';
  document.getElementById('edit-price').value = p.price ?? 0;
  document.getElementById('edit-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('edit-name').focus(), 100);
}

function closeEditModal() {
  document.getElementById('edit-modal').style.display = 'none';
}

async function saveEditProduct() {
  const id = document.getElementById('edit-id').value;
  const body = {
    name:      document.getElementById('edit-name').value.trim(),
    code:      document.getElementById('edit-code').value.trim(),
    qty:       parseInt(document.getElementById('edit-qty').value) || 0,
    min:       parseInt(document.getElementById('edit-min').value) || 5,
    critical:  parseInt(document.getElementById('edit-critical').value) || 0,
    orderQty:  parseInt(document.getElementById('edit-order-qty').value) || 10,
    articleNo: document.getElementById('edit-article').value.trim(),
    supplier:  document.getElementById('edit-supplier').value.trim(),
    price:     parseFloat(document.getElementById('edit-price').value) || 0
  };
  if (!body.name || !body.code) { toast('Namn och streckkod krävs', 'error'); return; }
  try {
    await api('PATCH', '/api/products/' + id, body);
    toast('Produkt sparad');
    closeEditModal();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

const editModal = document.getElementById('edit-modal');
editModal.addEventListener('click', e => { if (e.target === editModal) closeEditModal(); });
editModal.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveEditProduct();
  if (e.key === 'Escape') closeEditModal();
});

// ═══════════════════════════════════════════════════════════════
//  Skanning
// ═══════════════════════════════════════════════════════════════
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
function getAudioCtx() { if (!AudioCtx) return null; if (!audioCtx) audioCtx = new AudioCtx(); return audioCtx; }
function playTone(freq, dur, type, vol) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type || 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol == null ? 0.2 : vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch (_) {}
}
function soundSuccess() { playTone(880, .1, 'sine', .2); setTimeout(() => playTone(1100, .14, 'sine', .16), 90); }
function soundWarning() { playTone(440, .2, 'triangle', .24); }
function soundError()   { playTone(200, .16, 'sawtooth', .24); }
function soundCritical(){ playTone(300, .12, 'square', .28); setTimeout(() => playTone(220, .2, 'square', .28), 140); }

let scanZoneTimer = null;
let scanZoneGen = 0;
function paintScanFeedback(kind, text) {
  const zone = document.getElementById('scan-zone');
  const fb = document.getElementById('scan-feedback');
  if (!zone || !fb) return;
  zone.className = kind === 'err' ? 'scan-zone error' : (kind === 'ok' || kind === 'warn') ? 'scan-zone scanned' : 'scan-zone';
  fb.style.display = 'block';
  fb.className = 'scan-feedback ' + (kind === 'pending' ? 'pending' : kind === 'warn' ? 'warn' : kind === 'err' ? 'err' : 'ok');
  fb.textContent = text;
  const gen = ++scanZoneGen;
  clearTimeout(scanZoneTimer);
  scanZoneTimer = setTimeout(() => {
    if (gen !== scanZoneGen) return;
    zone.className = 'scan-zone';
  }, kind === 'err' ? 1400 : 800);
}

function patchQuickQty(code, qty) {
  if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') return;
  const el = document.querySelector('.quick-btn[data-code="' + CSS.escape(code) + '"] .qb-qty');
  if (!el) return;
  const p = (db.products || []).find(x => x.code === code);
  const min = p ? p.min : 0;
  const cls = qty === 0 ? 'danger' : qty <= min ? 'warn' : 'ok';
  el.textContent = qty + ' st';
  el.className = 'qb-qty ' + cls;
}

function focusScanField() {
  if (scanWedge) { scanWedge.refocus(); return; }
  const panel = document.getElementById('tab-scan');
  if (!panel || !panel.classList.contains('active')) return;
  const inp = document.getElementById('barcode-input');
  if (inp && document.activeElement !== inp) inp.focus();
}

function adminScanContext() {
  const input = document.getElementById('barcode-input');
  const panel = document.getElementById('tab-scan');
  const scanActive = !!(panel && panel.classList.contains('active'));
  const modalOpen = Array.prototype.some.call(document.querySelectorAll('.modal-overlay'), (el) => {
    const d = el.style && el.style.display;
    return !!(d && d !== 'none');
  });
  return ScannyScan.contextFromActiveElement(document.activeElement, input, scanActive, modalOpen);
}

function toggleScanKeyboard() {
  if (!scanWedge) return;
  const on = !scanWedge.isManual();
  scanWedge.setManual(on);
  const btn = document.getElementById('keyboard-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.classList.toggle('active', on);
  btn.textContent = on ? 'Dölj tangentbord' : 'Tangentbord';
}

function scanProduct(code) {
  const c = String(code || '').trim();
  if (!scanDedupe.accept(c, Date.now())) return;
  const mode = currentMode;
  if (mode === 'add') startAutoReset();
  const fbGen = ++scanFeedbackGen;
  const local = (db.products || []).find(x => x.code === c);

  if (mode === 'inv') {
    const zone = document.getElementById('scan-zone');
    const fb = document.getElementById('scan-feedback');
    if (!local) {
      soundError();
      if (zone && fb) {
        zone.className = 'scan-zone error';
        fb.style.display = 'block'; fb.className = 'scan-feedback err';
        fb.textContent = '✗ Okänd streckkod: ' + c;
        setTimeout(() => { if (zone.className.indexOf('error') !== -1) zone.className = 'scan-zone'; }, 1200);
      }
      return;
    }
    if (!inventory[local.id]) inventory[local.id] = { id: local.id, name: local.name, code: local.code, previous: local.qty, scanned: 0 };
    inventory[local.id].scanned++;
    soundSuccess();
    if (zone && fb) {
      zone.className = 'scan-zone scanned';
      fb.style.display = 'block'; fb.className = 'scan-feedback ok';
      fb.textContent = '✓ ' + local.name + ' — ' + inventory[local.id].scanned + ' st räknade';
      setTimeout(() => { zone.className = 'scan-zone'; }, 600);
    }
    renderInvList();
    focusScanField();
    return;
  }

  const plan = pendingQty.preview(local, mode);
  if (plan.status === 'ok') {
    soundSuccess();
    const msg = mode === 'add'
      ? '+ ' + plan.name + ' — nu ' + plan.qty + ' st i lager'
      : '✓ ' + plan.name + ' — ' + plan.qty + ' kvar på lager';
    paintScanFeedback('ok', msg);
    patchQuickQty(c, plan.qty);
  } else if (plan.status === 'empty') {
    soundError();
    paintScanFeedback('err', '✗ ' + plan.name + ' är slut på lager');
  } else {
    playTone(660, .05, 'sine', .12);
    paintScanFeedback('pending', '… Skannar ' + c);
  }

  const delta = plan.delta || 0;
  const endpoint = mode === 'add' ? '/api/add' : '/api/scan';
  scanQueue.enqueue(c, async () => {
    let settled = false;
    const settleOnce = () => {
      if (settled || !delta) return;
      settled = true;
      pendingQty.settle(c, delta);
    };
    try {
      const res = await api('POST', endpoint, { code: c });
      settleOnce();
      if (!res || !res.product) {
        const prod = (db.products || []).find(x => x.code === c);
        if (prod) patchQuickQty(c, prod.qty + pendingQty.get(c));
        return;
      }
      const p = res.product;
      applyProductUpdate(p);
      patchQuickQty(c, (Number(p.qty) || 0) + pendingQty.get(c));
      renderMetrics();
      if (fbGen === scanFeedbackGen) {
        const sameAsPreview = plan.status === 'ok' && p.qty === plan.qty;
        if (mode !== 'add' && res.criticalAlert) {
          soundCritical();
          paintScanFeedback('err', '🚨 ' + p.name + ' — KRITISKT LAGER: ' + p.qty + ' st! Varning skickad till chefen.');
        } else if (mode !== 'add' && res.orderCreated) {
          soundWarning();
          paintScanFeedback('warn', '⚠ ' + p.name + ' — ' + p.qty + ' kvar (under beställningsnivå). Lagd i beställningskö.');
        } else if (!sameAsPreview) {
          if (plan.status !== 'ok') soundSuccess();
          const msg = mode === 'add'
            ? '+ ' + p.name + ' — nu ' + p.qty + ' st i lager'
            : '✓ ' + p.name + ' — ' + p.qty + ' kvar på lager';
          paintScanFeedback('ok', msg);
        }
      } else if (mode !== 'add' && res.criticalAlert) {
        soundCritical();
        toast('Kritiskt lager: ' + p.name + ' (' + p.qty + ' st)', 'error');
      }
      scheduleSync();
    } catch (err) {
      settleOnce();
      const msg = err && err.message ? err.message : 'Serverfel';
      if (msg.startsWith('Okänd streckkod')) {
        if (fbGen === scanFeedbackGen) {
          const zone = document.getElementById('scan-zone');
          const fb = document.getElementById('scan-feedback');
          if (zone) zone.className = 'scan-zone';
          if (fb) fb.style.display = 'none';
          showAddUnknown(c);
        }
      } else if (fbGen === scanFeedbackGen) {
        if (plan.status !== 'empty') soundError();
        paintScanFeedback('err', '✗ ' + msg);
        const prod = (db.products || []).find(x => x.code === c);
        if (prod) patchQuickQty(c, prod.qty + pendingQty.get(c));
      } else {
        toast(msg, 'error');
      }
    }
  }).catch(() => {});
  focusScanField();
}

// ═══════════════════════════════════════════════════════════════
//  Kamera
// ═══════════════════════════════════════════════════════════════
async function toggleCamera() { if (cameraActive) { stopCamera(); return; } await startCamera(); }

async function startCamera() {
  if (!window.ZXing) { toast('Kamerabiblioteket laddas, försök igen', 'warning'); return; }
  try {
    codeReader = new ZXing.BrowserMultiFormatReader();
    availableCameras = await codeReader.listVideoInputDevices();
    if (availableCameras.length === 0) { toast('Ingen kamera hittades', 'error'); return; }
    currentCameraIndex = availableCameras.length > 1 ? 1 : 0;
    document.getElementById('camera-container').classList.add('active');
    ['camera-toggle-btn', 'camera-toggle-btn-mobile'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '✕ Stäng kamera'; el.classList.add('active'); }
    });
    cameraActive = true;
    await startDecoding();
  } catch (err) { toast('Kunde inte starta kamera: ' + err.message, 'error'); }
}

async function startDecoding() {
  const deviceId = availableCameras[currentCameraIndex]?.deviceId;
  document.getElementById('camera-status').textContent = 'Riktar kameran mot streckkoden...';
  try {
    await codeReader.decodeFromVideoDevice(deviceId, 'camera-video', result => {
      if (!result) return;
      const text = result.getText();
      // Kameran anropar den här ~flera ggr/sek medan en kod är i bild —
      // registrera samma kod högst var 1,5:e sekund.
      const now = Date.now();
      if (text === lastCamScan.code && (now - lastCamScan.t) < 1500) return;
      lastCamScan = { code: text, t: now };
      document.getElementById('camera-status').textContent = 'Skannad: ' + text;
      scanProduct(text);
    });
  } catch (err) {
    document.getElementById('camera-status').textContent = 'Kamerafel: ' + err.message;
  }
}

async function switchCamera() {
  if (!cameraActive || availableCameras.length < 2) { toast('Bara en kamera tillgänglig', 'warning'); return; }
  codeReader.reset();
  currentCameraIndex = (currentCameraIndex + 1) % availableCameras.length;
  await startDecoding();
}

function stopCamera() {
  if (codeReader) { codeReader.reset(); codeReader = null; }
  cameraActive = false;
  const cc = document.getElementById('camera-container');
  if (cc) cc.classList.remove('active');

  const camSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  const btn = document.getElementById('camera-toggle-btn');
  if (btn) { btn.innerHTML = camSvg + ' Använd kamera'; btn.classList.remove('active'); }
  const mb = document.getElementById('camera-toggle-btn-mobile');
  if (mb) { mb.innerHTML = '📷 Starta kamera'; mb.classList.remove('active'); }
}

// ═══════════════════════════════════════════════════════════════
//  Rendering
// ═══════════════════════════════════════════════════════════════
function renderMetrics() {
  const total    = db.products.length;
  const critical = db.products.filter(p => p.qty > 0 && p.qty <= (p.critical ?? 0)).length;
  const low      = db.products.filter(p => p.qty > (p.critical ?? 0) && p.qty <= p.min).length;
  const out      = db.products.filter(p => p.qty === 0).length;
  const pending  = db.orders.filter(o => !o.sent).length;

  document.getElementById('metrics').innerHTML =
    metric('Produkter', total, '') +
    metric('⚠ Kritiska', critical, critical > 0 ? 'danger' : 'ok') +
    metric('Beställ', low, low > 0 ? 'warn' : 'ok') +
    metric('Beställningar', pending, pending > 0 ? 'warn' : 'ok');
}

function metric(label, value, cls) {
  return '<div class="metric"><div class="m-label">' + label + '</div><div class="m-value ' + cls + '">' + value + '</div></div>';
}

function renderQuickGrid() {
  if (currentMode === 'inv') { document.getElementById('quick-grid').innerHTML = ''; return; }
  const sorted = [...db.products].sort((a, b) => {
    if (a.qty === 0 && b.qty !== 0) return -1;
    if (b.qty === 0 && a.qty !== 0) return 1;
    if (a.qty <= a.min && b.qty > b.min) return -1;
    if (b.qty <= b.min && a.qty > a.min) return 1;
    return a.name.localeCompare(b.name, 'sv');
  });
  document.getElementById('quick-grid').innerHTML = sorted.map(p => {
    const cls = p.qty === 0 ? 'danger' : p.qty <= p.min ? 'warn' : 'ok';
    return '<button type="button" class="quick-btn" data-code="' + esc(p.code) + '" onclick="scanProduct(\'' + escJs(p.code) + '\')">' +
      '<div class="qb-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
      '<div class="qb-row"><span class="qb-code">' + esc(p.code.slice(-6)) + '</span>' +
      '<span class="qb-qty ' + cls + '">' + p.qty + ' st</span></div></button>';
  }).join('');
}

function renderLager() {
  const q = document.getElementById('search-input')?.value || '';
  const filtered = db.products.filter(p => ScannySearch.productMatches(p, q));

  // Metrics på lagersidan
  const lagerMetrics = document.getElementById('lager-metrics');
  if (lagerMetrics) {
    const total    = db.products.length;
    const critical = db.products.filter(p => p.qty > 0 && p.qty <= (p.critical ?? 0)).length;
    const low      = db.products.filter(p => p.qty > (p.critical ?? 0) && p.qty <= p.min).length;
    const out      = db.products.filter(p => p.qty === 0).length;
    lagerMetrics.innerHTML =
      metric('Produkter', total, '') +
      metric('⚠ Kritiska', critical, critical > 0 ? 'danger' : 'ok') +
      metric('Beställ', low, low > 0 ? 'warn' : 'ok') +
      metric('Slut', out, out > 0 ? 'danger' : 'ok');
  }

  const badge = p => {
    if (p.qty === 0) return '<span class="status-badge badge-crit">Slut</span>';
    if (p.qty <= (p.critical ?? 0)) return '<span class="status-badge badge-critical">⚠ Kritisk</span>';
    if (p.qty <= p.min) return '<span class="status-badge badge-warn">Beställ</span>';
    return '<span class="status-badge badge-ok">OK</span>';
  };

  if (filtered.length === 0) {
    document.getElementById('lager-body').innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:2rem">Inga produkter hittades.</td></tr>';
    return;
  }

  document.getElementById('lager-body').innerHTML = filtered.map(p =>
    '<tr>' +
    '<td style="font-weight:500">' + esc(p.name) + '</td>' +
    '<td><div class="qty-cell">' +
	'<button class="btn btn-sm" onclick="adjustQty(\''+p.id+'\',-1)">−</button>'+
	'<span class="qty-display" id="qd-'+p.id+'" onclick="editQtyInline(\''+p.id+'\',this)">'+p.qty+'</span>'+
	'<button class="btn btn-sm" onclick="adjustQty(\''+p.id+'\',1)">+</button>'+
    '</div></td>' +
    '<td style="color:var(--text2)">' + esc(p.supplier || '—') + '</td>' +
    '<td style="text-align:right;white-space:nowrap">' + (p.price ? kr(p.price) : '—') + '</td>' +
    '<td>' + badge(p) + '</td>' +
    '<td style="white-space:nowrap">' +
	'<button class="btn btn-sm" onclick="showEditModal(\''+p.id+'\')">Redigera</button>'+
	'<button class="btn btn-sm" onclick="printLabel(\''+p.id+'\')" title="Skriv ut etikett">🏷 Etikett</button>'+
	queueLabelButton(p.id) +
	productDeleteButton(p) +
    '</td></tr>'
  ).join('');
}

function editQtyInline(id, el) {
  const current = db.products.find(p => p.id === id)?.qty ?? 0;
  const input = document.createElement('input');
  input.type = 'number';
  input.value = current;
  input.min = '0';
  input.style.cssText = 'width:60px;font-size:16px;font-weight:600;text-align:center;padding:2px 4px;border:2px solid var(--accent);border-radius:6px;outline:none';
  el.replaceWith(input);
  input.focus();
  input.select();

  async function save() {
    const val = parseInt(input.value);
    if (!isNaN(val) && val >= 0 && val !== current) {
      try {
        await api('PATCH', '/api/products/' + id, { qty: val });
        await loadAll();
      } catch (err) { toast(err.message, 'error'); }
    } else {
      await loadAll();
    }
  }

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') loadAll();
  });
}

document.getElementById('search-input').addEventListener('input', renderLager);

function renderOrders() {
  const pending = db.orders.filter(o => !o.sent);
  const count   = pending.length;

  ['order-count', 'order-count-mobile', 'tile-order-badge'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = count > 0 ? 'flex' : 'none'; el.textContent = count; }
  });

  const ordersList = document.getElementById('orders-list');
  if (pending.length === 0) {
    ordersList.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Inga aktiva beställningar.</p>';
  } else {
    ordersList.innerHTML = pending.map(o =>
      '<div class="order-card">' +
      '<div><div class="oc-name">' + esc(o.name) + '</div>' +
      '<div class="oc-detail">Beställ: ' + o.orderQty + ' st &nbsp;·&nbsp; Art.nr: ' + esc(o.articleNo || '—') + ' &nbsp;·&nbsp; Leverantör: ' + esc(o.supplier || '—') + (o.createdAt ? ' &nbsp;·&nbsp; ' + new Date(o.createdAt).toLocaleDateString('sv-SE') : '') + '</div></div>' +
      '<button class="btn btn-sm" onclick="markSent(\'' + o.id + '\')">Markera skickad</button>' +
      '</div>'
    ).join('');
  }

  // E-post förhandsvisning
  const s     = db.settings;
  const today = new Date().toLocaleDateString('sv-SE');
  const ws    = s.workshop || 'Verkstaden';
  const lines = pending.map((o, i) =>
    (i + 1) + '. ' + o.name + '\n   Antal: ' + o.orderQty + ' st\n   Artikelnummer: ' + (o.articleNo || '—') + '\n   Leverantör: ' + (o.supplier || '—') + '\n   Streckkod: ' + o.code
  ).join('\n\n');

  document.getElementById('email-preview').textContent = pending.length === 0
    ? '(Inga aktiva beställningar)'
    : 'Till: ' + (s.email || 'chef@verkstad.se') + '\n' +
      'Ämne: Beställningsorder — ' + ws + ' ' + today + '\n\n' +
      'Hej,\n\nFöljande artiklar behöver beställas till ' + ws + ':\n\n' +
      lines + '\n\nTotalt ' + pending.length + ' artikel' + (pending.length > 1 ? 'er' : '') +
      ' att beställa.\n\nVänliga hälsningar,\nScanny — ' + ws;
}

function renderInventering() {
  const el = document.getElementById('inventering-list');
  if (!el) return;
  const reports = db.inventoryReports || [];
  if (reports.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Inga inventeringar genomförda ännu.</p>';
    return;
  }

  el.innerHTML = reports.map(r => {
    const diffs = r.entries.filter(e => e.scanned !== e.previous);
    const ok    = r.entries.filter(e => e.scanned === e.previous);

    const diffRows = diffs.map(e => {
      const d  = e.scanned - e.previous;
      const ds = d > 0 ? '+' + d : '' + d;
      const icon = d > 0 ? '↑' : '↓';
      const color = d > 0 ? 'var(--accent)' : 'var(--danger)';
      return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
        '<span style="font-size:13px;font-weight:500">' + icon + ' ' + esc(e.name) + '</span>' +
        '<span style="font-size:13px;color:' + color + ';font-weight:600">' +
          e.previous + ' → ' + e.scanned + ' (' + ds + ')' +
        '</span></div>';
    }).join('');

    const okRows = ok.map(e =>
      '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
      '<span style="font-size:13px;color:var(--text2)">✓ ' + esc(e.name) + '</span>' +
      '<span style="font-size:13px;color:var(--text3)">' + e.scanned + ' st</span></div>'
    ).join('');

    return '<div class="order-card" style="flex-direction:column;align-items:stretch;border-left-color:' +
      (diffs.length > 0 ? 'var(--warn)' : 'var(--accent)') + ';margin-bottom:12px">' +

      // Header
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div>' +
          '<div class="oc-name">Inventering ' + esc(r.date) + '</div>' +
          '<div class="oc-detail">' +
            (function () {
              const who = window.ScannyUsers
                ? ScannyUsers.displayUserName(r.userId, r.actorName, db.users)
                : (r.actorDisplayName || r.actorName || '');
              return who && who !== '—' ? esc(who) + ' &nbsp;·&nbsp; ' : '';
            })() +
            'Totalt: ' + r.total + ' artiklar &nbsp;·&nbsp; ' +
            (diffs.length > 0
              ? '<span style="color:var(--warn)">' + diffs.length + ' differenser</span>'
              : '<span style="color:var(--accent)">Inga differenser</span>') +
          '</div>' +
        '</div>' +
        (diffs.length > 0
          ? '<span class="status-badge badge-warn">Differens</span>'
          : '<span class="status-badge badge-ok">OK</span>') +
      '</div>' +

      // Differenser
      (diffs.length > 0
        ? '<div style="margin-bottom:8px"><div class="section-title" style="margin-top:0">Differenser</div>' + diffRows + '</div>'
        : '') +

      // Utan differens
      '<div><div class="section-title" style="margin-top:0">Utan differens</div>' + (okRows || '<span style="font-size:13px;color:var(--text3)">Inga</span>') + '</div>' +

      '</div>';
  }).join('');
}

function renderHistory() {
  const history = db.orderHistory || [];
  const el = document.getElementById('history-list');
  if (!el) return;

  if (history.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Ingen historik ännu — beställningar visas här när de markeras som skickade.</p>';
    return;
  }

  // Gruppera per arkiveringsdatum
  const groups = {};
  history.forEach(o => {
    const key = o.archivedAt || o.created || 'Okänt datum';
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  });

  el.innerHTML = Object.entries(groups).map(([date, orders]) =>
    '<div style="margin-bottom:1.5rem">' +
    '<div class="section-title">' + esc(date) + '</div>' +
    orders.map(o =>
      '<div class="order-card" style="border-left-color:var(--text3);opacity:.8">' +
      '<div><div class="oc-name">' + esc(o.name) + '</div>' +
      '<div class="oc-detail">Beställt: ' + o.orderQty + ' st &nbsp;·&nbsp; ' + esc(o.supplier || '—') + '</div></div>' +
      '<span class="status-badge badge-ok">Skickad</span>' +
      '</div>'
    ).join('') +
    '</div>'
  ).join('');
}

function renderLog() {
  const list = document.getElementById('log-list');
  if (!list) return;
  const link = window.ScannyUsers;
  const users = db.users || [];
  const filterEl = document.getElementById('log-user-filter');
  const selected = filterEl ? filterEl.value : '';
  if (filterEl) {
    filterEl.innerHTML = '<option value="">Alla användare</option>' + users.map(u =>
      '<option value="' + esc(u.id) + '">' + esc(u.name) + '</option>'
    ).join('');
    if (selected && users.some(u => String(u.id) === selected)) filterEl.value = selected;
  }
  const user = selected ? users.find(u => String(u.id) === selected) : null;
  let logs = db.logs || [];
  if (user && link) logs = logs.filter(entry => link.matchesUser(entry, user));
  list.innerHTML = logs.length === 0
    ? '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Inga händelser ännu.</p>'
    : logs.slice(0, 100).map(l => {
        const msg = link ? link.displayLogMessage(l, users) : l.msg;
        return '<div class="log-item ' + (l.type || '') + '">' +
          '<span class="log-time">' + l.date + ' ' + l.time + '</span>' +
          '<span class="log-msg">' + esc(msg) + '</span></div>';
      }).join('');
  const statsEl = document.getElementById('log-user-stats');
  if (statsEl) {
    if (user && link) {
      const stats = link.statsForUser(user, db);
      statsEl.textContent = stats.events + ' händelser · ' + stats.scans + ' uttag i loggen · ' +
        stats.additions + ' påfyllningar · ' + stats.inventories + ' inventeringar · ' +
        stats.withdrawals + ' fordonsuttag';
    } else {
      statsEl.textContent = '';
    }
  }
}

let smtpFieldsTouched = false;

function setSmtpFieldsOpen(open) {
  const fields = document.getElementById('smtp-fields');
  const btn = document.getElementById('smtp-toggle');
  if (fields) fields.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleSmtpFields() {
  smtpFieldsTouched = true;
  const fields = document.getElementById('smtp-fields');
  setSmtpFieldsOpen(!fields || fields.hidden);
}

function renderSettings() {
  const s = db.settings || {};
  document.getElementById('s-email').value    = s.email    || '';
  const alertEl = document.getElementById('s-alert-email');
  const alertHint = document.getElementById('alert-email-hint');
  if (alertEl) {
    const dedicated = String(s.alertEmail || '').trim();
    const fallback = String(s.email || '').trim();
    alertEl.value = dedicated;
    if (alertHint) {
      alertHint.textContent = !dedicated && fallback
        ? 'Kritiska lagerlarm går tills vidare till ' + fallback + '. Beställningar och inventeringsrapporter skickas till chefens e-post.'
        : 'Hit skickas kritiska lagerlarm. Beställningar och inventeringsrapporter skickas till chefens e-post. Lämna tomt för att använda chefens e-post.';
    }
  }
  document.getElementById('s-workshop').value = s.workshop || '';
  document.getElementById('s-host').value     = s.smtpHost || '';
  document.getElementById('s-port').value     = s.smtpPort || 587;
  document.getElementById('s-user').value     = s.smtpUser || '';
  if (!smtpFieldsTouched) setSmtpFieldsOpen(!!String(s.smtpUser || '').trim());

  // Etikettskrivare
  const sizeEl = document.getElementById('s-label-size');
  if (sizeEl) sizeEl.value = s.labelSize || '62x29';
  renderPrintBridge();
  maybeRefreshPrintBridge();

  // Schema
  const dayEl  = document.getElementById('s-schedule-day');
  const timeEl = document.getElementById('s-schedule-time');
  if (dayEl)  dayEl.value  = s.scheduleDay !== undefined ? String(s.scheduleDay) : '';
  if (timeEl) timeEl.value = s.scheduleTime || '07:00';

  // Visa nästa schemalagda skickning
  const statusEl = document.getElementById('schedule-status');
  if (statusEl) {
    if (s.scheduleDay !== undefined && s.scheduleDay !== '' && s.scheduleTime) {
      const days = ['Söndag','Måndag','Tisdag','Onsdag','Torsdag','Fredag','Lördag'];
      statusEl.innerHTML = '✅ Schemalagd: <strong>' + days[s.scheduleDay] + ' kl ' + s.scheduleTime + '</strong>' +
        (s.lastScheduledSend ? ' &nbsp;·&nbsp; Senast skickad: ' + s.lastScheduledSend : '');
    } else {
      statusEl.textContent = 'Schemalagd skickning är inaktiverad.';
    }
  }

}

function renderAll() {
  const workshopEl = document.getElementById("workshop-name");
  if (workshopEl) workshopEl.textContent = db.settings?.workshop || "";
  renderMetrics();
  renderQuickGrid();
  renderLager();
  renderOrders();
  renderHistory();
  renderInventering();
  renderLog();
  renderSettings();
  renderUsers();
  renderVehicles();
  renderTrash();
  renderAdminChrome();
  applyPlanUI();
}

// ── Paketnivå-UI (kvot + funktionsgrindar) ──
function applyPlanUI() {
  const lim = db.planLimits || {};
  const count = (db.users || []).length;
  const max = lim.maxUsers; // null = obegränsat
  const usageEl = document.getElementById('users-usage');
  if (usageEl) usageEl.textContent = (max == null) ? `${count} användare (obegränsat)` : `${count} / ${max} användare`;
  const addBtn = document.getElementById('btn-add-user');
  if (addBtn) {
    const full = (max != null) && count >= max;
    addBtn.disabled = full;
    addBtn.style.opacity = full ? '0.5' : '';
    addBtn.style.cursor = full ? 'not-allowed' : '';
    addBtn.title = full ? `Din plan tillåter max ${max} användare` : '';
  }
  const schedCard = document.getElementById('schedule-card');
  const schedUp = document.getElementById('schedule-upgrade');
  const blocked = lim.scheduledOrders === false;
  if (schedUp) schedUp.style.display = blocked ? 'block' : 'none';
  if (schedCard) schedCard.querySelectorAll('select,input,button').forEach(e => { e.disabled = blocked; });
}

// ── Användare ──
function renderUsers() {
  const el = document.getElementById('users-list');
  if (!el) return;
  const users = db.users || [];
  if (users.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Inga användare tillagda ännu.</p>';
    return;
  }
  const permLabel = p => {
    const parts = [];
    if (p?.canScan || p?.scan !== false) parts.push('Uttag');
    if (p?.canAdd || p?.add) parts.push('Addera');
    if (p?.canInventory || p?.inventory) parts.push('Inventering');
    return parts.join(', ') || 'Inga behörigheter';
  };
  el.innerHTML = users.map(u => `
    <div class="order-card" style="border-left-color:${u.color||'var(--accent)'}">
      <div style="display:flex;align-items:center;gap:12px;flex:1">
        <div style="width:40px;height:40px;border-radius:50%;background:${u.color||'#0f6e56'};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0">${esc(u.initials||'?')}</div>
        <div>
          <div class="oc-name">${esc(u.name)}</div>
          <div class="oc-detail">Behörigheter: ${permLabel(u.permissions)}</div>
          <div class="oc-detail">${u.hasPin ? '🔒 PIN aktiv' : '🔓 Ingen PIN'}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="openEditUser('${escJs(u.id)}')">Redigera</button>
        <button class="btn btn-sm" onclick="setUserPin('${escJs(u.id)}')">🔑 PIN</button>
        <button class="btn btn-sm btn-danger" onclick="deleteUser('${escJs(u.id)}')">Ta bort</button>
      </div>
    </div>`).join('');
}

function openEditUser(id) {
  const u = (db.users || []).find(x => String(x.id) === String(id));
  const modal = document.getElementById('user-edit-modal');
  if (!u || !modal) return;
  document.getElementById('eu-id').value = u.id;
  document.getElementById('eu-name').value = u.name || '';
  const on = key => window.ScannyUsers ? ScannyUsers.checkboxOn(u.permissions, key) : false;
  document.getElementById('eu-perm-scan').checked = on('scan');
  document.getElementById('eu-perm-add').checked = on('add');
  document.getElementById('eu-perm-inv').checked = on('inventory');
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('eu-name').focus(), 100);
}

function closeEditUserModal() {
  const modal = document.getElementById('user-edit-modal');
  if (modal) modal.style.display = 'none';
}

async function saveEditUser() {
  const name = document.getElementById('eu-name').value.trim();
  if (!name) { toast('Fyll i namn', 'error'); return; }
  const permissions = {
    canScan: document.getElementById('eu-perm-scan').checked,
    canAdd: document.getElementById('eu-perm-add').checked,
    canInventory: document.getElementById('eu-perm-inv').checked
  };
  if (!permissions.canScan && !permissions.canAdd && !permissions.canInventory) {
    toast('Minst en behörighet måste väljas', 'error');
    return;
  }
  const id = document.getElementById('eu-id').value;
  try {
    await api('PATCH', '/api/users/' + id, { name, permissions });
    toast('Användare uppdaterad: ' + name);
    closeEditUserModal();
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

const userEditModal = document.getElementById('user-edit-modal');
if (userEditModal) {
  userEditModal.addEventListener('click', e => { if (e.target === userEditModal) closeEditUserModal(); });
  userEditModal.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveEditUser();
    if (e.key === 'Escape') closeEditUserModal();
  });
}

async function addUser() {
  const name = document.getElementById('u-name').value.trim();
  if (!name) { toast('Fyll i namn','error'); return; }
  const permissions = {
    scan:      document.getElementById('u-perm-scan').checked,
    add:       document.getElementById('u-perm-add').checked,
    inventory: document.getElementById('u-perm-inv').checked
  };
  const pinEl = document.getElementById('u-pin');
  const pin = pinEl ? pinEl.value.trim() : '';
  if (pin && !/^\d{4}$/.test(pin)) { toast('PIN måste vara 4 siffror', 'error'); return; }
  try {
    await api('POST', '/api/users', { name, permissions, pin: pin || undefined });
    toast('Användare tillagd: ' + name);
    document.getElementById('u-name').value = '';
    if (pinEl) pinEl.value = '';
    document.getElementById('u-perm-scan').checked = true;
    document.getElementById('u-perm-add').checked  = false;
    document.getElementById('u-perm-inv').checked  = false;
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

// Sätt / ändra / ta bort en användares PIN
async function setUserPin(id) {
  const u = db.users?.find(x => x.id === id);
  if (!u) return;
  const input = prompt(`PIN för ${u.name}\n\nAnge 4 siffror. Lämna tomt och tryck OK för att ta bort PIN.`, '');
  if (input === null) return; // avbrutet
  const pin = input.trim();
  if (pin !== '' && !/^\d{4}$/.test(pin)) { toast('PIN måste vara 4 siffror', 'error'); return; }
  try {
    await api('PATCH', '/api/users/' + id, { pin });
    toast(pin ? 'PIN sparad för ' + u.name : 'PIN borttagen för ' + u.name);
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteUser(id) {
  const u = db.users?.find(x => x.id === id);
  if (!u) return;
  if (!confirm('Ta bort användare "' + u.name + '"?')) return;
  try { await api('DELETE', '/api/users/' + id); toast('Användare borttagen'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

let vehiclesTab = 'active';
function setVehiclesTab(tab) {
  vehiclesTab = tab;
  const btnA = document.getElementById('vehicles-tab-active');
  const btnAr = document.getElementById('vehicles-tab-archived');
  const addCard = document.getElementById('add-vehicle-card');
  if (btnA)  { btnA.style.borderColor  = tab === 'active'   ? 'var(--accent)' : 'var(--border)'; btnA.style.color  = tab === 'active'   ? 'var(--accent)' : ''; }
  if (btnAr) { btnAr.style.borderColor = tab === 'archived' ? 'var(--accent)' : 'var(--border)'; btnAr.style.color = tab === 'archived' ? 'var(--accent)' : ''; }
  document.getElementById('vehicles-list')?.style.setProperty('display', tab === 'active' ? 'block' : 'none');
  document.getElementById('vehicles-archived-list')?.style.setProperty('display', tab === 'archived' ? 'block' : 'none');
  if (addCard) addCard.style.display = tab === 'active' ? 'block' : 'none';
}

function renderVehicles() {
  const active   = document.getElementById('vehicles-list');
  const archived = document.getElementById('vehicles-archived-list');
  if (!active) return;

  const vehicles     = (db.vehicles || []).filter(v => !v.archived);
  const archivedList = (db.vehicles || []).filter(v =>  v.archived);

  // Aktuellt A-pris för en historikpost (matcha på art.nr, annars namn)
  const priceOf = (h) => {
    const art = (h.articleNo || '').trim();
    let p = null;
    if (art && art !== '—') p = (db.products || []).find(x => (x.articleNo || '').trim() === art);
    if (!p) p = (db.products || []).find(x => x.name === h.productName);
    return p ? (p.price || 0) : 0;
  };
  // Summera historik per artikel (slå ihop dubbletter)
  const materialSummary = (v) => {
    const map = new Map();
    (v.history || []).forEach(h => {
      const art = (h.articleNo || '').trim();
      const key = (art && art !== '—') ? 'art:' + art : 'name:' + h.productName;
      const cur = map.get(key) || { name: h.productName, articleNo: h.articleNo, qty: 0, price: priceOf(h) };
      cur.qty += Number(h.qty) || 0;
      map.set(key, cur);
    });
    return [...map.values()];
  };

  const vehicleCard = (v, isArchived) => `
    <div class="order-card" style="border-left-color:#ec4899;flex-direction:column;align-items:stretch;margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div class="oc-name" style="font-size:18px;letter-spacing:1px">🚗 ${esc(v.regNr)}</div>
          <div class="oc-detail">${esc([v.make,v.model,v.color].filter(Boolean).join(' '))}</div>
          ${v.customerName ? `<div class="oc-detail">👤 ${esc(v.customerName)}${v.customerContact?' &nbsp;·&nbsp; 📞 '+esc(v.customerContact):''}</div>` : ''}
          ${v.lastExportAt ? `<div class="oc-detail" style="color:var(--text3)">Senaste export: ${esc(v.lastExportAt)}</div>` : ''}
          ${isArchived ? `<div class="oc-detail" style="color:var(--danger)">Arkiverad: ${esc(v.archivedAt||'')}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${!isArchived ? `
            ${(db.planLimits && db.planLimits.pdfExport === false) ? '' : `<button class="btn btn-sm" onclick="exportVehicle('${v.id}')">📄 Exportera</button>`}
            <button class="btn btn-sm" onclick="archiveVehicle('${v.id}')" style="border-color:var(--warn);color:var(--warn)">🔒 Stäng</button>
          ` : `
            <button class="btn btn-sm" onclick="unarchiveVehicle('${v.id}')" style="border-color:var(--accent);color:var(--accent)">🔓 Återöppna</button>
          `}
          <button class="btn btn-sm btn-danger" onclick="deleteVehicle('${v.id}')">Ta bort</button>
        </div>
      </div>
      ${(v.history||[]).length > 0 ? (() => {
        const items = materialSummary(v);
        const total = items.reduce((s, it) => s + it.qty * it.price, 0);
        return `
        <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
          <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Materialåtgång</div>
          <div style="display:flex;font-size:11px;color:var(--text3);padding:2px 0">
            <span style="flex:1">Artikel</span>
            <span style="width:36px;text-align:right">Antal</span>
            <span style="width:80px;text-align:right">A-pris</span>
            <span style="width:90px;text-align:right">Radkostnad</span>
          </div>
          ${items.map(it => `
            <div style="display:flex;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)">
              <span style="flex:1">${esc(it.name)}${it.price ? '' : ' <span style="color:var(--warn)" title="Inget A-pris satt">⚠</span>'}</span>
              <span style="width:36px;text-align:right">${it.qty}</span>
              <span style="width:80px;text-align:right;color:var(--text3)">${it.price ? kr(it.price) : '—'}</span>
              <span style="width:90px;text-align:right">${kr(it.qty * it.price)}</span>
            </div>`).join('')}
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;padding-top:6px">
            <span>Total materialkostnad</span>
            <span>${kr(total)}</span>
          </div>
          <div style="font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 6px">Senaste uttag</div>
          ${(v.history || []).slice(0, 5).map(h => {
            const who = window.ScannyUsers
              ? ScannyUsers.displayUserName(h.userId, h.userName, db.users)
              : (h.userDisplayName || h.userName || '—');
            return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)">
              <span>${esc(h.productName)} &nbsp;·&nbsp; ${esc(who)}</span>
              <span style="color:var(--text3)">${esc(h.time || '')}</span>
            </div>`;
          }).join('')}
        </div>`; })() : ''}
    </div>`;

  active.innerHTML = vehicles.length === 0
    ? '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Inga aktiva fordon.</p>'
    : vehicles.map(v => vehicleCard(v, false)).join('');

  archived.innerHTML = archivedList.length === 0
    ? '<p style="color:var(--text3);font-size:13px;padding:.5rem 0">Inga arkiverade fordon.</p>'
    : archivedList.map(v => vehicleCard(v, true)).join('');
}

// Export-modal
function exportVehicle(id) {
  const v = db.vehicles?.find(x => x.id === id);
  if (!v) return;
  const hasLastExport = !!v.lastExportAt;
  const choice = hasLastExport
    ? confirm(`Exportera "${v.regNr}"\n\nOK = Sedan senaste export (${v.lastExportAt})\nAvbryt = Alla uttag`)
    : null;
  const since = (choice === true) ? 'last' : 'all';
  const token = localStorage.getItem('scanny_token');
  fetch('/api/vehicles/' + id + '/export?since=' + since, {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.text()).then(html => {
    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
  }).catch(() => toast('Export misslyckades', 'error'));

  // Fråga om stängning efter kort delay
  setTimeout(() => {
    if (confirm('Vill du stänga fordonet så inga fler uttag kan loggas på det?')) {
      archiveVehicle(id);
    }
  }, 500);
}

async function archiveVehicle(id) {
  const v = db.vehicles?.find(x => x.id === id);
  if (!v) return;
  if (!confirm('Stäng fordon "' + v.regNr + '"? Det arkiveras och försvinner från kiosken.')) return;
  try { await api('PATCH', '/api/vehicles/' + id + '/archive'); toast('Fordon stängt och arkiverat'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

async function unarchiveVehicle(id) {
  const v = db.vehicles?.find(x => x.id === id);
  if (!v) return;
  if (!confirm('Återöppna fordon "' + v.regNr + '"?')) return;
  try { await api('PATCH', '/api/vehicles/' + id + '/unarchive'); toast('Fordon återöppnat'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

async function addVehicle() {
  const regNr = document.getElementById('v-regnr').value.trim().toUpperCase();
  if (!regNr) { toast('Fyll i reg-nr','error'); return; }
  const body = {
    regNr,
    make:            document.getElementById('v-make').value.trim(),
    model:           document.getElementById('v-model').value.trim(),
    color:           document.getElementById('v-color').value.trim(),
    customerName:    document.getElementById('v-customer').value.trim(),
    customerContact: document.getElementById('v-contact').value.trim()
  };
  try {
    await api('POST', '/api/vehicles', body);
    toast('Fordon tillagt: ' + regNr);
    ['v-regnr','v-make','v-model','v-color','v-customer','v-contact'].forEach(id => document.getElementById(id).value = '');
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteVehicle(id) {
  const v = db.vehicles?.find(x => x.id === id);
  if (!v) return;
  if (!confirm('Ta bort fordon "' + v.regNr + '"?')) return;
  try { await api('DELETE', '/api/vehicles/' + id); toast('Fordon borttaget'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
//  Produkthantering
// ═══════════════════════════════════════════════════════════════
// Reconcile (badges/metrics/full tabell) körs EN gång, först när alla anrop landat.
function scheduleReconcile() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    if (_inflight > 0) { scheduleReconcile(); return; }
    loadAll();
  }, 250);
}

function adjustQty(id, delta) {
  const p = db.products.find(x => x.id === id);
  if (!p) return;
  if (delta < 0 && p.qty <= 0) return;   // inget att ta bort
  // Optimistisk uppdatering: ändra BARA siffran, rör inte knappen — så inga snabba klick tappas.
  p.qty += delta;
  const span = document.getElementById('qd-' + id);
  if (span) span.textContent = p.qty;
  // Skicka atomärt i bakgrunden (/api/scan = −1, /api/add = +1). Ordningen spelar ingen roll.
  _inflight++;
  api('POST', delta < 0 ? '/api/scan' : '/api/add', { code: p.code })
    .catch(err => {                       // rulla tillbaka vid fel (t.ex. slut på lager)
      p.qty -= delta;
      if (span) span.textContent = p.qty;
      toast(err.message, 'error');
    })
    .finally(() => { _inflight--; scheduleReconcile(); });
}

function productDeleteButton(p) {
  if (currentRole() !== 'admin') return '';
  return '<button class="btn btn-sm btn-danger" onclick="deleteProduct(\'' + escJs(p.id) + '\')">Ta bort</button>';
}

async function loadTrashQuiet() {
  db.trash = [];
  if (currentRole() !== 'admin') return;
  try {
    const token = getToken();
    const res = await fetch('/api/products/trash', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    if (!res.ok) return;
    const rows = await res.json();
    db.trash = Array.isArray(rows) ? rows : [];
    db.trash.forEach(p => { if (!p.id && p._id) p.id = p._id; });
  } catch (_) {
    db.trash = [];
  }
}

function renderAdminChrome() {
  const tile = document.getElementById('trash-tile');
  if (tile) tile.hidden = currentRole() !== 'admin';
}

function trashWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderTrash() {
  const body = document.getElementById('trash-body');
  if (!body) return;
  if (currentRole() !== 'admin') {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:2rem">Papperskorgen är bara tillgänglig för administratörer.</td></tr>';
    return;
  }
  const rows = db.trash || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:2rem">Papperskorgen är tom.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(p =>
    '<tr>' +
    '<td style="font-weight:500">' + esc(p.name) + '</td>' +
    '<td style="font-family:monospace">' + esc(p.code || '—') + '</td>' +
    '<td>' + esc(p.articleNo || '—') + '</td>' +
    '<td>' + esc(p.deletedByName || '—') + '</td>' +
    '<td>' + esc(trashWhen(p.deletedAt)) + '</td>' +
    '<td>' + esc(trashWhen(p.purgeAt)) + '</td>' +
    '<td><div class="trash-actions">' +
      '<button class="btn btn-sm" onclick="restoreProduct(\'' + escJs(p.id) + '\')">Återställ</button>' +
      '<button class="btn btn-sm btn-danger" onclick="permanentlyDeleteProduct(\'' + escJs(p.id) + '\')">Radera permanent</button>' +
    '</div></td>' +
    '</tr>'
  ).join('');
}

async function deleteProduct(id) {
  if (currentRole() !== 'admin') { toast('Kräver admin-behörighet', 'error'); return; }
  const p = db.products.find(x => x.id === id);
  if (!p) return;
  if (!confirm('Flytta "' + p.name + '" till papperskorgen? Produkten kan återställas i 30 dagar.')) return;
  try { await api('DELETE', '/api/products/' + id); toast('Produkt flyttad till papperskorgen'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

async function restoreProduct(id) {
  if (currentRole() !== 'admin') { toast('Kräver admin-behörighet', 'error'); return; }
  const p = (db.trash || []).find(x => x.id === id);
  if (!p) return;
  if (!confirm('Återställ "' + p.name + '" till lagret?')) return;
  try { await api('POST', '/api/products/' + id + '/restore'); toast('Produkt återställd'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

async function permanentlyDeleteProduct(id) {
  if (currentRole() !== 'admin') { toast('Kräver admin-behörighet', 'error'); return; }
  const p = (db.trash || []).find(x => x.id === id);
  if (!p) return;
  if (!confirm('Radera "' + p.name + '" permanent? Detta går inte att ångra.')) return;
  try { await api('DELETE', '/api/products/' + id + '/permanent'); toast('Produkten raderades permanent'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

// Utskriftsmått i mm per etikettstorlek (bredd = tejpens bredd, höjd = matningslängd).
// För 29x90 skrivs designen liggande (90 bred) och drivrutinen roterar på den avlånga rullen.
const PRINT_DIMS_MM = {
  '62':    { w: 62, h: 100 },
  '62x29': { w: 62, h: 29 },   // DK-11209 – bred etikett
  '29x90': { w: 90, h: 29 },   // DK-11201 – avlång etikett (liggande design)
  '29':    { w: 29, h: 100 },
  '38':    { w: 38, h: 100 },
  '50':    { w: 50, h: 100 },
  '54':    { w: 54, h: 100 },
};

// ── Etikettutskrift (via webbläsaren till Brother QL-810W) ──
function renderLabel(p) {
  const area = document.getElementById('print-label');
  if (!area || typeof JsBarcode === 'undefined') {
    toast('Kunde inte skapa etikett (streckkodsbiblioteket laddades inte).', 'error');
    return false;
  }
  // Anpassa sidstorlek efter vald etikettstorlek i inställningarna
  const size = (db.settings && db.settings.labelSize) || '62x29';
  const dim = PRINT_DIMS_MM[size] || PRINT_DIMS_MM['62x29'];
  area.classList.toggle('dk11209', size === '62x29');
  area.style.width = dim.w + 'mm';
  const dimsEl = document.getElementById('print-dims');
  if (dimsEl) dimsEl.textContent = '@page{size:' + dim.w + 'mm ' + dim.h + 'mm;margin:0}';
  area.querySelector('.pl-name').textContent = p.name || '';
  area.querySelector('.pl-art').textContent  = p.articleNo ? 'Art.nr: ' + p.articleNo : '';
  try {
    JsBarcode(area.querySelector('.pl-bc'), String(p.code || ''),
      { format: 'CODE128', displayValue: true, height: 44, margin: 0, fontSize: 16 });
  } catch (e) {
    toast('Ogiltig streckkod för etikett: ' + e.message, 'error');
    return false;
  }
  return true;
}

function printLabel(id) {
  const p = db.products.find(x => x.id === id);
  if (!p) return;
  if (renderLabel(p)) setTimeout(() => window.print(), 120);
}

// Knappen visas bara när automatisk utskrift är på. Webbläsarens etikettknapp finns kvar.
function currentRole() {
  try {
    const part = (getToken() || '').split('.')[1];
    if (!part) return '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded + '='.repeat((4 - (padded.length % 4)) % 4);
    const json = JSON.parse(atob(pad));
    return json && json.role ? json.role : '';
  } catch (e) {
    return '';
  }
}

function bridgePrintReady() {
  const b = db.settings && db.settings.printBridge;
  return !!(b && b.enabled && b.configured);
}

function queueLabelButton(id) {
  if (!bridgePrintReady()) return '';
  return '<button class="btn btn-sm" onclick="queueLabel(\'' + id + '\')">Skriv ut etikett</button>';
}

async function queueLabel(id) {
  try {
    await api('POST', '/api/products/' + id + '/queue-label');
    toast('Etikett skickad till skrivaren');
  } catch (err) { toast(err.message, 'error'); }
}

// Öppnar en förhandsvisning av etiketten i nytt fönster (för test utan att skriva ut).
async function previewLabel(id) {
  try {
    const token = getToken();
    const res = await fetch('/api/products/' + id + '/label.png', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {},
    });
    if (!res.ok) throw new Error('Kunde inte generera förhandsvisning');
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank');
  } catch (err) { toast(err.message, 'error'); }
}

function showAddProductModal() {
  ['a-name','a-code','a-article','a-supplier'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('a-qty').value = '10';
  document.getElementById('a-min').value = '5';
  document.getElementById('a-critical').value = '2';
  document.getElementById('a-order').value = '10';
  document.getElementById('a-price').value = '0';
  document.getElementById('add-product-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('a-name').focus(), 100);
}

function closeAddProductModal() {
  document.getElementById('add-product-modal').style.display = 'none';
}

// Skapar en unik intern streckkod (12 siffror, prefix "2" = internt/butik).
// Kontrollerar mot befintliga produkter så inga dubbletter uppstår.
function generateBarcode() {
  const input = document.getElementById('a-code');
  if (!input) return;
  const existing = new Set((db.products || []).map(p => String(p.code)));
  let code, tries = 0;
  do {
    const rnd = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    code = '2' + String(Date.now()).slice(-6) + rnd; // 1 + 6 + 5 = 12 siffror
    tries++;
  } while (existing.has(code) && tries < 100);
  input.value = code;
  toast('Streckkod genererad: ' + code);
}

const addProductModal = document.getElementById('add-product-modal');
if (addProductModal) {
  addProductModal.addEventListener('click', e => { if (e.target === addProductModal) closeAddProductModal(); });
  addProductModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeAddProductModal(); });
}

async function addProduct() {
  const body = {
    name:      document.getElementById('a-name').value.trim(),
    code:      document.getElementById('a-code').value.trim(),
    qty:       parseInt(document.getElementById('a-qty').value) || 0,
    min:       parseInt(document.getElementById('a-min').value) || 5,
    critical:  parseInt(document.getElementById('a-critical').value) || 2,
    orderQty:  parseInt(document.getElementById('a-order').value) || 10,
    articleNo: document.getElementById('a-article').value.trim(),
    supplier:  document.getElementById('a-supplier').value.trim(),
    price:     parseFloat(document.getElementById('a-price').value) || 0
  };
  if (!body.name || !body.code) { toast('Fyll i namn och streckkod', 'error'); return; }
  const printEl = document.getElementById('a-print');
  const doPrint = printEl ? printEl.checked : false;
  try {
    const created = await api('POST', '/api/products', body);
    toast('Produkt tillagd: ' + body.name);
    closeAddProductModal();
    await loadAll();
    if (doPrint) {
      const np = db.products.find(x => x.code === body.code);
      if (np && renderLabel(np)) setTimeout(() => window.print(), 150);
    }
  } catch (err) { toast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
//  Inställningar
// ═══════════════════════════════════════════════════════════════
async function printApi(method, path, body) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { clearToken(); window.location.href = '/login'; return null; }
  if (!res.ok) throw new Error(data.error || 'Serverfel');
  return data;
}

let pbRefreshAt = 0;

function renderPrintBridge() {
  const b = (db.settings && db.settings.printBridge) || {};
  const admin = currentRole() === 'admin';
  const enabled = document.getElementById('pb-enabled');
  if (enabled) {
    enabled.value = b.enabled ? 'on' : 'off';
    enabled.disabled = !admin;
  }
  const hint = document.getElementById('pb-key-hint');
  if (hint) hint.hidden = !!b.configured;
  const status = document.getElementById('pb-status');
  if (status) status.textContent = bridgeStatusText(b);
  const configured = !!b.configured;
  const createBtn = document.getElementById('pb-create');
  const rotateBtn = document.getElementById('pb-rotate');
  const revokeBtn = document.getElementById('pb-revoke');
  if (createBtn) { createBtn.hidden = configured; createBtn.disabled = !admin; }
  if (rotateBtn) { rotateBtn.hidden = !configured; rotateBtn.disabled = !admin; }
  if (revokeBtn) { revokeBtn.hidden = !configured; revokeBtn.disabled = !admin; }
  const testBtn = document.getElementById('pb-test');
  if (testBtn) testBtn.disabled = !admin;
  const box = document.getElementById('pb-key-once');
  const val = document.getElementById('pb-key-value');
  if (box && val && !val.textContent) box.hidden = true;
}

function bridgeStatusText(b) {
  if (!b || !b.configured) return 'Brygga: ingen nyckel. Automatisk utskrift är av.';
  const prefix = b.keyPrefix ? ' Nyckel ' + b.keyPrefix + '….' : '';
  if (!b.enabled) return 'Brygga: nyckel finns men automatisk utskrift är av.' + prefix;
  if (b.online) {
    let text = 'Brygga: online.' + prefix;
    if (b.printerName) text += ' Kö: ' + b.printerName + '.';
    if (b.printerStatus && b.printerStatus !== 'ok') {
      text += ' Skrivarstatus: ' + b.printerStatus + (b.printerDetail ? ' (' + b.printerDetail + ')' : '') + '.';
    } else {
      text += ' Skrivaren svarar.';
    }
    return text;
  }
  const when = b.lastHeartbeatAt
    ? ' Senaste livstecken: ' + new Date(b.lastHeartbeatAt).toLocaleString('sv-SE') + '.'
    : ' Inget livstecken ännu.';
  return 'Brygga: offline.' + prefix + when;
}

function maybeRefreshPrintBridge() {
  const panel = document.getElementById('tab-settings');
  if (!panel || !panel.classList.contains('active')) return;
  if (!document.getElementById('pb-status')) return;
  const now = Date.now();
  if (now - pbRefreshAt < 5000) return;
  pbRefreshAt = now;
  refreshPrintBridgeStatus();
}

async function refreshPrintBridgeStatus() {
  try {
    const b = await printApi('GET', '/api/print/status');
    if (!b) return;
    db.settings = db.settings || {};
    db.settings.printBridge = b;
    renderPrintBridge();
  } catch (_) { /* behåll senaste kända läge */ }
}

function showBridgeKeyOnce(key) {
  const box = document.getElementById('pb-key-once');
  const val = document.getElementById('pb-key-value');
  if (val) val.textContent = key || '';
  if (box) box.hidden = !key;
}

async function onPrintBridgeEnabled() {
  const el = document.getElementById('pb-enabled');
  const hint = document.getElementById('pb-key-hint');
  if (!el) return;
  const wantOn = el.value === 'on';
  const configured = !!(db.settings && db.settings.printBridge && db.settings.printBridge.configured);
  if (wantOn && !configured) {
    el.value = 'off';
    if (hint) hint.hidden = false;
    toast('Skapa en bryggnyckel innan du slår på automatisk etikettutskrift.', 'error');
    return;
  }
  try {
    await printApi('PUT', '/api/print/settings', { enabled: wantOn });
    if (hint) hint.hidden = true;
    toast(wantOn ? 'Automatisk etikettutskrift är på' : 'Automatisk etikettutskrift är av');
    pbRefreshAt = 0;
    await loadAll();
  } catch (err) {
    el.value = wantOn ? 'off' : 'on';
    if (hint && /bryggnyckel/.test(err.message || '')) hint.hidden = false;
    toast(err.message, 'error');
  }
}

async function createBridgeKey() {
  try {
    const res = await printApi('POST', '/api/print/key');
    if (!res) return;
    showBridgeKeyOnce(res.key);
    toast(res.message || 'Nyckel skapad. Kopiera den nu — den visas bara en gång.');
    pbRefreshAt = 0;
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function revokeBridgeKey() {
  if (!confirm('Återkalla bryggnyckeln? Automatisk utskrift stängs av tills du skapar en ny nyckel.')) return;
  try {
    await printApi('DELETE', '/api/print/key');
    showBridgeKeyOnce('');
    toast('Nyckeln är återkallad');
    pbRefreshAt = 0;
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function testBridgePrint() {
  try {
    await printApi('POST', '/api/print/test');
    toast('Testetikett skickad till skrivaren');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveSettings() {
  const dayVal = document.getElementById('s-schedule-day').value;
  const alertEl = document.getElementById('s-alert-email');
  const body = {
    email:        document.getElementById('s-email').value.trim(),
    workshop:     document.getElementById('s-workshop').value.trim(),
    smtpHost:     document.getElementById('s-host').value.trim(),
    smtpPort:     parseInt(document.getElementById('s-port').value) || 587,
    smtpUser:     document.getElementById('s-user').value.trim(),
    scheduleDay:  dayVal !== '' ? parseInt(dayVal) : null,
    scheduleTime: document.getElementById('s-schedule-time').value || '07:00',
  };
  if (alertEl) body.alertEmail = alertEl.value.trim();
  const sizeEl = document.getElementById('s-label-size');
  if (sizeEl) {
    body.labelSize = sizeEl.value || '62x29';
    const pmap = { '62':'62mm','29':'29mm','38':'38mm','50':'50mm','54':'54mm','62x29':'DC06','29x90':'DC03' };
    body.pageSize  = pmap[body.labelSize] || '62mm';
  }
  const pass = document.getElementById('s-pass').value;
  if (pass) body.smtpPass = pass;
  try {
    await api('PUT', '/api/settings', body);
    toast('Inställningar sparade');
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

function setTestAlertStatus(msg, ok) {
  const el = document.getElementById('test-alert-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? 'var(--accent)' : 'var(--danger)';
}

async function sendTestAlertEmail() {
  const alertEl = document.getElementById('s-alert-email');
  const to = alertEl ? alertEl.value.trim() : '';
  const saved = db.settings || {};
  const btn = document.getElementById('btn-test-alert');
  if (!to && !String(saved.alertEmail || saved.email || '').trim()) {
    setTestAlertStatus('Ange en e-postadress för lagerlarm', false);
    toast('Ange en e-postadress för lagerlarm', 'error');
    return;
  }
  if (btn) btn.disabled = true;
  setTestAlertStatus('Skickar testmejl…', true);
  try {
    const res = await api('POST', '/api/settings/test-alert', to ? { to } : {});
    if (!res) return;
    const msg = res.channel ? `Testmejl skickat (${res.channel})` : 'Testmejl skickat';
    setTestAlertStatus(msg, true);
    toast(msg, 'success');
  } catch (err) {
    const msg = err.message || 'Kunde inte skicka testmejl';
    setTestAlertStatus(msg, false);
    toast(msg, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Beställningar
// ═══════════════════════════════════════════════════════════════
async function sendOrderEmail() {
  try {
    const res = await api('POST', '/api/orders/send');
    toast('E-post skickad (' + res.sent + ' artiklar)', 'success');
    await loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function markAllSent() {
  try { await api('POST', '/api/orders/mark-sent'); toast('Markerade som skickade'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

async function markSent(id) {
  try { await api('PATCH', '/api/orders/' + id + '/sent'); toast('Markerad som skickad'); await loadAll(); }
  catch (err) { toast(err.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════════════════════
function initScanWedge() {
  if (!window.ScannyScan || scanWedge) return;
  scanWedge = ScannyScan.attachScanWedge({
    getInput: () => document.getElementById('barcode-input'),
    getContext: adminScanContext,
    onScan: (value) => scanProduct(value)
  });
}

loadAll();
setInterval(loadAll, 15000);
initScanWedge();
if (window.ScannyUpdate) ScannyUpdate.bindModalViewport();

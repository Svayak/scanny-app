// Versionskoll och synlig yta för modaler. Rör inte skanningsfältets fokus.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScannyUpdate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const POLL_MS = 5 * 60 * 1000;
  const SCAN_IDLE_MS = 60 * 1000;

  function shouldReload(ctx) {
    if (!ctx || !ctx.version || !ctx.seen) return false;
    if (ctx.version === ctx.seen) return false;
    if (ctx.modalOpen) return false;
    const tag = String(ctx.focusedTag || '').toUpperCase();
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // Skanningsfältet är alltid fokuserat (inputmode=none). Det är inte
    // "någon skriver". Ett annat fält, eller tangentbordet påslaget, är det.
    if (typing && ctx.focusedId !== 'barcode-input') return false;
    if (ctx.manualKeyboard) return false;
    if (String(ctx.scanValue || '').trim()) return false;
    if (ctx.lastScanAt && (Number(ctx.now) - Number(ctx.lastScanAt)) < SCAN_IDLE_MS) return false;
    return true;
  }

  function isScanField(el) {
    if (!el) return false;
    if (el.id === 'barcode-input') return true;
    return el.getAttribute && el.getAttribute('data-scan-input') === 'true';
  }

  function scrollFocusedModalField() {
    const view = typeof document !== 'undefined' ? document : null;
    if (!view) return;
    const el = view.activeElement;
    if (!el || isScanField(el) || typeof el.closest !== 'function') return;
    if (!el.closest('.modal-box')) return;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    catch (_) { try { el.scrollIntoView(false); } catch (__) {} }
  }

  function syncVisualViewport() {
    const view = typeof window !== 'undefined' ? window : null;
    if (!view || !view.document) return;
    const root = view.document.documentElement;
    const vv = view.visualViewport;
    if (!vv) {
      root.style.setProperty('--vv-top', '0px');
      root.style.setProperty('--vv-height', '100dvh');
      return;
    }
    root.style.setProperty('--vv-top', vv.offsetTop + 'px');
    root.style.setProperty('--vv-height', vv.height + 'px');
    scrollFocusedModalField();
  }

  function bindModalViewport() {
    const view = typeof window !== 'undefined' ? window : null;
    if (!view || view.__scannyViewportBound) return;
    view.__scannyViewportBound = true;
    syncVisualViewport();
    if (view.visualViewport) {
      view.visualViewport.addEventListener('resize', syncVisualViewport);
      view.visualViewport.addEventListener('scroll', syncVisualViewport);
    }
    view.document.addEventListener('focusin', (e) => {
      const el = e && e.target;
      if (!el || isScanField(el) || typeof el.closest !== 'function') return;
      if (!el.closest('.modal-box')) return;
      view.requestAnimationFrame(scrollFocusedModalField);
    });
  }

  return { POLL_MS, SCAN_IDLE_MS, shouldReload, bindModalViewport, syncVisualViewport, scrollFocusedModalField };
});

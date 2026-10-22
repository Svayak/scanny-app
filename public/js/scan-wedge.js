// Skanningsinmatning för tangentbordskil (Zebra HID).
// Hårdvaran skriver tecken snabbt och avslutar med Enter. Bufferten är källan
// så att tecken inte tappas om fältet hunnit tappa fokus, och samma kod inom
// SCAN_DEDUPE_MS ignoreras (pistolens dubbelavfyrning).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScannyScan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCAN_DEDUPE_MS = 300;
  const SCAN_BUFFER_MAX = 128;

  function isPrintableKey(key) {
    return typeof key === 'string' && key.length === 1;
  }

  function keyFromEvent(e) {
    if (!e) return '';
    if (e.isComposing) return '';
    if (e.key && e.key !== 'Unidentified') return e.key;
    const code = e.keyCode || e.which || 0;
    if (code === 13) return 'Enter';
    if (code === 8) return 'Backspace';
    if (code === 27) return 'Escape';
    if (code >= 32 && code <= 126) return String.fromCharCode(code);
    return '';
  }

  function createScanBuffer(maxLen) {
    const limit = maxLen || SCAN_BUFFER_MAX;
    let buf = '';
    return {
      clear() { buf = ''; },
      value() { return buf; },
      applyKey(key) {
        if (key === 'Enter' || key === 'NumpadEnter') {
          const code = buf.trim();
          buf = '';
          return { type: 'submit', code };
        }
        if (key === 'Backspace') {
          buf = buf.slice(0, -1);
          return { type: 'edit' };
        }
        if (key === 'Escape') {
          buf = '';
          return { type: 'clear' };
        }
        if (isPrintableKey(key)) {
          buf = (buf + key).slice(-limit);
          return { type: 'edit' };
        }
        return { type: 'ignore' };
      }
    };
  }

  function createScanDedupe(windowMs) {
    const window = windowMs == null ? SCAN_DEDUPE_MS : windowMs;
    let lastCode = null;
    let lastAt = 0;
    return {
      accept(code, now) {
        const c = String(code ?? '').trim();
        if (!c) return false;
        if (c === lastCode && (now - lastAt) < window) return false;
        lastCode = c;
        lastAt = now;
        return true;
      },
      reset() { lastCode = null; lastAt = 0; }
    };
  }

  function shouldCaptureScanKeys(ctx) {
    if (!ctx || !ctx.scanActive || ctx.modalOpen) return false;
    if (ctx.activeIsRealTextField) return false;
    return true;
  }

  function shouldRefocusScanField(ctx) {
    if (!ctx || !ctx.scanActive || ctx.modalOpen) return false;
    if (ctx.activeIsScanField) return false;
    if (ctx.activeIsRealTextField) return false;
    return true;
  }

  function elementIsVisible(el) {
    if (!el || typeof el.getClientRects !== 'function') return false;
    try {
      if (el.getClientRects().length === 0) return false;
    } catch (_) {
      return false;
    }
    const view = typeof window !== 'undefined' ? window : null;
    if (view && typeof view.getComputedStyle === 'function') {
      const style = view.getComputedStyle(el);
      if (style && (style.visibility === 'hidden' || style.display === 'none')) return false;
    }
    return true;
  }

  function contextFromActiveElement(active, input, scanActive, modalOpen) {
    const activeIsScanField = !!(active && input && active === input);
    let activeIsRealTextField = false;
    if (active && !activeIsScanField) {
      const tag = String(active.tagName || '').toUpperCase();
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!active.isContentEditable;
      if (typing && elementIsVisible(active)) activeIsRealTextField = true;
    }
    return {
      scanActive: !!scanActive,
      modalOpen: !!modalOpen,
      activeIsScanField,
      activeIsRealTextField
    };
  }

  function resolveScanCode(opts) {
    const b = String((opts && opts.bufferCode) || '').trim();
    const v = String((opts && opts.inputValue) || '').trim();
    if (opts && opts.manual) return v || b;
    return b || v;
  }

  function createPendingQty() {
    const extra = new Map();
    return {
      get(code) { return extra.get(code) || 0; },
      preview(product, mode) {
        if (!product || (mode !== 'out' && mode !== 'add')) return { status: 'unknown' };
        const delta = mode === 'add' ? 1 : -1;
        const base = Number(product.qty) + (extra.get(product.code) || 0);
        if (delta < 0 && !(base > 0)) {
          return { status: 'empty', name: product.name, qty: base, delta: 0, code: product.code };
        }
        extra.set(product.code, (extra.get(product.code) || 0) + delta);
        return { status: 'ok', name: product.name, qty: base + delta, delta, code: product.code };
      },
      settle(code, delta) {
        if (!delta) return;
        const next = (extra.get(code) || 0) - delta;
        if (next === 0) extra.delete(code);
        else extra.set(code, next);
      }
    };
  }

  function createScanQueue() {
    const tails = new Map();
    return {
      enqueue(code, task) {
        const prev = tails.get(code) || Promise.resolve();
        const run = prev.then(() => task(), () => task());
        tails.set(code, run.then(() => {}, () => {}));
        return run;
      }
    };
  }

  function focusElement(el) {
    if (!el || typeof el.focus !== 'function') return;
    try { el.focus({ preventScroll: true }); }
    catch (_) { try { el.focus(); } catch (__) {} }
  }

  function attachScanWedge(options) {
    const getInput = options.getInput;
    const getContext = options.getContext;
    const onScan = options.onScan;
    const buffer = createScanBuffer();
    let manual = false;
    let refocusTimer = null;

    function inputEl() { return getInput ? getInput() : null; }

    function syncInputFromBuffer() {
      const input = inputEl();
      if (!input) return;
      const v = buffer.value();
      if (input.value !== v) input.value = v;
    }

    function clearBufferAndInput() {
      buffer.clear();
      const input = inputEl();
      if (input) input.value = '';
    }

    function refocus() {
      const ctx = getContext ? getContext() : null;
      if (!shouldRefocusScanField(ctx)) return;
      focusElement(inputEl());
    }

    function scheduleRefocus() {
      clearTimeout(refocusTimer);
      refocusTimer = setTimeout(refocus, 60);
    }

    function setManual(on) {
      manual = !!on;
      const input = inputEl();
      if (input) {
        input.setAttribute('inputmode', manual ? 'text' : 'none');
        input.setAttribute('virtualkeyboardpolicy', 'manual');
        input.classList.toggle('manual-keyboard', manual);
      }
      const vk = (typeof navigator !== 'undefined' && navigator.virtualKeyboard) ? navigator.virtualKeyboard : null;
      if (manual && input) {
        focusElement(input);
        if (vk && typeof vk.show === 'function') {
          try { vk.show(); } catch (_) {}
        } else {
          input.blur();
          setTimeout(() => focusElement(input), 40);
        }
      } else if (!manual) {
        if (vk && typeof vk.hide === 'function') {
          try { vk.hide(); } catch (_) {}
        }
        focusElement(input);
      }
      return manual;
    }

    function onKeyDown(e) {
      if (!e || e.metaKey || e.ctrlKey || e.altKey || e.key === 'Tab') return;
      const ctx = getContext ? getContext() : null;
      if (!shouldCaptureScanKeys(ctx)) {
        if (ctx && (ctx.modalOpen || !ctx.scanActive)) clearBufferAndInput();
        return;
      }
      const result = buffer.applyKey(keyFromEvent(e));
      if (result.type === 'ignore') return;
      e.preventDefault();
      e.stopPropagation();
      if (result.type === 'submit') {
        const input = inputEl();
        const code = resolveScanCode({
          bufferCode: result.code,
          inputValue: input ? input.value : '',
          manual
        });
        clearBufferAndInput();
        if (code && typeof onScan === 'function') onScan(code);
        scheduleRefocus();
        return;
      }
      syncInputFromBuffer();
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusout', scheduleRefocus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleRefocus();
    });
    window.addEventListener('pageshow', scheduleRefocus);
    const keepAlive = setInterval(() => {
      if (document.hidden) return;
      refocus();
    }, 1200);

    return {
      refocus,
      scheduleRefocus,
      setManual,
      isManual() { return manual; },
      clear: clearBufferAndInput,
      destroy() {
        clearInterval(keepAlive);
        clearTimeout(refocusTimer);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('focusout', scheduleRefocus);
      }
    };
  }

  return {
    SCAN_DEDUPE_MS,
    isPrintableKey,
    keyFromEvent,
    createScanBuffer,
    createScanDedupe,
    shouldCaptureScanKeys,
    shouldRefocusScanField,
    elementIsVisible,
    contextFromActiveElement,
    resolveScanCode,
    createPendingQty,
    createScanQueue,
    attachScanWedge
  };
});

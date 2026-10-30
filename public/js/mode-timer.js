// En enda nedräkning åt gången. start() stoppar den förra intervallen
// innan en ny skapas, så lägesbyte inte kan stapla timers.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScannyTimer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createCountdown() {
    let interval = null;
    return {
      start(totalMs, onTick, onExpire) {
        this.stop();
        let left = Math.max(1, Math.round(Number(totalMs) / 1000));
        if (typeof onTick === 'function') onTick(left);
        interval = setInterval(() => {
          left -= 1;
          if (typeof onTick === 'function') onTick(left);
          if (left <= 0) {
            this.stop();
            if (typeof onExpire === 'function') onExpire();
          }
        }, 1000);
      },
      stop() {
        if (interval != null) {
          clearInterval(interval);
          interval = null;
        }
      },
      running() { return interval != null; }
    };
  }
  return { createCountdown };
});

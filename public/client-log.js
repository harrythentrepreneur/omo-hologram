// Forwards browser errors and console output to the server so they
// appear in the Node process's terminal. Kept as a classic script (not
// a module) and loaded at the top of <head> so it captures failures
// that happen before the main module script runs.
(function () {
  const page = location.pathname || '/';
  const sid = Math.random().toString(36).slice(2, 8);
  const queue = [];
  let flushTimer = null;
  const MAX_QUEUE = 200;
  const FLUSH_MS = 1000;

  function serialise(v) {
    if (v instanceof Error) {
      return { __error: true, name: v.name, message: v.message, stack: v.stack };
    }
    if (v === undefined) return '[undefined]';
    if (typeof v === 'function') return `[fn ${v.name || 'anonymous'}]`;
    if (typeof v === 'object' && v !== null) {
      try {
        const seen = new WeakSet();
        return JSON.parse(JSON.stringify(v, (_k, val) => {
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[circular]';
            seen.add(val);
          }
          if (typeof val === 'bigint') return String(val) + 'n';
          return val;
        }));
      } catch {
        try { return String(v); } catch { return '[unserialisable]'; }
      }
    }
    return v;
  }

  function enqueue(level, args, extra) {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({
      t: Date.now(),
      level,
      page,
      sid,
      args: Array.prototype.map.call(args, serialise),
      ...(extra || {}),
    });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    const payload = JSON.stringify({ logs: batch });
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon('/log', blob)) return;
      }
      fetch('/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  // Wrap console methods — preserve native behaviour, also forward.
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = console[level] ? console[level].bind(console) : () => {};
    console[level] = function (...args) {
      try { enqueue(level, args); } catch {}
      orig(...args);
    };
  });

  window.addEventListener('error', (e) => {
    enqueue('error', [e.message || 'window.error'], {
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    enqueue('error', ['unhandledrejection', r instanceof Error ? r : serialise(r)], {
      stack: r && r.stack,
    });
  });

  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  // Public helper for the app to log its own structured events.
  window.clientLog = (level, ...args) => enqueue(level, args);

  // Announce ourselves so the server log shows page loads.
  enqueue('info', [`page load ${page}`], { ua: navigator.userAgent });
})();

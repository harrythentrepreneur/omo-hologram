// Insertion-order LRU map with optional TTL. `get()` refreshes position
// so read-heavy patterns don't cause premature eviction.

export function createLru({ max, ttlMs } = {}) {
  const entries = new Map();

  function purge() {
    if (ttlMs) {
      const cutoff = Date.now() - ttlMs;
      for (const [k, e] of entries) {
        if (e.t < cutoff) entries.delete(k);
      }
    }
    if (max) while (entries.size > max) entries.delete(entries.keys().next().value);
  }

  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (ttlMs && Date.now() - e.t > ttlMs) { entries.delete(key); return undefined; }
      entries.delete(key); entries.set(key, e);
      return e.v;
    },
    set(key, value) {
      entries.set(key, { v: value, t: Date.now() });
      purge();
    },
    delete(key) { entries.delete(key); },
    has(key) { return entries.has(key); },
    get size() { return entries.size; },
  };
}

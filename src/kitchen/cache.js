// Fingerprint → assembled-HTML cache. Fingerprints themselves are computed
// per-path in src/kitchen/index.js (template vs generator have different
// keys); this module just holds the LRU.

import { createLru } from '../lru.js';

const cache = createLru({ max: 100, ttlMs: 30 * 60 * 1000 });

export function getHtml(fp) { return cache.get(fp) ?? null; }
export function putHtml(fp, html) { cache.set(fp, html); }

// Id-keyed cache of tool-returned datasets. The model references these
// by id from render_viz — avoiding that is the hallucination gate.

import { createLru } from '../lru.js';
import { mintId } from '../util.js';

const cache = createLru({ max: 200, ttlMs: 30 * 60 * 1000 });

export function put(kind, data) {
  const prefix = kind.split('_')[0].slice(0, 4);
  const id = mintId(prefix);
  cache.set(id, { kind, data });
  return id;
}

export function get(id) {
  return cache.get(id) ?? null;
}

// Unified projectable store.
//
// Every server tool in the projection family (render_chart, render_status,
// show_media, introduce_agent) writes its fully-assembled payload here
// keyed by a single id, then the client mounts by kind. The id-referencing
// contract matches the dataset store — the model never gets raw HTML,
// DOM, or mesh data back; it gets a `projectable_id` and narrates.
//
// Schema stored per id:
//   {
//     kind:   'chart' | 'status' | 'agent' | 'media'
//     meta:   kind-specific metadata that rides in the tool response
//     payload?: kind-specific render data (HTML for charts, image URL for
//               media, text body for status cards, persona spec for agents)
//     createdAt: number  // ms since epoch; for observability only
//   }
//
// The store itself doesn't know what kinds mean — each server tool module
// owns its own payload shape. This keeps the store tiny and decoupled
// while letting the projection tool family grow.

import { createLru } from '../lru.js';
import { mintId } from '../util.js';

// 200 is enough for ~a day of heavy interaction; 30-min TTL so cached
// chart HTML doesn't balloon memory for a long-running session.
const cache = createLru({ max: 200, ttlMs: 30 * 60 * 1000 });

// id prefix per kind so at-a-glance logs tell you what's live. Matches the
// four-char prefix convention from datasets.js.
const ID_PREFIX = {
  chart:  'chrt',
  status: 'stat',
  agent:  'agnt',
  media:  'medi',
  notification: 'note',
};

export const KINDS = Object.freeze(Object.keys(ID_PREFIX));

export function put(kind, { meta = {}, payload = null } = {}) {
  if (!ID_PREFIX[kind]) throw new Error(`unknown projectable kind: ${kind}`);
  const id = mintId(ID_PREFIX[kind]);
  cache.set(id, { kind, meta, payload, createdAt: Date.now() });
  return id;
}

export function get(id) {
  return cache.get(id) ?? null;
}

export function has(id) {
  return cache.has(id);
}

// Convenience for debug endpoints / introspection. Not used in the hot path.
export function peek(id) {
  const e = cache.get(id);
  if (!e) return null;
  return { kind: e.kind, meta: e.meta, createdAt: e.createdAt };
}

// Projection broadcast — the single server-side entry point that any
// autonomous producer (Stripe live, Gmail live, mock feeds, agent
// completion hooks) calls when it wants a card to materialise inside
// Momo's hologram on the client WITHOUT a model round-trip.
//
// Flow:
//   1. Renders HTML via the kitchen (same pipeline render_viz uses).
//   2. Stores it as a 'chart' projectable (payload = HTML).
//   3. Emits a Data Core event with source:'projection', kind:'project'
//      onto the shared WS bus. /omo/ws already fans out every emitted
//      event to connected clients; the browser's auto-project subscriber
//      (public/auto-project.js) filters for source:'projection' and
//      mounts via window.__holoStage.mount(...).
//
// Why `source:'projection'` and not a bespoke channel: the Data Core
// already owns a single event ring + WS fanout. Riding that rail keeps
// every autonomous projection on the same stream as the raw event that
// caused it, which is great for debugging the "sales appear as cards"
// pipeline end-to-end.
//
// Contract: producers must pre-store any datasets in the dataset store
// and pass `data_refs` — never raw numbers. Mirrors render_viz's
// id-referencing invariant.

import { renderViz } from '../kitchen/index.js';
import { CHART_TYPES } from '../kitchen/templates.js';
import { SIZES, SIZE_NAMES } from '../sizes.js';
import * as projectables from '../store/projectables.js';
import { emit } from '../data_core.js';
import { randomUUID } from 'node:crypto';

/**
 * @param {object} opts
 * @prop {string} intent        HOLO-TITLE / headline for the card.
 * @prop {string[]} data_refs   dataset ids from the dataset store.
 * @prop {string} [chart_type]  kitchen template key. Omit to let
 *                               pickChartType route by dataset kind.
 * @prop {string} [size]        'wide' | 'square' | 'stat' (default wide).
 * @prop {string} [reason]      Short annotation on the event ring
 *                               ("stripe charge succeeded", "new
 *                               email from Sarah"). Goes into the event
 *                               summary so it's visible in logs.
 * @prop {string} [producer]    Tag for the event.source channel. Kept
 *                               as 'projection' so all autonomous cards
 *                               share one filter. Override only if you
 *                               need a separate channel.
 * @prop {number} [ttlMs]       Optional auto-dismiss hint the client
 *                               may honour. 0 = manual dismiss.
 *
 * @returns {Promise<{ok: boolean, projectable_id?: string, error?: string}>}
 */
export async function broadcastProjection({
  intent,
  data_refs = [],
  chart_type,
  size = 'wide',
  reason = '',
  producer = 'projection',
  ttlMs = 0,
} = {}) {
  const trimmedIntent = String(intent || '').trim();
  if (!trimmedIntent) return { ok: false, error: 'intent required' };
  if (!Array.isArray(data_refs) || data_refs.length === 0) {
    return { ok: false, error: 'data_refs required' };
  }
  const sizeName = SIZE_NAMES.includes(size) ? size : 'wide';
  const sizeSpec = SIZES[sizeName];
  const type = CHART_TYPES.includes(chart_type) ? chart_type : undefined;

  let rendered;
  try {
    rendered = await renderViz({ intent: trimmedIntent, data_refs, size: sizeSpec, chart_type: type });
  } catch (err) {
    return { ok: false, error: `render failed: ${err?.message || err}` };
  }
  if (!rendered.ok) return { ok: false, error: rendered.error };

  const projectable_id = projectables.put('chart', {
    payload: rendered.html,
    meta: {
      intent: trimmedIntent,
      fingerprint: rendered.fingerprint,
      chart_type: rendered.chart_type,
      size: sizeName,
      autonomous: true,
      reason,
      producer,
    },
  });

  // Emit onto the Data Core bus. The WS fanout picks it up and every
  // connected client (hologram pages + /hq) receives it.
  emit({
    id: randomUUID(),
    ts: Date.now(),
    source: producer,
    kind: 'project',
    title: trimmedIntent,
    summary: reason || `Auto-mount ${rendered.chart_type}`,
    data: {
      projectable_kind: 'chart',
      projectable_id,
      chart_type: rendered.chart_type,
      size: sizeName,
      width: sizeSpec.width,
      height: sizeSpec.height,
      cached: rendered.cached,
      ttlMs,
      reason,
    },
  });

  return { ok: true, projectable_id, chart_type: rendered.chart_type };
}

/**
 * Tell connected clients to dismiss the currently-mounted card. Used
 * by producers that want to clear a stale auto-projection (e.g. a
 * meeting card when the event ends).
 */
export function broadcastDismiss({ reason = '', producer = 'projection' } = {}) {
  emit({
    id: randomUUID(),
    ts: Date.now(),
    source: producer,
    kind: 'dismiss',
    title: 'DISMISS',
    summary: reason || 'auto-dismiss',
    data: { reason },
  });
}

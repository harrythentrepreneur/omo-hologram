// src/preview/dispatch.js — shared command dispatch helper.
//
// One place to send a preview command, await its ack, and shape the
// uniform result envelope. Used by preview_nav (single-shot tools) AND
// do_preview (compound flows). Kept tiny + dependency-free so it doesn't
// drift between callers.

import { randomUUID } from 'node:crypto';
import * as bus from './bus.js';
import * as acks from './acks.js';

export function newId() {
  return 'pcmd_' + randomUUID().replace(/-/g, '').slice(0, 10);
}

// Send a command + await the bridge's reply. Resolution shape:
//   { ok: true,  result: {...},                  id }
//   { ok: false, error: 'no_preview',     ...,   id }   ← no holo connected
//   { ok: false, error: 'bridge_timeout', ...,   id }   ← ack didn't arrive
//   { ok: false, error: '<bridge msg>',   suggestions?: [...], id }
//
// We deliberately don't bake "no_preview"-skip-the-ack as a free
// shortcut for compound flows: do_preview wants the right message for
// each individual step. Keep this fn doing one thing.
export async function dispatch(envelope, { timeoutMs = 3000 } = {}) {
  if (!envelope.id) envelope.id = newId();
  const reached = bus.broadcast(envelope);
  if (reached === 0) {
    return {
      ok: false,
      error: 'no_preview',
      message:
        "I can't reach the preview right now. The holo needs a /preview pane open first — try \"show me the app\" or show_preview().",
      id: envelope.id,
    };
  }
  const ack = await acks.awaitAck(envelope.id, { timeoutMs });
  if (ack?.error === 'bridge_timeout') {
    return {
      ok: false,
      error: 'bridge_timeout',
      message:
        "The page didn't respond in time. Either it's cross-origin without the bridge loaded, or it's hung. " +
        "For omo's own pages the bridge auto-loads; for an external app, add <script src=\"http://localhost:8080/preview-bridge.js\"></script>.",
      id: envelope.id,
      timedOutAfterMs: ack.timedOutAfterMs,
    };
  }
  return { ...ack, id: envelope.id };
}

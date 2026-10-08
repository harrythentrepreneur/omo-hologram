// src/preview/acks.js — in-memory ack registry for preview-bridge commands.
//
// The flow:
//   1. A preview_* tool builds a command, registers a pending ack,
//      emits it on /omo/ws, and awaits the Promise.
//   2. The holo client receives the WS event, forwards into /preview's
//      inner iframe via __holoPane.forwardMessage.
//   3. preview-bridge.js executes against the DOM, posts an ack back.
//   4. The holo's message listener catches the ack and POSTs it to
//      /omo/preview/ack on this server.
//   5. mountRoutes()'s handler calls settle(id, result), which resolves
//      the pending Promise. The tool's `await` returns truthful data.
//   6. If no ack arrives within the timeout, the Promise resolves with
//      { ok: false, error: 'bridge_timeout', ... } so the model can
//      narrate honestly.
//
// Hard rules:
//   • registry is a plain Map; no persistence (acks are ephemeral)
//   • timers are unref'd so they never hold the process open
//   • every Promise resolves exactly once, even on double-acks

import express from 'express';

const pending = new Map();   // id → { resolve, timer, registeredAt }

// Wait for an ack matching `id`. Returns the bridge's ack payload, or a
// timeout envelope if nothing arrives in `timeoutMs`.
//
// Shape of resolved value (matches what preview-bridge.js posts):
//   { ok: true,  result: {...} }
//   { ok: false, error: '...', suggestions?: [...] }
//   { ok: false, error: 'bridge_timeout', timedOutAfterMs }
export function awaitAck(id, { timeoutMs = 3000 } = {}) {
  if (!id) return Promise.resolve({ ok: false, error: 'no command id' });
  // Defensive: if a previous awaitAck for the same id is still pending,
  // resolve it as superseded. Shouldn't happen with uuid ids but cheap.
  const prior = pending.get(id);
  if (prior) {
    prior.resolve({ ok: false, error: 'superseded' });
    clearTimeout(prior.timer);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(id)) {
        pending.delete(id);
        resolve({ ok: false, error: 'bridge_timeout', timedOutAfterMs: timeoutMs });
      }
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, timer, registeredAt: Date.now() });
  });
}

// Called by the /omo/preview/ack route. Settle the pending Promise if we
// have one. Returns true when we matched a pending command, false when
// the ack arrived too late (post-timeout) or for an unknown id.
export function settle(id, payload) {
  if (!id) return false;
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  // Normalise — the bridge already sends { ok, result, error } shape,
  // but we defensively coerce so the tool's awaiter sees a consistent
  // envelope no matter what came over the wire.
  const ok = payload?.ok !== false;
  entry.resolve({
    ok,
    result: ok ? (payload?.result ?? null) : null,
    error: ok ? null : (payload?.error || 'bridge_error'),
    suggestions: payload?.suggestions || undefined,
  });
  return true;
}

// Snapshot for diagnostics (/omo/api/preview/status, future use).
export function inflight() {
  const now = Date.now();
  return [...pending.entries()].map(([id, e]) => ({ id, ageMs: now - e.registeredAt }));
}

// Wire the HTTP endpoint. Body must include `id`; everything else is
// passed through to settle(). Same-origin only; rate-limited implicitly
// by the bridge round-trip (one ack per command, capped by registry).
export function mountRoutes(app) {
  const json = express.json({ limit: '64kb' });
  app.post('/omo/preview/ack', json, (req, res) => {
    const id = req.body?.id ? String(req.body.id) : null;
    if (!id) return res.status(400).json({ accepted: false, error: 'missing id' });
    const accepted = settle(id, req.body);
    res.json({ accepted });
  });
  // Debug-friendly: show what's still waiting.
  app.get('/omo/api/preview/inflight', (_req, res) => res.json(inflight()));
}

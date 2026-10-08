// Data Core backend: in-memory event ring, pub/sub bus, plus the HTTP +
// WS route wiring that consumers (e.g. /hq) read from. Real events are
// emitted by the connectors in src/connectors/* — this module only owns
// the ring, the broadcast plumbing, and the live-source registry.
//
// Mount from the boot script with:
//   mountRoutes(app)                    // HTTP handlers (/omo/api/*)
//   mountWebSocket(httpServer)          // /omo/ws + event broadcast
//   startMocks()                        // emits the single startup marker

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as ambient from './momo/ambient.js';

// --------------------------------------------------------------- Store + bus

const MAX_EVENTS = 1000;
const ring = []; // newest first

const subscribers = new Set();

function insertEvent(e) {
  ring.unshift(e);
  if (ring.length > MAX_EVENTS) ring.length = MAX_EVENTS;
  return e;
}

function publish(e) {
  for (const fn of subscribers) {
    try { fn(e); } catch {}
  }
}

function emit(e) {
  insertEvent(e);
  publish(e);
  return e;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Public ingest path for external producers (e.g. the Agents layer) that
// want their events in the shared ring and /omo/ws fanout. Exported as
// `emit` so the name matches what consumers already use internally.
export { emit };

export function listEvents({ source, since = 0, limit = 200 } = {}) {
  const cap = Math.min(Math.max(1, limit | 0), 1000);
  const out = [];
  for (const e of ring) {
    if (source && e.source !== source) continue;
    if (e.ts < since) continue;
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

// Pure read over the event ring with case-insensitive substring filter.
// Used by `hq_query` (and any other tool that needs to mine the ring)
// to answer questions like "what emails did I get today?" or "any
// transcript mentioning 'term sheet'?". Never mutates — just reads.
//
//   source     'gmail' | 'stripe' | 'meta_ads' | 'drive' | 'transcript'
//              | 'audio' | 'system' | 'all'  (default 'all')
//   sinceMs    absolute epoch-ms lower bound (default 0 = unbounded)
//   limit      cap, 1..1000 (default 200)
//   query      case-insensitive substring matched against title /
//              summary / data text fields (subject, snippet, body,
//              preview, text, campaign, product, customer_email,
//              from, sender). Missing query → no text filter.
export function getEvents({ source, sinceMs = 0, limit = 200, query } = {}) {
  const cap = Math.min(Math.max(1, limit | 0), 1000);
  const wantSource =
    source && source !== 'all' && source !== 'transcript' ? String(source) : null;
  // Treat 'transcript' as a shorthand for the audio-source transcripts;
  // callers mix that with real 'audio' elsewhere, keep them findable.
  const wantTranscript = source === 'transcript';
  const q = query ? String(query).trim().toLowerCase() : '';

  const fieldsFrom = (ev) => {
    const d = ev?.data || {};
    const parts = [
      ev.title, ev.summary,
      d.subject, d.snippet, d.body, d.preview, d.text,
      d.campaign, d.product,
      d.customer_email,
      typeof d.from === 'string' ? d.from : d.from?.email || d.from?.name,
      typeof d.sender === 'string' ? d.sender : d.sender?.email || d.sender?.name,
    ];
    return parts.filter(Boolean).join(' \n ').toLowerCase();
  };

  const out = [];
  for (const e of ring) {
    if (e.ts < sinceMs) continue;
    if (wantSource && e.source !== wantSource) continue;
    if (wantTranscript && !(e.source === 'audio' && e.kind === 'transcript')) continue;
    if (q && !fieldsFrom(e).includes(q)) continue;
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

export function statsBySource() {
  const now = Date.now();
  const h1 = now - 60 * 60 * 1000;
  const h24 = now - 24 * 60 * 60 * 1000;
  const d7 = now - 7 * 24 * 60 * 60 * 1000;
  const bySource = {};
  const totals = { h1: 0, h24: 0, d7: 0 };
  for (const e of ring) {
    if (e.ts < d7) continue;
    const entry = bySource[e.source] || { h1: 0, h24: 0, d7: 0 };
    if (e.ts >= h1) { entry.h1++; totals.h1++; }
    if (e.ts >= h24) { entry.h24++; totals.h24++; }
    entry.d7++; totals.d7++;
    bySource[e.source] = entry;
  }
  return { bySource, totals, liveSources: getLiveSources() };
}

// --------------------------------------------------------------- Live source registry
// Connectors call markSourceLive('foo') after a successful boot.
// Consumers read this list (via /omo/api/stats) to suppress the
// synthetic mini-widget ticker for sources that now have real
// events flowing in.
const _liveSources = new Set();

export function markSourceLive(name) {
  if (!name) return;
  _liveSources.add(String(name));
}

export function getLiveSources() {
  return [..._liveSources];
}

// --------------------------------------------------------------- Audio stub

const SAMPLE_RATE = 16000;
const FLUSH_INTERVAL_MS = 2000;
let pendingCount = 0;
let pendingDurationMs = 0;
let lastFlushAt = 0;
let flushTimer = null;

function flushAudio() {
  flushTimer = null;
  if (pendingCount === 0) return;
  const count = pendingCount;
  const duration_ms = pendingDurationMs;
  pendingCount = 0;
  pendingDurationMs = 0;
  lastFlushAt = Date.now();
  const secs = (duration_ms / 1000).toFixed(1);
  emit({
    id: randomUUID(),
    source: 'audio',
    kind: 'chunk',
    ts: lastFlushAt,
    title: 'Audio',
    summary: `${count} chunks · ${secs}s`,
    data: { duration_ms: Math.round(duration_ms), count },
  });
}

export function handleAudioChunk({ pcmBuffer, ts }) {
  if (!pcmBuffer || pcmBuffer.byteLength === 0) return;
  const duration_ms = (pcmBuffer.byteLength / 2 / SAMPLE_RATE) * 1000;
  pendingCount += 1;
  pendingDurationMs += duration_ms;
  const now = Date.now();
  if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
    flushAudio();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushAudio, FLUSH_INTERVAL_MS - (now - lastFlushAt));
    flushTimer.unref?.();
  }
}

// --------------------------------------------------------------- Boot signal

export function startMocks() {
  // Real connectors (stripe / gmail / meta / google_drive / google_docs)
  // emit directly via their `connect()` paths. This function is kept as
  // the single boot signal for the data core — it only emits a startup
  // marker so late-subscribing /omo/ws clients see at least one event.
  emit({
    id: randomUUID(),
    source: 'system',
    kind: 'startup',
    ts: Date.now(),
    title: 'Omo online',
    summary: 'Data Core ready',
    data: { pid: process.pid },
  });
}

// --------------------------------------------------------------- HTTP routes
// Registers /omo/api/* on the given Express app.
export function mountRoutes(app) {
  app.get('/omo/api/events', (req, res) => {
    const { source, since, limit } = req.query || {};
    const events = listEvents({
      source: source || undefined,
      since: Number(since) || 0,
      limit: Number(limit) || 200,
    });
    res.json({ events });
  });

  app.get('/omo/api/stats', (_req, res) => res.json(statsBySource()));
}

// --------------------------------------------------------------- WebSocket
// /omo/ws carries a snapshot on connect, live event broadcasts, and an
// inbound audio_chunk channel for the microphone-ingest path.
// Live count of /omo/ws subscribers — used by browser_tasks.js as part of
// its UI-presence watchdog (no UI = nothing to narrate to, abort idle
// browser sessions). Hoisted to module scope so getClientCount() can
// expose it without reaching into the WSS instance.
let omoWsClientCount = 0;
export function getClientCount() {
  return omoWsClientCount;
}

export function mountWebSocket(httpServer) {
  // noServer + manual upgrade routing. Multiple WebSocketServers share
  // this httpServer (see src/agents/terminals.js — /agents/ws). A legacy
  // `{server, path}` WSS will call abortHandshake(400) on any mismatched
  // path, killing the other sockets. Scoping with an explicit upgrade
  // listener keeps us strictly to /omo/ws and leaves everything else
  // alone.
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, sock, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/omo/ws') return;
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
  });
  const clients = new Set();

  wss.on('connection', (socket) => {
    clients.add(socket);
    omoWsClientCount = clients.size;
    try {
      socket.send(JSON.stringify({ type: 'snapshot', events: listEvents({ limit: 100 }) }));
    } catch {}
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'audio_chunk' && typeof msg.pcm_b64 === 'string') {
        try {
          const pcmBuffer = Buffer.from(msg.pcm_b64, 'base64');
          handleAudioChunk({ pcmBuffer, ts: Number(msg.ts) || Date.now() });
        } catch {}
        return;
      }
      if (msg?.type === 'ambient_transcript') {
        try { ambient.handleAmbientMessage(msg, { socket, emitEvent: emit }); } catch {}
        return;
      }
    });
    socket.on('close', () => { clients.delete(socket); omoWsClientCount = clients.size; });
    socket.on('error', () => { clients.delete(socket); omoWsClientCount = clients.size; });
  });

  // Fan event-bus emissions out to every connected client.
  //
  // Skip historical events. Backfill paths (notably Stripe deep backfill)
  // can fire 500+ `historical:true` events in one tick — each carrying a
  // multi-KB charge object. The cylinder has 4 WS subscribers and each
  // JSON.parses every frame; that's thousands of parses landing on the
  // main thread synchronously and freezes the tab for many seconds.
  // The events still go onto the ring, so /hq's snapshot-on-connect
  // shows them. Live consumers just don't get spammed for ancient data
  // they would have ignored anyway (the projection layer already skips
  // historical events at the consumer side).
  let broadcastCount = 0;
  let broadcastBytes = 0;
  let lastBurstReport = Date.now();
  subscribe((event) => {
    if (event && event.historical) return;
    const payload = JSON.stringify({ type: 'event', event });
    broadcastCount += 1;
    broadcastBytes += payload.length;
    for (const sock of clients) {
      try { if (sock.readyState === 1) sock.send(payload); }
      catch { clients.delete(sock); }
    }
    // Burst report: if we've sent ≥20 events or ≥256KB to clients in
    // the last 1s, log it. That's the smoking-gun pattern for "browser
    // tab freezes during a connector emit storm". Quiet otherwise.
    const now = Date.now();
    if (now - lastBurstReport >= 1000) {
      if (broadcastCount >= 20 || broadcastBytes >= 256 * 1024) {
        console.log(`[ws] /omo/ws burst · ${broadcastCount} events · ${(broadcastBytes / 1024).toFixed(0)}KB · ${clients.size} client(s)`);
      }
      broadcastCount = 0;
      broadcastBytes = 0;
      lastBurstReport = now;
    }
  });
}

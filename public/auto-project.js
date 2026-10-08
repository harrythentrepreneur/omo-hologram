// Auto-project — the browser-side counterpart to src/projection/broadcast.js.
//
// Subscribes to /omo/ws (the Data Core event bus already serving /hq),
// filters for kind:'project' and kind:'dismiss' directives
// coming from autonomous producers (Stripe live, Gmail live, agent
// completion, etc.), and dispatches them onto the local hologram stage
// via window.__holoStage. The voice/tool loop is untouched — when Momo
// herself calls render_viz, that path renders synchronously and mounts
// via /tool's response without touching this WS channel.
//
// Contract (must match broadcast.js):
//   incoming message: { type: 'event', event: {
//     source: 'projection' (or another producer tag),
//     kind:   'project' | 'dismiss',
//     data:   { projectable_kind, projectable_id, chart_type, size,
//               width, height, cached, ttlMs, reason }
//   }}
//
// Lifecycle:
//   - Connects on installAutoProject() call; retries with backoff on
//     close. Each tab owns one socket; the server WS mountWebSocket
//     already fans events out to every connected client.
//   - Drops everything silently if window.__holoStage doesn't exist
//     (the current page doesn't have a stage; cylinder-warp, etc.).
//
// Kill switch: window.__autoProjectPaused = true halts mounting
// without tearing down the socket. Handy while debugging so you can
// compare /hq's raw events with the hologram behaviour.

const WS_PATH = '/omo/ws';
const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 8000;
const AUTO_DISMISS_SAFE_MIN_MS = 1500;

// Minimum gap between auto-projection mounts. Stripe / Gmail backfills
// can fire 15+ projection events in milliseconds; each call mounts a
// new chart iframe (loads /viz/:id HTML + ECharts script). Doing that
// 15 times in one tick starves the cylinder's main thread and the OS
// kills the tab — we've reproduced this. Throttle to at most one mount
// per gap; coalesce bursts to the latest event the user can actually
// see and read. Tunable if needed without touching anything else.
const MOUNT_MIN_GAP_MS = 650;

let socket = null;
let retryDelay = RECONNECT_MIN_MS;
let pendingDismissTimer = 0;
let installed = false;
let lastMountAt = 0;
let coalesceTimer = 0;
let coalescedEvent = null;

export function installAutoProject() {
  if (installed) return;
  installed = true;
  connect();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}${WS_PATH}`;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.warn('[auto-project] ws construct failed', err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    console.log('[auto-project] ws open');
    retryDelay = RECONNECT_MIN_MS;
  });
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', (e) => {
    console.log(`[auto-project] ws closed code=${e?.code ?? '?'} reason=${e?.reason || '-'}`);
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener('error', (e) => {
    console.warn('[auto-project] ws error', e?.message || e);
    try { socket && socket.close(); } catch (_) {}
  });
}

function scheduleReconnect() {
  setTimeout(() => {
    retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, retryDelay);
}

function onMessage(e) {
  if (window.__autoProjectPaused) return;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }

  // Snapshot messages arrive on connect; we skip them — historical
  // autonomous projections shouldn't retroactively mount. Only live
  // events should drive the stage.
  if (msg?.type !== 'event' || !msg.event) return;

  const ev = msg.event;
  // Accept any producer that explicitly emits a projection. Originally
  // this was locked to `source === 'projection'` but task-completion
  // diffs come through with `source === 'agents'` — same semantics, the
  // producer tag is informational.
  if (ev.source !== 'projection' && ev.source !== 'agents') return;

  if (ev.kind === 'project') return handleProject(ev);
  if (ev.kind === 'dismiss') return handleDismiss(ev);
}

function handleProject(ev) {
  // Coalesce bursts: if a mount fired recently OR another event is
  // already queued, replace the queued event with this latest one and
  // schedule the actual mount for after MOUNT_MIN_GAP_MS. Producer can
  // emit 15 events in 5ms and the user still only sees one mount per
  // ~650ms — the most recent of that window.
  coalescedEvent = ev;
  if (coalesceTimer) return;

  const sinceLast = Date.now() - lastMountAt;
  const wait = Math.max(0, MOUNT_MIN_GAP_MS - sinceLast);
  coalesceTimer = setTimeout(() => {
    coalesceTimer = 0;
    const next = coalescedEvent;
    coalescedEvent = null;
    if (next) doProject(next);
  }, wait);
}

function doProject(ev) {
  const stage = window.__holoStage;
  if (!stage || typeof stage.mount !== 'function') return;

  const d = ev.data || {};
  const kind = d.projectable_kind || 'chart';
  const projectable_id = d.projectable_id;
  if (!projectable_id) {
    console.warn('[auto-project] project event missing projectable_id', ev);
    return;
  }

  // Clear any pending TTL dismount from a previous auto-projection —
  // if a new card is mounting, the old timer shouldn't fire and wipe it.
  if (pendingDismissTimer) {
    clearTimeout(pendingDismissTimer);
    pendingDismissTimer = 0;
  }

  try {
    stage.mount({
      kind,
      projectable_id,
      size:  d.size,
      width: d.width,
      height: d.height,
      cached: !!d.cached,
      // Pass-through metadata in case future kinds consume it.
      chart_type: d.chart_type,
      reason: d.reason,
    });
    lastMountAt = Date.now();
  } catch (err) {
    console.warn('[auto-project] mount failed', err);
    return;
  }

  // Honour a TTL if the producer supplied one — floored so the card has
  // time to actually render and read before it vanishes.
  const ttl = Number(d.ttlMs) || 0;
  if (ttl >= AUTO_DISMISS_SAFE_MIN_MS) {
    const fireAt = ttl;
    pendingDismissTimer = setTimeout(() => {
      pendingDismissTimer = 0;
      try { stage.dismount && stage.dismount(); } catch (_) {}
    }, fireAt);
  }
}

function handleDismiss(_ev) {
  const stage = window.__holoStage;
  if (!stage || typeof stage.dismount !== 'function') return;
  if (pendingDismissTimer) {
    clearTimeout(pendingDismissTimer);
    pendingDismissTimer = 0;
  }
  // Cancel any coalesced mount sitting in the queue too — otherwise the
  // dismount fires now, then the queued mount fires ~650ms later and
  // contradicts the dismiss intent.
  if (coalesceTimer) {
    clearTimeout(coalesceTimer);
    coalesceTimer = 0;
    coalescedEvent = null;
  }
  try { stage.dismount(); } catch (_) {}
}

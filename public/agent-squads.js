// agent-squads — choreographed sprite *teams* for research sub-agents.
//
// Where SpriteLayer (agent-sprites.js) gives us one charming blob per tool
// call, this module layers on top of that API to orchestrate a whole squad
// of sprites for a single research agent run. When Momo dispatches a
// `spawn_research_agent` call, instead of a lone sprite the user sees a
// captain + 2-3 scouts forming up, each with a designated "station" for
// a particular source (hq desk / web portal). As the sub-agent's internal
// Gemini loop calls `hq_query` or `web_search`, the matching scout peels
// off to its station, returns with the result, and the whole squad
// converges back on the avatar when the agent completes.
//
// Nothing here is allowed to modify `agent-sprites.js`. We only use the
// public `SpriteLayer.spawn()` + `SpriteHandle.runOff/returnWith/fail`
// surface and treat sprite handles as opaque.
//
// Public surface:
//   import { SquadLayer, installSquadLayer } from './agent-squads.js';
//   const layer = installSquadLayer(spriteLayer);  // idempotent
//   layer.dispose();
//
// Event handling (parsed in `handleMessage`, same wrapping convention as
// agent-sprites): accepts both dataCore-wrapped `{type:'event', event:{…}}`
// frames and unwrapped `{type:'agent:…'}` frames. New events we consume:
//   - agent:started       { agent_id, task }
//   - agent:tool_start    { agent_id, tool_name, query_summary }
//   - agent:tool_end      { agent_id, tool_name, ok, summary }
//   - agent:complete      { agent_id, findings }
//   - agent:error         { agent_id, error }

import { avatarAnchorPoint, anchorBasis } from './spatial.js';

// ── Configuration ───────────────────────────────────────────────────────
const MAX_SQUADS = 3;                 // hard cap; oldest is disbanded first
const LEAK_TIMEOUT_MS = 40_000;       // auto-disperse if no complete/error
const SPAWN_STAGGER_MS = 80;          // stagger between sprites on form-up
const DEFAULT_AVATAR_POS = { x: 0, y: 0, z: 0 };

// ── Anchors ─────────────────────────────────────────────────────────────
// Each squad picks one of these anchors at spawn time (round-robin across
// successive squads so consecutive research runs land on different sides
// of the avatar). theta/phi are in the spherical convention from
// spatial.js: theta=0 front, π/2 right, π back, 3π/2 left. The first
// squad defaults to 'front-above' so a user who hasn't orbited the camera
// yet still sees the familiar front-facing shoulder squad.
const SQUAD_ANCHORS = [
  { theta: 0,                phi:  Math.PI / 10, r: 1.8, name: 'front-above' },
  { theta: Math.PI / 2,      phi:  0,            r: 2.0, name: 'right-level' },
  { theta: Math.PI,          phi:  Math.PI / 12, r: 2.0, name: 'back-above' },
  { theta: 3 * Math.PI / 2,  phi:  0,            r: 2.0, name: 'left-level' },
  { theta: Math.PI / 4,      phi: -Math.PI / 12, r: 1.9, name: 'front-right-low' },
  { theta: 5 * Math.PI / 4,  phi: -Math.PI / 12, r: 1.9, name: 'back-left-low' },
];

// Rolling pointer used for round-robin selection across squads AND to
// drive the dev demo button through all anchors in order.
let _anchorCursor = 0;

// V-formation offsets in the ANCHOR'S LOCAL FRAME. Captain sits at the
// anchor; scouts fan tangentially (along the horizontal ring) on the
// *outside* of the anchor so they never clip through the avatar body.
//   tangent: horizontal spread around the ring (+right / −left of anchor)
//   up:      vertical offset
//   forward: distance along the anchor's radial direction (+further from
//            avatar, −closer). Kept non-positive for scouts so they hang
//            slightly outside the captain rather than between it and the
//            avatar body.
const LOCAL_FORMATION = {
  captain:     { tangent:  0.00, up:  0.00, forward:  0.00 },
  scout_hq:    { tangent: -0.55, up: -0.18, forward: -0.15 },
  scout_web:   { tangent:  0.55, up: -0.18, forward: -0.15 },
  scout_extra: { tangent:  0.00, up: -0.35, forward: -0.25 },
};

// Tool stations are placed tangentially around the anchor. HQ sits to the
// anchor's LEFT (−tangent) and the web portal to its RIGHT (+tangent),
// mirroring the original "HQ left / web right" mental model but now with
// "left" and "right" relative to the anchor's facing, not to the world.
// forward: +0.0 keeps the station at the anchor's radius so scouts don't
// visit points deep inside the avatar when the anchor is 'back-above'.
const STATION_HQ_LOCAL  = { tangent: -1.20, up:  0.30, forward: 0.00 };
const STATION_WEB_LOCAL = { tangent:  1.20, up:  0.30, forward: 0.00 };

// tool_name → scout role. Anything unrecognised goes to scout_extra so
// the squad never freezes over an unexpected tool name.
function roleForTool(toolName) {
  if (toolName === 'hq_query') return 'scout_hq';
  if (toolName === 'web_search') return 'scout_web';
  return 'scout_extra';
}

// role → sprite "kind" from agent-sprites' palette. Gives each scout a
// distinct accent colour tied to the kind of work it does.
function kindForRole(role) {
  if (role === 'captain') return 'research_agent';
  if (role === 'scout_hq') return 'hq_query';
  if (role === 'scout_web') return 'web_search';
  return 'research_agent';
}

// ── Helpers ─────────────────────────────────────────────────────────────
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Best-effort normalisation of event messages coming off /omo/ws. Returns
// `{ type, agentId, data }` or null. Mirrors the discriminator in
// agent-sprites so both layers agree on what a "started" message looks
// like, but recognises the new tool_start / tool_end kinds.
function normaliseMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  let kind, data;
  if (msg.type === 'event' && msg.event) {
    const e = msg.event;
    data = e.data || {};
    const k = e.kind || '';
    if (k.startsWith('agent:')) kind = k;
    else if (e.source === 'agent' || e.source === 'agents') kind = 'agent:' + k;
    else return null;
  } else if (typeof msg.type === 'string' && msg.type.startsWith('agent:')) {
    kind = msg.type;
    data = msg;
  } else {
    return null;
  }
  const agentId = data.agent_id || data.agentId || data.id;
  if (!agentId) return null;
  return { type: kind, agentId, data };
}

// Try to read avatar world position off the sprite layer; fall back to
// zero so we never blow up if the host scene keeps Momo at origin.
function readAvatarPos(spriteLayer) {
  const p = spriteLayer && spriteLayer.avatarPos;
  if (p && typeof p.x === 'number') return { x: p.x, y: p.y, z: p.z };
  return { ...DEFAULT_AVATAR_POS };
}

// Build a world-space vector by adding an offset to the avatar position.
function stationVec(avatarPos, offset) {
  // We don't import THREE here — agent-sprites does, and we only need
  // plain {x,y,z} to feed into runOff() (which accepts a direction) and
  // setReturnTarget (if it exists). Spriteland does its own normalisation.
  return { x: avatarPos.x + offset.x, y: avatarPos.y + offset.y, z: avatarPos.z + offset.z };
}

// Build a world-space point by placing a (tangent, up, forward) local
// offset in the anchor's basis around the avatar. Used for both formation
// slots and tool stations so a single anchor choice completely determines
// the squad's 3D layout. Returns {x, y, z} for parity with stationVec.
function localToWorld(avatarPos, anchor, local) {
  const anchorPt = avatarAnchorPoint(avatarPos, anchor);
  const { forward, tangent, up } = anchorBasis(anchor.theta, anchor.phi);
  return {
    x: anchorPt.x + tangent.x * local.tangent + up.x * local.up + forward.x * local.forward,
    y: anchorPt.y + tangent.y * local.tangent + up.y * local.up + forward.y * local.forward,
    z: anchorPt.z + tangent.z * local.tangent + up.z * local.up + forward.z * local.forward,
  };
}

// Pick the next anchor in round-robin order. If `preferFront` is true
// and no squads are currently active, return the front anchor (index 0)
// WITHOUT consuming the cursor — so the very first squad still feels
// front-and-centre, and subsequent squads cycle through the remaining
// anchors from index 1 onward.
function pickAnchor(preferFront) {
  if (preferFront) {
    _anchorCursor = 1 % SQUAD_ANCHORS.length;
    return SQUAD_ANCHORS[0];
  }
  const anchor = SQUAD_ANCHORS[_anchorCursor % SQUAD_ANCHORS.length];
  _anchorCursor = (_anchorCursor + 1) % SQUAD_ANCHORS.length;
  return anchor;
}

// If the sprite handle supports `setReturnTarget`, use it. Otherwise
// silently no-op — the sprite will still return to its default spawn
// point which is visually fine.
function trySetReturnTarget(handle, target) {
  try {
    if (handle && typeof handle.setReturnTarget === 'function') {
      handle.setReturnTarget(target);
    }
  } catch {}
}

// runOff accepts a direction; convert the desired world-space destination
// into a direction from the avatar. If the handle doesn't cooperate we
// degrade to a plain runOff() which still sends the sprite outward.
function runOffToward(handle, avatarPos, destination) {
  try {
    const dx = destination.x - avatarPos.x;
    const dy = destination.y - avatarPos.y;
    const dz = destination.z - avatarPos.z;
    // If THREE is available via the sprite itself we can pass a proper
    // Vector3-like. But runOff's contract only checks `.isVector3`; a
    // plain object without that flag triggers the radial default, which
    // is wrong for us. So stamp one on.
    const dir = { x: dx, y: dy, z: dz, isVector3: true,
                  clone() { return { ...this, normalize: this.normalize, clone: this.clone }; },
                  normalize() {
                    const m = Math.hypot(this.x, this.y, this.z) || 1;
                    this.x /= m; this.y /= m; this.z /= m;
                    return this;
                  } };
    handle.runOff(dir);
  } catch {
    try { handle.runOff(); } catch {}
  }
}

// ── Squad ────────────────────────────────────────────────────────────────
// One per active research agent. Owns up to 4 sprite handles indexed by
// role. Handles are opaque to us — we only drive them through runOff /
// returnWith / fail. Sprite lifecycle (fading, dead) is owned entirely
// by the sprite layer, so our teardown is fire-and-forget.
class Squad {
  constructor(agentId, spriteLayer, task, opts = {}) {
    this.agentId = agentId;
    this.spriteLayer = spriteLayer;
    this.task = truncate(task || 'research', 20);
    this.createdAt = performance.now();
    this.members = new Map();   // role → SpriteHandle
    this.stations = new Map();  // role → {x,y,z}
    this.timers = [];
    this.done = false;          // set once complete/error has run

    this.avatarPos = readAvatarPos(spriteLayer);
    // Pick an anchor for this squad. Caller can force one (demo button);
    // otherwise round-robin unless this is the first active squad, in
    // which case we prefer the front anchor so the scene still feels
    // familiar for a camera that hasn't orbited yet.
    this.anchor = opts.anchor || pickAnchor(opts.preferFront === true);
    this.stations.set('scout_hq',    localToWorld(this.avatarPos, this.anchor, STATION_HQ_LOCAL));
    this.stations.set('scout_web',   localToWorld(this.avatarPos, this.anchor, STATION_WEB_LOCAL));
    // scout_extra shadows whichever scout is currently busy; park it at
    // the HQ station so it's never un-parked.
    this.stations.set('scout_extra', localToWorld(this.avatarPos, this.anchor, STATION_HQ_LOCAL));

    this._formUp();
  }

  // Staggered spawn so the squad reveals rather than popping all at once.
  // Labels pair the specialist persona (Atlas / Prism / …) with the tool
  // station the scout is assigned to, so the user sees both who and what.
  _formUp() {
    const plan = [
      { role: 'captain',     delay: 0,                     label: 'Atlas · research' },
      { role: 'scout_hq',    delay: SPAWN_STAGGER_MS * 1,  label: 'Prism · hq_query' },
      { role: 'scout_web',   delay: SPAWN_STAGGER_MS * 2,  label: 'Atlas · web_search' },
      { role: 'scout_extra', delay: SPAWN_STAGGER_MS * 3,  label: 'Pulse · assist' },
    ];
    for (const step of plan) {
      const t = setTimeout(() => this._spawnMember(step.role, step.label), step.delay);
      this.timers.push(t);
    }
  }

  _spawnMember(role, label) {
    if (this.done) return;
    let handle;
    try {
      handle = this.spriteLayer.spawn({ kind: kindForRole(role), label: truncate(label, 20) });
    } catch (err) {
      console.warn('[agent-squads] spawn failed for', role, err);
      return;
    }
    if (!handle) return;
    this.members.set(role, handle);
    // Non-captain members run out to their formation slot immediately so
    // the V-shape is visible during idle. The captain bobs at its own
    // formation slot — we still point it there so it's not stuck at the
    // spawn point. The formation is computed in the ANCHOR's local frame
    // so the whole squad rotates cohesively around the avatar depending
    // on which anchor we picked.
    const local = LOCAL_FORMATION[role] || LOCAL_FORMATION.scout_extra;
    const slot = localToWorld(this.avatarPos, this.anchor, local);
    runOffToward(handle, this.avatarPos, slot);
    // Captain's "home" for later convergence is its formation slot.
    trySetReturnTarget(handle, slot);
  }

  // agent:tool_start → peel off matching scout to its station.
  onToolStart({ tool_name, query_summary }) {
    if (this.done) return;
    const role = roleForTool(tool_name);
    const scout = this.members.get(role);
    if (!scout) return;
    const station = this.stations.get(role) || localToWorld(this.avatarPos, this.anchor, STATION_HQ_LOCAL);
    // Keep the scout's specialist name visible — we stash the query text
    // on the sprite's `name` field (for awareness/narration) rather than
    // overwriting the displayed label.
    try {
      scout.name = truncate(query_summary || tool_name || 'searching', 40);
    } catch {}
    runOffToward(scout, this.avatarPos, station);

    // scout_extra shadows whichever scout just got dispatched so the
    // user can see a backup nearby. Only re-assign if not currently
    // running its own errand.
    if (role !== 'scout_extra') {
      const extra = this.members.get('scout_extra');
      if (extra) {
        // Park extra just behind the busy scout.
        const shadow = {
          x: station.x - 0.35,
          y: station.y - 0.15,
          z: station.z - 0.2,
        };
        runOffToward(extra, this.avatarPos, shadow);
      }
    }

    // Best-effort eye-look on the captain. paint() accepts { eyeLook }
    // on SOME sprite builds; if not supported it's a silent no-op. Wrap
    // in try so we never crash the squad on an unsupported painter.
    const captain = this.members.get('captain');
    if (captain) {
      try {
        if (typeof captain.paint === 'function') {
          captain.paint({ eyeLook: { x: station.x - this.avatarPos.x, y: station.y - this.avatarPos.y } });
        }
      } catch {}
    }
  }

  // agent:tool_end → matching scout returns with a summary, or fails.
  onToolEnd({ tool_name, ok, summary }) {
    if (this.done) return;
    const role = roleForTool(tool_name);
    const scout = this.members.get(role);
    if (!scout) return;
    // Keep the scout's specialist-name label; stash the summary/error
    // text on `name` for awareness instead of overwriting the caption.
    if (ok) {
      try {
        scout.name = truncate(summary || 'got it', 40);
        scout.returnWith(scout.label);
      } catch {}
      // Small confetti at the captain: spawn a one-shot tool_call sprite
      // that immediately returns. Cheap reuse of the sparkle burst built
      // into SpriteHandle.returnWith — see sparkle-reuse note in the spec.
      this._confettiAtCaptain();
    } else {
      try {
        scout.name = truncate(summary || 'dead end', 40);
        scout.fail(scout.label);
      } catch {}
    }
  }

  // Spawn a tiny tool_call sprite and immediately return it so the
  // sprite layer's own bounce+sparkle does the celebration for us.
  _confettiAtCaptain() {
    try {
      const h = this.spriteLayer.spawn({ kind: 'tool_call', label: '+1' });
      if (!h) return;
      // Fire runOff so the sprite enters the runOff phase, then almost
      // immediately return it so the bounce kicks in near the avatar.
      try { h.runOff(); } catch {}
      setTimeout(() => { try { h.returnWith('+1'); } catch {} }, 40);
    } catch {}
  }

  // agent:complete → everyone converges, captain speaks.
  onComplete({ findings }) {
    if (this.done) return;
    this.done = true;
    const headline = truncate(findings || 'done', 40);
    const captainSlot = localToWorld(this.avatarPos, this.anchor, LOCAL_FORMATION.captain);
    for (const [, handle] of this.members) {
      if (!handle) continue;
      trySetReturnTarget(handle, captainSlot);
      // Stash findings on `name` for awareness/narration and keep the
      // specialist-name label (Atlas / Prism / …) on screen.
      try { handle.name = headline; } catch {}
      try { handle.returnWith(handle.label); } catch {}
    }
    this._clearTimers();
  }

  // agent:error → everyone droops.
  onError({ error }) {
    if (this.done) return;
    this.done = true;
    const reason = truncate(error || 'error', 40);
    for (const [, handle] of this.members) {
      if (!handle) continue;
      try { handle.name = reason; } catch {}
      try { handle.fail(handle.label); } catch {}
    }
    this._clearTimers();
  }

  // Force everyone home with a specific label. Used when we hit the
  // max-squads cap or the leak timeout.
  disperse(label = 'stale') {
    if (this.done) return;
    this.done = true;
    const reason = truncate(label, 40);
    for (const [, handle] of this.members) {
      if (!handle) continue;
      try { handle.name = reason; } catch {}
      try { handle.returnWith(handle.label); } catch {}
    }
    this._clearTimers();
  }

  _clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

// ── SquadLayer ──────────────────────────────────────────────────────────
export class SquadLayer {
  constructor(spriteLayer, opts = {}) {
    if (!spriteLayer) throw new Error('[agent-squads] spriteLayer required');
    this.spriteLayer = spriteLayer;
    this.opts = opts || {};
    this.squads = new Map();   // agent_id → Squad
    this.socket = null;
    this._retry = 800;
    this._disposed = false;
    this._leakTimers = new Map();  // agent_id → timeout id
  }

  // Connect to /omo/ws. Safe to call multiple times; no-ops if already
  // connected. We don't reuse agent-sprites' socket because it lives
  // inside that module's closure — ours is independent so that either
  // layer being disabled doesn't break the other.
  attachToWS(url = '/omo/ws') {
    if (this._disposed) return;
    if (this.socket && this.socket.readyState <= 1) return;
    if (typeof location === 'undefined' || location.protocol === 'file:') return;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const full = url.startsWith('ws') ? url : `${proto}://${location.host}${url}`;
      this.socket = new WebSocket(full);
    } catch { this._scheduleReconnect(url); return; }
    this.socket.addEventListener('open', () => { this._retry = 800; });
    this.socket.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      // Same snapshot-skip convention as agent-sprites — historical
      // events shouldn't resurrect completed squads.
      if (msg?.type === 'snapshot') return;
      this.handleMessage(msg);
    });
    this.socket.addEventListener('close', () => { this.socket = null; this._scheduleReconnect(url); });
    this.socket.addEventListener('error', () => { try { this.socket?.close(); } catch {} });
  }

  _scheduleReconnect(url) {
    if (this._disposed) return;
    setTimeout(() => {
      this._retry = Math.min(this._retry * 2, 8000);
      this.attachToWS(url);
    }, this._retry);
  }

  // Public handler — exported so the demo button can fire fake events
  // through the same code path the WS uses.
  handleMessage(msg) {
    if (this._disposed) return;
    const n = normaliseMessage(msg);
    if (!n) return;
    const { type, agentId, data } = n;

    if (type === 'agent:started') {
      if (this.squads.has(agentId)) return; // dedupe
      // Enforce the concurrency cap BEFORE we spawn the new squad so a
      // flurry of starts doesn't briefly exceed MAX_SQUADS.
      if (this.squads.size >= MAX_SQUADS) {
        let oldestId = null;
        let oldestTs = Infinity;
        for (const [id, sq] of this.squads) {
          if (sq.createdAt < oldestTs) { oldestTs = sq.createdAt; oldestId = id; }
        }
        if (oldestId) this._retireSquad(oldestId, 'stale');
      }
      // Prefer the front anchor when no squads are currently active — the
      // first visible squad should land in the familiar front-shoulder
      // spot so a user who hasn't orbited the camera still sees it.
      const preferFront = this.squads.size === 0;
      // Allow a caller (e.g. demo button via `data._forceAnchor`) to pin
      // a specific anchor so a dev can cycle through all of them.
      const anchor = data._forceAnchor || null;
      const sq = new Squad(agentId, this.spriteLayer, data.task, { preferFront, anchor });
      this.squads.set(agentId, sq);
      // Leak guard — if we never see a complete/error, auto-disperse.
      const leak = setTimeout(() => this._retireSquad(agentId, 'timeout'), LEAK_TIMEOUT_MS);
      this._leakTimers.set(agentId, leak);
    } else if (type === 'agent:tool_start') {
      const sq = this.squads.get(agentId);
      if (sq) sq.onToolStart({ tool_name: data.tool_name, query_summary: data.query_summary });
    } else if (type === 'agent:tool_end') {
      const sq = this.squads.get(agentId);
      if (sq) sq.onToolEnd({ tool_name: data.tool_name, ok: data.ok !== false, summary: data.summary });
    } else if (type === 'agent:complete') {
      const sq = this.squads.get(agentId);
      if (sq) {
        sq.onComplete({ findings: data.findings });
        this._clearLeak(agentId);
        // Leave the squad in the Map briefly so late tool_end events
        // (if any) still find their owner; the squad's internal `done`
        // flag makes further calls no-ops. Drop after the sprites fade.
        setTimeout(() => this.squads.delete(agentId), 5000);
      }
    } else if (type === 'agent:error') {
      const sq = this.squads.get(agentId);
      if (sq) {
        sq.onError({ error: data.error });
        this._clearLeak(agentId);
        setTimeout(() => this.squads.delete(agentId), 5000);
      }
    }
  }

  _retireSquad(agentId, label) {
    const sq = this.squads.get(agentId);
    if (!sq) return;
    sq.disperse(label);
    this._clearLeak(agentId);
    setTimeout(() => this.squads.delete(agentId), 5000);
  }

  _clearLeak(agentId) {
    const t = this._leakTimers.get(agentId);
    if (t) clearTimeout(t);
    this._leakTimers.delete(agentId);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try { this.socket?.close(); } catch {}
    this.socket = null;
    for (const [id] of this.squads) this._retireSquad(id, 'bye');
    this.squads.clear();
    for (const t of this._leakTimers.values()) clearTimeout(t);
    this._leakTimers.clear();
  }
}

// ── One-shot installer ──────────────────────────────────────────────────
// Mirrors agent-sprites' installer pattern. Safe to call with nothing
// when the sprite layer isn't ready yet — we poll briefly for
// `window.__momoSprites` before giving up.
let _installed = null;
export function installSquadLayer(spriteLayer, opts = {}) {
  // Resolve the real SpriteLayer instance. `window.__momoSprites` holds
  // `{ layer: SpriteLayer }` per agent-sprites.js; accept either form.
  function resolveLayer(candidate) {
    if (!candidate) return null;
    if (typeof candidate.spawn === 'function') return candidate;
    if (candidate.layer && typeof candidate.layer.spawn === 'function') return candidate.layer;
    return null;
  }

  let layer = resolveLayer(spriteLayer);
  if (!layer && typeof window !== 'undefined') {
    layer = resolveLayer(window.__momoSprites);
  }

  // Tear down any previous install so re-mounting during a scene swap
  // (e.g. cylinder warp toggle) rebinds cleanly on top of the fresh
  // SpriteLayer instance. The WS socket is owned per-install.
  if (_installed) {
    try { _installed.dispose(); } catch {}
    _installed = null;
  }

  // Defer if the sprite layer isn't available yet. Retry a few times;
  // if it still isn't there, quietly give up — the squad layer must
  // NOT crash the host when its dependency is missing (per spec).
  if (!layer) {
    let attempts = 0;
    const maxAttempts = 20;
    const tick = () => {
      attempts++;
      const l = resolveLayer(spriteLayer) || resolveLayer(typeof window !== 'undefined' ? window.__momoSprites : null);
      if (l) {
        installSquadLayer(l, opts);
      } else if (attempts < maxAttempts) {
        setTimeout(tick, 150);
      } else {
        console.warn('[agent-squads] sprite layer not available; squad layer not installed');
      }
    };
    setTimeout(tick, 150);
    return null;
  }

  const squadLayer = new SquadLayer(layer, opts);
  squadLayer.attachToWS(opts.wsUrl || '/omo/ws');
  _installed = squadLayer;

  try { window.__momoSquads = squadLayer; } catch {}

  return squadLayer;
}

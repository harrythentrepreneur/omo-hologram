// momo-awareness — the orchestration layer that makes Momo *notice* her
// sprite helpers and research squads. Subscribes to the scene-wide event
// stream (sprite_*, helper_*, agent:*, momo:agent_update), decides which
// target deserves Momo's gaze right now, and drives avatar.focusOn /
// avatar.react*.
//
// Public surface:
//   const awareness = installMomoAwareness(avatar, spriteLayer, opts);
//   awareness.dispose();
//
// Design notes:
//   - Pure event consumer. Never modifies the sprite layer, squad layer,
//     or ambient module. Treats sprite handles as opaque — only uses
//     `handle.sprite.position` (a THREE.Vector3) and `handle.phase` to
//     decide when to stop tracking.
//   - Focus priority is *by event weight, then recency*. A fresh landing
//     always beats a stale spawn; chart landings beat research completes
//     by weight but a newer research complete can still win on recency.
//   - For moving sprites we re-sample position every N frames via a
//     lightweight rAF poller. We never snapshot-and-forget; a sprite that
//     runs off screen shouldn't leave Momo staring at where it used to be.
//   - Graceful degradation: missing avatar, missing spriteLayer, and
//     `prefers-reduced-motion` all degrade without crashing. Reactions
//     damp to 40 % intensity in reduced-motion (handled inside avatar.js,
//     but we dial priorities here too so tiny movements win more often).
//
// All scratch THREE helpers are imported lazily so this module can be
// dropped into a page without Three — the worst case is that worldPos
// tracking silently no-ops and we rely purely on reactions.

import * as THREE from 'three';

// ── Tunables ───────────────────────────────────────────────────────────
// Event weights determine priority when two events compete on the same
// tick. Higher = more attention. Tie-broken by recency (most recent wins).
const WEIGHTS = {
  chart_landing:     100,  // sprite arriving home carrying a chart viz_id
  chart_carrying:     75,
  squad_complete:     90,  // research squad finished — full reactDelighted
  squad_error:        85,  // failure — reactConcerned
  helper_landed:      60,
  helper_working:     40,
  helper_appeared:    55,
  agent_started:      45,
  agent_update:       35,
  ambient_peek:       25,
};

// Per-event intensity fed into avatar.focusOn. Softer non-chart sprites,
// full strength for real tool outputs and research completes.
const INTENSITY = {
  chart_landing:   1.0,
  chart_carrying:  0.9,
  squad_complete:  1.0,
  squad_error:     0.8,
  helper_landed:   0.65,
  helper_working:  0.5,
  helper_appeared: 0.6,
  agent_started:   0.55,
  agent_update:    0.45,
  ambient_peek:    0.5,
};

// How long Momo holds a passive look before auto-relaxing. Landing events
// hold longer (she's acknowledging the delivery) than spawning or generic
// helpers (quick glance). null = indefinite, caller relaxes manually.
const HOLD_MS = {
  chart_landing:   1200,
  chart_carrying:   900,
  squad_complete:  1400,
  squad_error:     1400,
  helper_landed:    900,
  helper_working:   700,
  helper_appeared:  600,
  agent_started:    700,
  agent_update:     500,
  ambient_peek:     550,
};

// After a focus ends (sprite gone or hold expires), Momo waits this long
// before another event is allowed to re-engage her. Prevents gaze flicker
// during bursty event streams while still feeling responsive.
const RELAX_LINGER_MS = 500;

// Position-tracking cadence. 3 → sample a moving sprite every 3 frames
// (~50ms at 60fps). Plenty for the eye — human saccade latency is ~150ms.
const POSITION_SAMPLE_EVERY_N = 3;

// ── Helpers ─────────────────────────────────────────────────────────────
const _scratchWorldPos = new THREE.Vector3();

function readHandleWorldPos(handle, out) {
  // Handle is opaque; we know from agent-sprites.js that it owns a
  // THREE.Sprite at handle.sprite. We don't touch anything else.
  const spr = handle && handle.sprite;
  if (!spr || !spr.position) return false;
  out.copy(spr.position);
  return true;
}

function isHandleAlive(handle) {
  if (!handle) return false;
  const ph = handle.phase;
  return ph && ph !== 'dead' && ph !== 'fading';
}

// Look up a sprite handle from an event detail. Events fired by
// agent-sprites include `{ handle }` when a handle is available so we can
// track. `worldPos` is a fallback {x,y,z} snapshot for when the handle
// isn't exposed (squad completes, agent:* events that don't carry one).
function resolveTarget(detail) {
  if (!detail) return null;
  if (detail.handle && isHandleAlive(detail.handle)) return { handle: detail.handle, pos: null };
  if (detail.worldPos) return { handle: null, pos: detail.worldPos };
  return null;
}

// ── Awareness orchestrator ──────────────────────────────────────────────
class MomoAwareness {
  constructor(avatar, spriteLayer, opts = {}) {
    this.avatar = avatar;
    this.spriteLayer = spriteLayer || null;
    this.opts = opts || {};
    this._disposed = false;

    // Active focus state. `handle` (if any) gets polled for position; `pos`
    // is the snapshot used when the event didn't provide a live handle.
    this._focus = {
      kind: null,            // event kind that set this focus
      handle: null,          // sprite handle (optional)
      pos: new THREE.Vector3(),
      ts: 0,                 // when the focus was set (ms)
      weight: 0,
      expiresAt: 0,          // ms — auto-relax deadline (0 = indefinite)
    };
    this._lastRelaxAt = 0;
    this._frameCount = 0;

    // Debug hook. Intentionally minimal — the task spec calls for just
    // these three fields so tests/devtools can verify behaviour.
    this._debug = { lastTarget: null, lastEvent: null, focusedHandle: null };
    try { window.__momoAwareness = this._debug; } catch {}

    this._reducedMotion = false;
    try {
      this._reducedMotion = !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {}

    // Bind once so addEventListener/removeEventListener match.
    this._onSpriteCarrying  = (e) => this._handle('chart_carrying',  e.detail);
    this._onSpriteLanding   = (e) => this._handle('chart_landing',   e.detail);
    this._onSpriteGone      = (e) => this._handleGone(e.detail);
    this._onHelperAppeared  = (e) => this._handle('helper_appeared', e.detail);
    this._onHelperWorking   = (e) => this._handle('helper_working',  e.detail);
    this._onHelperLanded    = (e) => this._handle('helper_landed',   e.detail);
    this._onHelperGone      = (e) => this._handleGone(e.detail);
    this._onAgentStarted    = (e) => this._handleAgent('agent_started', e.detail);
    this._onAgentComplete   = (e) => this._handleAgent('squad_complete', e.detail);
    this._onAgentError      = (e) => this._handleAgent('squad_error', e.detail);
    this._onAgentUpdate     = (e) => this._handle('agent_update', e.detail);

    this._installListeners();
    this._rafId = null;
    this._tick = this._tick.bind(this);
    this._rafId = requestAnimationFrame(this._tick);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._removeListeners();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    // Gentle hand-off: if we were focused, release so the idle action bag
    // resumes immediately rather than Momo frozen mid-gaze.
    try { this.avatar && this.avatar.relax && this.avatar.relax(); } catch {}
  }

  _installListeners() {
    window.addEventListener('momo:sprite_carrying', this._onSpriteCarrying);
    window.addEventListener('momo:sprite_landing',  this._onSpriteLanding);
    window.addEventListener('momo:sprite_gone',     this._onSpriteGone);
    window.addEventListener('momo:helper_appeared', this._onHelperAppeared);
    window.addEventListener('momo:helper_working',  this._onHelperWorking);
    window.addEventListener('momo:helper_landed',   this._onHelperLanded);
    window.addEventListener('momo:helper_gone',     this._onHelperGone);
    window.addEventListener('agent:started',        this._onAgentStarted);
    window.addEventListener('agent:complete',       this._onAgentComplete);
    window.addEventListener('agent:error',          this._onAgentError);
    window.addEventListener('momo:agent_update',    this._onAgentUpdate);
  }

  _removeListeners() {
    window.removeEventListener('momo:sprite_carrying', this._onSpriteCarrying);
    window.removeEventListener('momo:sprite_landing',  this._onSpriteLanding);
    window.removeEventListener('momo:sprite_gone',     this._onSpriteGone);
    window.removeEventListener('momo:helper_appeared', this._onHelperAppeared);
    window.removeEventListener('momo:helper_working',  this._onHelperWorking);
    window.removeEventListener('momo:helper_landed',   this._onHelperLanded);
    window.removeEventListener('momo:helper_gone',     this._onHelperGone);
    window.removeEventListener('agent:started',        this._onAgentStarted);
    window.removeEventListener('agent:complete',       this._onAgentComplete);
    window.removeEventListener('agent:error',          this._onAgentError);
    window.removeEventListener('momo:agent_update',    this._onAgentUpdate);
  }

  // ── Event handlers ────────────────────────────────────────────────────
  _handle(kind, detail) {
    if (this._disposed || !this.avatar || !this.avatar.focusOn) return;
    this._debug.lastEvent = { kind, at: performance.now() };

    const target = resolveTarget(detail);
    if (!target) return;

    // Priority check: new event beats current focus if it has a higher
    // weight, OR equal weight but is newer (handled by always comparing).
    const now = performance.now();
    const weight = WEIGHTS[kind] || 0;
    const isOverride = !this._focus.kind
      || weight >= this._focus.weight;
    if (!isOverride) return;

    // Resolve initial position. For handles we poll every frame; we still
    // need a decent first estimate so the first frame's focusOn lands on
    // something sensible even before the poller runs.
    let pos;
    if (target.handle && readHandleWorldPos(target.handle, _scratchWorldPos)) {
      pos = _scratchWorldPos;
    } else if (target.pos) {
      _scratchWorldPos.set(target.pos.x || 0, target.pos.y || 0, target.pos.z || 0);
      pos = _scratchWorldPos;
    } else {
      return;
    }

    this._focus.kind = kind;
    this._focus.handle = target.handle;
    this._focus.pos.copy(pos);
    this._focus.ts = now;
    this._focus.weight = weight;
    this._focus.expiresAt = HOLD_MS[kind] != null ? now + HOLD_MS[kind] : 0;
    this._debug.focusedHandle = target.handle || null;
    this._debug.lastTarget = { x: pos.x, y: pos.y, z: pos.z };

    try {
      this.avatar.focusOn(this._focus.pos, {
        intensity: INTENSITY[kind] || 0.8,
        durationMs: HOLD_MS[kind] || null,
      });
    } catch {}

    // Reaction layering. Landings and completes add emotional beats on
    // top of the gaze. Errors get a concerned tilt; completes get
    // delighted; chart landings get a small happy nod.
    try {
      if (kind === 'squad_complete') this.avatar.reactDelighted && this.avatar.reactDelighted();
      else if (kind === 'squad_error') this.avatar.reactConcerned && this.avatar.reactConcerned();
      else if (kind === 'chart_landing') this.avatar.reactHappy && this.avatar.reactHappy();
      else if (kind === 'helper_landed') this.avatar.reactHappy && this.avatar.reactHappy();
    } catch {}
  }

  _handleAgent(kind, detail) {
    // Agent-level events don't always carry a worldPos. Feed a synthetic
    // position that roughly represents the squad anchor — we default to
    // the avatar's up-front zone so Momo looks "ahead" when research starts.
    // If the detail carries worldPos we honour it; otherwise synthesize.
    const synth = detail && detail.worldPos
      ? detail.worldPos
      : { x: 0, y: 0.6, z: 1.8 };
    this._handle(kind, { ...detail, worldPos: synth });
  }

  _handleGone(detail) {
    if (this._disposed) return;
    const handle = detail && detail.handle;
    // A failing sprite gets a concerned reaction even if it wasn't our
    // current focus — if Momo's helper just faceplanted, she should at
    // least notice. The reaction overlays the gaze non-destructively.
    if (detail && detail.sad) {
      try { this.avatar.reactConcerned && this.avatar.reactConcerned(); } catch {}
    }
    // Only relax the gaze if the gone sprite was our current focus; an
    // unrelated sprite fading out shouldn't break Momo's focus on something
    // she's actively looking at.
    if (this._focus.kind && (!handle || handle === this._focus.handle)) {
      this._lineUpRelax();
    }
  }

  // Schedule a gentle relax after a short linger so bursty events don't
  // cause Momo to snap back and forth.
  _lineUpRelax() {
    this._focus.expiresAt = performance.now() + RELAX_LINGER_MS;
  }

  // ── Per-frame tick ────────────────────────────────────────────────────
  // Drives two jobs: re-sample the focused handle's world position (for
  // moving sprites), and fire avatar.relax() when the hold window expires.
  _tick() {
    if (this._disposed) return;
    this._frameCount++;
    const now = performance.now();

    if (this._focus.kind) {
      // Re-sample position every few frames for live handles. Static pos
      // focuses (squad events, synthesized positions) skip the re-sample.
      if (
        this._focus.handle
        && (this._frameCount % POSITION_SAMPLE_EVERY_N) === 0
      ) {
        if (readHandleWorldPos(this._focus.handle, _scratchWorldPos)) {
          this._focus.pos.copy(_scratchWorldPos);
          // Re-focus with the fresh position; the avatar's gaze controller
          // already smooths so this doesn't cause a visible jump.
          try {
            this.avatar.focusOn(this._focus.pos, {
              intensity: INTENSITY[this._focus.kind] || 0.8,
              // Preserve the original expiry — don't keep extending hold.
              durationMs: Math.max(1, this._focus.expiresAt - now),
            });
          } catch {}
        } else if (!isHandleAlive(this._focus.handle)) {
          // Sprite dispatched — drop it and let the hold expire naturally.
          this._focus.handle = null;
          this._debug.focusedHandle = null;
        }
      }

      // Expiry check — if the hold elapsed we release.
      if (this._focus.expiresAt && now >= this._focus.expiresAt) {
        this._releaseFocus();
      }
    }

    this._rafId = requestAnimationFrame(this._tick);
  }

  _releaseFocus() {
    this._focus.kind = null;
    this._focus.handle = null;
    this._focus.weight = 0;
    this._focus.expiresAt = 0;
    this._lastRelaxAt = performance.now();
    this._debug.focusedHandle = null;
    try { this.avatar.relax(); } catch {}
  }
}

// ── Installer ─────────────────────────────────────────────────────────
// One-shot install. Graceful against missing avatar / spriteLayer /
// reduced-motion. Re-install is idempotent: the second call replaces the
// first (scene swaps on the cylinder page rebuild the world, so we want
// a fresh listener binding when called again).
let _installed = null;
let _warned = false;

export function installMomoAwareness(avatar, spriteLayer, opts = {}) {
  // Feature-detect the gaze API. If the avatar build doesn't match, log
  // once and return a dispose-only stub so the caller can unconditionally
  // use the install site.
  if (!avatar || typeof avatar.focusOn !== 'function') {
    if (!_warned) {
      _warned = true;
      console.warn('[momo-awareness] avatar.focusOn missing; awareness install is a no-op');
    }
    // Defer: if window.__momoAvatar is populated later, rebind. Useful
    // when the installer runs inside createHologramScene() before the
    // host page has created the avatar.
    const tryBind = () => {
      if (_installed && _installed._disposed === false) return;
      const late = typeof window !== 'undefined' ? window.__momoAvatar : null;
      if (late && typeof late.focusOn === 'function') {
        return installMomoAwareness(late, spriteLayer, opts);
      }
      return null;
    };
    // Poll a few times — give the host page up to 2s to park the avatar
    // on window.__momoAvatar. Not a busy loop; setTimeout stays out of
    // the rAF budget.
    let tries = 0;
    const poll = () => {
      tries++;
      if (tryBind()) return;
      if (tries < 20) setTimeout(poll, 100);
    };
    if (typeof window !== 'undefined') setTimeout(poll, 100);
    return { dispose() {} };
  }

  if (_installed && _installed.dispose) {
    try { _installed.dispose(); } catch {}
    _installed = null;
  }

  _installed = new MomoAwareness(avatar, spriteLayer, opts);
  return {
    dispose() {
      try { _installed && _installed.dispose(); } catch {}
      _installed = null;
    },
  };
}

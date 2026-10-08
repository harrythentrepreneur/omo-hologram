// agent-ambient — unprompted "life" for the hologram scene.
//
// When Momo has been quiet for a stretch (no tool calls, no sprites, no
// voice activity), this module occasionally pops a single small sprite out
// from the periphery to do a micro-action (peek, stretch, wave, glance,
// float-by, stargaze) and fade. Makes the scene feel inhabited rather
// than frozen. Think fireflies in the hologram.
//
// Layered on top of agent-sprites — does NOT modify that module. Uses only
// the SpriteLayer / SpriteHandle public API, feature-detecting optional
// extensions (say/name/react/eyeLook/getWorldPosition/setReturnTarget)
// from the parallel personality agent.
//
// Public API:
//   const ambient = new AmbientLife(spriteLayer, opts);
//   ambient.start();         // begin idle scheduling
//   ambient.stop();          // cancel any pending scheduled tick
//   ambient.dispose();       // stop + release listeners
//   ambient.markActivity();  // external systems call when user is active
//
//   installAmbientLife(spriteLayer, opts);  // one-shot convenience

import * as THREE from 'three';
import { avatarAnchorPoint, randomThetaPhi } from './spatial.js';

// ── Tunables ────────────────────────────────────────────────────────────
const IDLE_THRESHOLD_MS_DEFAULT = 25_000;
const SCHEDULE_MIN_MS = 30_000;
const SCHEDULE_MAX_MS = 90_000;
// How often we re-check idle conditions while *not* idle. We don't need a
// dense interval here — the idle re-arm is just a wake-up.
const IDLE_POLL_MS = 5_000;

const ACTION_WEIGHTS = [
  { name: 'peek',     weight: 35 },
  { name: 'stretch',  weight: 20 },
  { name: 'wave',     weight: 15 },
  { name: 'glance',   weight: 15 },
  { name: 'float-by', weight: 10 },
  { name: 'stargaze', weight: 5 },
];

// Quieter kinds only — white/cyan. No magenta (research) noise.
const KIND_POOL = ['tool_call', 'hq_query'];

// The external activity events the sprite layer already fires when anything
// is happening. If the parallel personality agent adds them, we pick them
// up; if not, we still have sprites.size as a coarse fallback.
const ACTIVITY_EVENTS = [
  'momo:sprite_carrying',
  'momo:sprite_landing',
  'momo:sprite_gone',
  'momo:agent_update',
];

// ── Helpers ─────────────────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function weightedPick(items) {
  let total = 0;
  for (const it of items) total += it.weight;
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.name;
  }
  return items[0].name;
}

// Feature-detect the optional extras from the personality agent.
function spawnCompat(layer, spec) {
  // Try the 3-arg form (name) first, fall back to 2-arg.
  try {
    return layer.spawn(spec);
  } catch (err) {
    // Very unlikely — layer.spawn shouldn't throw, but don't crash if it does.
    console.warn('[ambient] spawn failed', err);
    return null;
  }
}

function trySay(handle, text) {
  if (!handle) return;
  try {
    if (typeof handle.say === 'function') handle.say(text);
  } catch {}
}

function tryEyeLook(handle, vec) {
  if (!handle) return;
  try {
    if (typeof handle.eyeLook === 'function') handle.eyeLook(vec);
  } catch {}
}

function trySetReturnTarget(handle, vec) {
  if (!handle) return false;
  try {
    if (typeof handle.setReturnTarget === 'function') {
      handle.setReturnTarget(vec);
      return true;
    }
  } catch {}
  return false;
}

function tryReact(handle, mood) {
  if (!handle) return;
  try {
    if (typeof handle.react === 'function') handle.react(mood);
  } catch {}
}

// Convert a world-space station into a runOff direction vector relative
// to the avatar. runOff normalises and re-scales into the orbit band, so
// we just need a Vector3 pointing from avatar toward the desired spot.
// Used by all ambient actions so they can target ANY side of the avatar
// via a shared helper.
function directionTo(avatarPos, worldPoint) {
  return new THREE.Vector3(
    (worldPoint?.x ?? 0) - (avatarPos?.x ?? 0),
    (worldPoint?.y ?? 0) - (avatarPos?.y ?? 0),
    (worldPoint?.z ?? 0) - (avatarPos?.z ?? 0),
  );
}

/**
 * Random world-space position around the avatar, shared by the ambient
 * actions so they can all land on any side. `thetaRange` lets specific
 * actions restrict the bearing (e.g. stargaze can be anywhere; float-by
 * picks axes explicitly). If `forceTheta` is supplied it OVERRIDES the
 * random roll — used by the demo button to pin an action to a side.
 */
function randomPositionAroundAvatar(avatarPos, {
  radius = 2.2,
  yRange = [-0.2, 0.8],
  thetaRange,
  phiRange,
  forceTheta,
} = {}) {
  const { theta: randTheta, phi } = randomThetaPhi({
    thetaMin: thetaRange?.[0],
    thetaMax: thetaRange?.[1],
    phiMin:   phiRange?.[0],
    phiMax:   phiRange?.[1],
  });
  const theta = typeof forceTheta === 'number' ? forceTheta : randTheta;
  const p = avatarAnchorPoint(avatarPos, { theta, phi, r: radius });
  // Allow a direct y override if the caller wants a specific band. Uses
  // avatarPos.y as the reference so the yRange reads intuitively as
  // "offset from the avatar's feet".
  if (yRange) {
    p.y = (avatarPos?.y ?? 0) + yRange[0] + Math.random() * (yRange[1] - yRange[0]);
  }
  return p;
}

// ── AmbientLife ────────────────────────────────────────────────────────
export class AmbientLife {
  constructor(spriteLayer, opts = {}) {
    if (!spriteLayer) throw new Error('[agent-ambient] spriteLayer required');
    this.layer = spriteLayer;
    this.idleThresholdMs = Number.isFinite(opts.idleThresholdMs)
      ? opts.idleThresholdMs : IDLE_THRESHOLD_MS_DEFAULT;

    this._lastActivityAt = performance.now();
    this._currentHandle = null;
    this._scheduleTimer = null;
    this._pollTimer = null;
    this._running = false;
    this._disposed = false;

    // Reduced-motion check. Cache once; users who flip the OS setting
    // mid-session are rare enough not to worry about.
    this._reducedMotion = false;
    try {
      this._reducedMotion = !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {}

    // Observe size growth of the sprite layer — any non-ambient spawn
    // counts as user activity. We snapshot size between polls; if size
    // has grown and we didn't cause it, that's activity.
    this._lastObservedSize = spriteLayer.sprites ? spriteLayer.sprites.size : 0;

    // Pause while the tab is hidden (no point animating).
    this._onVisibility = () => {
      if (document.hidden) this._clearTimers();
      else if (this._running) this._scheduleNext(IDLE_POLL_MS);
    };

    // External activity listeners.
    this._onActivity = () => this.markActivity();
    this._onSessionStart = () => this.markActivity();

    this._installedListeners = false;
  }

  start() {
    if (this._disposed || this._running) return this;
    if (this._reducedMotion) {
      // No-op in reduced motion: don't schedule anything, don't add listeners.
      this._running = true;
      return this;
    }
    this._running = true;
    this._installListeners();
    this._scheduleNext(IDLE_POLL_MS);
    return this;
  }

  stop() {
    this._running = false;
    this._clearTimers();
    this._removeListeners();
    return this;
  }

  dispose() {
    this._disposed = true;
    this.stop();
    this._gracefulExitCurrent();
    this._currentHandle = null;
  }

  markActivity() {
    this._lastActivityAt = performance.now();
    // If an ambient sprite is alive and the user just came back, gracefully
    // fade it out so it doesn't fight with real activity.
    this._gracefulExitCurrent();
  }

  // ── Internals ────────────────────────────────────────────────────────
  _installListeners() {
    if (this._installedListeners) return;
    this._installedListeners = true;
    try {
      document.addEventListener('visibilitychange', this._onVisibility);
      for (const ev of ACTIVITY_EVENTS) {
        window.addEventListener(ev, this._onActivity);
      }
      // Heuristic: any voice/session start should count as activity.
      window.addEventListener('momo:session_started', this._onSessionStart);
    } catch {}
  }

  _removeListeners() {
    if (!this._installedListeners) return;
    this._installedListeners = false;
    try {
      document.removeEventListener('visibilitychange', this._onVisibility);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, this._onActivity);
      }
      window.removeEventListener('momo:session_started', this._onSessionStart);
    } catch {}
  }

  _clearTimers() {
    if (this._scheduleTimer) {
      clearTimeout(this._scheduleTimer);
      this._scheduleTimer = null;
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _scheduleNext(delayMs) {
    if (!this._running || this._disposed || this._reducedMotion) return;
    this._clearTimers();
    this._scheduleTimer = setTimeout(() => this._tick(), Math.max(100, delayMs | 0));
  }

  _isIdle() {
    if (this._reducedMotion) return false;
    if (document.hidden) return false;
    const now = performance.now();
    if (now - this._lastActivityAt < this.idleThresholdMs) return false;

    // If non-ambient sprites are live, we're not idle. `_currentHandle` is
    // our own sprite; any other member of the layer is user-driven.
    const sprites = this.layer.sprites;
    if (sprites && sprites.size > 0) {
      if (!this._currentHandle) return false;
      if (sprites.size > 1) return false;
    }
    return true;
  }

  _pollExternalActivity() {
    // If the layer grew unexpectedly (a spawn we didn't make), treat as
    // activity and gracefully exit any of our own sprites.
    const size = this.layer.sprites ? this.layer.sprites.size : 0;
    const ourCount = this._currentHandle ? 1 : 0;
    if (size > ourCount + this._lastObservedSize) {
      this.markActivity();
    }
    this._lastObservedSize = Math.max(0, size - ourCount);
  }

  _tick() {
    if (!this._running || this._disposed) return;
    this._pollExternalActivity();

    // If we already have one of ours still alive, wait for it to die
    // before scheduling the next.
    if (this._currentHandle && !this._isHandleDone(this._currentHandle)) {
      this._scheduleNext(IDLE_POLL_MS);
      return;
    }
    // Clear stale reference.
    if (this._currentHandle && this._isHandleDone(this._currentHandle)) {
      this._currentHandle = null;
    }

    if (!this._isIdle()) {
      this._scheduleNext(IDLE_POLL_MS);
      return;
    }

    // We're idle. Run an action.
    try {
      this.runAction();
    } catch (err) {
      console.warn('[ambient] action failed', err);
    }

    // Next scheduled tick somewhere in the 30–90s band.
    this._scheduleNext(rand(SCHEDULE_MIN_MS, SCHEDULE_MAX_MS));
  }

  _isHandleDone(handle) {
    if (!handle) return true;
    const ph = handle.phase;
    return ph === 'dead' || ph === 'fading';
  }

  _gracefulExitCurrent() {
    const h = this._currentHandle;
    if (!h) return;
    if (this._isHandleDone(h)) {
      this._currentHandle = null;
      return;
    }
    try {
      // returnWith('') produces a clean fade-out via the normal return path.
      h.returnWith('');
    } catch {}
    this._currentHandle = null;
  }

  /**
   * Run a specific action (or a weighted-random pick). Public so the dev
   * demo button can cycle through them.
   * @param {string} [name]
   * @returns {string|null} the action name that ran, or null if skipped.
   */
  runAction(name, opts = {}) {
    if (this._reducedMotion) return null;
    // If there's already an ambient sprite alive, don't stack.
    if (this._currentHandle && !this._isHandleDone(this._currentHandle)) {
      return null;
    }
    const action = name || weightedPick(ACTION_WEIGHTS);
    const fn = ACTIONS[action];
    if (!fn) return null;
    // `forceTheta` lets the demo button pin an action to a specific side
    // of the avatar so a developer can exercise full-ring coverage. Real
    // activity leaves it undefined and the actions roll their own random
    // theta.
    const helpers = { spawnCompat, trySay, tryEyeLook, trySetReturnTarget, tryReact,
                      forceTheta: typeof opts.forceTheta === 'number' ? opts.forceTheta : null };
    const handle = fn(this.layer, helpers);
    if (!handle) return null;
    this._currentHandle = handle;
    this._lastObservedSize = (this.layer.sprites ? this.layer.sprites.size : 0) - 1;
    return action;
  }
}

// ── Action implementations ─────────────────────────────────────────────
// Each returns the SpriteHandle it spawned (or null if skipped). They use
// only the public SpriteLayer/SpriteHandle API plus defensive feature
// detection. Timings are deliberately short — 2-5s end-to-end.

function spawnQuiet(layer, labelOverride, nameOverride) {
  const kind = pick(KIND_POOL);
  // The parallel agent is adding an optional `name` arg. Feature-detect by
  // passing it and letting the layer either honour or drop it — the current
  // implementation ignores unknown keys.
  const spec = { kind, label: labelOverride || '' };
  if (nameOverride) spec.name = nameOverride;
  return spawnCompat(layer, spec);
}

function actionPeek(layer, helpers) {
  const h = spawnQuiet(layer, '', 'peeky');
  if (!h) return null;
  // Pick one of four cardinal sides (front / right / back / left) so the
  // peek may happen behind or beside the camera depending on orbit
  // position. With the camera unknown, the random pick still guarantees
  // the peeks spread over time rather than always on the front shoulder.
  const sides = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const theta = typeof helpers.forceTheta === 'number'
    ? helpers.forceTheta
    : sides[Math.floor(Math.random() * sides.length)];
  const destination = avatarAnchorPoint(layer.avatarPos, { theta, phi: Math.PI / 16, r: 2.0 });
  const dir = directionTo(layer.avatarPos, destination);
  try { h.runOff(dir); } catch {}
  helpers.trySay(h, 'hi!');
  // Hold briefly at station, then fade back home silently.
  setTimeout(() => {
    helpers.tryEyeLook(h, { x: 0, y: 0 });
    try { h.returnWith(''); } catch {}
  }, 1100);
  return h;
}

function actionStretch(layer, helpers) {
  const h = spawnQuiet(layer, '', 'stretchy');
  if (!h) return null;
  // Pick a random theta around the avatar so consecutive stretches pop
  // on different sides. The vertical component is kept positive so the
  // sprite reads as "reaching up".
  const destination = randomPositionAroundAvatar(layer.avatarPos, {
    radius: 2.0,
    yRange: [0.6, 1.1],
    forceTheta: helpers.forceTheta,
  });
  const dir = directionTo(layer.avatarPos, destination);
  try { h.runOff(dir); } catch {}
  helpers.trySay(h, '~stretch~');
  setTimeout(() => {
    try { h.returnWith(''); } catch {}
  }, 900);
  return h;
}

function actionWave(layer, helpers) {
  const h = spawnQuiet(layer, '', 'wavey');
  if (!h) return null;
  // Any theta around the avatar so a wave can happen on any side.
  // Slight bias upward so it reads as "greeting".
  const destination = randomPositionAroundAvatar(layer.avatarPos, {
    radius: 2.0,
    yRange: [0.3, 0.7],
    forceTheta: helpers.forceTheta,
  });
  const dir = directionTo(layer.avatarPos, destination);
  try { h.runOff(dir); } catch {}
  helpers.trySay(h, 'hello');
  helpers.tryReact(h, 'happy');
  // Pan eyes left → right → centre over the loiter.
  setTimeout(() => helpers.tryEyeLook(h, { x: -1, y: 0 }), 500);
  setTimeout(() => helpers.tryEyeLook(h, { x: 1, y: 0 }), 1100);
  setTimeout(() => helpers.tryEyeLook(h, { x: 0, y: 0 }), 1700);
  setTimeout(() => {
    try { h.returnWith(''); } catch {}
  }, 2100);
  return h;
}

function actionGlance(layer, helpers) {
  const h = spawnQuiet(layer, '', 'glancey');
  if (!h) return null;
  // Glance is normally a quick spawn-point peek. Randomise its station
  // at any theta so the glance may appear from behind, to the side, or
  // in front. Short runOff so it reads as "poke head around and back".
  const destination = randomPositionAroundAvatar(layer.avatarPos, {
    radius: 1.8,
    yRange: [0.2, 0.8],
    forceTheta: helpers.forceTheta,
  });
  const dir = directionTo(layer.avatarPos, destination);
  try { h.runOff(dir); } catch {}
  helpers.trySay(h, '…?');
  helpers.tryEyeLook(h, { x: 0, y: 0 });
  setTimeout(() => {
    try { h.returnWith(''); } catch {}
  }, 650);
  return h;
}

function actionFloatBy(layer, helpers) {
  const h = spawnQuiet(layer, '', 'drifty');
  if (!h) return null;
  // Pick one of four axes so transits happen across the full 3D scene:
  //   0: left → right    (along the X axis)
  //   1: right → left
  //   2: front → back    (along the Z axis)
  //   3: back → front
  // Each axis is expressed as (entryTheta, exitTheta) pairs on the ring.
  const axes = [
    { entry: 3 * Math.PI / 2, exit: Math.PI / 2 },   // left → right
    { entry: Math.PI / 2,     exit: 3 * Math.PI / 2 }, // right → left
    { entry: 0,               exit: Math.PI },         // front → back
    { entry: Math.PI,         exit: 0 },               // back → front
  ];
  // If the demo button pinned a side, pick the axis whose entry matches
  // so the transit starts from that side. Otherwise roll randomly.
  let axis;
  if (typeof helpers.forceTheta === 'number') {
    axis = axes.reduce((best, cur) => {
      const d = Math.abs(((cur.entry - helpers.forceTheta + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      const bd = Math.abs(((best.entry - helpers.forceTheta + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      return d > bd ? cur : best;   // larger d = closer to forceTheta after wrap
    });
  } else {
    axis = axes[Math.floor(Math.random() * axes.length)];
  }
  const entryPoint = avatarAnchorPoint(layer.avatarPos, { theta: axis.entry, phi: 0.1, r: 2.2 });
  const exitPoint  = avatarAnchorPoint(layer.avatarPos, { theta: axis.exit,  phi: 0.1, r: 3.0 });
  const entryDir = directionTo(layer.avatarPos, entryPoint);
  try { h.runOff(entryDir); } catch {}
  helpers.trySay(h, '~');
  // After it arrives, retarget to the far side along the chosen axis
  // so the transit reads as a true "float by". setReturnTarget is
  // optional on the parallel agent's sprite build; returnWith('') is
  // the baseline fallback.
  setTimeout(() => {
    const moved = helpers.trySetReturnTarget(h, exitPoint);
    try { h.returnWith(''); } catch {}
    void moved;
  }, 1400);
  return h;
}

function actionStargaze(layer, helpers) {
  const h = spawnQuiet(layer, '', 'dreamy');
  if (!h) return null;
  // Random theta around the avatar so the dreamer can appear anywhere
  // on the ring. Vertical bias so the sprite ends up "reaching for the
  // stars" regardless of which side of Momo it picked.
  const destination = randomPositionAroundAvatar(layer.avatarPos, {
    radius: 2.2,
    yRange: [0.8, 1.3],
    forceTheta: helpers.forceTheta,
  });
  const dir = directionTo(layer.avatarPos, destination);
  try { h.runOff(dir); } catch {}
  helpers.trySay(h, 'oooh');
  helpers.tryEyeLook(h, { x: 0, y: -1 });
  helpers.tryReact(h, 'dreamy');
  setTimeout(() => {
    helpers.tryEyeLook(h, { x: 0, y: 0 });
    try { h.returnWith(''); } catch {}
  }, 1800);
  return h;
}

const ACTIONS = {
  'peek':     actionPeek,
  'stretch':  actionStretch,
  'wave':     actionWave,
  'glance':   actionGlance,
  'float-by': actionFloatBy,
  'stargaze': actionStargaze,
};

// ── Installer ──────────────────────────────────────────────────────────
// Idempotent-ish: each call creates a fresh AmbientLife bound to the given
// layer. Re-calling disposes the previous instance (scene swaps on the
// cylinder page do this). Exposes the instance on window.__momoAmbient
// so external code can call markActivity() without re-importing.
let _installed = null;
export function installAmbientLife(spriteLayer, opts = {}) {
  // Be defensive: if the sprite layer isn't installed yet, bail. The caller
  // typically installs the sprite layer first, but if something is racy,
  // retry a couple of times rather than crash.
  if (!spriteLayer) {
    let tries = 0;
    const attempt = () => {
      tries++;
      const sl = (typeof window !== 'undefined' && window.__momoSprites)
        ? window.__momoSprites.layer : null;
      if (sl) {
        installAmbientLife(sl, opts);
      } else if (tries < 20) {
        setTimeout(attempt, 500);
      }
    };
    attempt();
    return null;
  }

  // Dispose previous instance if present — typically on scene swap.
  if (_installed) {
    try { _installed.dispose(); } catch {}
    _installed = null;
  }

  const ambient = new AmbientLife(spriteLayer, opts);
  ambient.start();
  _installed = ambient;

  try { window.__momoAmbient = ambient; } catch {}

  return ambient;
}

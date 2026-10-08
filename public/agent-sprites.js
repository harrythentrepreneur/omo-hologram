// agent-sprites — cute little helper sprites that appear in the hologram
// scene, run off to "fetch" something, and return with a result label.
// Makes tool calls and research sub-agents visible as charming activity in
// the periphery of the avatar scene.
//
// Public API (see SpriteLayer below):
//   const layer = new SpriteLayer(scene, camera, { maxConcurrent, avatarPos, palette });
//   const handle = layer.spawn({ kind, label });
//   handle.runOff(direction?);            // run outward (radially by default)
//   handle.returnWith(resultLabel);       // triumphant bounce, 2s, fade out
//   handle.fail(reason);                  // red flash + shake, fade out
//   handle.dispose();
//   layer.update(t, dt);                  // call from render loop
//   layer.dispose();
//
// Design notes:
//   - Sprites are drawn into small offscreen canvases (128×128) and plugged
//     into a THREE.Sprite via CanvasTexture. No image assets, no external
//     tween libs. Geometry/material lookups are cached per palette entry
//     (we share one material per (kind, phase) by cloning from a prototype
//     so per-sprite opacity/colour tweaks don't leak), but each sprite owns
//     its own texture + canvas because the label changes.
//   - Sprites orbit in a torus shell around the avatar. They always spawn
//     near Momo, run out to an orbit radius, loiter, then return or fade.
//     This keeps them clear of the avatar face region (inner radius) and
//     beyond the pedestal disk (lower band) so they don't visually collide
//     with viz iframes mounted by chart-layer.
//   - If more than MAX_CONCURRENT sprites are spawned, oldest running-off
//     sprites are force-completed (coalesced) rather than queued. This
//     preserves visual freshness — stale sprites would look like a backlog.

import * as THREE from 'three';
import { avatarAnchorPoint, randomThetaPhi } from './spatial.js';

// ── Palette (reflector-safe) ────────────────────────────────────────────
// All colours shown against a black background on a glass reflector; the
// set here is the same cyan/magenta/white palette the rest of the scene
// uses so no haze appears on a real hologram rig.
const DEFAULT_PALETTE = {
  body: '#f5fbff',           // near-white body
  eye:  '#080a16',           // near-black eyes
  smile: '#080a16',
  shadow: 'rgba(8, 10, 22, 0.28)',
  // kind → { halo, accent, label }
  kinds: {
    research_agent: { halo: '#e879f9', accent: '#e879f9', label: '#e879f9' },
    hq_query:       { halo: '#22d3ee', accent: '#22d3ee', label: '#22d3ee' },
    web_search:     { halo: '#ffffff', accent: '#22d3ee', label: '#ffffff' },
    tool_call:      { halo: '#ffffff', accent: '#ffffff', label: '#ffffff' },
    chart_render:   { halo: '#e879f9', accent: '#ffffff', label: '#e879f9' },
    // GitHub family — soft mint for read tools (PR list / CI / activity),
    // warmer ember for write tools (comment / merge / close), and a
    // distinctive cyan-violet for the review-agent dispatch so the user
    // can tell at a glance which sprite is the long-running review.
    github_read:    { halo: '#5eead4', accent: '#5eead4', label: '#5eead4' },
    github_write:   { halo: '#fb923c', accent: '#fb923c', label: '#fb923c' },
    review_agent:   { halo: '#a78bfa', accent: '#a78bfa', label: '#a78bfa' },
  },
};

// ── Tunables ────────────────────────────────────────────────────────────
// Canvas is 256² (power of two so mipmaps work) for crisp faces. Coordinates
// in paintSprite are expressed in a 128-unit design grid and scaled up by
// `u = W/128`, so the painter reads the same as the original but renders 2×.
const CANVAS_PX = 256;           // offscreen canvas size per sprite
const SPRITE_SCALE = 0.62;       // world-space scale of the sprite plane
const ORBIT_RADIUS_MIN = 2.0;
const ORBIT_RADIUS_MAX = 2.8;
const ORBIT_Y_MIN = -0.8;
const ORBIT_Y_MAX = 1.3;
const SPAWN_POP_MS = 260;        // quick squash-and-stretch pop-in
const RUN_OFF_MS  = 900;         // spawn → arrive at orbit station
const LOITER_MIN_MS = 600;       // minimum loiter at station before return
const RETURN_MS   = 700;         // station → spawn point on returnWith()
const BOUNCE_MS   = 900;         // triumph bounce on return
const SPARKLE_MS  = 520;         // sparkle burst duration during bounce
const HOLD_MS     = 1400;        // linger after bounce before fade
const FADE_OUT_MS = 420;
const FAIL_SHAKE_MS = 640;
const BLINK_CYCLE_S = 3.2;       // blink every N seconds
const BLINK_DUR_S = 0.17;        // single blink animation length
const DEFAULT_MAX = 8;

// ── Helpers ─────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, k) => a + (b - a) * k;
const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
const easeInOutCubic = (k) =>
  k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
// A happy bounce: quick launch, slow descent with little jiggle.
function bounceEnvelope(k) {
  if (k < 0.35) return easeOutCubic(k / 0.35);       // rise
  const tail = (k - 0.35) / 0.65;
  return 1 - Math.pow(tail, 2) + Math.sin(tail * Math.PI * 3) * 0.06 * (1 - tail);
}

// ── Sprite canvas painter ───────────────────────────────────────────────
// Paints the blob body, eyes, smile, halo glow, cheeks, antenna, optional
// sparkle burst, and the label. Coordinates are on a 128-unit design grid
// and scaled by `u = W/128`, so doubling the canvas size just makes
// everything crisper with no feature-layout shift.
function paintSprite(ctx, opts) {
  const { palette, kind, label, sad, blink, sparkleT } = opts;
  const accent = palette.kinds[kind] || palette.kinds.tool_call;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const u = W / 128;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2 + 8 * u;
  const rx = 37 * u;
  const ry = 35 * u;

  // Soft halo — multi-stop radial gradient for a gentle falloff (fewer
  // banding artifacts than a 3-stop version). Slight warm-pink tint when
  // sad so the fail state reads without being jarring.
  const haloColor = sad ? '#fca5a5' : accent.halo;
  const halo = ctx.createRadialGradient(cx, cy, 6 * u, cx, cy, 62 * u);
  halo.addColorStop(0.00, hexAlpha(haloColor, 0.58));
  halo.addColorStop(0.28, hexAlpha(haloColor, 0.38));
  halo.addColorStop(0.60, hexAlpha(haloColor, 0.16));
  halo.addColorStop(1.00, hexAlpha(haloColor, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);

  // Drop shadow — larger blur-effect via layered ellipses at low opacity.
  ctx.fillStyle = palette.shadow;
  ctx.beginPath();
  ctx.ellipse(cx, cy + ry + 5 * u, rx * 0.78, 5 * u, 0, 0, Math.PI * 2);
  ctx.fill();

  // Cute antenna tuft rising from the top of the head, drawn BEFORE the
  // body so the body's rim stroke visually "tucks" it under. A tiny
  // accent-coloured dot at the tip makes it read as a bobble.
  ctx.strokeStyle = hexAlpha(accent.accent, 0.92);
  ctx.lineWidth = 1.8 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + 1 * u, cy - ry + 2 * u);
  ctx.quadraticCurveTo(cx + 5 * u, cy - ry - 7 * u, cx + 2 * u, cy - ry - 13 * u);
  ctx.stroke();
  ctx.fillStyle = accent.accent;
  ctx.beginPath();
  ctx.arc(cx + 2 * u, cy - ry - 13 * u, 2.4 * u, 0, Math.PI * 2);
  ctx.fill();

  // Rounded blob body — ellipse with a subtle vertical gradient for a
  // soft "inflated" read. Sad state desaturates to a neutral dusty tone.
  const bodyTop = sad ? '#f6e8ea' : palette.body;
  const bodyBot = sad ? '#ebdadc' : '#eef5fb';
  const bodyGrad = ctx.createLinearGradient(cx, cy - ry, cx, cy + ry);
  bodyGrad.addColorStop(0, bodyTop);
  bodyGrad.addColorStop(1, bodyBot);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // Accent rim — keeps kind readable against bright backgrounds. Thinner
  // now that the body has a subtle gradient to carry some of the weight.
  ctx.strokeStyle = hexAlpha(accent.accent, 0.85);
  ctx.lineWidth = 1.8 * u;
  ctx.stroke();

  // Glossy highlight — soft elongated ellipse near the upper-left.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.beginPath();
  ctx.ellipse(cx - 11 * u, cy - 16 * u, 12 * u, 5.5 * u, -0.38, 0, Math.PI * 2);
  ctx.fill();
  // Tiny secondary sparkle highlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(cx - 16 * u, cy - 10 * u, 1.8 * u, 0, Math.PI * 2);
  ctx.fill();

  // Cheek blushes — soft warm pink ellipses. Skipped when sad so the
  // face read is obviously "off" rather than just colour-shifted.
  if (!sad) {
    ctx.fillStyle = 'rgba(244, 114, 182, 0.32)';
    ctx.beginPath();
    ctx.ellipse(cx - 20 * u, cy + 5 * u, 5.5 * u, 3.5 * u, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 20 * u, cy + 5 * u, 5.5 * u, 3.5 * u, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eyes — bigger, rounder, with a main shine and a secondary sparkle.
  // Blink is a smooth 0→1→0 ellipse squish, not a binary toggle.
  const eyeY = cy - 3 * u;
  const eyeDx = 11 * u;
  const eyeR = 5.2 * u;
  const eyeOpen = 1 - clamp(blink || 0, 0, 1);
  ctx.fillStyle = palette.eye;
  for (const dx of [-eyeDx, eyeDx]) {
    ctx.beginPath();
    ctx.ellipse(cx + dx, eyeY, eyeR, Math.max(eyeR * eyeOpen, 0.8 * u), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (eyeOpen > 0.25) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    for (const dx of [-eyeDx, eyeDx]) {
      ctx.beginPath();
      ctx.arc(cx + dx + 1.8 * u, eyeY - 1.8 * u, 1.8 * u, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.75;
    for (const dx of [-eyeDx, eyeDx]) {
      ctx.beginPath();
      ctx.arc(cx + dx - 1.4 * u, eyeY + 1.6 * u, 0.85 * u, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Sad brows — short slanted marks above each eye when failing.
  if (sad) {
    ctx.strokeStyle = hexAlpha(palette.eye, 0.75);
    ctx.lineWidth = 1.6 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - eyeDx - 4 * u, eyeY - 6 * u);
    ctx.lineTo(cx - eyeDx + 3 * u, eyeY - 8 * u);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + eyeDx + 4 * u, eyeY - 6 * u);
    ctx.lineTo(cx + eyeDx - 3 * u, eyeY - 8 * u);
    ctx.stroke();
  }

  // Mouth — smile (upturned arc) or a small sad curve. Slightly thicker
  // than before so the expression reads clearly.
  ctx.strokeStyle = palette.smile;
  ctx.lineWidth = 2 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  if (sad) {
    ctx.arc(cx, cy + 13 * u, 5 * u, Math.PI * 1.2, Math.PI * 1.8);
  } else {
    ctx.arc(cx, cy + 7 * u, 6.5 * u, Math.PI * 0.15, Math.PI * 0.85);
  }
  ctx.stroke();

  // Sparkle burst — fires once on return. sparkleT ∈ [0,1], where 0 is
  // the moment the sprite arrives home and 1 is end of burst. Five little
  // cross-shaped sparkles orbit outward and fade.
  if (sparkleT != null && sparkleT >= 0 && sparkleT < 1) {
    const s = 1 - sparkleT;
    ctx.strokeStyle = hexAlpha(accent.accent, 0.9 * s);
    ctx.lineWidth = 1.6 * u;
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + sparkleT * Math.PI * 0.6;
      const d = (22 + 18 * sparkleT) * u;
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d * 0.8 - 4 * u * sparkleT;
      const r = 2.4 * u * s;
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
      ctx.stroke();
    }
  }

  // Label — drawn last so nothing overlaps it. Shadow-then-fill for
  // legibility against bright holograms.
  if (label) {
    const shown = (String(label).length > 22
      ? String(label).slice(0, 21) + '…'
      : String(label));
    ctx.font = `600 ${13 * u}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(4, 6, 14, 0.85)';
    ctx.fillText(shown, cx + 1 * u, 30 * u + 1 * u);
    ctx.fillStyle = accent.label;
    ctx.fillText(shown, cx, 30 * u);
  }
}

// Accepts '#rrggbb' or 'rgb(...)' and returns an 'rgba(r,g,b,alpha)' string.
function hexAlpha(hex, alpha) {
  if (!hex) return `rgba(255,255,255,${alpha})`;
  if (hex.startsWith('rgba')) return hex;
  if (hex.startsWith('rgb(')) {
    return hex.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  }
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Awareness event helpers ─────────────────────────────────────────────
// Fires `momo:sprite_*` + `momo:helper_*` CustomEvents at sprite lifecycle
// transitions so Momo (via momo-awareness.js) can look at her helpers.
// Two streams:
//   - helper_appeared/working/landed/gone fire for EVERY sprite.
//   - sprite_carrying/landing/gone fire ONLY for sprites attached to a
//     viz_id (i.e. charts Momo is about to materialise). Kept separate
//     so awareness can react more strongly to chart deliveries than to
//     ambient peeks.
// Fire-once per-phase using _firedHelperX flags on the handle so bursty
// phase flapping (e.g. runOff → loiter → runOff from a setReturnTarget)
// never double-fires the same transition.
function _fireHelperEvent(handle, eventName, phaseFlag) {
  if (handle[phaseFlag]) return;
  handle[phaseFlag] = true;
  // Guard the worldPos read — the sprite may have been disposed between
  // the phase change and this event flush.
  let worldPos = null;
  try {
    if (handle.sprite && handle.sprite.position) {
      const p = handle.sprite.position;
      worldPos = { x: p.x, y: p.y, z: p.z };
    }
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        kind: handle.kind,
        name: handle.name || null,
        hasViz: !!handle.vizId,
        handle,
        worldPos,
      },
    }));
  } catch {}
}

function _fireGoneEvent(handle, eventName, phaseFlag) {
  if (handle[phaseFlag]) return;
  handle[phaseFlag] = true;
  try {
    window.dispatchEvent(new CustomEvent(eventName, {
      detail: {
        kind: handle.kind,
        name: handle.name || null,
        handle,
        // `sad` lets downstream (momo-awareness) pick reactConcerned vs.
        // a plain release when this sprite is gone because it failed.
        sad: handle.phase === 'fail',
      },
    }));
  } catch {}
}

// ── Sprite handle ───────────────────────────────────────────────────────
// One per active sprite. Owns the THREE.Sprite, the canvas, a little FSM
// (idle → runOff → loiter → (returnWith|fail) → fading → dead) and the
// per-frame animation. Lives as long as the SpriteLayer keeps it; it's
// reaped when phase === 'dead'.
class SpriteHandle {
  constructor(layer, { kind, label, vizId, name }) {
    this.layer = layer;
    this.kind = layer.palette.kinds[kind] ? kind : 'tool_call';
    this.label = String(label || '').slice(0, 22);
    this.resultLabel = null;
    // Optional identity fields. `vizId` gates the chart-specific event
    // stream (sprite_*); `name` is a human handle for debugging/awareness.
    this.vizId = vizId || null;
    this.name = name || null;
    // Fire-once flags for the awareness event streams. Reset nowhere —
    // once a sprite has appeared/worked/landed, it can't un-fire those
    // even if it re-enters an earlier phase.
    this._firedHelperAppeared = false;
    this._firedHelperWorking = false;
    this._firedHelperLanded = false;
    this._firedHelperGone = false;
    this._firedCarrying = false;
    this._firedLanding = false;
    this._firedGone = false;

    // Canvas + texture for this sprite. One canvas per sprite because the
    // label is unique. 256² is a power of two so mipmaps generate cleanly
    // and the sprite stays crisp when viewed at shallow angles or from far.
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = CANVAS_PX;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    try {
      const r = layer.renderer || (typeof window !== 'undefined' && window.__momoRenderer);
      const maxAniso = r && r.capabilities ? r.capabilities.getMaxAnisotropy() : 4;
      this.texture.anisotropy = Math.min(4, maxAniso || 1);
    } catch { this.texture.anisotropy = 1; }

    // Each sprite gets its own material — opacity tweens per-phase and we
    // can't share an opacity uniform across sprites that are out of sync.
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.scale.set(SPRITE_SCALE, SPRITE_SCALE, 1);

    // Pick a station on the orbit shell. Radial angle is random around the
    // avatar; height/radius are uniform within the torus band. Full 3D —
    // sprites end up on ALL sides of the avatar so orbiting the camera
    // reveals activity everywhere rather than a front-facing cluster.
    const avatarPos = layer.avatarPos;
    const theta = Math.random() * Math.PI * 2;
    const radius = lerp(ORBIT_RADIUS_MIN, ORBIT_RADIUS_MAX, Math.random());
    const y = lerp(ORBIT_Y_MIN, ORBIT_Y_MAX, Math.random());
    this.station = new THREE.Vector3(
      avatarPos.x + Math.cos(theta) * radius,
      avatarPos.y + y,
      avatarPos.z + Math.sin(theta) * radius
    );
    // Spawn point — 3D distributed so sprites emerge from above/below/around
    // the avatar instead of always popping out of the chest. Distribution:
    //   70% front-band  — the original (+0.28, +0.62, +1.0) zone with jitter
    //                     and a ±X mirror so new spawns bounce between the
    //                     avatar's left and right shoulders.
    //   15% above-band  — higher y, closer z (emerge from "over head")
    //   15% below-band  — lower y, closer z (emerge from "under feet")
    // Squad / chart_render sprites that later have an explicit station via
    // runOff(dir) or setReturnTarget bypass this on the return trip — the
    // spawnPoint stays where it was picked so the round trip reads right.
    this.spawnPoint = this._pickSpawnPoint(avatarPos);
    this.sprite.position.copy(this.spawnPoint);

    // FSM — we ALWAYS start in 'spawn' so every sprite gets the cute
    // squash-and-stretch pop-in. If the caller invokes runOff() while still
    // in 'spawn', we queue it via _pendingPhase and transition when the pop
    // finishes.
    this.phase = 'spawn';        // spawn|runOff|loiter|return|bounce|fail|fading|dead
    this.phaseT = 0;
    this._pendingPhase = null;
    this._runFrom = null;
    this._lastPaint = null;
    this.needsRepaint = true;
    this.spawnedAt = performance.now();

    // Small floating bob timing — independent of phase so sprite feels
    // alive even during loiter.
    this.bobPhase = Math.random() * Math.PI * 2;

    layer.scene.add(this.sprite);
    this.paint(); // first paint synchronously so the sprite isn't blank
  }

  // ── Public API ────────────────────────────────────────────────────────
  runOff(direction) {
    // If caller supplies a direction vector, steer the station along it.
    if (direction && direction.isVector3) {
      const d = direction.clone().normalize();
      const r = lerp(ORBIT_RADIUS_MIN, ORBIT_RADIUS_MAX, 0.5);
      this.station.set(
        this.layer.avatarPos.x + d.x * r,
        this.layer.avatarPos.y + d.y * r,
        this.layer.avatarPos.z + d.z * r
      );
    }
    // Queue the run if we're still popping in, so the squash animation
    // isn't cut off. Otherwise start immediately.
    if (this.phase === 'spawn') {
      this._pendingPhase = 'runOff';
    } else {
      this._runFrom = this.sprite.position.clone();
      this.phase = 'runOff';
      this.phaseT = 0;
    }
    return this;
  }

  returnWith(resultLabel) {
    if (this.phase === 'dead' || this.phase === 'fading') return this;
    this.resultLabel = String(resultLabel || '').slice(0, 22);
    // Short label swap — sprite carries its result home.
    this.label = this.resultLabel || this.label;
    this.needsRepaint = true;
    // Enter return no matter where we currently are.
    this.phase = 'return';
    this.phaseT = 0;
    return this;
  }

  fail(reason) {
    if (this.phase === 'dead' || this.phase === 'fading') return this;
    this.label = reason ? String(reason).slice(0, 22) : this.label;
    this.needsRepaint = true;
    this.phase = 'fail';
    this.phaseT = 0;
    return this;
  }

  dispose() {
    if (this.phase === 'dead') return;
    // External dispose (coalescing, scene swap) should still notify
    // awareness so Momo stops tracking this sprite; normal fade-end also
    // hits this path because _teardown runs with phase already 'dead'.
    _fireGoneEvent(this, 'momo:helper_gone', '_firedHelperGone');
    if (this.vizId) _fireGoneEvent(this, 'momo:sprite_gone', '_firedGone');
    this.phase = 'dead';
    this._teardown();
  }

  // ── Internals ─────────────────────────────────────────────────────────
  paint(extra = {}) {
    paintSprite(this.ctx, {
      palette: this.layer.palette,
      kind: this.kind,
      label: this.label,
      sad: !!extra.sad,
      blink: extra.blink || 0,
      sparkleT: extra.sparkleT,
    });
    this.texture.needsUpdate = true;
    this.needsRepaint = false;
  }

  // Choose a spawn point in one of three bands (front/above/below) so
  // sprites emerge from all sides of the avatar over time. The front band
  // keeps the original bilateral shoulder mirror so consecutive spawns
  // don't cluster in the same spot.
  _pickSpawnPoint(avatarPos) {
    const roll = Math.random();
    // Jitter ranges inside each band. Small relative to body scale so the
    // sprite still clearly reads as "from the avatar" rather than floating
    // in at an arbitrary point.
    const jitter = (amt) => (Math.random() * 2 - 1) * amt;
    if (roll < 0.15) {
      // Above — higher y, closer z. Random theta across the horizontal ring
      // keeps it varied across calls.
      const theta = Math.random() * Math.PI * 2;
      const r = 0.6 + Math.random() * 0.4;
      return new THREE.Vector3(
        avatarPos.x + Math.sin(theta) * r * 0.4 + jitter(0.08),
        avatarPos.y + 1.5 + jitter(0.12),
        avatarPos.z + Math.cos(theta) * r * 0.4 + jitter(0.08)
      );
    }
    if (roll < 0.30) {
      // Below — lower y, closer z. Same small-radius horizontal spread.
      const theta = Math.random() * Math.PI * 2;
      const r = 0.5 + Math.random() * 0.4;
      return new THREE.Vector3(
        avatarPos.x + Math.sin(theta) * r * 0.4 + jitter(0.08),
        avatarPos.y - 0.7 + jitter(0.10),
        avatarPos.z + Math.cos(theta) * r * 0.4 + jitter(0.08)
      );
    }
    // Front band — the classic shoulder pop-out. ±X mirror per spawn so
    // consecutive front spawns alternate left/right shoulder.
    const mirror = Math.random() < 0.5 ? -1 : 1;
    return new THREE.Vector3(
      avatarPos.x + mirror * (0.28 + jitter(0.10)),
      avatarPos.y + 0.62 + jitter(0.14),
      avatarPos.z + 1.00 + jitter(0.18)
    );
  }

  _teardown() {
    try { this.layer.scene.remove(this.sprite); } catch {}
    try { this.material.dispose(); } catch {}
    try { this.texture.dispose(); } catch {}
  }

  update(t, dt) {
    if (this.phase === 'dead') return;

    // Phase timers — ms-based so animation is framerate-independent.
    this.phaseT += dt * 1000;

    // ── Awareness events ────────────────────────────────────────────
    // Fire the helper_* + (for viz-carrying sprites) sprite_* events at
    // each first entry into a phase so Momo's gaze knows when to look at
    // us. Ordered cheapest-check first; fire-once flags prevent re-fires.
    // We read sprite.position inside _fireHelperEvent to give awareness a
    // fresh worldPos snapshot at the moment the event is dispatched.
    // helper_appeared fires on the first non-spawn phase (runOff or loiter)
    // so callers that don't chain .runOff() still announce themselves.
    if (this.phase !== 'spawn' && !this._firedHelperAppeared) {
      _fireHelperEvent(this, 'momo:helper_appeared', '_firedHelperAppeared');
      if (this.vizId) _fireHelperEvent(this, 'momo:sprite_carrying', '_firedCarrying');
    }
    if (this.phase === 'loiter' && !this._firedHelperWorking) {
      _fireHelperEvent(this, 'momo:helper_working', '_firedHelperWorking');
    } else if (this.phase === 'bounce' && !this._firedHelperLanded) {
      _fireHelperEvent(this, 'momo:helper_landed', '_firedHelperLanded');
      if (this.vizId) _fireHelperEvent(this, 'momo:sprite_landing', '_firedLanding');
    } else if ((this.phase === 'fading' || this.phase === 'fail') && !this._firedHelperGone) {
      _fireGoneEvent(this, 'momo:helper_gone', '_firedHelperGone');
      if (this.vizId) _fireGoneEvent(this, 'momo:sprite_gone', '_firedGone');
    }

    // Vertical bob overlay — small sine, applied on top of whatever position
    // the phase sets. Disabled during spawn pop so the squash reads cleanly.
    const allowBob = this.phase !== 'spawn' && this.phase !== 'fail';
    const bob = allowBob ? Math.sin(t * 2.4 + this.bobPhase) * 0.04 : 0;

    // Smooth blink: bell curve across BLINK_DUR_S, centred partway into
    // each BLINK_CYCLE_S window. Produces 0→1→0 eye-squish instead of a
    // binary pop. Only active when the sprite is visible & settled.
    const blinkPosS = ((t + this.bobPhase * 0.3) % BLINK_CYCLE_S);
    const blinkValue = blinkPosS < BLINK_DUR_S
      ? Math.sin((blinkPosS / BLINK_DUR_S) * Math.PI)
      : 0;

    let basePos = null;
    let opacity = 0;
    let scale = { x: 1, y: 1 };
    const paint = { blink: 0 };

    switch (this.phase) {
      case 'spawn': {
        // Pop-in squash-and-stretch. Over the first 55% of the phase the
        // sprite fades in and stretches slightly tall; then it settles.
        const k = clamp(this.phaseT / SPAWN_POP_MS, 0, 1);
        basePos = this.spawnPoint.clone();
        opacity = easeOutCubic(Math.min(1, k * 1.5));
        if (k < 0.45) {
          const kk = k / 0.45;
          scale.x = lerp(0.55, 1.12, easeOutCubic(kk));
          scale.y = lerp(0.35, 1.20, easeOutCubic(kk));
        } else {
          const kk = (k - 0.45) / 0.55;
          scale.x = lerp(1.12, 1.00, easeInOutCubic(kk));
          scale.y = lerp(1.20, 1.00, easeInOutCubic(kk));
        }
        if (k >= 1) {
          this.phase = this._pendingPhase || 'loiter';
          this.phaseT = 0;
          this._pendingPhase = null;
          // If runOff was queued, re-anchor for the run.
          if (this.phase === 'runOff') this._runFrom = this.spawnPoint.clone();
        }
        break;
      }
      case 'runOff': {
        const k = clamp(this.phaseT / RUN_OFF_MS, 0, 1);
        const eased = easeInOutCubic(k);
        const from = this._runFrom || this.spawnPoint;
        basePos = from.clone().lerp(this.station, eased);
        opacity = 1;
        // Subtle lean-forward stretch while travelling, settle on arrival.
        if (k < 0.3) {
          scale.x = lerp(1.00, 0.92, k / 0.3);
          scale.y = lerp(1.00, 1.08, k / 0.3);
        } else if (k < 0.85) {
          scale.x = 0.94; scale.y = 1.06;
        } else {
          const kk = (k - 0.85) / 0.15;
          scale.x = lerp(0.94, 1.00, kk);
          scale.y = lerp(1.06, 1.00, kk);
        }
        paint.blink = blinkValue;
        if (k >= 1) { this.phase = 'loiter'; this.phaseT = 0; }
        break;
      }
      case 'loiter': {
        const driftX = Math.cos(t * 0.7 + this.bobPhase) * 0.1;
        const driftZ = Math.sin(t * 0.7 + this.bobPhase) * 0.1;
        basePos = this.station.clone().add(new THREE.Vector3(driftX, 0, driftZ));
        opacity = 1;
        paint.blink = blinkValue;
        // Safety — if the caller never calls returnWith/fail, self-despawn
        // after 30s so we don't leak.
        if (this.phaseT > 30_000) {
          this.phase = 'fading'; this.phaseT = 0;
        }
        break;
      }
      case 'return': {
        const k = clamp(this.phaseT / RETURN_MS, 0, 1);
        const eased = easeInOutCubic(k);
        basePos = this.station.clone().lerp(this.spawnPoint, eased);
        opacity = 1;
        paint.blink = blinkValue;
        if (k >= 1) { this.phase = 'bounce'; this.phaseT = 0; this.needsRepaint = true; }
        break;
      }
      case 'bounce': {
        const k = clamp(this.phaseT / BOUNCE_MS, 0, 1);
        basePos = this.spawnPoint.clone();
        basePos.y += bounceEnvelope(k) * 0.34;
        opacity = 1;
        // Landing squash-stretch
        if (k < 0.18) {
          scale.x = lerp(1.15, 1.00, k / 0.18);
          scale.y = lerp(0.88, 1.00, k / 0.18);
        } else if (k < 0.45) {
          const kk = (k - 0.18) / 0.27;
          scale.x = lerp(1.00, 0.96, kk);
          scale.y = lerp(1.00, 1.08, kk);
        } else {
          const kk = (k - 0.45) / 0.55;
          scale.x = lerp(0.96, 1.00, kk);
          scale.y = lerp(1.08, 1.00, kk);
        }
        // Sparkle fires during the first SPARKLE_MS of the bounce.
        if (this.phaseT < SPARKLE_MS) {
          paint.sparkleT = this.phaseT / SPARKLE_MS;
        }
        paint.blink = blinkValue;
        if (this.phaseT >= BOUNCE_MS + HOLD_MS) {
          this.phase = 'fading'; this.phaseT = 0;
        }
        break;
      }
      case 'fail': {
        // Gentler shake (smaller amplitude, lower freq) + sad face. No red
        // flash — just a soft colour shift + drooped brows done in the
        // painter when `sad: true`.
        const k = clamp(this.phaseT / FAIL_SHAKE_MS, 0, 1);
        const shake = Math.sin(this.phaseT * 0.024) * 0.035 * (1 - k);
        basePos = this.station.clone();
        basePos.x += shake;
        opacity = 1 - k * 0.15;
        scale.x = 1.0; scale.y = lerp(1.0, 0.94, k); // slight droop
        paint.sad = true;
        paint.blink = blinkValue * 0.4;
        this.needsRepaint = true;
        if (k >= 1) { this.phase = 'fading'; this.phaseT = 0; }
        break;
      }
      case 'fading': {
        const k = clamp(this.phaseT / FADE_OUT_MS, 0, 1);
        basePos = this.sprite.position.clone();
        opacity = 0.85 * (1 - easeOutCubic(k));
        scale.x = scale.y = 1 + 0.18 * k;
        if (k >= 1) {
          this.phase = 'dead';
          this._teardown();
          return;
        }
        break;
      }
      default: { // idle
        basePos = this.sprite.position.clone();
        opacity = 0;
      }
    }

    if (basePos) {
      this.sprite.position.copy(basePos);
      this.sprite.position.y += bob;
    }
    this.material.opacity = opacity;
    const sx = SPRITE_SCALE * scale.x;
    const sy = SPRITE_SCALE * scale.y;
    this.sprite.scale.set(sx, sy, 1);

    // Repaint gating: always repaint on explicit needsRepaint; otherwise
    // only repaint when a visually-meaningful value has changed since the
    // last paint. Keeps canvas work down to a handful of frames per blink
    // rather than every frame.
    const prev = this._lastPaint || {};
    const curSad = !!paint.sad;
    const blinkDelta = Math.abs((paint.blink || 0) - (prev.blink || 0));
    const sparkleDelta = Math.abs((paint.sparkleT ?? -1) - (prev.sparkleT ?? -1));
    const sparkleActive = paint.sparkleT != null;
    const sadChanged = curSad !== !!prev.sad;

    if (
      this.needsRepaint
      || sadChanged
      || blinkDelta > 0.06
      || (sparkleActive && sparkleDelta > 0.04)
    ) {
      this.paint(paint);
      this._lastPaint = {
        blink: paint.blink || 0,
        sparkleT: paint.sparkleT,
        sad: curSad,
      };
    }
  }
}

// ── SpriteLayer ─────────────────────────────────────────────────────────
export class SpriteLayer {
  constructor(scene, camera, config = {}) {
    if (!scene) throw new Error('[agent-sprites] scene required');
    this.scene = scene;
    this.camera = camera || null;
    this.maxConcurrent = Number.isFinite(config.maxConcurrent)
      ? config.maxConcurrent : DEFAULT_MAX;

    // Merge palette overrides on top of defaults. Per-kind accents can be
    // supplied as partial objects — we keep defaults for any absent key.
    const pal = config.palette || {};
    const kinds = { ...DEFAULT_PALETTE.kinds, ...(pal.kinds || {}) };
    this.palette = { ...DEFAULT_PALETTE, ...pal, kinds };

    // Avatar position the sprites orbit around. Defaults to origin (where
    // createAvatar() parks its root group) which works for every holo page.
    const ap = config.avatarPos || { x: 0, y: 0, z: 0 };
    this.avatarPos = new THREE.Vector3(ap.x || 0, ap.y || 0, ap.z || 0);

    this.sprites = new Set();
  }

  spawn({ kind = 'tool_call', label = '', vizId = null, name = null } = {}) {
    // Coalesce — if we're over the cap, kill the oldest loiter/runOff
    // sprite so the new one has a slot. See class comment for rationale.
    if (this.sprites.size >= this.maxConcurrent) {
      let victim = null;
      let oldest = Infinity;
      for (const s of this.sprites) {
        if (s.phase === 'fading' || s.phase === 'dead') continue;
        if (s.spawnedAt < oldest) { oldest = s.spawnedAt; victim = s; }
      }
      if (victim) victim.dispose();
    }
    const h = new SpriteHandle(this, { kind, label, vizId, name });
    this.sprites.add(h);
    return h;
  }

  setAvatarPos(x, y, z) {
    this.avatarPos.set(x, y, z);
  }

  update(t, dt) {
    for (const s of this.sprites) {
      s.update(t, dt);
      if (s.phase === 'dead') this.sprites.delete(s);
    }
  }

  dispose() {
    for (const s of this.sprites) s.dispose();
    this.sprites.clear();
  }
}

// ── Integration helpers ─────────────────────────────────────────────────
// Convenience: translate a `/tool` call's `name` argument to a sprite kind
// and human label. Exported so the host page (avatar.js/holo_*.html) can
// use the same mapping when wrapping fetch.
export function kindForTool(toolName) {
  switch (toolName) {
    case 'hq_query':            return 'hq_query';
    case 'web_search':          return 'web_search';
    case 'render_viz':          return 'chart_render';
    case 'highlight_viz':       return 'chart_render';
    case 'dismiss_viz':         return 'chart_render';
    case 'spawn_research_agent':return 'research_agent';
    // GitHub
    case 'list_prs':
    case 'get_pr':
    case 'list_ci_runs':
    case 'list_repo_activity':
    case 'list_issues':
    case 'list_gh_notifications':
      return 'github_read';
    case 'post_pr_comment':
    case 'merge_pr':
    case 'close_issue':
      return 'github_write';
    case 'spawn_review_agent':
      return 'review_agent';
    default:                    return 'tool_call';
  }
}

// Specialist roster mirrors src/agents/registry.js. Each tool maps to the
// agent whose role it fits — so sprites show a recognisable identity
// ("Atlas", "Prism", "Lumen"…) instead of raw tool names or query text.
export function agentNameForTool(toolName) {
  switch (toolName) {
    case 'web_search':
    case 'spawn_research_agent':
      return 'Atlas';      // Research · Web
    case 'hq_query':
    case 'orders':
    case 'customers':
    case 'products':
    case 'ads':
    case 'profile':
    case 'snapshot':
      return 'Prism';      // Data · Analysis
    case 'render_viz':
    case 'highlight_viz':
    case 'dismiss_viz':
    case 'viz':
      return 'Lumen';      // Visual · Charts
    case 'gmail_send':
    case 'gmail_read':
    case 'calendar':
    case 'tasks':
      return 'Quill';      // Writing · Comms
    case 'spawn_agent_task':
    case 'list_agent_tasks':
    case 'agent':
      return 'Aurora';     // Orchestrator
    // GitHub roles — Cinder owns code (review / write), Atlas owns
    // discovery / browsing, Prism owns repo-activity analytics.
    case 'list_prs':
    case 'get_pr':
    case 'list_ci_runs':
    case 'list_issues':
      return 'Cinder';     // Code
    case 'list_repo_activity':
    case 'list_gh_notifications':
      return 'Atlas';      // Research-y / scouting
    case 'post_pr_comment':
    case 'merge_pr':
    case 'close_issue':
      return 'Cinder';     // Code (write)
    case 'spawn_review_agent':
      return 'Cinder';     // Code review
    case 'approve':
    case 'notify':
    case 'status':
    case 'timer':
    case 'now_playing':
      return 'Pulse';      // Ops · Monitoring
    default:
      return 'Cinder';     // Code · Refactor (fallback)
  }
}

export function labelForTool(toolName, args) {
  // Sprite caption — show the specialist agent's name AND the underlying
  // tool name so the user can recognise both the persona (Atlas / Prism /
  // Lumen / …) and the concrete capability being invoked.
  const agent = agentNameForTool(toolName);
  if (!toolName) return agent;
  return `${agent} · ${toolName}`;
}

export function queryTextForTool(toolName, args) {
  try {
    const a = args || {};
    switch (toolName) {
      case 'web_search':
        return truncate(a.query || 'web search', 40);
      case 'hq_query':
        return truncate(a.question || a.query || 'hq query', 40);
      case 'render_viz':
        return truncate(a.intent || 'render chart', 40);
      case 'spawn_research_agent':
        return truncate(a.task || 'research', 40);
      case 'list_prs':
        return truncate(`PRs · ${a.state || 'open'}${a.repo ? ' · ' + a.repo : ''}`, 40);
      case 'get_pr':
        return truncate(`PR ${a.repo || ''}#${a.number || '?'}`, 40);
      case 'list_ci_runs':
        return truncate(`CI · ${a.status || 'all'}${a.repo ? ' · ' + a.repo : ''}`, 40);
      case 'list_issues':
        return truncate(`Issues · ${a.state || 'open'}${a.repo ? ' · ' + a.repo : ''}`, 40);
      case 'list_repo_activity':
        return truncate(`Activity${a.repo ? ' · ' + a.repo : ''}`, 40);
      case 'list_gh_notifications':
        return truncate(`Notifications${a.reason ? ' · ' + a.reason : ''}`, 40);
      case 'post_pr_comment':
        return truncate(`Comment ${a.repo || ''}#${a.number || '?'}`, 40);
      case 'merge_pr':
        return truncate(`Merge ${a.repo || ''}#${a.number || '?'}`, 40);
      case 'close_issue':
        return truncate(`Close ${a.repo || ''}#${a.number || '?'}`, 40);
      case 'spawn_review_agent':
        return truncate(`Review ${a.repo || ''}#${a.number || '?'}`, 40);
      default:
        return truncate(toolName || 'tool', 40);
    }
  } catch {
    return truncate(toolName || 'tool', 40);
  }
}

export function truncate(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ── One-shot installer ──────────────────────────────────────────────────
// Called once from createHologramScene() so every holo page gets the layer
// automatically. Wires up:
//   - a SpriteLayer rendered into the scene
//   - WebSocket subscription to /omo/ws for agent:* events
//   - a fetch() wrapper on `/tool` to make every tool call visible
//
// Idempotent: the first call installs; subsequent calls return the existing
// layer. Safe to call from multiple createHologramScene invocations on the
// same page (e.g. the cylinder's minimal/non-minimal swap).
let _installed = null;
export function installSpriteLayer(scene, camera, opts = {}) {
  // Each new scene gets its own SpriteLayer (sprites are scene children),
  // but the WS + fetch + demo button hookups are global to the page — we
  // re-point them at the newest layer on each install.
  const layer = new SpriteLayer(scene, camera, opts);

  if (_installed) {
    _installed.layer.dispose();
    _installed.layer = layer;
    // If the scene swapped, we still reuse the WS/fetch wrappers which
    // read `_installed.layer` through the closure below.
    return layer;
  }
  _installed = { layer };

  // Expose to window so other modules / console / the parallel narration
  // code can spawn sprites too without re-importing.
  try { window.__momoSprites = _installed; } catch {}

  // ── WebSocket subscription ────────────────────────────────────────────
  // Map agent_id → sprite handle so we can returnWith / fail the correct
  // sprite when a later message references the same id.
  const agentHandles = new Map();

  function handleAgentMessage(msg) {
    // Messages can arrive in two shapes from the server bus:
    //   1. Wrapped by dataCore: { type:'event', event: { source, kind, data } }
    //      where kind includes 'agent:started' / 'agent:complete' /
    //      'agent:error'. The data carries { agent_id, task, findings, error }.
    //   2. Unwrapped (future/direct): { type:'agent:started', agent_id, ... }
    //      Handle both so we're future-proof either way.
    let type, agentId, task, findings, error;

    if (msg?.type === 'event' && msg.event) {
      const e = msg.event;
      const d = e.data || {};
      const k = e.kind || '';
      // Accept both 'agent:started' and short 'started' under an 'agent' source
      if (k === 'agent:started' || (e.source === 'agent' && k === 'started')) {
        type = 'agent:started';
      } else if (k === 'agent:complete' || (e.source === 'agent' && k === 'complete')) {
        type = 'agent:complete';
      } else if (k === 'agent:error' || (e.source === 'agent' && k === 'error')) {
        type = 'agent:error';
      } else {
        return;
      }
      agentId = d.agent_id || d.agentId || d.id;
      task = d.task || d.label;
      findings = d.findings || d.result || d.summary;
      error = d.error || d.reason;
    } else if (typeof msg?.type === 'string' && msg.type.startsWith('agent:')) {
      type = msg.type;
      agentId = msg.agent_id || msg.agentId || msg.id;
      task = msg.task || msg.label;
      findings = msg.findings || msg.result;
      error = msg.error || msg.reason;
    } else {
      return;
    }
    if (!agentId) return;

    const activeLayer = _installed.layer;
    // Re-broadcast the agent event on the window so momo-awareness (and
    // any other non-WS consumer) can react without wiring its own socket.
    // Detail mirrors the squad layer's shape so consumers don't need a
    // second discriminator.
    try {
      window.dispatchEvent(new CustomEvent(type, {
        detail: { agentId, task, findings, error },
      }));
    } catch {}
    if (type === 'agent:started') {
      if (agentHandles.has(agentId)) return; // dedupe duplicate start
      const h = activeLayer.spawn({
        kind: 'research_agent',
        label: 'Atlas',
        name: truncate(task || 'research', 40),
      }).runOff();
      agentHandles.set(agentId, h);
    } else if (type === 'agent:complete') {
      const h = agentHandles.get(agentId);
      if (h) {
        // Keep the agent's name as the label; drop findings into awareness.
        h.returnWith('Atlas');
        agentHandles.delete(agentId);
        // Fire the voice-integration hook so downstream can read it out.
        dispatchAgentUpdate(truncate(findings || 'done', 60));
      }
    } else if (type === 'agent:error') {
      const h = agentHandles.get(agentId);
      if (h) {
        h.fail('Atlas');
        agentHandles.delete(agentId);
      }
    }
  }

  // Long-lived socket with exponential backoff. We don't reuse the
  // agentNarrationWs from holo_cylinder because that's gated on a running
  // session; sprites should work before the mic is connected too.
  let socket = null;
  let retry = 800;
  function connect() {
    if (location.protocol === 'file:') return;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/omo/ws`);
    } catch { scheduleReconnect(); return; }
    socket.addEventListener('open', () => { console.log('[sprites] ws open'); retry = 800; });
    socket.addEventListener('message', (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.type === 'snapshot') return; // historical events shouldn't mount sprites
      handleAgentMessage(msg);
    });
    socket.addEventListener('close', (e) => { console.log(`[sprites] ws closed code=${e?.code ?? '?'}`); socket = null; scheduleReconnect(); });
    socket.addEventListener('error', (e) => { console.warn('[sprites] ws error', e?.message || e); try { socket?.close(); } catch {} });
  }
  function scheduleReconnect() {
    setTimeout(() => { retry = Math.min(retry * 2, 8000); connect(); }, retry);
  }
  connect();

  // ── fetch('/tool', …) wrapper ─────────────────────────────────────────
  // Intercept every browser-side tool POST so the invisible work becomes
  // visible. Because all four holo pages call fetch('/tool', …) inline,
  // wrapping window.fetch globally is the simplest universal hookup and
  // doesn't risk leaking into unrelated pages (the wrapper only acts on
  // /tool requests).
  if (!window.__momoFetchWrapped) {
    window.__momoFetchWrapped = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init) {
      let url = '';
      try { url = typeof input === 'string' ? input : (input?.url || ''); } catch {}
      // Match /tool exactly. (Relative URL — resolved against the page.)
      const isTool = url === '/tool' || url.endsWith('/tool');
      if (!isTool) return origFetch(input, init);

      // Parse body lazily so we can pull name/args for the sprite label.
      let name = null, args = null;
      try {
        const b = init?.body;
        if (typeof b === 'string') {
          const parsed = JSON.parse(b);
          name = parsed?.name; args = parsed?.arguments;
        }
      } catch {}

      const activeLayer = _installed.layer;
      const handle = activeLayer.spawn({
        kind: kindForTool(name),
        label: labelForTool(name, args),
        name: queryTextForTool(name, args),
      }).runOff();

      try {
        const res = await origFetch(input, init);
        // Clone to read body without disturbing the caller. .clone() is
        // cheap and safe; if parsing fails, the response still passes
        // through unmodified.
        let payload = null;
        try { payload = await res.clone().json(); } catch {}
        const result = payload?.result ?? payload;
        if (payload?.error || result?.error) {
          handle.fail(truncate(String(result?.error || payload?.error), 20));
        } else {
          // Attach vizId retroactively for viz-carrying tool calls — the
          // id isn't known at spawn time, only when the server responds.
          // Awareness uses this to gate the stronger sprite_* event stream.
          if (result && result.viz_id) handle.vizId = result.viz_id;
          // Keep the agent name on the sprite even after completion —
          // we drop the result summary into the awareness stream only.
          handle.returnWith(labelForTool(name, args));
          dispatchAgentUpdate(summariseResult(name, result));
        }
        return res;
      } catch (err) {
        handle.fail(truncate(String(err?.message || err), 20));
        throw err;
      }
    };
  }

  return layer;
}

function summariseResult(toolName, result) {
  if (!result || typeof result !== 'object') return truncate(String(result || 'ok'), 20);
  // Heuristic: common summary fields from Momo's data tools.
  const candidates = [
    result.summary, result.count, result.viz_id, result.id,
    result.title, result.name, result.message,
  ];
  for (const c of candidates) {
    if (c != null && c !== '') return truncate(typeof c === 'number' ? String(c) : String(c), 20);
  }
  return toolName ? truncate(`${toolName} ok`, 20) : 'ok';
}

function dispatchAgentUpdate(text) {
  try {
    window.dispatchEvent(new CustomEvent('momo:agent_update', { detail: { text } }));
  } catch {}
}


// A Projectable is anything Momo can materialize inside her volumetric
// frame — a chart, a thinking card, a mini companion agent, a media
// preview. The world (world.js) owns one Projectable at a time (for now);
// every Projectable implements the same small lifecycle so swap-in of a
// new artifact is a new file under projectables/, not a world.js edit.
//
// Lifecycle:
//
//   pending  → enter()  → entering  → (ready ⇒) live  → exit()  → leaving  → dead
//                                      |                                      ^
//                                      └──── highlight(opts) any time ────────┘
//
// Contract — every Projectable exposes:
//   id            string       unique per mount (used for postMessage routing)
//   kind          string       'chart' | 'status' | 'agent' | 'media'
//   sizeName      string       'wide' | 'square' | 'stat'
//   enter(world)  void         attach to parent, start entrance animation
//   tick(t,dt,cam) void        per-frame; drives billboard + opacity state machine
//   exit()        void         start leaving animation; eventually transitions to dead
//   isDead()      bool         world drops references once true
//   highlight?(o) bool         optional: react to "point at this"; returns false if ignored
//   clearHighlight?() void     optional: stop pointing
//
// The world's Choreographer RAF calls tick() every frame and checks isDead()
// after exit() has been requested — no setTimeouts in world code. Each
// Projectable manages its own (t - bornAt) timing internally.

export const PROJECTABLE_STATES = Object.freeze({
  pending:  'pending',
  entering: 'entering',
  live:     'live',
  leaving:  'leaving',
  dead:     'dead',
});

let __nextId = 1;
export function mintProjectableId(kind) {
  const n = __nextId++;
  return `${kind}-${n}`;
}

// Tiny easing helper — enter: cubicOut, exit: quadIn. Keep both available so
// projectables don't reinvent them.
export function cubicOut(t) { return 1 - Math.pow(1 - t, 3); }
export function quadIn(t)   { return t * t; }
export function clamp01(v)  { return v < 0 ? 0 : v > 1 ? 1 : v; }

// Shared pose presets — every Projectable that mounts in avatar-local
// space uses the same coordinate system so multiple kinds line up
// consistently in the hologram column.
//   x: lateral offset (0 = centered in front of Momo)
//   y: height relative to avatar origin (0 ≈ chest, +0.85 ≈ face, -0.9 ≈ hip)
//   z: +forward toward camera; +0.80 clears her torso and lands inside the column
//   tilt: forward tilt of the plane (radians), reads as a projected display
export const POSE = Object.freeze({
  wide:   { x: 0.00, y: 0.20, z: 0.80, tilt: -8 * Math.PI / 180 },
  square: { x: 0.00, y: 0.20, z: 0.80, tilt: -8 * Math.PI / 180 },
  stat:   { x: 0.00, y: 0.85, z: 0.80, tilt: -8 * Math.PI / 180 },
  thought:{ x: 0.00, y: 1.05, z: 0.85, tilt: -6 * Math.PI / 180 },
});

// CSS pixels → world units. 720 CSS-px × CSS3D_SCALE ≈ 2.0 world units,
// which fits inside the hologram column without escaping Momo's frame.
export const CSS3D_SCALE = 0.0028;

// Default panel sizes (CSS pixels) per sizeName.
export const PANEL_PX = Object.freeze({
  wide:    { w: 720, h: 420 },
  square:  { w: 520, h: 520 },
  stat:    { w: 360, h: 220 },
  thought: { w: 320, h: 120 },
});

export function panelWorldSize(sizeName) {
  const px = PANEL_PX[sizeName] || PANEL_PX.wide;
  return { w: px.w * CSS3D_SCALE, h: px.h * CSS3D_SCALE };
}

// Small reduced-motion check that all projectables share. Used to skip
// sine-drive sways and shorten entrance/exit durations.
export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Hologram chrome — the reusable WebGL decoration that frames every
// Projectable. Wireframe bracket cube + drifting scan-line plane + cyan
// platter + projector beam + upward-sparkle emitter + pedestal pulse.
//
// Every Projectable type (chart, status, agent, media) shares this kit
// so the whole hologram speaks with one visual voice — swap the contents
// and the chrome stays the same.
//
// The low-level geometry factories still live in avatar.js (createHologramFrame,
// createScanLinePlane, createChartPlatter) since that file already owns the
// scene's WebGL idioms; this module is the single place that composes those
// pieces for a Projectable, positions them against a shared pose, and drives
// entrance / tick / exit as one unit.

import * as THREE from 'three';
import {
  createHologramFrame,
  createScanLinePlane,
  createChartPlatter,
  createHoloColumn,
  createProjectorRay,
} from './avatar.js';

// Platter local-Y underneath a projectable (avatar-local units).
// -1.75 puts it near Momo's feet given avatar origin ≈ chest-height.
export const PLATTER_Y_LOCAL = -1.75;

// Inflate the frame 5% beyond the panel so the wireframe reads AROUND the
// card, not printed on its edge. Height gets a little more so the top and
// bottom markers clear the title/delta chip.
const FRAME_INFLATE_W = 1.05;
const FRAME_INFLATE_H = 1.08;
const FRAME_DEPTH     = 0.20;

// Scan plane sits 0.02 world units in front of the card so it composites
// over the DOM iframe in the reflector frame instead of z-fighting it.
const SCAN_Z_OFFSET = 0.02;

// Volumetric column geometry — wider and taller than the panel so the
// chart visibly sits INSIDE the column rather than capping it. The
// inflate factors come from visual trial: ~1.35x wider reads as "column
// comfortably encloses the card" without feeling puffy.
const COLUMN_INFLATE_W = 1.35;
const COLUMN_EXTRA_ABOVE = 0.6;   // world units above the card top
const COLUMN_EXTRA_BELOW = 0.4;   // world units below the card bottom

// Anchor point on Momo for the projector ray. Avatar-local ≈ antenna-orb
// position (see createAvatar: orb.position.y = 1.42). We re-declare here
// as a constant so chrome doesn't reach into avatar.userData.orb, whose
// world position is rigged with breathing and tilt animations each frame.
const RAY_ORIGIN_LOCAL = new THREE.Vector3(0, 1.42, 0);

// Mount-time reveal sweep duration — one upward "print" pass through the
// scan plane. Matches the card's iframe-fade envelope so the card is
// readable just after the bar leaves the top edge.
const REVEAL_SWEEP_S = 0.7;

// Chrome fade envelope. Independent of the projectable's own entrance so
// a sluggish iframe load doesn't leave the chrome hanging mid-fade.
const CHROME_FADE_IN  = 0.50;
const CHROME_FADE_OUT = 0.36;

/**
 * Attach the full chrome bundle to a parent Three.Object3D at a world-
 * local pose, sized to the panel.
 *
 * @param {THREE.Object3D} parent   usually the avatar group so chrome
 *                                  inherits Momo's sway, or the scene
 *                                  for a headless/preview context
 * @param {object} pose             { x, y, z, tilt } in parent-local units
 * @param {object} panelWorldSize   { w, h } of the panel in world units
 * @param {object} opts
 *   @prop {object=} sceneCtl       { pulsePedestal } for mount flare
 *   @prop {boolean=} withPlatter   default true; set false for small cards
 *                                  (e.g. thinking state) so we don't stack
 *                                  a platter under a tiny card
 * @returns {{
 *   tick: (t:number) => void,
 *   fadeIn: () => void,
 *   fadeOut: () => void,
 *   setPose: (pose) => void,
 *   dispose: () => void,
 *   group: THREE.Group,
 * }}
 */
export function attachChrome(parent, pose, panelWorldSize, opts = {}) {
  const { sceneCtl, withPlatter = true } = opts;
  const { w: panelW, h: panelH } = panelWorldSize;

  // ── Wireframe bracket cube ──────────────────────────────────────────
  const frame = createHologramFrame({
    width:  panelW * FRAME_INFLATE_W,
    height: panelH * FRAME_INFLATE_H,
    depth:  FRAME_DEPTH,
  });
  frame.group.position.set(pose.x, pose.y, pose.z);
  frame.group.rotation.order = 'YXZ';
  frame.group.rotation.x = pose.tilt;
  parent.add(frame.group);

  // ── Drifting scan-line plane ────────────────────────────────────────
  const scanPlane = createScanLinePlane({ width: panelW, height: panelH });
  scanPlane.mesh.position.set(pose.x, pose.y, pose.z + SCAN_Z_OFFSET);
  scanPlane.mesh.rotation.order = 'YXZ';
  scanPlane.mesh.rotation.x = pose.tilt;
  parent.add(scanPlane.mesh);

  // ── Platter + projector beam + sparkles (optional) ──────────────────
  let platter = null;
  if (withPlatter) {
    const panelLocalY = pose.y - PLATTER_Y_LOCAL;
    platter = createChartPlatter({
      scene: parent,
      panelY: Math.max(0.4, panelLocalY),
    });
    platter.group.position.set(pose.x, PLATTER_Y_LOCAL, pose.z);
  }

  // ── Volumetric hologram column ──────────────────────────────────────
  // Wraps the chart in a translucent glass-tube of light from platter to
  // above the card. Parented to the same parent as the frame so it sways
  // with Momo. Only attached when there's a platter (stat-sized cards
  // that turn off the platter also skip the column — looks weird to have
  // a column with no base).
  let column = null;
  if (withPlatter) {
    const colHeight = (pose.y + panelH / 2 + COLUMN_EXTRA_ABOVE)
                    - (PLATTER_Y_LOCAL - COLUMN_EXTRA_BELOW);
    column = createHoloColumn({
      width:  panelW * COLUMN_INFLATE_W,
      height: colHeight,
    });
    const centerY = (
      (pose.y + panelH / 2 + COLUMN_EXTRA_ABOVE) +
      (PLATTER_Y_LOCAL       - COLUMN_EXTRA_BELOW)
    ) / 2;
    column.group.position.set(pose.x, centerY, pose.z);
    parent.add(column.group);
  }

  // ── Projector ray from Momo's orb to the chart top ──────────────────
  // Sells the connection: the chart isn't floating, she's actively
  // projecting it. Parented to the same parent (the avatar group) so
  // the ray breathes with her and retargets only if the pose changes.
  const rayTo = new THREE.Vector3(pose.x, pose.y + panelH / 2, pose.z);
  const ray = createProjectorRay({
    from: RAY_ORIGIN_LOCAL.clone(),
    to:   rayTo,
  });
  parent.add(ray.group);

  // ── Pedestal flare on mount ─────────────────────────────────────────
  if (sceneCtl && typeof sceneCtl.pulsePedestal === 'function') {
    sceneCtl.pulsePedestal();
  }

  // ── Chrome-level fade envelope ──────────────────────────────────────
  // Owned by us (not the projectable) so the wireframe + scan plane fade
  // in/out in sync even if the projectable's content (iframe, DOM card)
  // has its own opacity path.
  let phase = 'entering';  // entering | live | leaving | dead
  let phaseStart = performance.now() / 1000;
  let currentOpacity = 0;

  function fadeIn() {
    phase = 'entering';
    phaseStart = performance.now() / 1000;
  }
  function fadeOut() {
    if (phase === 'dead' || phase === 'leaving') return;
    phase = 'leaving';
    phaseStart = performance.now() / 1000;
    if (platter) platter.fadeOut();
    // Reverse pulse on dismiss flares the pedestal as a final flash.
    if (sceneCtl && typeof sceneCtl.pulsePedestal === 'function') {
      sceneCtl.pulsePedestal();
    }
  }

  // Start entering immediately so callers don't have to remember to call
  // fadeIn(); platter does the same.
  if (platter) platter.fadeIn();

  // Reveal sweep clock — starts when the chrome begins entering, runs once
  // up through the scan plane, then settles at 1 (no further sweep). Uses
  // performance.now() rather than the host's clock.elapsedTime `t` because
  // phaseStart (and the rest of the fade envelope) is on that epoch too.
  const revealStart = performance.now() / 1000;

  function tick(t) {
    // Chrome opacity envelope.
    const age = t - phaseStart;
    if (phase === 'entering') {
      const k = Math.min(1, age / CHROME_FADE_IN);
      currentOpacity = 1 - Math.pow(1 - k, 3);  // cubicOut
      if (k >= 1) { phase = 'live'; currentOpacity = 1; }
    } else if (phase === 'leaving') {
      const k = Math.min(1, age / CHROME_FADE_OUT);
      currentOpacity = 1 - k * k;               // quadIn out-fade
      if (k >= 1) { phase = 'dead'; currentOpacity = 0; }
    } else if (phase === 'live') {
      currentOpacity = 1;
    }

    frame.setOpacity(currentOpacity);
    scanPlane.setOpacity(currentOpacity);
    scanPlane.setTime(t);

    // Mount-time print sweep — uv.y goes 0→1 over REVEAL_SWEEP_S, clamped.
    // Compute on performance.now() epoch so the sweep matches revealStart
    // (the host passes clock.elapsedTime as `t`, which is 0-relative).
    const nowS = performance.now() / 1000;
    const revealT = Math.min(1, (nowS - revealStart) / REVEAL_SWEEP_S);
    scanPlane.setReveal(revealT);

    if (platter) platter.update(t, 1 / 60);   // platter uses dt; pass a stable fallback
    if (column)  { column.setTime(t);  column.setOpacity(currentOpacity * 0.95); }
    if (ray)     { ray.setTime(t);     ray.setOpacity(currentOpacity);           }
  }

  function setPose(nextPose) {
    pose = nextPose;
    frame.group.position.set(pose.x, pose.y, pose.z);
    frame.group.rotation.x = pose.tilt;
    scanPlane.mesh.position.set(pose.x, pose.y, pose.z + SCAN_Z_OFFSET);
    scanPlane.mesh.rotation.x = pose.tilt;
    if (platter) {
      platter.group.position.set(pose.x, PLATTER_Y_LOCAL, pose.z);
    }
    if (column) {
      const centerY = (
        (pose.y + panelH / 2 + COLUMN_EXTRA_ABOVE) +
        (PLATTER_Y_LOCAL       - COLUMN_EXTRA_BELOW)
      ) / 2;
      column.group.position.set(pose.x, centerY, pose.z);
    }
    if (ray) {
      ray.retarget(RAY_ORIGIN_LOCAL, new THREE.Vector3(
        pose.x, pose.y + panelH / 2, pose.z
      ));
    }
  }

  function mirrorYaw(yaw) {
    // Called by the projectable each tick so the chrome billboards in sync
    // with the panel's yaw. We don't do our own billboard calculation —
    // the projectable owns the yaw so chrome and panel can't drift apart.
    frame.group.rotation.set(pose.tilt, yaw, 0);
    scanPlane.mesh.rotation.set(pose.tilt, yaw, 0);
    // Column and ray are positioned in parent-local space and already sway
    // with the avatar via the parent transform — don't spin them on yaw,
    // that'd double-apply rotation and read as "spinning glass tube."
  }

  function dispose() {
    phase = 'dead';
    try { frame.dispose(); } catch (_) {}
    try { scanPlane.dispose(); } catch (_) {}
    if (platter) try { platter.dispose(); } catch (_) {}
    if (column)  try { column.dispose();  } catch (_) {}
    if (ray)     try { ray.dispose();     } catch (_) {}
  }

  return {
    tick,
    fadeIn,
    fadeOut,
    setPose,
    mirrorYaw,
    dispose,
    isDead: () => phase === 'dead',
    get opacity() { return currentOpacity; },
  };
}

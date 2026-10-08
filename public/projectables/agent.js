// AgentProjectable — a companion sub-agent materializes beside Momo as a
// small holographic figure of its own. Same lifecycle as every other
// Projectable, but the mount target is a WebGL mesh (not a CSS3DObject),
// and the orbit slot lives in scene-space rather than avatar-local so
// the companion feels like a peer, not a HUD element Momo carries around.
//
// The figure itself is a stylised "crystal body" — an emissive
// octahedron for the core, a smaller upward antenna bead, a soft halo
// sprite. Not a full Momo-replica; companions should feel kindred but
// distinctly smaller / simpler. Role colour: analyst=cyan, courier=pink,
// scribe=white-ice, generic=soft cyan.
//
// For the voice-and-mouth analyser the vision asks for: the server-side
// runtime for sub-agents isn't wired yet (each would need its own
// Gemini Live session). Today the companion reads the parent session's
// `avatar.userData.mouthDrive` as a placeholder so the visual beat
// still lands when Momo speaks on the companion's behalf. When the
// dedicated sub-agent channel arrives, swap `driveFromParent` for a
// real analyser.

import * as THREE from 'three';
import { mintProjectableId, prefersReducedMotion } from './base.js';

// Role palette — matches the main hologram cyan/pink/ice language so
// companions look like siblings, not strangers.
const ROLE_PALETTE = {
  analyst: { core: 0x00e5ff, halo: 0x6ff2ff, emit: 1.35 },
  courier: { core: 0xff66b3, halo: 0xff99cc, emit: 1.25 },
  scribe:  { core: 0xe8f9ff, halo: 0xffffff, emit: 1.15 },
  generic: { core: 0x00e5ff, halo: 0xaeefff, emit: 1.20 },
};

// Orbit slots relative to Momo (avatar origin). Companions sit out in
// scene-space at avatar shoulder height, offset laterally by ±2 world
// units so the camera frames both together.
const SLOT_POSITION = {
  left:  new THREE.Vector3(-2.2, 0.2, 0.6),
  right: new THREE.Vector3( 2.2, 0.2, 0.6),
};

const ENTER_DUR = 0.72;   // seconds
const EXIT_DUR  = 0.48;
const IDLE_BOB_HZ = 0.9;
const IDLE_BOB_AMP = 0.08;

export function createAgentProjectable({
  name = 'Companion',
  role = 'generic',
  slot = 'right',
  greeting = null,
  onDismiss,
} = {}) {
  const id = mintProjectableId('agent');
  const palette = ROLE_PALETTE[role] || ROLE_PALETTE.generic;
  const slotPos = (SLOT_POSITION[slot] || SLOT_POSITION.right).clone();
  // Companions enter from off-stage (further out on X, lower Y) and tween
  // to the slot position — reads as "swooping in from just off the side".
  const offscreenPos = slotPos.clone();
  offscreenPos.x *= 1.6;
  offscreenPos.y -= 0.6;

  // ── Mesh group ─────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.position.copy(offscreenPos);
  group.userData.projectableId = id;

  // Core: stylised octahedron, emissive. Scale ~0.32 of Momo's body.
  const coreGeom = new THREE.OctahedronGeometry(0.42, 0);
  const coreMat = new THREE.MeshPhysicalMaterial({
    color: palette.core,
    emissive: palette.core,
    emissiveIntensity: palette.emit,
    transparent: true,
    opacity: 0,                    // fades in via tick
    roughness: 0.2,
    metalness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.15,
  });
  const core = new THREE.Mesh(coreGeom, coreMat);
  group.add(core);

  // Halo sprite behind the core — same look as Momo's orb glow.
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = haloCanvas.height = 128;
  const hctx = haloCanvas.getContext('2d');
  const grad = hctx.createRadialGradient(64, 64, 6, 64, 64, 60);
  const haloHex = '#' + palette.halo.toString(16).padStart(6, '0');
  grad.addColorStop(0, haloHex);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  hctx.fillStyle = grad;
  hctx.fillRect(0, 0, 128, 128);
  const haloTex = new THREE.CanvasTexture(haloCanvas);
  haloTex.colorSpace = THREE.SRGBColorSpace;
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex,
    color: palette.halo,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(1.6, 1.6, 1);
  halo.position.z = -0.05;
  group.add(halo);

  // Antenna bead — little dot above the core that pulses when the
  // companion is speaking, same vocabulary as Momo's antenna.
  const beadMat = new THREE.MeshBasicMaterial({
    color: palette.halo,
    transparent: true,
    opacity: 0,
  });
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), beadMat);
  bead.position.set(0, 0.7, 0);
  group.add(bead);

  // Floor ring marker at the companion's feet — mirrors Momo's pedestal
  // ring so the pair visually share a stage floor.
  const ringMat = new THREE.MeshBasicMaterial({
    color: palette.core,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const ringGeom = new THREE.RingGeometry(0.5, 0.55, 64);
  ringGeom.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.y = -0.9;
  group.add(ring);

  // Name badge — CSS3DObject floating just under the companion core.
  // Reuses the status-card type vocabulary so labels look uniform across
  // the hologram.
  let nameSprite = null;
  if (name) {
    nameSprite = makeNameSprite(name, palette.core);
    nameSprite.position.set(0, -0.55, 0.01);
    group.add(nameSprite);
  }

  // ── State ─────────────────────────────────────────────────────────────
  let phase = 'pending';
  let phaseStart = 0;
  let parentObj = null;
  const avatarTarget = { x: 0, y: 0, z: 0 };
  let analyserSource = null;       // wired in enter()

  function enter({ scene, avatarObj }) {
    phase = 'entering';
    phaseStart = performance.now() / 1000;
    // Companions live in scene-space (they orbit Momo; they don't ride
    // her sway). But they still inherit the scene's lighting setup.
    parentObj = scene;
    scene.add(group);
    // Placeholder analyser source — read the parent's mouthDrive until
    // sub-agents get their own Gemini Live channel. When the real one
    // arrives, pass it in via setAnalyserSource().
    analyserSource = avatarObj ? () => avatarObj.userData?.mouthDrive : null;
  }

  function tick(t, dt, camera) {
    if (!parentObj) return;

    // Phase-driven opacity + position envelope.
    const age = t - phaseStart;
    if (phase === 'entering') {
      const k = Math.min(1, age / ENTER_DUR);
      const eased = 1 - Math.pow(1 - k, 3);   // cubicOut
      coreMat.opacity = 0.92 * eased;
      haloMat.opacity = 0.9 * eased;
      beadMat.opacity = 0.95 * eased;
      ringMat.opacity = 0.75 * eased;
      if (nameSprite) nameSprite.material.opacity = 0.9 * eased;
      group.position.lerpVectors(offscreenPos, slotPos, eased);
      if (k >= 1) phase = 'live';
    } else if (phase === 'leaving') {
      const k = Math.min(1, age / EXIT_DUR);
      const eased = k * k;                    // quadIn
      const alpha = 1 - eased;
      coreMat.opacity = 0.92 * alpha;
      haloMat.opacity = 0.9 * alpha;
      beadMat.opacity = 0.95 * alpha;
      ringMat.opacity = 0.75 * alpha;
      if (nameSprite) nameSprite.material.opacity = 0.9 * alpha;
      // Drift back offstage on exit so it doesn't just fade in place.
      group.position.lerpVectors(slotPos, offscreenPos, eased);
      if (k >= 1) { finalize(); return; }
    } else if (phase === 'live') {
      coreMat.opacity = 0.92;
      haloMat.opacity = 0.9;
      beadMat.opacity = 0.95;
      ringMat.opacity = 0.75;
      if (nameSprite) nameSprite.material.opacity = 0.9;
    }

    // Idle bob + spin. Cosmetic only; skipped for reduced-motion.
    if (!prefersReducedMotion()) {
      const bob = Math.sin(t * IDLE_BOB_HZ * Math.PI * 2) * IDLE_BOB_AMP;
      group.position.y = (phase === 'live' ? slotPos.y : group.position.y) + bob * (phase === 'live' ? 1 : 0);
      core.rotation.y += dt * 0.35;
      core.rotation.x += dt * 0.18;
    }

    // Yaw toward the camera so the companion faces the user, like Momo.
    if (camera) {
      const dx = camera.position.x - group.position.x;
      const dz = camera.position.z - group.position.z;
      group.rotation.y = Math.atan2(dx, dz);
    }

    // Mouth-bead pulse driven by the analyser source (placeholder reads
    // the parent mouthDrive). Scales the bead 1.0 → 1.6x so the viewer
    // sees that THIS companion is speaking (or quieter when Momo speaks).
    let drive = 0;
    if (typeof analyserSource === 'function') {
      const v = analyserSource();
      if (typeof v === 'number') drive = Math.max(0, Math.min(1, v));
    }
    const beadScale = 1 + drive * 0.6;
    bead.scale.setScalar(beadScale);
    beadMat.opacity = (0.65 + drive * 0.35) * (phase === 'live' ? 1 : beadMat.opacity / 0.95);
  }

  function exit() {
    if (phase === 'dead' || phase === 'leaving') return;
    phase = 'leaving';
    phaseStart = performance.now() / 1000;
  }

  function finalize() {
    if (phase === 'dead') return;
    phase = 'dead';
    if (parentObj && group.parent === parentObj) parentObj.remove(group);
    coreGeom.dispose();
    coreMat.dispose();
    haloMat.dispose();
    haloTex.dispose();
    beadMat.dispose();
    ringGeom.dispose();
    ringMat.dispose();
    if (nameSprite) {
      nameSprite.material.map?.dispose();
      nameSprite.material.dispose();
    }
    if (typeof onDismiss === 'function') {
      try { onDismiss(id); } catch (_) {}
    }
  }

  function dispose() { finalize(); }

  // Hot-swap the analyser source once the sub-agent's own audio channel
  // is available. For now the default is driveFromParent (see enter()).
  function setAnalyserSource(fn) {
    analyserSource = typeof fn === 'function' ? fn : null;
  }

  return {
    id,
    kind: 'agent',
    sizeName: 'agent',
    name,
    role,
    slot,
    greeting,
    avatarTarget,
    getObject3D: () => group,
    enter,
    tick,
    exit,
    dispose,
    setAnalyserSource,
    isDead: () => phase === 'dead',
  };
}

// ─── Name label sprite ──────────────────────────────────────────────────
// Lightweight canvas-texture sprite so we don't need CSS3DObject here —
// the companion itself is a WebGL mesh; keeping the label in WebGL means
// the whole projectable renders in one scene pass, inside bloom.
function makeNameSprite(text, tint) {
  const w = 256, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0, 0, 0, 0)';
  ctx.fillRect(0, 0, w, h);
  // Soft background card.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  roundRect(ctx, 8, 14, w - 16, h - 28, 10);
  ctx.fill();
  // Cyan hairline border.
  ctx.strokeStyle = '#' + tint.toString(16).padStart(6, '0');
  ctx.lineWidth = 1;
  roundRect(ctx, 8, 14, w - 16, h - 28, 10);
  ctx.stroke();
  // Text.
  ctx.font = 'bold 16px "SF Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#eaffff';
  ctx.shadowColor = '#' + tint.toString(16).padStart(6, '0');
  ctx.shadowBlur = 8;
  ctx.fillText(String(text).toUpperCase().slice(0, 18), w / 2, h / 2 + 1);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.0, 0.25, 1);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

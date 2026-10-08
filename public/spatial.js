// spatial — tiny shared helper for placing sprite-system elements around
// the avatar. Used by agent-sprites, agent-squads, and agent-ambient so
// they share the same "theta/phi/radius" spherical convention.
//
// Convention (used consistently across all three sprite files):
//   theta = radial angle in the X/Z plane.
//     0       → front  (positive Z, camera-facing)
//     π/2     → right  (positive X)
//     π       → back   (negative Z)
//     3π/2    → left   (negative X)
//   phi = elevation above the ring plane.
//     0       → ring level (avatar eye-line)
//     +π/6    → slightly above
//     −π/6    → slightly below
//   r   = distance from the avatar in world units.
//
// No classes, no state — pure functions returning Vector3s so callers can
// drop them straight into spawn positions, stations, or runOff directions.

import * as THREE from 'three';

/**
 * Place a world-space point at (theta, phi, r) around an avatar position.
 * @param {THREE.Vector3 | {x:number,y:number,z:number}} avatarPos
 * @param {{theta?: number, phi?: number, r?: number}} [sph]
 * @returns {THREE.Vector3}
 */
export function avatarAnchorPoint(avatarPos, { theta = 0, phi = 0, r = 1.8 } = {}) {
  const cosPhi = Math.cos(phi);
  const ax = avatarPos?.x || 0;
  const ay = avatarPos?.y || 0;
  const az = avatarPos?.z || 0;
  return new THREE.Vector3(
    ax + Math.sin(theta) * r * cosPhi,
    ay + Math.sin(phi) * r,
    az + Math.cos(theta) * r * cosPhi
  );
}

/**
 * Pick a random (theta, phi) pair inside the given ranges. Defaults cover
 * the full horizontal ring with a shallow vertical spread (slightly more
 * above the ring than below, matching where a standing user naturally
 * looks).
 */
export function randomThetaPhi({
  thetaMin = 0,
  thetaMax = 2 * Math.PI,
  phiMin = -Math.PI / 12,
  phiMax = Math.PI / 6,
} = {}) {
  return {
    theta: thetaMin + Math.random() * (thetaMax - thetaMin),
    phi:   phiMin   + Math.random() * (phiMax   - phiMin),
  };
}

/**
 * Convenience: a random world-space point around the avatar. Equivalent to
 * `avatarAnchorPoint(avatarPos, randomThetaPhi(range))` plus an r roll
 * inside [radiusMin, radiusMax]. `yRange` is an optional OVERRIDE that
 * replaces the computed Y (handy for fixed ring-level bands).
 * @param {THREE.Vector3 | {x:number,y:number,z:number}} avatarPos
 * @param {{radiusMin?: number, radiusMax?: number, thetaMin?: number, thetaMax?: number, phiMin?: number, phiMax?: number, yRange?: [number,number]}} [opts]
 * @returns {THREE.Vector3}
 */
export function randomPositionAroundAvatar(avatarPos, opts = {}) {
  const {
    radiusMin = 1.8,
    radiusMax = 2.4,
    thetaMin, thetaMax, phiMin, phiMax, yRange,
  } = opts;
  const { theta, phi } = randomThetaPhi({ thetaMin, thetaMax, phiMin, phiMax });
  const r = radiusMin + Math.random() * (radiusMax - radiusMin);
  const p = avatarAnchorPoint(avatarPos, { theta, phi, r });
  if (yRange) {
    p.y = (avatarPos?.y || 0) + yRange[0] + Math.random() * (yRange[1] - yRange[0]);
  }
  return p;
}

/**
 * Given a theta, return the local "tangent" (around-the-avatar, clockwise)
 * and "bitangent" (up) basis vectors. Squads use these so scouts fan out in
 * a V-formation that always sits on the *outside* of the anchor, never
 * inside the avatar body. The forward-ish vector (anchor direction) is the
 * third leg of the triad, computable as cross(up, tangent) if callers need
 * it.
 */
export function anchorBasis(theta, phi = 0) {
  // Anchor direction in world space at phi=0 (we keep the basis horizontal
  // so scouts fan side-to-side, not up/down, regardless of the anchor's
  // vertical tilt).
  const forward = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  // Tangent is rotated 90° around Y — points "to the right" along the ring.
  const tangent = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
  const up = new THREE.Vector3(0, 1, 0);
  void phi; // phi reserved for future use if we want tilted bases.
  return { forward, tangent, up };
}

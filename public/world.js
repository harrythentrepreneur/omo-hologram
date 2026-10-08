// The hologram world — the single place that owns Momo's 3D stage for any
// Projectable that wants to materialize inside her volumetric frame.
//
// Responsibilities
// ────────────────
//   1. CSS3DRenderer plumbing: create a DOM container that overlays the
//      WebGL canvas exactly, hook up resize, and call .render() in sync
//      with the composer pass.
//   2. Projectable registry: mount(projectable) / dismount() / current().
//      (Single-active for now — the hologram column shows one artifact at
//      a time; multi-active is easy to add later but would need lane
//      management.)
//   3. Choreographer RAF: one update(t, dt) that drives the active
//      projectable's tick, yaw-billboard math, avatar "leaning in" tween,
//      and chrome fade. No setTimeouts in world code; projectables compute
//      everything from (t - bornAt). The host page still owns the RAF loop
//      (we don't want two RAFs competing over the composer) — it calls
//      world.update(t, dt) and world.renderCss() each frame.
//   4. Rebind escape hatch: when holo_reflector toggles pedestal on/off it
//      rebuilds the scene; rebind({scene, camera, sceneCtl}) repoints our
//      captured references so the next mount attaches to the new scene.
//
// Projectable contract: see public/projectables/base.js.

import { PROJECTABLE_STATES } from './projectables/base.js';

// Module-scoped singleton (matches the original chart-layer.js pattern —
// the host page only has one scene, one camera, one stage). installWorld
// is idempotent: a second call returns the existing API.
let state = null;

const SWAY_DEG = 4;
const TO_RAD = Math.PI / 180;

// Reused scratch objects for yaw math; lazily initialised from the camera
// so we don't import THREE directly (the host page does).
let __scratchCamPos = null;
let __scratchObjPos = null;
let __scratchQuat   = null;
let __scratchEuler  = null;

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Install the world. Accepts the same DI bundle as the old chart-layer:
 * the host page owns all the Three.js imports, we receive what we need.
 *
 * @returns the world API (also published as window.__holoWorld for debugging)
 */
export function installWorld({
  avatarObj,
  stageEl,
  scene,
  camera,
  renderer,
  webglCanvas,
  CSS3DObject,
  CSS3DRenderer,
  sceneCtl,
} = {}) {
  if (state) return state.api;

  const host = stageEl || document.body;

  // ── CSS3D renderer setup ────────────────────────────────────────────
  // Matches the WebGL canvas sizing rule in holo_reflector.html::layout()
  // — a square of side min(innerW, innerH), centered in the stage. If we
  // sized it differently the world origin would project to the wrong
  // screen pixel and every Projectable would drift out of the hologram
  // column. Two fences: setSize for the renderer's internal dims, plus
  // centre-via-translate on the DOM element so it anchors at the stage
  // centre rather than top-left.
  let css3dRenderer = null;
  let css3dContainer = null;
  const use3D = !!(scene && camera && CSS3DObject && CSS3DRenderer);
  if (use3D) {
    css3dRenderer = new CSS3DRenderer();
    css3dContainer = css3dRenderer.domElement;
    css3dContainer.id = 'holo-css3d';
    css3dContainer.style.position = 'absolute';
    css3dContainer.style.left = '50%';
    css3dContainer.style.top = '50%';
    css3dContainer.style.transform = 'translate(-50%, -50%)';
    css3dContainer.style.pointerEvents = 'none';
    css3dContainer.style.zIndex = '10';
    host.appendChild(css3dContainer);
    sizeCss3dRenderer();
    window.addEventListener('resize', sizeCss3dRenderer);
    window.addEventListener('orientationchange', sizeCss3dRenderer);
  }

  function sizeCss3dRenderer() {
    if (!css3dRenderer) return;
    // Prefer matching the WebGL canvas exactly — CSS3D and WebGL share the
    // camera, so same output dims = same world→screen pixel mapping. Falls
    // back to a window-inscribed square for hosts that don't pass a canvas.
    let w, h;
    if (webglCanvas && webglCanvas.getBoundingClientRect) {
      const rect = webglCanvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width  || webglCanvas.clientWidth  || 0));
      h = Math.max(1, Math.floor(rect.height || webglCanvas.clientHeight || 0));
    }
    if (!w || !h) {
      const sz = Math.floor(Math.min(window.innerWidth, window.innerHeight));
      w = h = sz;
    }
    css3dRenderer.setSize(w, h);
  }

  // ── Projectable registry ────────────────────────────────────────────
  // One active at a time. dismount() triggers exit; the Choreographer RAF
  // drops the reference once projectable.isDead() is true, so host code
  // can call mount(next) immediately and the old projectable drains its
  // exit animation in the background without blocking the new one.
  let current = null;
  let draining = [];   // projectables whose exit is still animating

  function mount(projectable) {
    dismount();
    current = projectable;
    if (projectable.enter) {
      projectable.enter({
        scene,
        camera,
        avatarObj,
        CSS3DObject,
        sceneCtl,
      });
    }
  }

  function dismount() {
    if (!current) return;
    if (current.exit) current.exit();
    draining.push(current);
    current = null;
  }

  function rebind(next = {}) {
    // Host is about to swap the scene — e.g. holo_reflector's PEDESTAL
    // toggle rebuilds the hologram scene. Kill anything currently on
    // stage (old scene is going away; holding references would orphan
    // meshes against a Scene that's no longer being rendered) and
    // repoint our captured refs so the next mount attaches to the new
    // scene.
    dismount();
    // Force-drop drains too; the old scene is gone.
    for (const d of draining) { try { d.dispose && d.dispose(); } catch (_) {} }
    draining = [];
    if (next.scene)    scene = next.scene;
    if (next.camera)   camera = next.camera;
    if (next.sceneCtl) sceneCtl = next.sceneCtl;
  }

  // ── Choreographer RAF: per-frame tick ───────────────────────────────
  // Called by the host render loop *after* composer.render() but before
  // renderCss(). Drives billboard math for the active projectable, mirrors
  // yaw onto chrome, runs avatar "lean-in" tween, and drains any exiting
  // projectables.
  function update(t, dt) {
    // Avatar lean-in tween.
    tickAvatarTween(t);

    // Active projectable tick.
    if (current) {
      const yaw = computeLocalYaw(current);
      current.tick(t, dt, camera, yaw);
    }

    // Drain exits.
    if (draining.length) {
      let write = 0;
      for (let i = 0; i < draining.length; i++) {
        const p = draining[i];
        const yaw = computeLocalYaw(p);
        p.tick(t, dt, camera, yaw);
        if (!p.isDead || !p.isDead()) {
          if (write !== i) draining[write] = p;
          write++;
        } else {
          try { p.dispose && p.dispose(); } catch (_) {}
        }
      }
      draining.length = write;
    }
  }

  function renderCss() {
    if (!css3dRenderer) return;
    css3dRenderer.render(scene, camera);
  }

  // Yaw-only billboard math. We want projectables to face the camera in
  // yaw while keeping their fixed forward tilt (reads as a projected
  // display plane). Object3D.lookAt would overwrite the tilt, so we
  // compute the local yaw that aims the object's +Z at the camera,
  // subtract the parent's yaw, add a subtle sway. Euler order 'YXZ' on
  // the projectable's CSS3DObject (set at mount time) makes this compose
  // cleanly.
  function computeLocalYaw(projectable) {
    if (!camera) return 0;
    const obj = projectable.getObject3D ? projectable.getObject3D() : null;
    if (!obj) return 0;

    if (!__scratchCamPos) __scratchCamPos = camera.position.clone();
    if (!__scratchObjPos) __scratchObjPos = camera.position.clone();
    camera.getWorldPosition(__scratchCamPos);
    obj.getWorldPosition(__scratchObjPos);

    const dx = __scratchCamPos.x - __scratchObjPos.x;
    const dz = __scratchCamPos.z - __scratchObjPos.z;
    const worldYaw = Math.atan2(dx, dz);

    let parentYaw = 0;
    if (obj.parent) {
      if (!__scratchQuat) {
        __scratchQuat = obj.quaternion.clone();
        __scratchEuler = obj.rotation.clone();
        __scratchEuler.order = 'YXZ';
      }
      obj.parent.getWorldQuaternion(__scratchQuat);
      __scratchEuler.setFromQuaternion(__scratchQuat, 'YXZ');
      parentYaw = __scratchEuler.y;
    }

    const now = performance.now() / 1000;
    const sway = reducedMotion() ? 0 : Math.sin(now * 0.55) * SWAY_DEG * TO_RAD;
    return worldYaw - parentYaw + sway;
  }

  // ── Avatar "lean-in" tween ──────────────────────────────────────────
  // Subtle avatar position shift when a projectable is live — gives the
  // impression of Momo leaning forward to present whatever she's showing.
  // Symmetric enough that callers don't need to pass offsets; the tween
  // is keyed off current.pose, which projectables expose.
  let avatarTarget = { x: 0, y: 0, z: 0 };
  let avatarFrom = { x: 0, y: 0, z: 0 };
  let avatarTweenStart = 0;
  const AVATAR_TWEEN_MS = 560;

  function retargetAvatar() {
    if (!avatarObj) return;
    const p = current && current.avatarTarget ? current.avatarTarget : { x: 0, y: 0, z: 0 };
    avatarFrom = {
      x: avatarObj.position.x,
      y: avatarObj.position.y,
      z: avatarObj.position.z,
    };
    avatarTarget = { x: p.x || 0, y: p.y || 0, z: p.z || 0 };
    avatarTweenStart = performance.now();
  }

  function tickAvatarTween(_t) {
    if (!avatarObj) return;
    const elapsed = performance.now() - avatarTweenStart;
    const k = Math.min(1, elapsed / AVATAR_TWEEN_MS);
    const eased = 1 - Math.pow(1 - k, 3);
    avatarObj.position.x = avatarFrom.x + (avatarTarget.x - avatarFrom.x) * eased;
    avatarObj.position.y = avatarFrom.y + (avatarTarget.y - avatarFrom.y) * eased;
    avatarObj.position.z = avatarFrom.z + (avatarTarget.z - avatarFrom.z) * eased;
  }

  // ── Public API ──────────────────────────────────────────────────────
  const api = {
    mount: (projectable) => { mount(projectable); retargetAvatar(); },
    dismount: () => { dismount(); retargetAvatar(); },
    update,
    renderCss,
    rebind,
    getCurrent: () => current,
    getDrainCount: () => draining.length,
    // Expose DI bundle so projectables can ask the world for the scene/
    // camera/CSS3DObject etc. without callers re-threading them.
    get scene()        { return scene; },
    get camera()       { return camera; },
    get avatarObj()    { return avatarObj; },
    get sceneCtl()     { return sceneCtl; },
    get stageEl()      { return stageEl; },
    get CSS3DObject()  { return CSS3DObject; },
    get use3D()        { return use3D; },
  };

  state = { api, css3dRenderer, css3dContainer };
  window.__holoWorld = api;
  return api;
}

// Tiny helper for host pages: read the installed world if any.
export function getWorld() { return state?.api || null; }

export { PROJECTABLE_STATES };

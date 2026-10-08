import * as THREE from 'three';
import { installSpriteLayer } from './agent-sprites.js';
import { installSquadLayer } from './agent-squads.js';
import { installAmbientLife } from './agent-ambient.js';
import { installMomoAwareness } from './momo-awareness.js';

const CYAN = 0x00e5ff;
const CYAN_DEEP = 0x00b8d4;
const PINK = 0xff66b3;
const PINK_GLOW = 0xff99cc;

// Glossy hologram material for torso, hands, ears — crystal-like.
function holoMat(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.22,
    transparent: true,
    opacity: 0.9,
    roughness: 0.25,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    ...opts,
  });
}

// Head uses a softer spec so the forehead highlight doesn't skate across
// the face as the camera orbits. Still glossy, just not mirror-sharp.
function headMat() {
  return new THREE.MeshPhysicalMaterial({
    color: CYAN,
    emissive: CYAN,
    emissiveIntensity: 0.28,
    transparent: true,
    opacity: 0.94,
    roughness: 0.45,
    metalness: 0.03,
    clearcoat: 0.5,
    clearcoatRoughness: 0.45,
  });
}

export function createAvatar() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const headG = new THREE.SphereGeometry(1, 96, 96);
  headG.scale(1, 0.96, 1);
  const head = new THREE.Mesh(headG, headMat());
  body.add(head);

  const rimG = new THREE.SphereGeometry(1.04, 64, 64);
  rimG.scale(1, 0.96, 1);
  const rim = new THREE.Mesh(
    rimG,
    new THREE.MeshBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    })
  );
  // Pinned render order: the rim is additive + BackSide, and three.js's
  // transparent sort can swap it with the head as the body rotates,
  // producing a one-frame bright pop. Drawing it first (renderOrder = -2)
  // with depthTest off makes the composite stable at every angle.
  rim.renderOrder = -2;
  body.add(rim);

  const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyeG = new THREE.SphereGeometry(0.26, 36, 36);
  // makeEye returns the outer group (positioned on the face) AND the inner
  // "pupils" sub-group (pupil + shines). Animating pupils' local x lets
  // Momo glance sideways without moving the eye whites — classic cute.
  const makeEye = (x) => {
    const g = new THREE.Group();
    const white = new THREE.Mesh(eyeG, eyeWhiteMat);
    white.scale.set(1, 1.18, 0.45);
    g.add(white);
    const pupils = new THREE.Group();
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 28, 28),
      new THREE.MeshBasicMaterial({ color: 0x060a14 })
    );
    pupil.position.z = 0.08;
    pupil.scale.set(1, 1.22, 0.5);
    pupils.add(pupil);
    const shine1 = new THREE.Mesh(
      new THREE.SphereGeometry(0.058, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    shine1.position.set(0.07, 0.08, 0.18);
    pupils.add(shine1);
    const shine2 = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    shine2.position.set(-0.07, -0.07, 0.18);
    pupils.add(shine2);
    g.add(pupils);
    g.position.set(x, 0.1, 0.85);
    return { eye: g, pupils, shine1, shine2 };
  };
  const L = makeEye(-0.36);
  const R = makeEye(0.36);
  const leftEye = L.eye, rightEye = R.eye;
  const leftPupils = L.pupils, rightPupils = R.pupils;
  const allShines = [L.shine1, L.shine2, R.shine1, R.shine2];
  body.add(leftEye, rightEye);

  const blushCanvas = document.createElement('canvas');
  blushCanvas.width = 128;
  blushCanvas.height = 128;
  const bctx = blushCanvas.getContext('2d');
  const bg = bctx.createRadialGradient(64, 64, 4, 64, 64, 60);
  bg.addColorStop(0, 'rgba(255,140,180,0.95)');
  bg.addColorStop(1, 'rgba(255,140,180,0)');
  bctx.fillStyle = bg;
  bctx.fillRect(0, 0, 128, 128);
  const blushTex = new THREE.CanvasTexture(blushCanvas);
  const blushMat = new THREE.SpriteMaterial({ map: blushTex, transparent: true, opacity: 0.75, depthWrite: false });
  const leftBlush = new THREE.Sprite(blushMat);
  leftBlush.position.set(-0.5, -0.2, 0.84);
  leftBlush.scale.set(0.36, 0.26, 1);
  const rightBlush = new THREE.Sprite(blushMat);
  rightBlush.position.set(0.5, -0.2, 0.84);
  rightBlush.scale.set(0.36, 0.26, 1);
  body.add(leftBlush, rightBlush);

  // Cute mouth — a horizontal capsule. At rest the y-scale collapses it to
  // a small smile line; when speaking it rounds up into a soft "o".
  const mouthGeom = new THREE.CapsuleGeometry(0.06, 0.14, 10, 20);
  mouthGeom.rotateZ(Math.PI / 2);
  const mouth = new THREE.Mesh(
    mouthGeom,
    new THREE.MeshStandardMaterial({
      color: 0x5a0a26,
      emissive: 0xff4d8f,
      emissiveIntensity: 0.55,
      roughness: 0.4,
      metalness: 0,
    })
  );
  mouth.position.set(0, -0.34, 0.92);
  mouth.scale.set(1, 0.22, 0.75);
  body.add(mouth);

  const earMat = holoMat(CYAN, { emissiveIntensity: 0.28, opacity: 0.92 });
  const makeEar = (x, rot) => {
    const g = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.58, 24), earMat);
    g.add(outer);
    const inner = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.36, 24),
      new THREE.MeshBasicMaterial({ color: PINK_GLOW, transparent: true, opacity: 0.65 })
    );
    inner.position.z = 0.08;
    g.add(inner);
    g.position.set(x, 0.82, -0.05);
    g.userData.restRot = rot;
    g.rotation.z = rot;
    return g;
  };
  const leftEar = makeEar(-0.55, 0.28);
  const rightEar = makeEar(0.55, -0.28);
  body.add(leftEar, rightEar);

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.38, 8),
    new THREE.MeshBasicMaterial({ color: CYAN })
  );
  antenna.position.set(0, 1.18, 0);
  body.add(antenna);
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 24, 24),
    new THREE.MeshBasicMaterial({ color: PINK })
  );
  orb.position.set(0, 1.42, 0);
  body.add(orb);
  const orbGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 24, 24),
    new THREE.MeshBasicMaterial({
      color: PINK,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    })
  );
  orbGlow.position.copy(orb.position);
  // Render after the head (large renderOrder) so the additive halo is
  // always composited on top, not occasionally behind, as the antenna
  // swings past the silhouette during rotation/wiggle.
  orbGlow.renderOrder = 3;
  body.add(orbGlow);
  const orbLight = new THREE.PointLight(PINK, 0.7, 3);
  orbLight.position.copy(orb.position);
  body.add(orbLight);

  const torsoG = new THREE.CapsuleGeometry(0.55, 0.35, 12, 24);
  const torso = new THREE.Mesh(torsoG, holoMat(CYAN_DEEP, { opacity: 0.82, emissiveIntensity: 0.22 }));
  torso.position.set(0, -1.3, 0);
  body.add(torso);

  const handMat = holoMat(CYAN_DEEP, { emissiveIntensity: 0.3 });
  const handG = new THREE.SphereGeometry(0.17, 24, 24);
  const leftHand = new THREE.Mesh(handG, handMat);
  leftHand.position.set(-0.8, -1.22, 0.15);
  const rightHand = new THREE.Mesh(handG, handMat);
  rightHand.position.set(0.8, -1.22, 0.15);
  body.add(leftHand, rightHand);

  // Heart sprite pool — tiny additive pink hearts that puff upward over
  // Momo's head during the "happyHeart" idle action. Pooled so no
  // allocations happen mid-loop.
  const heartCanvas = document.createElement('canvas');
  heartCanvas.width = heartCanvas.height = 64;
  const hctx = heartCanvas.getContext('2d');
  hctx.fillStyle = '#ff6bb5';
  hctx.beginPath();
  hctx.moveTo(32, 22);
  hctx.bezierCurveTo(32, 10, 10, 10, 10, 30);
  hctx.bezierCurveTo(10, 46, 32, 58, 32, 58);
  hctx.bezierCurveTo(32, 58, 54, 46, 54, 30);
  hctx.bezierCurveTo(54, 10, 32, 10, 32, 22);
  hctx.fill();
  const heartTex = new THREE.CanvasTexture(heartCanvas);
  const hearts = [];
  for (let i = 0; i < 3; i++) {
    const h = new THREE.Sprite(new THREE.SpriteMaterial({
      map: heartTex,
      color: 0xff88c4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    h.scale.set(0.22, 0.22, 1);
    h.visible = false;
    h.userData = { life: 0, active: false, ox: 0, oy: 1.55 };
    body.add(h);
    hearts.push(h);
  }

  root.userData = {
    body,
    head,
    leftEye,
    rightEye,
    leftPupils,
    rightPupils,
    allShines,
    leftEar,
    rightEar,
    blushMat,
    hearts,
    mouth,
    leftHand,
    rightHand,
    orb,
    orbGlow,
    antenna,
    blinkTimer: 0,
    nextBlink: 2 + Math.random() * 2.5,
    mouthCurrent: 0,
    speaking: false,
    listening: false,
    mouthDrive: null,
    // Idle personality — a tiny state machine that fires cute micro-actions
    // (head tilt, bounce, antenna wiggle, eye darts, sparkle, giggle) every
    // couple of seconds while Momo isn't speaking or listening.
    idleTimer: 0,
    nextIdleAction: 2 + Math.random() * 2.5,
    // Smoothed (lerped) runtime values — every applied visual eases toward
    // its target each frame instead of snapping, so action-to-action
    // transitions blend seamlessly with no visible seams.
    sPupilX: 0, sPupilY: 0,
    sShine: 1,
    sBlush: 0.75,
    sEarL: 0, sEarR: 0,
    sTilt: 0, sBounce: 0, sAntenna: 0,
    sHandL: 0, sHandR: 0,
    sSway: 0, sHeadNod: 0,
    sIdleHum: 0,
    idleSustain: 0,
    actionKind: null,
    actionProgress: 0,
    actionDuration: 1,
    actionForced: false,
    // ── Gaze state (see createGazeController below) ─────────────────────
    // `gaze.target` is a Vector3 or null. When non-null, the update loop
    // asks the controller for per-frame head/eye offsets and *suppresses*
    // the random idle action bag (Momo is already engaged). Reactions are
    // independent of focus — they compose on top.
    gaze: null,
    gazeSuppress: false,
    // Reaction FSM — overlay that fires on top of any gaze/idle state.
    // Driven by reactHappy/reactConcerned/reactDelighted.
    reaction: null,
  };

  // Install the gaze controller and expose the public gaze API on root.
  // Methods are attached directly to the root Group — it's a regular
  // object, so adding properties is fine and lets callers treat the
  // avatar as "object with scene node + behaviours".
  root.userData.gaze = createGazeController(root.userData);
  root.focusOn      = (pos, opts) => root.userData.gaze.focusOn(pos, opts);
  root.relax        = ()            => root.userData.gaze.relax();
  root.getGazeState = ()            => root.userData.gaze.getState();
  root.reactHappy     = (note) => triggerReaction(root.userData, 'happy',     note);
  root.reactConcerned = (note) => triggerReaction(root.userData, 'concerned', note);
  root.reactDelighted = (note) => triggerReaction(root.userData, 'delighted', note);
  root.playCuteAction = (kind, opts) => playCuteAction(root, kind, opts);

  return root;
}

// ─── Gaze controller ────────────────────────────────────────────────────
// Converts world-space focus targets into smoothed head yaw/pitch and eye
// pupil offsets with anatomical limits. Reusable scratch vectors live at
// module scope so focusOn() and per-frame updates do zero allocations.
//
// Why spring smoothing, not linear lerp? Real heads don't reach a target in
// a straight ramp — they accelerate, overshoot imperceptibly, settle. A
// critically-damped exponential decay (`k = 1 - exp(-dt * ω)`) gives that
// feel with no oscillation and is framerate-independent. Half-life is the
// intuitive knob: at t = halfLife the error is halved.
//
// Eyes lead the head by design: shorter half-life (~120ms) vs head's 220ms.
// When a real person looks at something, the eyes saccade first and the
// head catches up — that 100ms offset reads as naturalness without any
// extra machinery.

// Anatomical limits. Slightly generous compared to real human heads because
// Momo is stylised (big eyes, cute head), but the ratios match so she still
// reads as "looking *there*" rather than "spinning her head like a doll".
const GAZE_MAX_YAW   = Math.PI * (35 / 180);  // ±35°
const GAZE_MAX_PITCH = Math.PI * (18 / 180);  // ±18°
const GAZE_PUPIL_MAX = 0.07;                   // ±0.07 world-units ≈ 0.7 × eye ellipse radius
const GAZE_HEAD_HALFLIFE_S = 0.220;
const GAZE_EYE_HALFLIFE_S  = 0.120;
const GAZE_EYE_LEAD_S      = 0.080;            // eyes arrive ~80ms before head
const GAZE_RELAX_DUR_S     = 0.300;            // ease-out after relax()

// Scratch vectors — reused every frame so the gaze path allocates nothing.
const _scratchHeadWorld = new THREE.Vector3();
const _scratchTargetLocal = new THREE.Vector3();
const _scratchInvQuat = new THREE.Quaternion();

// Convert a half-life (seconds) to an exponential-decay factor for a given
// dt. Framerate-independent: the same half-life decays the same proportion
// of error per wall-clock second regardless of frame rate.
function decayFactor(halfLifeS, dt) {
  if (halfLifeS <= 0) return 1;
  // k such that (1 - k) = 2^(-dt / halfLife). Clamped to [0,1] so huge
  // dt spikes (tab-switch pauses) can't overshoot.
  return Math.min(1, 1 - Math.pow(0.5, dt / halfLifeS));
}

function createGazeController(u) {
  // Focus state. `activeTarget` is the latest call to focusOn; on relax()
  // we switch to relaxing mode and linearly ease yaw/pitch/pupils back to 0
  // over GAZE_RELAX_DUR_S. `holdUntil` enforces durationMs auto-relax.
  const state = {
    target: null,          // { pos: Vector3, intensity, priority, holdUntil: ms | null }
    active: false,         // true while focused or relaxing
    relaxing: false,
    relaxStartMs: 0,
    relaxFromYaw: 0,
    relaxFromPitch: 0,
    relaxFromEyeX: 0,
    relaxFromEyeY: 0,
    lastActivityMs: 0,
    // Current smoothed values — head lags eyes. Stored here so
    // updateAvatar() can read/write them each frame.
    yaw: 0,
    pitch: 0,
    eyeX: 0,
    eyeY: 0,
  };

  // Per-call durable Vector3 for the current target — we copy incoming
  // vectors into it so the caller is free to mutate theirs without us
  // silently retargeting. Saves us a `.clone()` on every focusOn.
  const _targetPos = new THREE.Vector3();

  function focusOn(worldVec3, opts = {}) {
    if (!worldVec3) return;
    const { intensity = 1, durationMs = null, priority = 'normal' } = opts;
    _targetPos.copy(worldVec3);
    const now = performance.now();
    state.target = {
      pos: _targetPos,
      intensity: Math.max(0, Math.min(1, intensity)),
      priority,
      holdUntil: durationMs != null ? now + durationMs : null,
    };
    state.active = true;
    state.relaxing = false;
    state.lastActivityMs = now;
    u.gazeSuppress = true;
  }

  function relax() {
    if (!state.active) return;
    // Snapshot current values so the ease-out starts from exactly where we
    // are — no popping if relax() fires mid-turn.
    state.relaxing = true;
    state.target = null;
    state.relaxStartMs = performance.now();
    state.relaxFromYaw = state.yaw;
    state.relaxFromPitch = state.pitch;
    state.relaxFromEyeX = state.eyeX;
    state.relaxFromEyeY = state.eyeY;
    // Idle action bag can resume as soon as relax starts — the ease is
    // small enough that the two don't visually fight.
    u.gazeSuppress = false;
  }

  function getState() {
    return {
      target: state.target ? state.target.pos : null,
      active: state.active,
      lastActivityTs: state.lastActivityMs,
    };
  }

  // Per-frame tick: mutates u.head rotation + pupil offsets. Called from
  // updateAvatar AFTER the base body.rotation.y sway is set so we can
  // subtract it (keeping head world-yaw aimed at target rather than
  // drifting with the body).
  function tick(avatar, t, dt) {
    const now = performance.now();

    // Auto-relax on durationMs expiry.
    if (state.target && state.target.holdUntil != null && now >= state.target.holdUntil) {
      relax();
    }

    let desiredYaw = 0, desiredPitch = 0, desiredEyeX = 0, desiredEyeY = 0;

    if (state.target) {
      // Compute target position in the avatar's local space. The head sits
      // at avatar-local y≈0 (body is centred at origin, head at y=0), so we
      // project the world target into avatar space and measure the bearing.
      u.head.getWorldPosition(_scratchHeadWorld);
      _scratchTargetLocal.copy(state.target.pos).sub(_scratchHeadWorld);
      // Avatar root may be rotated — undo that to get a body-local bearing
      // we can feed directly into head.rotation (which composes on top of
      // body.rotation.y sway).
      _scratchInvQuat.copy(avatar.quaternion).invert();
      _scratchTargetLocal.applyQuaternion(_scratchInvQuat);

      // Subtract the body's current sway so head yaw targets the WORLD
      // bearing to the target, not the body-local bearing. Computed from
      // `t` directly rather than u.body.rotation.y because the body's
      // rotation is set later in the same frame — we'd otherwise read a
      // 1-frame-stale value. Keep this in sync with the ambient motion
      // block below.
      const bodySway = Math.sin(t * 0.55) * 0.16;

      // Bearing: yaw = atan2(x, z) in local space. Pitch = atan2(y, horiz).
      const horiz = Math.max(1e-4, Math.hypot(_scratchTargetLocal.x, _scratchTargetLocal.z));
      const rawYaw   = Math.atan2(_scratchTargetLocal.x, _scratchTargetLocal.z) - bodySway;
      const rawPitch = Math.atan2(_scratchTargetLocal.y, horiz);

      const intensity = state.target.intensity;
      desiredYaw   = Math.max(-GAZE_MAX_YAW,   Math.min(GAZE_MAX_YAW,   rawYaw   * intensity));
      desiredPitch = Math.max(-GAZE_MAX_PITCH, Math.min(GAZE_MAX_PITCH, rawPitch * intensity));

      // Eyes lead the head by ~80ms: we aim them at where the head WILL be
      // shortly, not where it is now. Equivalent to overshooting the head
      // target by eyeLead / headHalfLife worth of travel. Eye ellipse max
      // displacement is tuned to 0.7× the pupil ellipse (GAZE_PUPIL_MAX).
      const eyeLeadGain = GAZE_EYE_LEAD_S / GAZE_HEAD_HALFLIFE_S;
      desiredEyeX = Math.max(-GAZE_PUPIL_MAX, Math.min(GAZE_PUPIL_MAX,
        (desiredYaw   / GAZE_MAX_YAW)   * GAZE_PUPIL_MAX * (1 + eyeLeadGain)));
      desiredEyeY = Math.max(-GAZE_PUPIL_MAX, Math.min(GAZE_PUPIL_MAX,
        (desiredPitch / GAZE_MAX_PITCH) * GAZE_PUPIL_MAX * (1 + eyeLeadGain)));

      state.lastActivityMs = now;
    } else if (state.relaxing) {
      // Ease-out from snapshot values to zero over GAZE_RELAX_DUR_S. Using
      // a cubic-out so the tail is gentle — feels less abrupt than a pure
      // exponential when returning to neutral (300ms is long enough that
      // the user sees the settle).
      const elapsed = (now - state.relaxStartMs) / 1000;
      const k = Math.min(1, elapsed / GAZE_RELAX_DUR_S);
      const ease = 1 - Math.pow(1 - k, 3);
      desiredYaw   = state.relaxFromYaw   * (1 - ease);
      desiredPitch = state.relaxFromPitch * (1 - ease);
      desiredEyeX  = state.relaxFromEyeX  * (1 - ease);
      desiredEyeY  = state.relaxFromEyeY  * (1 - ease);
      if (k >= 1) {
        state.relaxing = false;
        state.active = false;
      }
    } else {
      return { yaw: 0, pitch: 0, eyeX: 0, eyeY: 0 };
    }

    // Spring smoothing — head lags eyes. Each value decays toward its
    // desired by a framerate-independent proportion per frame.
    const headK = decayFactor(GAZE_HEAD_HALFLIFE_S, dt);
    const eyeK  = decayFactor(GAZE_EYE_HALFLIFE_S,  dt);
    state.yaw   += (desiredYaw   - state.yaw)   * headK;
    state.pitch += (desiredPitch - state.pitch) * headK;
    state.eyeX  += (desiredEyeX  - state.eyeX)  * eyeK;
    state.eyeY  += (desiredEyeY  - state.eyeY)  * eyeK;

    return { yaw: state.yaw, pitch: state.pitch, eyeX: state.eyeX, eyeY: state.eyeY };
  }

  return { focusOn, relax, getState, tick };
}

// ─── Reactions ──────────────────────────────────────────────────────────
// Short-lived expressive overlays (happy, concerned, delighted). They
// compose on top of gaze/idle — reactions don't break focus; they layer a
// smile boost, nod, sparkle, or hearts on whatever Momo is currently doing.
//
// Small UX polish: each reaction has a 40ms "anticipation" frame where the
// main gesture nudges in the OPPOSITE direction before springing. Classic
// Disney trick — reads as snappy rather than squishy.

// Reaction amplitudes — tuned to read clearly even while Momo is speaking
// (mouth flap + body sway would otherwise wash out subtle overlays). The
// delighted envelope now reaches every expressive channel she owns so a
// giggle is unmistakable.
const REACTION_SPECS = {
  happy:     { durationMs:  700, nodAmp: 0.14, smileBoost: 0.45, sparkle: 0.9,  blushBoost: 0.45, concernTilt: 0,    heart: false },
  concerned: { durationMs:  900, nodAmp: 0,    smileBoost: -0.45, sparkle: 0,    blushBoost: 0,    concernTilt: 0.14, heart: false },
  delighted: { durationMs: 1400, nodAmp: 0.24, smileBoost: 0.75, sparkle: 1.7,  blushBoost: 0.80, concernTilt: 0,    heart: true  },
};

function triggerReaction(u, kind, note) {
  const spec = REACTION_SPECS[kind];
  if (!spec) return;
  // Reduced-motion: damp everything to 40% intensity and halve nod amp.
  const reduced = !!(typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  u.reaction = {
    kind,
    startMs: performance.now(),
    durationMs: spec.durationMs,
    nodAmp: spec.nodAmp * (reduced ? 0.5 : 1),
    smileBoost: spec.smileBoost * (reduced ? 0.4 : 1),
    sparkle: spec.sparkle * (reduced ? 0.4 : 1),
    blushBoost: spec.blushBoost * (reduced ? 0.4 : 1),
    concernTilt: spec.concernTilt * (reduced ? 0.4 : 1),
    heartFired: false,
    wantHeart: spec.heart,
    note: note || null,
  };
}

// Sample the active reaction: returns overlay values (or zeros) for the
// current frame. The reaction clears itself when its envelope finishes.
function sampleReaction(u) {
  const r = u.reaction;
  if (!r) return null;
  const now = performance.now();
  const k = (now - r.startMs) / r.durationMs;
  if (k >= 1) { u.reaction = null; return null; }

  // 40ms anticipation frame. For a 600ms reaction that's k ∈ [0, 0.067]
  // where the primary axis nudges the WRONG way. Tiny but makes the main
  // motion feel sprung rather than floaty.
  const antiK = 40 / r.durationMs;
  let gesture;
  if (k < antiK) {
    // Anticipation: ramp backward to -0.3 then back to 0 over antiK.
    const kk = k / antiK;
    gesture = -0.3 * Math.sin(kk * Math.PI);
  } else {
    // Main envelope: quick rise, slow settle. Bell-shape so it self-clears.
    const kk = (k - antiK) / (1 - antiK);
    gesture = Math.sin(kk * Math.PI);
  }

  // Spawn exactly one happy-heart for delighted reactions, on the first
  // sampled frame so the existing hearts pool picks it up through the
  // same path as the idle 'happyHeart' action.
  const spawnHeart = r.wantHeart && !r.heartFired;
  if (spawnHeart) r.heartFired = true;

  return {
    nod: -r.nodAmp * gesture,         // negative pitch = chin-down nod
    concernTilt: r.concernTilt * gesture,
    smileBoost: r.smileBoost * Math.max(0, gesture),  // no negative smile on anticipation
    sparkleBoost: r.sparkle * Math.max(0, gesture),
    blushBoost: r.blushBoost * Math.max(0, gesture),
    spawnHeart,
  };
}

// Action-duration lookup. Shared between the idle-bag selector and
// playCuteAction() so forced reactions run for the same length as the
// equivalent idle action. Keep keys in sync with the switch() in
// updateAvatar's idle block.
function computeActionDuration(kind) {
  switch (kind) {
    case 'doubleBlink': return 0.55;
    case 'sparkle':     return 0.7;
    case 'giggle':      return 0.75;
    case 'earL':
    case 'earR':        return 0.35;
    case 'blushPulse':  return 1.0;
    case 'shyPeek':     return 1.1;
    case 'happyHeart':  return 0.1;
    case 'headBob':     return 0.7;
    case 'sway':        return 1.4;
    case 'stretch':     return 1.0;
    case 'boop':        return 0.5;
    case 'chirp':       return 0.55;
    case 'nodYes':      return 0.7;
    case 'twinkle':     return 0.8;
    case 'shake':       return 0.7;
    case 'hop':         return 0.55;
    case 'pawWave':     return 0.9;
    case 'peekBoop':    return 0.9;
    case 'yay':         return 0.95;
    case 'lookL':
    case 'lookR':
    case 'lookUp':
    case 'lookDown':    return 1.2 + Math.random() * 0.6;
    default:            return 0.8 + Math.random() * 0.5;
  }
}

// Public API: force a specific cute action now, bypassing the idle bag.
// Survives through Momo speaking/listening state so we can visually react
// while she's mid-turn. Idempotent if an action is already running — we
// only start a new one if the current slot is free OR the incoming action
// is marked as interrupting.
export function playCuteAction(avatar, kind, { interrupt = false } = {}) {
  const u = avatar.userData;
  if (!u) return;
  if (u.actionKind && !interrupt) return;
  u.actionKind = kind;
  u.actionDuration = computeActionDuration(kind);
  u.actionProgress = 0;
  u.actionForced = true;
  u.idleTimer = 0;
}

export function updateAvatar(avatar, t, dt) {
  const u = avatar.userData;

  // ── Idle personality ─────────────────────────────────────────────────
  // While Momo isn't speaking or listening, fire a cute micro-action every
  // few seconds: a curious head tilt, a happy bounce, a hand wave, or an
  // antenna wiggle. Each action has a bell-curve progress so it eases in
  // and out smoothly, then clears itself.
  let tiltBonus = 0, bounceBonus = 0, antennaBonus = 0;
  let leftHandWave = 0, rightHandWave = 0;
  let pupilX = 0, pupilY = 0;       // eye-dart offset
  let shineBoost = 1;                 // sparkle eyes
  let extraBlink = 0;                 // 0..1 force-close
  let earBonusL = 0, earBonusR = 0;   // kitty ear twitches
  let blushBoost = 0;                 // 0..1 extra blush on top of resting
  let spawnHeart = false;
  let swayBonus = 0;                  // body x-position sway (dance-y)
  let headBobBonus = 0;               // head pitch double-nod
  // Idle action bag is suppressed while Momo is focused on a sprite/squad
  // (gazeSuppress === true). She's already engaged — layering random tilts
  // or eye-darts on top would fight the focus. The existing action bag is
  // untouched; we just gate the *selection* here.
  const isIdle = !u.speaking && !u.listening && !u.gazeSuppress;
  if (isIdle) {
    u.idleTimer += dt;
    u.idleSustain += dt;
    if (!u.actionKind && u.idleTimer > u.nextIdleAction) {
      // Weighted action bag. Small gestures (tilt, eye-dart, twitch) come
      // up more often than big ones so Momo feels alive without overacting.
      const kinds = [
        'tilt', 'tilt', 'tiltR', 'tiltR',
        'lookL', 'lookL', 'lookR', 'lookR',
        'lookUp', 'lookDown',
        'sparkle', 'sparkle',
        'earL', 'earR', 'earL', 'earR',
        'blushPulse', 'blushPulse',
        'shyPeek',
        'bounce', 'giggle', 'giggle', 'wiggle', 'wave',
        'doubleBlink',
        'happyHeart', 'happyHeart',
        'headBob', 'headBob',
        'sway', 'sway',
        'stretch',
        'boop', 'boop',
        'chirp', 'chirp', 'chirp',
        'nodYes', 'nodYes',
        'twinkle', 'twinkle',
        'shake',
        'hop',
        'pawWave',
        'peekBoop',
        'yay',
      ];
      u.actionKind = kinds[Math.floor(Math.random() * kinds.length)];
      u.actionProgress = 0;
      u.actionDuration = computeActionDuration(u.actionKind);
      u.actionForced = false;
      u.idleTimer = 0;
      // Cadence tightens the longer she's been idle — more cuteness while
      // actually waiting, same pace during normal conversation pauses.
      const warmth = Math.min(1, u.idleSustain / 8);
      u.nextIdleAction = (2 - 0.6 * warmth) + Math.random() * (2.5 - 0.9 * warmth);
    }
  } else {
    u.idleTimer = 0;
    u.idleSustain = 0;
    // Idle-spawned actions clear when Momo engages. Forced reactions
    // (playCuteAction) survive so she can giggle mid-turn.
    if (u.actionKind && !u.actionForced) u.actionKind = null;
  }

  // Action processing — runs unconditionally so forced actions play
  // during speaking/listening too. Idle-spawned actions only start above.
  if (u.actionKind) {
    u.actionProgress += dt / u.actionDuration;
    const p = u.actionProgress;
    if (p >= 1) {
      u.actionKind = null;
      u.actionForced = false;
    } else {
        const bell = Math.sin(p * Math.PI);
        switch (u.actionKind) {
          case 'tilt':        tiltBonus = 0.22 * bell; break;
          case 'tiltR':       tiltBonus = -0.22 * bell; break;
          case 'bounce':      bounceBonus = 0.16 * bell; break;
          case 'wiggle':      antennaBonus = 0.35 * Math.sin(p * Math.PI * 7) * bell; break;
          case 'wave':
            leftHandWave = 0.35 * bell;
            rightHandWave = 0.12 * Math.sin(p * Math.PI * 4) * bell;
            break;
          case 'lookL':       pupilX = -0.065 * bell; pupilY = 0.01 * bell; break;
          case 'lookR':       pupilX =  0.065 * bell; pupilY = 0.01 * bell; break;
          case 'lookUp':      pupilY =  0.045 * bell; break;
          case 'lookDown':    pupilY = -0.035 * bell; break;
          case 'sparkle':     shineBoost = 1 + 1.1 * bell; break;
          case 'giggle': {
            // Big obvious giggle — bouncing, antenna swinging, blush + sparkle,
            // brief shoulder tilt. Reads clearly even mid-sentence.
            const gb = Math.abs(Math.sin(p * Math.PI * 5));
            bounceBonus = 0.20 * gb;
            antennaBonus = 0.35 * Math.sin(p * Math.PI * 6) * bell;
            blushBoost = 0.55 * bell;
            shineBoost = 1 + 0.5 * bell;
            tiltBonus = 0.06 * Math.sin(p * Math.PI * 4) * bell;
            if (p > 0.15 && p < 0.22) spawnHeart = true;
            break;
          }
          case 'doubleBlink':
            extraBlink = Math.max(
              Math.max(0, 1 - Math.abs(p - 0.25) * 10),
              Math.max(0, 1 - Math.abs(p - 0.7) * 10)
            );
            break;
          // Kitty ear twitches — just a tiny flick from rest rotation.
          case 'earL':        earBonusL = 0.35 * Math.sin(p * Math.PI * 3) * bell; break;
          case 'earR':        earBonusR = -0.35 * Math.sin(p * Math.PI * 3) * bell; break;
          // Blush pulse — cheeks bloom brighter for ~1s.
          case 'blushPulse':  blushBoost = 0.45 * bell; break;
          // Shy peek — soft extra blink + blush + small down-look.
          case 'shyPeek':
            extraBlink = 0.75 * bell;
            blushBoost = 0.4 * bell;
            pupilY = -0.025 * bell;
            tiltBonus = 0.08 * bell;
            break;
          // Heart — spawn exactly once on first frame, then animation
          // continues in the heart loop below on its own timeline.
          case 'happyHeart':
            if (p < 0.5) { spawnHeart = true; blushBoost = 0.25; }
            break;
          // Quick curious double-nod, "mhm mhm" — 2 small nods in a bell.
          case 'headBob':
            headBobBonus = 0.10 * Math.sin(p * Math.PI * 4) * bell;
            break;
          // Dance-y body sway — side to side twice, hands bob with it.
          case 'sway': {
            const s = Math.sin(p * Math.PI * 2) * bell;
            swayBonus = 0.06 * s;
            tiltBonus = 0.05 * s;
            earBonusL = 0.10 * s;
            earBonusR = -0.10 * s;
            break;
          }
          // Little stretch — tiny rise, antenna up, subtle blush.
          case 'stretch':
            bounceBonus = 0.08 * bell;
            antennaBonus = 0.12 * bell;
            blushBoost = 0.15 * bell;
            break;
          // "Boop" thinking moment — sparkle + blush + micro-tilt.
          case 'boop':
            blushBoost = 0.30 * bell;
            shineBoost = 1 + 0.7 * bell;
            tiltBonus = 0.06 * bell;
            break;
          // Chirp — 3 micro-bounces with blush + sparkle (squeaky cute).
          case 'chirp': {
            const b = Math.abs(Math.sin(p * Math.PI * 6)) * bell;
            bounceBonus = 0.07 * b;
            blushBoost = 0.25 * bell;
            shineBoost = 1 + 0.45 * bell;
            break;
          }
          // Agreeable 3-nod "mhm mhm mhm" — bigger than headBob, with blush.
          case 'nodYes':
            headBobBonus = 0.14 * Math.sin(p * Math.PI * 6) * bell;
            blushBoost = 0.15 * bell;
            break;
          // Eye twinkle — close → hold → open with a sparkle burst.
          case 'twinkle': {
            if (p < 0.35)      extraBlink = p / 0.35;
            else if (p < 0.5)  extraBlink = 1;
            else               extraBlink = Math.max(0, 1 - (p - 0.5) / 0.4);
            shineBoost = p > 0.5 ? 1 + 1.1 * Math.max(0, 1 - (p - 0.5) / 0.4) : 1;
            blushBoost = 0.2 * bell;
            break;
          }
          // Happy shake — fast body wiggle side-to-side (like a puppy shake).
          case 'shake': {
            const s = Math.sin(p * Math.PI * 9) * bell;
            swayBonus = 0.035 * s;
            tiltBonus = 0.05 * s;
            earBonusL = 0.12 * s;
            earBonusR = -0.12 * s;
            blushBoost = 0.2 * bell;
            break;
          }
          // Little hop — arc up and back down with an antenna whoosh.
          case 'hop': {
            const h = Math.max(0, Math.sin(p * Math.PI));
            bounceBonus = 0.24 * h;
            antennaBonus = 0.28 * h;
            blushBoost = 0.15 * bell;
            break;
          }
          // Both-paws wave — peppy hi-hi, hands bob together.
          case 'pawWave': {
            const w = Math.sin(p * Math.PI * 4) * bell;
            leftHandWave = 0.32 * w;
            rightHandWave = 0.32 * w;
            blushBoost = 0.2 * bell;
            shineBoost = 1 + 0.3 * bell;
            break;
          }
          // Peek-boop — paws up to cheeks + big blush + shy squeeze.
          case 'peekBoop':
            leftHandWave = 0.7 * bell;
            rightHandWave = 0.7 * bell;
            blushBoost = 0.55 * bell;
            shineBoost = 1 + 0.55 * bell;
            extraBlink = 0.25 * bell;
            break;
          // Yay — hands up bounce + heart burst + sparkle. The marquee cute.
          case 'yay':
            bounceBonus = 0.18 * bell;
            leftHandWave = 0.42 * bell;
            rightHandWave = 0.42 * bell;
            shineBoost = 1 + 0.9 * bell;
            blushBoost = 0.35 * bell;
            antennaBonus = 0.2 * bell;
            // Short burst of hearts (first ~3 frames activate 2-3 from pool).
            if (p < 0.06) spawnHeart = true;
            break;
        }
      }
    }

  // ── Reaction overlay ─────────────────────────────────────────────────
  // reactHappy / reactConcerned / reactDelighted layer their envelopes on
  // top of whatever idle/gaze state Momo is in. Values compose with the
  // idle-action bag's bonuses (tilt, blush, sparkle, hearts) so reactions
  // during a focus don't break the gaze — they decorate it.
  let reactionNod = 0, reactionConcernTilt = 0, reactionSmile = 0;
  const reactionSample = sampleReaction(u);
  if (reactionSample) {
    tiltBonus += reactionSample.concernTilt;
    shineBoost += reactionSample.sparkleBoost;
    blushBoost += reactionSample.blushBoost;
    if (reactionSample.spawnHeart) spawnHeart = true;
    reactionNod = reactionSample.nod;
    reactionConcernTilt = reactionSample.concernTilt;
    reactionSmile = reactionSample.smileBoost;
  }

  // ── Gaze tick ────────────────────────────────────────────────────────
  // Evaluated here (before the smoothing pass) so both the pupil apply
  // below AND the head-rotation block further down can read the cached
  // values. Zero allocations — the controller reuses its own scratch
  // vectors under the hood.
  let gazeYaw = 0, gazePitch = 0, gazeEyeX = 0, gazeEyeY = 0;
  if (u.gaze) {
    const g = u.gaze.tick(avatar, t, dt);
    gazeYaw = g.yaw;
    gazePitch = g.pitch;
    gazeEyeX = g.eyeX;
    gazeEyeY = g.eyeY;
  }

  // ── Look bias toward a projectable ──────────────────────────────────
  // When a chart/card mounts in the hologram column, the projectable sets
  // u.lookBias = { x, y, tilt?, duration, t0 }. We bias pupils (and
  // optionally head tilt) toward that artifact on a sin-bell so Momo
  // appears to glance at what she's showing. Runs AFTER the idle/action
  // block so it has final say over pupilX/pupilY — even if an idle
  // action fired on the same frame, the look wins.
  if (u.lookBias) {
    const bias = u.lookBias;
    const elapsed = performance.now() / 1000 - bias.t0;
    if (elapsed >= bias.duration) {
      u.lookBias = null;
    } else {
      const k = elapsed / bias.duration;
      const bell = Math.sin(k * Math.PI);
      pupilX = (bias.x || 0) * bell;
      pupilY = (bias.y || 0) * bell;
      tiltBonus = (bias.tilt || 0) * bell;
    }
  }

  // ── Smoothing pass ──────────────────────────────────────────────────
  // Every action bonus flows through an exponential lerp toward its target
  // so transitions between actions (or into/out of idle) are seamless.
  // Fast values (pupils, shine) lerp quicker; slower ones (blush, ears)
  // ease more gently.
  const ease = (a, b, k) => a + (b - a) * Math.min(1, dt * k);
  u.sPupilX  = ease(u.sPupilX,  pupilX,       10);
  u.sPupilY  = ease(u.sPupilY,  pupilY,       10);
  u.sShine   = ease(u.sShine,   shineBoost,    9);
  u.sBlush   = ease(u.sBlush,   0.75 + blushBoost * 0.35, 6);
  u.sEarL    = ease(u.sEarL,    earBonusL,     8);
  u.sEarR    = ease(u.sEarR,    earBonusR,     8);
  u.sTilt    = ease(u.sTilt,    tiltBonus,     7);
  u.sBounce  = ease(u.sBounce,  bounceBonus,   7);
  u.sAntenna = ease(u.sAntenna, antennaBonus, 10);
  u.sHandL   = ease(u.sHandL,   leftHandWave,  7);
  u.sHandR   = ease(u.sHandR,   rightHandWave, 7);
  u.sSway    = ease(u.sSway,    swayBonus,     8);
  u.sHeadNod = ease(u.sHeadNod, headBobBonus,  9);
  // Ambient "wait hum" — a tiny humming-to-myself sway that fades in after
  // ~1.5s of continuous idle and fades out the instant Momo engages. Caps
  // at 1.0 around 3s sustained idle so it never gets loud.
  const humTarget = isIdle ? Math.min(1, Math.max(0, (u.idleSustain - 1.5) / 1.5)) : 0;
  u.sIdleHum = ease(u.sIdleHum, humTarget, 2.5);

  // Apply smoothed pupils (sub-group keeps whites still while gaze moves).
  // Gaze eye offsets compose additively on top of idle eye-darts — two
  // sources of pupil motion without fighting each other. The idle-dart
  // amplitudes (~0.065) plus gaze max (0.07) sum well under the eye
  // ellipse radius so the pupils never escape the whites.
  u.leftPupils.position.x = u.sPupilX + gazeEyeX;
  u.leftPupils.position.y = u.sPupilY + gazeEyeY;
  u.rightPupils.position.x = u.sPupilX + gazeEyeX;
  u.rightPupils.position.y = u.sPupilY + gazeEyeY;
  for (const s of u.allShines) s.scale.setScalar(u.sShine);

  u.leftEar.rotation.z = u.leftEar.userData.restRot + u.sEarL;
  u.rightEar.rotation.z = u.rightEar.userData.restRot + u.sEarR;
  u.blushMat.opacity = u.sBlush;

  // Hearts — spawn on request, then float up + fade over their own life.
  if (spawnHeart) {
    for (const h of u.hearts) {
      if (!h.userData.active) {
        h.userData.active = true;
        h.userData.life = 0;
        h.userData.ox = (Math.random() - 0.5) * 0.5;
        h.userData.oy = 1.5 + Math.random() * 0.1;
        h.visible = true;
        break;
      }
    }
  }
  for (const h of u.hearts) {
    if (!h.userData.active) continue;
    h.userData.life += dt / 1.6;
    const life = h.userData.life;
    if (life >= 1) {
      h.userData.active = false;
      h.visible = false;
      h.material.opacity = 0;
      continue;
    }
    h.position.x = h.userData.ox + Math.sin(life * Math.PI * 2) * 0.08;
    h.position.y = h.userData.oy + life * 0.9;
    h.position.z = 0.1;
    // In/out fade bell
    h.material.opacity = Math.sin(life * Math.PI) * 0.95;
    // Grow then shrink
    const s = 0.18 + Math.sin(life * Math.PI) * 0.12;
    h.scale.set(s, s, 1);
  }

  // ── Base ambient motion ──────────────────────────────────────────────
  // Subtle breathing — whole-body scale at ±1.5% on a slow sine. Reads as
  // "alive" without the viewer consciously noticing.
  const breath = 1 + Math.sin(t * 1.1) * 0.015;
  u.body.scale.set(breath, breath, breath);
  u.body.position.y = Math.sin(t * 1.4) * 0.08 + u.sBounce;
  // X-position: action-driven sway + a gentle idle hum that only blooms
  // while she's actually waiting. Amplitude stays tiny so it never fights
  // the rotation sway or looks wobbly on reflector layouts.
  u.body.position.x = u.sSway + Math.sin(t * 0.9) * 0.022 * u.sIdleHum;
  u.body.rotation.y = Math.sin(t * 0.55) * 0.16;
  u.head.rotation.z = Math.sin(t * 0.8) * 0.05 + u.sTilt;

  // ── Gaze application ─────────────────────────────────────────────────
  // Apply cached gaze tick output to head yaw / pitch. The reaction nod
  // (negative pitch) rides on top of gaze pitch. reactionConcernTilt nudges
  // the existing tilt-z by a fraction so concerned reads as a head-down
  // head-cock rather than a straight pitch-down.
  u.head.rotation.y = gazeYaw;
  u.head.rotation.x = gazePitch + reactionNod + u.sHeadNod;
  u.head.rotation.z += reactionConcernTilt * 0.3;

  const handBob = u.listening ? 0.14 : 0.08;
  u.leftHand.position.y = -1.22 + Math.sin(t * 1.9) * handBob + u.sHandL;
  u.rightHand.position.y = -1.22 + Math.sin(t * 1.9 + Math.PI) * handBob + u.sHandR;

  u.antenna.rotation.z = Math.sin(t * 1.2) * 0.08 + u.sAntenna;
  // Gentler halo pulse — the large amplitude was crossing the bloom
  // threshold in/out, which read as a flash every ~2s.
  u.orbGlow.scale.setScalar(1 + Math.sin(t * 3) * 0.06);

  u.blinkTimer += dt;
  let blinkScale = 1;
  if (u.blinkTimer > u.nextBlink) {
    const b = u.blinkTimer - u.nextBlink;
    if (b < 0.1) blinkScale = 1 - b / 0.1;
    else if (b < 0.22) blinkScale = (b - 0.1) / 0.12;
    else {
      u.blinkTimer = 0;
      u.nextBlink = 1.8 + Math.random() * 3;
    }
  }
  // Combine with the doubleBlink idle action — whichever is closing
  // harder at this instant wins.
  blinkScale = Math.min(blinkScale, 1 - extraBlink);
  u.leftEye.scale.y = u.rightEye.scale.y = blinkScale;

  // If an external signal (e.g. audio analyser) is driving the mouth, use it.
  // Otherwise fall back to a faked sine-wave flap while u.speaking is true.
  const target = typeof u.mouthDrive === 'number'
    ? Math.max(0.1, Math.min(1, u.mouthDrive))
    : u.speaking
      ? 0.45 + Math.abs(Math.sin(t * 14)) * 0.55
      : u.listening
        ? 0.25
        : 0.1;
  u.mouthCurrent += (target - u.mouthCurrent) * Math.min(1, dt * 18);
  // Reaction smile: positive widens + flattens the capsule (happy/delighted),
  // negative compresses width + thickens it slightly (concerned). Values
  // are small — this is a seasoning on top of audio-driven mouth shape.
  u.mouth.scale.y = 0.22 + u.mouthCurrent * 0.9 - reactionSmile * 0.08;
  u.mouth.scale.x = 1 + u.mouthCurrent * 0.12 + reactionSmile * 0.18;
}

// Paints the nebula sky used in non-minimal mode: violet void, soft pink/
// cyan/lavender wisps, a little pink moon, and a gentle aurora band across
// the middle. One canvas, one texture, sits at infinite distance.
function buildNebulaTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d');

  const base = x.createRadialGradient(512, 512, 30, 512, 512, 720);
  base.addColorStop(0, '#120a2e');
  base.addColorStop(0.55, '#0a0622');
  base.addColorStop(1, '#020010');
  x.fillStyle = base; x.fillRect(0, 0, 1024, 1024);

  const wisps = [
    { x: 340, y: 380, r: 340, c: 'rgba(255, 100, 180, 0.22)' },
    { x: 700, y: 640, r: 360, c: 'rgba(80, 200, 255, 0.18)' },
    { x: 620, y: 280, r: 260, c: 'rgba(180, 140, 255, 0.14)' },
  ];
  for (const w of wisps) {
    const g = x.createRadialGradient(w.x, w.y, 0, w.x, w.y, w.r);
    g.addColorStop(0, w.c); g.addColorStop(1, w.c.replace(/[\d.]+\)$/, '0)'));
    x.fillStyle = g; x.fillRect(0, 0, 1024, 1024);
  }

  // Gentle horizontal aurora ribbon — soft pink→cyan gradient, low alpha.
  const aur = x.createLinearGradient(0, 480, 1024, 560);
  aur.addColorStop(0, 'rgba(255, 140, 200, 0)');
  aur.addColorStop(0.3, 'rgba(255, 140, 200, 0.08)');
  aur.addColorStop(0.6, 'rgba(140, 220, 255, 0.08)');
  aur.addColorStop(1, 'rgba(140, 220, 255, 0)');
  x.fillStyle = aur; x.fillRect(0, 440, 1024, 140);

  // Little pink moon, high-right. Halo, core, faint crater shading.
  const mx = 820, my = 220, mr = 42;
  const halo = x.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 3);
  halo.addColorStop(0, 'rgba(255, 180, 220, 0.35)');
  halo.addColorStop(1, 'rgba(255, 180, 220, 0)');
  x.fillStyle = halo; x.fillRect(mx - mr * 3, my - mr * 3, mr * 6, mr * 6);
  const moon = x.createRadialGradient(mx - mr * 0.3, my - mr * 0.3, 4, mx, my, mr);
  moon.addColorStop(0, '#ffe6f2');
  moon.addColorStop(0.7, '#ffb0d2');
  moon.addColorStop(1, '#d88bb0');
  x.fillStyle = moon;
  x.beginPath(); x.arc(mx, my, mr, 0, Math.PI * 2); x.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Options:
//   minimal: true     — pure black bg, no pedestal/grid/particles. For
//                       reflective hologram displays (Pepper's Ghost etc.)
//                       where any non-black pixel reflects as haze.
//   bare:    true     — user-facing "hide the backdrop" look. Black bg +
//                       sparkle dots + the 3 thin pedestal rings as a
//                       visual anchor under the character. No nebula,
//                       stars, crystals, grid, or big cylinder beam.
export function createHologramScene(opts = {}) {
  const { minimal = false, bare = false } = opts;
  const lite = minimal || bare;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(lite ? 0x000000 : 0x030310);
  scene.fog = lite ? null : new THREE.FogExp2(0x04001a, 0.07);

  scene.add(new THREE.HemisphereLight(0x9cc8ff, 0x220044, 0.45));
  const key = new THREE.DirectionalLight(0x00e5ff, 1.0);
  key.position.set(4, 6, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xff66b3, 0.5);
  fill.position.set(-4, 2, 3);
  scene.add(fill);
  // Overhead halo light — kept far up so it doesn't hotspot the forehead.
  const halo = new THREE.PointLight(0xaeefff, 1.8, 10);
  halo.position.set(0, 5, 0);
  scene.add(halo);

  let ringData = [];
  let beamMat = null;
  let updateParticles = null;

  if (lite) {
    // Reflector-safe sparkles. Each point carries an `aLife` attribute in
    // [0,1]; the fragment shader fades it in at life<0.2 and out at
    // life>0.8 via a smooth bell curve, so respawn is invisible (no pop,
    // no lighting flash through bloom).
    const count = 80;
    const pGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const lives = new Float32Array(count);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 1.8 + Math.random() * 2.3;
      const theta = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = -2.2 + Math.random() * 4.4;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      lives[i] = Math.random();
      speeds[i] = 0.12 + Math.random() * 0.2;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pGeo.setAttribute('aLife', new THREE.BufferAttribute(lives, 1));
    const sparkleMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xaeefff) } },
      vertexShader: `
        attribute float aLife;
        varying float vFade;
        void main() {
          vFade = smoothstep(0.0, 0.2, aLife) * (1.0 - smoothstep(0.8, 1.0, aLife));
          gl_PointSize = 4.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float a = smoothstep(0.25, 0.0, r2) * vFade;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    scene.add(new THREE.Points(pGeo, sparkleMat));

    updateParticles = (t, dt) => {
      const pos = pGeo.attributes.position.array;
      const life = pGeo.attributes.aLife.array;
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 1] += speeds[i] * dt;
        life[i] += dt / 4.5;
        if (life[i] >= 1.0) {
          life[i] = 0;
          const r = 1.8 + Math.random() * 2.3;
          const theta = Math.random() * Math.PI * 2;
          pos[i * 3] = Math.cos(theta) * r;
          pos[i * 3 + 1] = -2.2 + Math.random() * 2;
          pos[i * 3 + 2] = Math.sin(theta) * r;
          speeds[i] = 0.12 + Math.random() * 0.2;
        }
      }
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.aLife.needsUpdate = true;
    };

    if (bare) {
      // Bottom pedestal rings only — character still sits on something,
      // but nothing surrounds or floats above them. Thin, dim torii so
      // they don't steal focus from the avatar.
      for (let i = 0; i < 3; i++) {
        const r = 1.45 + i * 0.36;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(r, 0.016, 8, 96),
          new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.75 - i * 0.18 })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = -2.48 + i * 0.02;
        scene.add(ring);
        ringData.push({ mesh: ring, speed: 0.3 - i * 0.08, phase: i });
      }
    }
  } else {
    // ── Environment: nebula sky + distant stars + orbiting crystals ────
    // Canvas-painted background: deep violet void with soft cyan / pink
    // nebula wisps. Sits behind everything at infinite distance.
    scene.background = buildNebulaTexture();

    // Distant starfield — tiny points on a big sphere. Each star has its
    // own phase so the whole sky twinkles softly on a shared time uniform.
    const starCount = 600;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(starCount * 3);
    const starCol = new Float32Array(starCount * 3);
    const starPhase = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      const r = 38 + Math.random() * 18;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi);
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      const tint = Math.random();
      if (tint < 0.1)      { starCol[i*3]=1.0; starCol[i*3+1]=0.6; starCol[i*3+2]=0.85; }
      else if (tint < 0.2) { starCol[i*3]=0.6; starCol[i*3+1]=0.95; starCol[i*3+2]=1.0; }
      else                 { starCol[i*3]=1.0; starCol[i*3+1]=1.0; starCol[i*3+2]=1.0; }
      starPhase[i] = Math.random() * Math.PI * 2;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(starPhase, 1));
    const starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute vec3 color;
        attribute float aPhase;
        uniform float uTime;
        varying vec3 vColor;
        varying float vA;
        void main() {
          vColor = color;
          // Each star gently pulses between 0.55 and 1.0. Sin phase per-star
          // means the sky twinkles instead of strobing together.
          vA = 0.55 + 0.45 * (0.5 + 0.5 * sin(uTime * 1.3 + aPhase * 3.0));
          gl_PointSize = 2.3;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          float core = smoothstep(0.25, 0.0, r2);
          gl_FragColor = vec4(vColor, core * vA);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    scene.add(new THREE.Points(starGeo, starMat));
    scene.userData.starMat = starMat;

    // Floating crystal shards orbiting Momo at varied radii / heights.
    // Pink and cyan mix, emissive so they don't need lighting. Each has
    // its own orbit speed, bob, and self-rotation phase.
    const crystals = [];
    for (let i = 0; i < 10; i++) {
      const pink = i % 3 === 0;
      const size = 0.08 + Math.random() * 0.12;
      const geom = new THREE.OctahedronGeometry(size, 0);
      const mat = new THREE.MeshPhysicalMaterial({
        color: pink ? PINK : CYAN,
        emissive: pink ? PINK : CYAN,
        emissiveIntensity: 0.55,
        transparent: true, opacity: 0.75,
        roughness: 0.15, metalness: 0.1,
        clearcoat: 1, clearcoatRoughness: 0.2,
      });
      const m = new THREE.Mesh(geom, mat);
      const u = {
        radius: 2.4 + Math.random() * 1.1,
        theta0: (i / 10) * Math.PI * 2 + Math.random() * 0.6,
        speed: 0.05 + Math.random() * 0.07,
        yBase: (Math.random() - 0.5) * 2.4,
        bobAmp: 0.12 + Math.random() * 0.15,
        bobSpeed: 0.5 + Math.random() * 0.7,
        spinX: 0.2 + Math.random() * 0.4,
        spinY: 0.3 + Math.random() * 0.5,
        // Emissive shimmer — base + sine amplitude + phase per crystal so
        // they breathe out of sync with each other.
        emitBase: 0.4,
        emitAmp: 0.25,
        emitSpeed: 0.8 + Math.random() * 0.7,
        emitPhase: Math.random() * Math.PI * 2,
      };
      m.userData = u;
      scene.add(m);
      crystals.push(m);
    }
    // Stash on scene so the updater can find them.
    scene.userData.crystals = crystals;

    // ── Pedestal (existing) ────────────────────────────────────────────
    const pedestal = new THREE.Group();
    const disk = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2.25, 0.2, 64),
      new THREE.MeshStandardMaterial({
        color: 0x0a2230,
        emissive: 0x001a28,
        roughness: 0.4,
        metalness: 0.35,
      })
    );
    disk.position.y = -2.6;
    pedestal.add(disk);

    for (let i = 0; i < 3; i++) {
      const r = 1.45 + i * 0.36;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.016, 8, 96),
        new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.75 - i * 0.18 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -2.48 + i * 0.02;
      pedestal.add(ring);
      ringData.push({ mesh: ring, speed: 0.3 - i * 0.08, phase: i });
    }

    const beamGeo = new THREE.CylinderGeometry(2, 0.45, 5.2, 48, 1, true);
    beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(CYAN) } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          float edge = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          float scan = 0.5 + 0.5 * sin(vUv.y * 42.0 - uTime * 3.2);
          float a = edge * (0.09 + scan * 0.08);
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.position.y = 0;
    pedestal.add(beamMesh);
    scene.add(pedestal);

    // Softer floor grid — the new nebula sky is doing most of the
    // atmosphere work, so the ground just needs to be suggested.
    const grid = new THREE.GridHelper(24, 32, 0x00e5ff, 0x00334d);
    grid.material.transparent = true;
    grid.material.opacity = 0.2;
    grid.position.y = -2.5;
    scene.add(grid);

    const count = 260;
    const pGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = Math.random() * 3.2;
      const theta = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = Math.random() * 6 - 2.5;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      speeds[i] = 0.2 + Math.random() * 0.9;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Points(
      pGeo,
      new THREE.PointsMaterial({
        color: CYAN,
        size: 0.045,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    ));

    updateParticles = (t, dt) => {
      const pos = pGeo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 1] += speeds[i] * dt * 0.45;
        if (pos[i * 3 + 1] > 3.5) pos[i * 3 + 1] = -2.5;
      }
      pGeo.attributes.position.needsUpdate = true;
    };
  }

  // ── Pedestal-ring pulse handle ────────────────────────────────────────
  // Exposed so chart mounts can briefly brighten Momo's pedestal, reading
  // as "she just projected the panel". Each ring stores its own baseline
  // opacity so the pulse rides on top without clobbering future frames.
  const pulseState = { active: false, t0: 0, duration: 0.4 };
  function pulsePedestal() {
    pulseState.active = true;
    pulseState.t0 = performance.now() / 1000;
  }
  function applyPedestalPulse(tNow) {
    if (!pulseState.active || !ringData.length) return;
    const dt = tNow - pulseState.t0;
    if (dt >= pulseState.duration) {
      pulseState.active = false;
      // Reset to baseline
      ringData.forEach((r, i) => {
        r.mesh.material.opacity = 0.75 - i * 0.18;
      });
      return;
    }
    const bell = Math.sin((dt / pulseState.duration) * Math.PI);
    ringData.forEach((r, i) => {
      const base = 0.75 - i * 0.18;
      r.mesh.material.opacity = Math.min(1, base + bell * 0.9);
    });
  }

  // ── Sprite layer ──────────────────────────────────────────────────────
  // Cute "helper" sprites that appear when Momo delegates work (tool calls
  // or research sub-agents), run off to fetch the result, and return with
  // a label. Installed per scene so swap-between-minimal-and-full rebuilds
  // (cylinder warp mode toggle) re-seed a fresh layer; the WS + fetch
  // hookups are global so the event stream keeps flowing across swaps.
  let spriteLayer = null;
  try {
    spriteLayer = installSpriteLayer(scene, null, {});
    try { installSquadLayer(spriteLayer); } catch (err) { console.warn('[avatar] squad layer install failed', err); }
  } catch (err) {
    // Never let a sprite-layer failure break the main hologram.
    console.warn('[avatar] sprite layer install failed', err);
  }
  try {
    if (spriteLayer) installAmbientLife(spriteLayer, {});
  } catch (err) {
    console.warn('[avatar] ambient life install failed', err);
  }
  // Awareness: Momo notices her helpers. Avatar may not exist at scene-
  // build time (holo pages build the scene then create the avatar); the
  // installer polls window.__momoAvatar for a late bind.
  try { installMomoAwareness(opts.avatar || (typeof window !== 'undefined' ? window.__momoAvatar : null), spriteLayer); } catch (err) { console.warn('[avatar] awareness install failed', err); }

  return {
    scene,
    pulsePedestal,
    spriteLayer,
    update(t, dt) {
      if (beamMat) beamMat.uniforms.uTime.value = t;
      ringData.forEach((r) => { r.mesh.rotation.z = t * r.speed + r.phase; });
      applyPedestalPulse(t);
      if (updateParticles) updateParticles(t, dt);
      if (scene.userData.starMat) {
        scene.userData.starMat.uniforms.uTime.value = t;
      }
      const cs = scene.userData.crystals;
      if (cs) {
        for (const m of cs) {
          const u = m.userData;
          const theta = u.theta0 + t * u.speed;
          m.position.x = Math.cos(theta) * u.radius;
          m.position.z = Math.sin(theta) * u.radius;
          m.position.y = u.yBase + Math.sin(t * u.bobSpeed + u.theta0) * u.bobAmp;
          m.rotation.x = t * u.spinX;
          m.rotation.y = t * u.spinY;
          m.material.emissiveIntensity =
            u.emitBase + u.emitAmp * Math.sin(t * u.emitSpeed + u.emitPhase);
        }
      }
      if (spriteLayer) spriteLayer.update(t, dt);
    },
  };
}

// ─── Volumetric hologram column ─────────────────────────────────────────
// A wider translucent cyan cylinder that encloses a projectable from its
// platter up past the top of the card. Purpose: make the chart visually
// *sit inside* Momo's hologram volume, not float in air beside her. The
// chart iframe (CSS3D layer) composites on top of WebGL, so this column
// reads as light wrapping the chart's left/right/top/bottom edges — the
// parts that stick out past the iframe's footprint.
//
// Shader: additive cyan tube, inward-fresnel (brighter at grazing angles
// so the cylinder reads as a glass column), plus slow-drifting vertical
// scan bands and a tiny per-frame noise for "energy."
//
// Returns: { group, setOpacity, setTime, dispose }. Parent it into the
// same group as the chart (usually the avatar) and it inherits sway.
export function createHoloColumn({
  width = 2.4,
  height = 3.6,
  depthScale = 0.42,   // elliptical cross-section; column is wider than deep
} = {}) {
  const radiusX = width / 2;
  const radiusZ = radiusX * depthScale;

  // Use a unit cylinder and scale it so we can have an ellipse (matches
  // chart aspect — wider than deep) without a custom geometry.
  const geom = new THREE.CylinderGeometry(1, 1, height, 48, 1, true);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:    { value: 0 },
      uOpacity: { value: 0 },
      uColor:   { value: new THREE.Color(0x00e5ff) },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        // Transform normal into view space so fresnel is stable under orbit.
        vNormalView = normalize(normalMatrix * normal);
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3  uColor;
      varying vec2  vUv;
      varying vec3  vNormalView;
      varying vec3  vViewDir;
      void main() {
        // Fresnel — bright at grazing, dim face-on. Glass column look.
        float ndv = clamp(abs(dot(vNormalView, vViewDir)), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 2.0);

        // Soft top/bottom fade so the column doesn't cap hard.
        float topFade = smoothstep(0.0, 0.18, vUv.y) *
                        (1.0 - smoothstep(0.82, 1.0, vUv.y));

        // Drifting vertical bands — subtle, higher frequency than the
        // chart's scan lines so they read as ambient column "noise"
        // rather than a second scan.
        float bands = 0.5 + 0.5 * sin(vUv.y * 28.0 - uTime * 1.1);

        float a = (0.09 * fres + 0.035 * bands * fres) * topFade * uOpacity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.scale.set(radiusX, 1, radiusZ);
  // Render BEFORE the wireframe frame (renderOrder 4) so it sits visually
  // behind the chrome — column is the atmospheric volume, frame is the
  // HUD bracket on top of it.
  mesh.renderOrder = 2;

  const group = new THREE.Group();
  group.add(mesh);

  // Thin cap rings at top and bottom to crisp the column boundary.
  const capMat = new THREE.MeshBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const makeCap = (y) => {
    const capGeo = new THREE.RingGeometry(0.96, 1.02, 64);
    capGeo.rotateX(-Math.PI / 2);
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.y = y;
    cap.scale.set(radiusX, 1, radiusZ);
    cap.renderOrder = 3;
    group.add(cap);
    return { mesh: cap, geom: capGeo };
  };
  const topCap    = makeCap( height / 2);
  const bottomCap = makeCap(-height / 2);

  function setTime(t)      { mat.uniforms.uTime.value = t; }
  function setOpacity(v)   {
    mat.uniforms.uOpacity.value = v;
    capMat.opacity = 0.6 * v;
  }
  function dispose() {
    geom.dispose();
    mat.dispose();
    topCap.geom.dispose();
    bottomCap.geom.dispose();
    capMat.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return { group, setTime, setOpacity, dispose };
}

// ─── Projector ray ──────────────────────────────────────────────────────
// Thin tapered glowing cylinder from one point (typically Momo's antenna
// orb) to another (typically the chart's top-center). Parented to the
// avatar group so it sways with her. Shader animates a scan along its
// length so energy reads as flowing from Momo toward the artifact.
//
// Usage:
//   const ray = createProjectorRay({ from: V3(0, 1.42, 0), to: V3(0, 0.8, 0.8) });
//   parent.add(ray.group);
//   ray.fadeIn();
//   // per frame: ray.update(t);
//   ray.fadeOut();  // then eventually ray.dispose();
//
// The geometry is a unit cylinder we orient + scale via a matrix each
// frame, so endpoints can retarget without rebuilding geometry.
export function createProjectorRay({
  from = new THREE.Vector3(0, 1.42, 0),
  to   = new THREE.Vector3(0, 0.8, 0.8),
  startRadius = 0.012,
  endRadius   = 0.06,
} = {}) {
  // Unit cylinder: radius varies along length via vertex shader instead
  // of geometry taper so we can retarget by changing from/to only.
  const geom = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:        { value: 0 },
      uOpacity:     { value: 0 },
      uColor:       { value: new THREE.Color(0x00e5ff) },
      uStartRadius: { value: startRadius },
      uEndRadius:   { value: endRadius   },
    },
    vertexShader: `
      uniform float uStartRadius;
      uniform float uEndRadius;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // uv.y goes 0 at base (from) to 1 at top (to). Taper by radius.
        float r = mix(uStartRadius, uEndRadius, uv.y);
        vec3 pos = vec3(position.x * r, position.y, position.z * r);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3  uColor;
      varying vec2  vUv;
      void main() {
        // Scan bar travelling from source (uv.y=0) toward target (uv.y=1).
        float scanPos  = fract(uTime * 0.45);
        float scanBar  = smoothstep(0.10, 0.0, abs(vUv.y - scanPos));
        float baseLine = 0.28;
        // Soft end fades so ray doesn't cut hard at either end.
        float endFade  = smoothstep(0.0, 0.06, vUv.y) *
                         (1.0 - smoothstep(0.94, 1.0, vUv.y));
        float a = (baseLine + 0.72 * scanBar) * endFade * uOpacity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 3;
  const group = new THREE.Group();
  group.add(mesh);

  // Orient a unit cylinder (default: axis along +Y, length 1, centered
  // at origin) so its base is at `from` and its top is at `to`.
  // Scale y to length, translate midpoint, rotate axis to (to-from).
  const _y = new THREE.Vector3(0, 1, 0);
  const _dir = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _mid = new THREE.Vector3();

  function retarget(newFrom, newTo) {
    if (newFrom) from.copy(newFrom);
    if (newTo)   to.copy(newTo);
    _dir.copy(to).sub(from);
    const len = _dir.length();
    if (len < 1e-4) { mesh.visible = false; return; }
    mesh.visible = true;
    _dir.divideScalar(len);
    _q.setFromUnitVectors(_y, _dir);
    _mid.copy(from).add(to).multiplyScalar(0.5);
    mesh.position.copy(_mid);
    mesh.quaternion.copy(_q);
    mesh.scale.set(1, len, 1);
  }
  retarget();

  function setTime(t)    { mat.uniforms.uTime.value    = t; }
  function setOpacity(v) { mat.uniforms.uOpacity.value = v; }

  function dispose() {
    geom.dispose();
    mat.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return { group, retarget, setTime, setOpacity, dispose };
}

// ─── Chart-platter companion factory ────────────────────────────────────
// Builds the WebGL stage underneath a chart panel: a cyan disc, a pulsing
// inner ring, an upward projector beam to the panel's base, and a small
// pool of upward-drifting sparkle particles — all additive, all in the
// same cyan/pink/ice palette as Momo's pedestal.
//
// Caller wires this into the same Three.js scene:
//   const platter = createChartPlatter({ scene, position, panelY });
//   platter.fadeIn();         // entrance
//   platter.update(t, dt);    // every frame
//   platter.fadeOut();        // exit; call platter.dispose() once gone
//
// `position`  THREE.Vector3   world-space anchor (platter sits here)
// `panelY`    number          y offset above platter where the chart lives;
//                             the beam grows from platter top → panelY
// `pedestalY` number          y of Momo's pedestal (default -2.48); the
//                             beam's bottom tapers toward this so it feels
//                             connected to her rig
export function createChartPlatter({
  scene,
  position = new THREE.Vector3(1.6, 0.2, 0),
  panelY = 0.9,
  pedestalY = -2.48,
} = {}) {
  const group = new THREE.Group();
  group.position.copy(position);
  // All children fade in/out via this group's visibility + per-material
  // opacity uniforms; we lerp toward `targetOpacity` each frame.
  group.userData.opacity = 0;
  group.userData.targetOpacity = 0;

  // ── Platter disc ──────────────────────────────────────────────────────
  // A thin filled cyan disc that sits flat (lying in the XZ plane). Same
  // additive style as Momo's pedestal ring stack.
  const discGeom = new THREE.CircleGeometry(0.58, 64);
  discGeom.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(discGeom, discMat);
  disc.position.y = 0;
  group.add(disc);

  // ── Outer ring ────────────────────────────────────────────────────────
  const outerRingGeom = new THREE.RingGeometry(0.54, 0.6, 96);
  outerRingGeom.rotateX(-Math.PI / 2);
  const outerRingMat = new THREE.MeshBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const outerRing = new THREE.Mesh(outerRingGeom, outerRingMat);
  outerRing.position.y = 0.002;
  group.add(outerRing);

  // ── Inner pulsing ring ────────────────────────────────────────────────
  const innerRingGeom = new THREE.RingGeometry(0.3, 0.34, 64);
  innerRingGeom.rotateX(-Math.PI / 2);
  const innerRingMat = new THREE.MeshBasicMaterial({
    color: PINK_GLOW,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const innerRing = new THREE.Mesh(innerRingGeom, innerRingMat);
  innerRing.position.y = 0.004;
  group.add(innerRing);

  // ── Projector beam ────────────────────────────────────────────────────
  // Thin cone/cylinder in the same shader language as the pedestal beam,
  // travelling from platter top up to the panel's base. We parent it to
  // the group at local y=0 and scale its height on entrance.
  const beamHeight = Math.max(0.1, panelY);
  const beamGeo = new THREE.CylinderGeometry(0.08, 0.22, 1.0, 32, 1, true);
  const platterBeamMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(CYAN) },
      uOpacity: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        // Thin, top-fading cone — the bottom flares a touch brighter so
        // the beam feels anchored at the platter.
        float edge = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.65, 1.0, vUv.y));
        float scan = 0.5 + 0.5 * sin(vUv.y * 36.0 - uTime * 3.2);
        float a = edge * (0.1 + scan * 0.08) * uOpacity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(beamGeo, platterBeamMat);
  // Anchor the cylinder so its base sits at y=0 and top at y=beamHeight.
  beam.position.y = beamHeight / 2;
  beam.scale.y = 0.001; // collapsed; grows on entrance
  group.add(beam);

  // ── Sparkle emitters ──────────────────────────────────────────────────
  // Upward-drifting cyan-ice dots rising off the platter edge. Same shader
  // pattern as reflector-minimal mode.
  const SPARK_COUNT = 40;
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(SPARK_COUNT * 3);
  const sparkLife = new Float32Array(SPARK_COUNT);
  const sparkSpeed = new Float32Array(SPARK_COUNT);
  for (let i = 0; i < SPARK_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    const r = 0.45 + Math.random() * 0.2;
    sparkPos[i * 3] = Math.cos(theta) * r;
    sparkPos[i * 3 + 1] = Math.random() * 0.8;
    sparkPos[i * 3 + 2] = Math.sin(theta) * r;
    sparkLife[i] = Math.random();
    sparkSpeed[i] = 0.15 + Math.random() * 0.25;
  }
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('aLife', new THREE.BufferAttribute(sparkLife, 1));
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xaeefff) },
      uOpacity: { value: 0 },
    },
    vertexShader: `
      attribute float aLife;
      varying float vFade;
      void main() {
        vFade = smoothstep(0.0, 0.2, aLife) * (1.0 - smoothstep(0.8, 1.0, aLife));
        gl_PointSize = 5.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float a = smoothstep(0.25, 0.0, r2) * vFade * uOpacity;
        gl_FragColor = vec4(uColor, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  group.add(sparks);

  scene.add(group);

  // ── Reduced-motion check ──────────────────────────────────────────────
  const reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── State + transitions ───────────────────────────────────────────────
  let phase = 'hidden'; // hidden | entering | live | leaving | dead
  let phaseT = 0;
  const ENTER_DUR = reduceMotion ? 0.25 : 0.56;
  const EXIT_DUR  = reduceMotion ? 0.2  : 0.36;

  function fadeIn() {
    phase = 'entering';
    phaseT = 0;
  }
  function fadeOut() {
    if (phase === 'hidden' || phase === 'dead') return;
    phase = 'leaving';
    phaseT = 0;
  }

  function update(t, dt) {
    if (phase === 'dead') return;
    platterBeamMat.uniforms.uTime.value = t;

    // Opacity envelope per phase.
    if (phase === 'entering') {
      phaseT += dt;
      const k = Math.min(1, phaseT / ENTER_DUR);
      const eased = 1 - Math.pow(1 - k, 3); // cubicOut
      group.userData.opacity = eased;
      beam.scale.y = Math.max(0.001, eased);
      if (k >= 1) { phase = 'live'; group.userData.opacity = 1; }
    } else if (phase === 'leaving') {
      phaseT += dt;
      const k = Math.min(1, phaseT / EXIT_DUR);
      const eased = k * k;
      group.userData.opacity = 1 - eased;
      beam.scale.y = Math.max(0.001, 1 - eased);
      if (k >= 1) { phase = 'dead'; group.userData.opacity = 0; group.visible = false; }
    } else if (phase === 'live') {
      group.userData.opacity = 1;
    }

    const op = group.userData.opacity;
    discMat.opacity   = 0.35 * op;
    outerRingMat.opacity = 0.9 * op;
    // Breathing inner ring — pulse radius slightly via scale and opacity.
    const pulse = reduceMotion ? 1 : (1 + Math.sin(t * 2.4) * 0.08);
    innerRing.scale.set(pulse, 1, pulse);
    innerRingMat.opacity = (0.45 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.4))) * op;
    platterBeamMat.uniforms.uOpacity.value = op;
    sparkMat.uniforms.uOpacity.value = op;

    // Sparkle drift.
    const pos = sparkGeo.attributes.position.array;
    const life = sparkGeo.attributes.aLife.array;
    for (let i = 0; i < SPARK_COUNT; i++) {
      pos[i * 3 + 1] += sparkSpeed[i] * dt;
      life[i] += dt / 2.4;
      if (life[i] >= 1 || pos[i * 3 + 1] > panelY) {
        life[i] = 0;
        const theta = Math.random() * Math.PI * 2;
        const r = 0.45 + Math.random() * 0.2;
        pos[i * 3] = Math.cos(theta) * r;
        pos[i * 3 + 1] = 0;
        pos[i * 3 + 2] = Math.sin(theta) * r;
        sparkSpeed[i] = 0.15 + Math.random() * 0.25;
      }
    }
    sparkGeo.attributes.position.needsUpdate = true;
    sparkGeo.attributes.aLife.needsUpdate = true;
  }

  function dispose() {
    scene.remove(group);
    [discGeom, outerRingGeom, innerRingGeom, beamGeo, sparkGeo].forEach((g) => g.dispose());
    [discMat, outerRingMat, innerRingMat, platterBeamMat, sparkMat].forEach((m) => m.dispose());
  }

  return {
    group,
    fadeIn,
    fadeOut,
    update,
    dispose,
    isDead: () => phase === 'dead',
  };
}

// ─── Hologram frame ──────────────────────────────────────────────────────
// Builds a cyan wireframe "bracket cube" that encloses the chart panel —
// the Iron-Man-HUD frame readers expect to see around a holographic display.
// Returns a Group with:
//   - 12 edges of a wireframe cube (LineSegments, additive cyan)
//   - 4 tiny corner marker cubes at the front face for sci-fi polish
//   - a `setOpacity(v)` helper so the chart-layer can fade it in/out
//   - a `dispose()` helper that drops geometries + materials
// Sized so it sits slightly PROUD of the chart: width/height/depth map to
// the chart panel's world dimensions; the caller inflates by ~5% so the
// lines read as a frame around, not on top of, the chart.
export function createHologramFrame({ width = 2.0, height = 1.2, depth = 0.2 } = {}) {
  const group = new THREE.Group();

  const hw = width / 2, hh = height / 2, hd = depth / 2;
  // 8 corners of the cube.
  const corners = [
    [-hw, -hh, -hd], [ hw, -hh, -hd], [ hw,  hh, -hd], [-hw,  hh, -hd],
    [-hw, -hh,  hd], [ hw, -hh,  hd], [ hw,  hh,  hd], [-hw,  hh,  hd],
  ];
  // 12 edge pairs (index pairs into corners).
  const edges = [
    [0,1],[1,2],[2,3],[3,0],          // back face
    [4,5],[5,6],[6,7],[7,4],          // front face
    [0,4],[1,5],[2,6],[3,7],          // connecting edges
  ];
  const positions = new Float32Array(edges.length * 2 * 3);
  let p = 0;
  for (const [a, b] of edges) {
    positions[p++] = corners[a][0]; positions[p++] = corners[a][1]; positions[p++] = corners[a][2];
    positions[p++] = corners[b][0]; positions[p++] = corners[b][1]; positions[p++] = corners[b][2];
  }
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const edgeMat = new THREE.LineBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
  // Draw after the card so the additive lines composite crisply on top of
  // the translucent black panel behind them.
  edgeLines.renderOrder = 4;
  group.add(edgeLines);

  // Corner marker cubes on the front face — tiny solid cyan boxes.
  const markerGeo = new THREE.BoxGeometry(0.045, 0.045, 0.045);
  const markerMat = new THREE.MeshBasicMaterial({
    color: CYAN,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const markerPositions = [
    [-hw, -hh, hd], [ hw, -hh, hd],
    [-hw,  hh, hd], [ hw,  hh, hd],
  ];
  const markers = [];
  for (const [x, y, z] of markerPositions) {
    const m = new THREE.Mesh(markerGeo, markerMat);
    m.position.set(x, y, z);
    m.renderOrder = 4;
    group.add(m);
    markers.push(m);
  }

  function setOpacity(v) {
    edgeMat.opacity = 0.5 * v;
    markerMat.opacity = 0.85 * v;
  }
  function dispose() {
    edgeGeo.dispose();
    edgeMat.dispose();
    markerGeo.dispose();
    markerMat.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return { group, setOpacity, dispose };
}

// ─── Scan-line plane ─────────────────────────────────────────────────────
// A flat WebGL plane with a custom shader that drifts faint horizontal
// cyan scan lines upward over time. Parented alongside the chart (same
// world pose, same size) to overlay the translucent DOM card with a
// real-time hologram animation that CSS can't replicate (bloom+additive
// compositing inside the Three.js pipeline).
//
// Returns a Mesh-like wrapper with:
//   - mesh: the THREE.Mesh to add to the scene/parent
//   - setTime(t): drives the scan drift (host calls from render loop)
//   - setOpacity(v): master fade for entrance/exit
//   - dispose(): drops geometry + shader material
export function createScanLinePlane({ width = 2.0, height = 1.2 } = {}) {
  const geom = new THREE.PlaneGeometry(width, height, 1, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:    { value: 0 },
      uOpacity: { value: 0 },
      // 0..1 — drives the one-shot bright "print" bar up the plane. Host
      // ticks this from 0 → 1 over ~700ms on mount, then leaves it at 1
      // (no further sweep). Below 1, a thick bright bar rides at uv.y =
      // uReveal, overwriting the subtle drifting scan lines so the chart
      // reads as being *printed* into the hologram instead of fading in.
      uReveal:  { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uReveal;
      void main() {
        // Horizontal scan lines drifting upward over time.
        float y = vUv.y - uTime * 0.08;
        float lines = smoothstep(0.49, 0.5, sin(y * 60.0) * 0.5 + 0.5);
        float alpha = lines * 0.12 + 0.02; // faint overall
        // Fade the top and bottom edges so the lines don't cut hard.
        float edgeFade = smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.9, vUv.y);

        // Mount-time print bar — a fat bright cyan bar at uv.y = uReveal
        // while uReveal < 1, tapering to nothing once reveal completes.
        float revealActive = step(uReveal, 0.999);
        float barDist   = abs(vUv.y - uReveal);
        float bar       = smoothstep(0.05, 0.0, barDist) * revealActive;
        float barAlpha  = bar * 0.75;

        float a = (alpha + barAlpha) * edgeFade * uOpacity;
        gl_FragColor = vec4(0.0, 0.9, 1.0, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  // Composite over the card frame.
  mesh.renderOrder = 5;

  function setTime(t) {
    mat.uniforms.uTime.value = t;
  }
  function setOpacity(v) {
    mat.uniforms.uOpacity.value = v;
  }
  function setReveal(v) {
    mat.uniforms.uReveal.value = v;
  }
  function dispose() {
    geom.dispose();
    mat.dispose();
    if (mesh.parent) mesh.parent.remove(mesh);
  }

  return { mesh, setTime, setOpacity, setReveal, dispose };
}

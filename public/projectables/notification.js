// NotificationProjectable — the ambient "glance" pill. Slides in from
// offscreen-right, perches in the upper-right of the hologram stage,
// waits for its TTL, then slides back out. Unlike StatusProjectable the
// notification has no platter and no hologram chrome column: it reads as
// a fleeting detached card, not an object welded into the hologram.
//
// Lifecycle:
//   pending → entering (slide in) → live → (TTL) → leaving (slide out) → dead
//
// Factory signature (chart-layer.js will wire this into FACTORIES):
//   createNotificationProjectable({ title, detail, icon, accent, ttlMs, onDismiss? })
// Receives the same shape as render_notification's response mapped through:
//   notification: (r) => createNotificationProjectable({
//     title: r.title, detail: r.detail,
//     icon: r.icon, accent: r.accent,
//     ttlMs: Number.isInteger(r.ttl_ms) ? r.ttl_ms : 4500,
//   })

import {
  mintProjectableId,
  CSS3D_SCALE,
  prefersReducedMotion,
} from './base.js';

const NOTIFICATION_STYLE_ID = 'holo-notification-styles';

// Slide-in is short — the pill should feel reactive, not produced.
const ENTER_MS = 360;
const EXIT_MS  = 320;

// Panel dimensions in CSS pixels. Sized like stat (~stat card) so the
// pill reads as a compact single-line band.
const PANEL_W = 340;
const PANEL_H = 78;

// Perch pose in avatar-local coordinates. Upper-right of the hologram
// column: +x offset puts it beside Momo rather than over her face,
// +y lifts it toward eye level, +z pulls it forward so it doesn't
// clip the column.
const PERCH = Object.freeze({
  x:  0.65,
  y:  1.00,
  z:  0.80,
  tilt: -6 * Math.PI / 180,
});

// Offscreen-right hiding spot — same y/z as perch so the slide is pure
// lateral. The world scale is small enough that x=+3.0 sits well beyond
// the visible frame.
const OFFSCREEN_X = 3.0;

const VALID_ICONS = new Set(['email', 'bell', 'check', 'warn']);
const VALID_ACCENTS = new Set(['cyan', 'pink', 'amber']);

export function createNotificationProjectable({
  title = 'NOTIFICATION',
  detail = '',
  icon = 'bell',
  accent = 'cyan',
  ttlMs = 4500,
  onDismiss,
} = {}) {
  const id = mintProjectableId('notification');
  const iconKey = VALID_ICONS.has(icon) ? icon : 'bell';
  const accentKey = VALID_ACCENTS.has(accent) ? accent : 'cyan';

  // ── DOM ────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = `holo-notif-wrap holo-notif--${accentKey}`;
  wrap.dataset.projectableId = id;
  wrap.style.width  = PANEL_W + 'px';
  wrap.style.height = PANEL_H + 'px';

  const card = document.createElement('div');
  card.className = 'holo-notif-card';

  const iconEl = document.createElement('div');
  iconEl.className = 'holo-notif-icon';
  iconEl.innerHTML = iconGlyph(iconKey);
  card.appendChild(iconEl);

  const main = document.createElement('div');
  main.className = 'holo-notif-main';

  const titleEl = document.createElement('div');
  titleEl.className = 'holo-notif-title';
  titleEl.textContent = String(title || '').toUpperCase();
  main.appendChild(titleEl);

  const detailEl = document.createElement('div');
  detailEl.className = 'holo-notif-detail';
  detailEl.textContent = String(detail || '');
  main.appendChild(detailEl);

  card.appendChild(main);

  const rail = document.createElement('div');
  rail.className = 'holo-notif-rail';
  card.appendChild(rail);

  wrap.appendChild(card);

  // ── State ──────────────────────────────────────────────────────────
  let phase = 'pending';
  let phaseStart = 0;
  let ttlStart = 0;
  let css3dObj = null;
  const avatarTarget = { x: 0, y: 0, z: 0 };

  // Reduced-motion: keep the slide but cut the duration by a third and
  // skip overshoot easing. Users who opt out of motion still get a
  // legible arrival/departure, just faster.
  const reducedMotion = prefersReducedMotion();
  const enterMs = reducedMotion ? Math.round(ENTER_MS * 0.65) : ENTER_MS;
  const exitMs  = reducedMotion ? Math.round(EXIT_MS  * 0.65) : EXIT_MS;

  function enter({ avatarObj, scene, CSS3DObject }) {
    ensureCSS();

    phase = 'entering';
    phaseStart = performance.now() / 1000;
    ttlStart = ttlMs > 0 ? phaseStart + ttlMs / 1000 : 0;

    const parent = avatarObj || scene;
    css3dObj = new CSS3DObject(wrap);
    // Start offscreen; tick() slides us to PERCH.
    css3dObj.position.set(OFFSCREEN_X, PERCH.y, PERCH.z);
    css3dObj.scale.setScalar(CSS3D_SCALE);
    css3dObj.rotation.order = 'YXZ';
    css3dObj.rotation.x = PERCH.tilt;
    css3dObj.userData.projectableId = id;
    parent.add(css3dObj);

    // Two RAFs so the fade-in class lands after the initial layout, same
    // pattern as status.js — keeps the first frame clean.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => wrap.classList.add('is-entering'));
    });
  }

  // Slide easing — cubicOut on enter for a decisive arrival, cubicIn on
  // exit for a snappy clear. The small overshoot (1.04 on enter, -0.04
  // on exit) gives the pill a light "settling" feel without being
  // bouncy. Reduced-motion paths just use linear.
  function easeEnter(t) {
    const c = 1 - Math.pow(1 - t, 3);
    if (reducedMotion) return c;
    // overshoot curve: slight past-the-target at ~0.75, settle to 1 at end
    const p = 0.04 * Math.sin(Math.PI * c);
    return Math.min(1, Math.max(0, c + p * (1 - c)));
  }
  function easeExit(t) { return reducedMotion ? t : t * t; }

  function tick(t, _dt, _camera, localYaw) {
    if (!css3dObj) return;
    // Keep the pill yaw-mirroring the avatar's heading like status cards
    // do, so Momo turning her head doesn't desync the pill.
    css3dObj.rotation.set(PERCH.tilt, localYaw, 0);

    if (phase === 'entering') {
      const elapsed = (t - phaseStart) * 1000;
      const u = Math.min(1, elapsed / enterMs);
      const e = easeEnter(u);
      const x = OFFSCREEN_X + (PERCH.x - OFFSCREEN_X) * e;
      css3dObj.position.set(x, PERCH.y, PERCH.z);
      if (u >= 1) {
        phase = 'live';
        css3dObj.position.set(PERCH.x, PERCH.y, PERCH.z);
        wrap.classList.add('is-ready');
      }
    }

    if (phase === 'live' && ttlStart && t >= ttlStart) {
      exit();
    }

    if (phase === 'leaving') {
      const elapsed = (t - phaseStart) * 1000;
      const u = Math.min(1, elapsed / exitMs);
      const e = easeExit(u);
      const x = PERCH.x + (OFFSCREEN_X - PERCH.x) * e;
      css3dObj.position.set(x, PERCH.y, PERCH.z);
      if (u >= 1) finalize();
    }
  }

  function exit() {
    if (phase === 'dead' || phase === 'leaving') return;
    phase = 'leaving';
    phaseStart = performance.now() / 1000;
    ttlStart = 0;
    wrap.classList.remove('is-entering', 'is-ready');
    wrap.classList.add('is-leaving');
  }

  function finalize() {
    if (phase === 'dead') return;
    phase = 'dead';
    if (css3dObj && css3dObj.parent) css3dObj.parent.remove(css3dObj);
    try { wrap.remove(); } catch (_) {}
    if (typeof onDismiss === 'function') {
      try { onDismiss(id); } catch (_) {}
    }
  }

  function dispose() { finalize(); }

  function update({ title: nt, detail: nd, icon: ni, accent: na } = {}) {
    if (nt != null) titleEl.textContent = String(nt).toUpperCase();
    if (nd != null) detailEl.textContent = String(nd);
    if (ni != null && VALID_ICONS.has(ni)) iconEl.innerHTML = iconGlyph(ni);
    if (na != null && VALID_ACCENTS.has(na)) {
      wrap.className = `holo-notif-wrap holo-notif--${na}`;
      if (phase === 'entering') wrap.classList.add('is-entering');
      if (phase === 'live')     wrap.classList.add('is-entering', 'is-ready');
      if (phase === 'leaving')  wrap.classList.add('is-leaving');
    }
  }

  return {
    id,
    kind: 'notification',
    sizeName: 'stat',
    avatarTarget,
    getObject3D: () => css3dObj,
    enter,
    tick,
    exit,
    dispose,
    update,
    isDead: () => phase === 'dead',
  };
}

function iconGlyph(name) {
  switch (name) {
    case 'email':
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l8 6 8-6M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/></svg>';
    case 'check':
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    case 'warn':
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
    case 'bell':
    default:
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>';
  }
}

function ensureCSS() {
  if (document.getElementById(NOTIFICATION_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = NOTIFICATION_STYLE_ID;
  s.textContent = NOTIFICATION_CSS;
  document.head.appendChild(s);
}

const NOTIFICATION_CSS = `
  .holo-notif-wrap {
    position: relative;
    opacity: 0;
    pointer-events: none;
    transition: opacity ${ENTER_MS}ms ease;
    perspective: 1200px;
    transform-style: preserve-3d;
  }
  .holo-notif-wrap.is-entering { opacity: 1; }
  .holo-notif-wrap.is-leaving {
    opacity: 0;
    transition: opacity ${EXIT_MS}ms ease;
  }

  .holo-notif-card {
    position: relative;
    width: 100%; height: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    box-sizing: border-box;
    border-radius: 14px;
    background:
      linear-gradient(180deg, rgba(0,229,255,0.075) 0%, rgba(0,0,0,0) 55%),
      rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(8px);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.38) inset,
      0 0 0 1px rgba(0, 229, 255, 0.08),
      0 12px 40px rgba(0, 0, 0, 0.55);
    isolation: isolate;
    overflow: hidden;
    font-family: "SF Pro Text", system-ui, sans-serif;
  }

  .holo-notif-icon {
    flex: 0 0 auto;
    width: 36px; height: 36px;
    border-radius: 10px;
    background: rgba(0, 229, 255, 0.10);
    border: 1px solid rgba(0, 229, 255, 0.42);
    color: #00e5ff;
    display: inline-flex;
    align-items: center; justify-content: center;
    box-shadow: 0 0 10px rgba(0, 229, 255, 0.25) inset;
  }
  .holo-notif-icon svg { filter: drop-shadow(0 0 4px currentColor); }

  .holo-notif-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .holo-notif-title {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.22em;
    color: #00e5ff;
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.55);
    white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .holo-notif-detail {
    font-size: 12.5px;
    color: rgba(255, 255, 255, 0.92);
    line-height: 1.25;
    white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .holo-notif-rail {
    position: absolute;
    top: 12%; bottom: 12%;
    right: 6px;
    width: 2px;
    border-radius: 1px;
    background: linear-gradient(180deg, rgba(0,229,255,0), #00e5ff 50%, rgba(0,229,255,0));
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.85);
    opacity: 0.9;
  }

  /* Breathe on the ring while live so it reads as active. */
  .holo-notif-wrap.is-ready .holo-notif-card {
    animation: notif-breathe 2.8s ease-in-out infinite;
  }
  @keyframes notif-breathe {
    0%, 100% {
      box-shadow:
        0 0 0 1px rgba(0, 229, 255, 0.32) inset,
        0 0 0 1px rgba(0, 229, 255, 0.06),
        0 12px 40px rgba(0, 0, 0, 0.55);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(0, 229, 255, 0.52) inset,
        0 0 0 3px rgba(0, 229, 255, 0.12),
        0 12px 40px rgba(0, 0, 0, 0.55);
    }
  }

  /* Pink variant */
  .holo-notif--pink .holo-notif-icon {
    color: #ff66b3;
    background: rgba(255, 102, 179, 0.10);
    border-color: rgba(255, 102, 179, 0.42);
  }
  .holo-notif--pink .holo-notif-title {
    color: #ff66b3;
    text-shadow: 0 0 6px rgba(255, 102, 179, 0.55);
  }
  .holo-notif--pink .holo-notif-card {
    box-shadow:
      0 0 0 1px rgba(255, 102, 179, 0.38) inset,
      0 0 0 1px rgba(255, 102, 179, 0.08),
      0 12px 40px rgba(0, 0, 0, 0.55);
  }
  .holo-notif--pink .holo-notif-rail {
    background: linear-gradient(180deg, rgba(255,102,179,0), #ff66b3 50%, rgba(255,102,179,0));
    box-shadow: 0 0 8px rgba(255, 102, 179, 0.85);
  }
  .holo-notif--pink.is-ready .holo-notif-card {
    animation: notif-breathe-pink 2.8s ease-in-out infinite;
  }
  @keyframes notif-breathe-pink {
    0%, 100% {
      box-shadow:
        0 0 0 1px rgba(255, 102, 179, 0.32) inset,
        0 0 0 1px rgba(255, 102, 179, 0.06),
        0 12px 40px rgba(0, 0, 0, 0.55);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(255, 102, 179, 0.52) inset,
        0 0 0 3px rgba(255, 102, 179, 0.12),
        0 12px 40px rgba(0, 0, 0, 0.55);
    }
  }

  /* Amber variant */
  .holo-notif--amber .holo-notif-icon {
    color: #ffcf66;
    background: rgba(255, 207, 102, 0.10);
    border-color: rgba(255, 207, 102, 0.42);
  }
  .holo-notif--amber .holo-notif-title {
    color: #ffcf66;
    text-shadow: 0 0 6px rgba(255, 207, 102, 0.55);
  }
  .holo-notif--amber .holo-notif-card {
    box-shadow:
      0 0 0 1px rgba(255, 207, 102, 0.38) inset,
      0 0 0 1px rgba(255, 207, 102, 0.08),
      0 12px 40px rgba(0, 0, 0, 0.55);
  }
  .holo-notif--amber .holo-notif-rail {
    background: linear-gradient(180deg, rgba(255,207,102,0), #ffcf66 50%, rgba(255,207,102,0));
    box-shadow: 0 0 8px rgba(255, 207, 102, 0.85);
  }
  .holo-notif--amber.is-ready .holo-notif-card {
    animation: notif-breathe-amber 2.8s ease-in-out infinite;
  }
  @keyframes notif-breathe-amber {
    0%, 100% {
      box-shadow:
        0 0 0 1px rgba(255, 207, 102, 0.32) inset,
        0 0 0 1px rgba(255, 207, 102, 0.06),
        0 12px 40px rgba(0, 0, 0, 0.55);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(255, 207, 102, 0.52) inset,
        0 0 0 3px rgba(255, 207, 102, 0.12),
        0 12px 40px rgba(0, 0, 0, 0.55);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .holo-notif-wrap.is-ready .holo-notif-card { animation: none; }
  }
`;

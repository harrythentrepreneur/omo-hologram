// StatusProjectable — a small DOM-backed card Momo materializes above her
// head while she's thinking, waiting on a tool result, or surfacing a
// fire-and-forget status (incoming email preview, calendar next-up, task
// complete flourish). Shares the same lifecycle contract + hologram
// chrome bundle as ChartProjectable so swapping artifacts is just a new
// file under projectables/.
//
// Why DOM-in-CSS3DObject instead of an iframe:
//   A thinking card materializes in response to local client events — a
//   tool call just went out, a notification just arrived — not a Gemini-
//   side tool call. There's no untrusted content to render, no ECharts
//   needed, and a direct DOM node avoids an iframe boot. The chrome
//   bundle (wireframe + scan-line + optional platter) still welds it into
//   the hologram column so it reads as the same kind of object.

import {
  mintProjectableId,
  POSE,
  PANEL_PX,
  CSS3D_SCALE,
  panelWorldSize,
  prefersReducedMotion,
} from './base.js';
import { attachChrome } from '../hologram-chrome.js';

const STATUS_STYLE_ID = 'holo-status-styles';

// Match the feel of the chart-card entrance (scan-line paint → content
// fade → settle) but shorter since there's no iframe boot to hide behind.
const ENTER_MS = 320;
const EXIT_MS  = 280;

export const STATUS_VARIANTS = Object.freeze({
  thinking:  'thinking',    // active tool call; spinner dot
  complete:  'complete',    // task done; checkmark flash
  incoming:  'incoming',    // inbound email / calendar preview
  alert:     'alert',       // attention flag; pink accent
});

/**
 * @param {object} opts
 *   @prop {string} title     TOP line, uppercase (e.g. "THINKING", "EMAIL IN")
 *   @prop {string=} detail   subtitle line (e.g. "get_recent_orders", "From: Stripe")
 *   @prop {string=} variant  STATUS_VARIANTS key; default 'thinking'
 *   @prop {string=} pose     POSE key; default 'thought'
 *   @prop {number=} ttlMs    auto-dismiss after this many ms; 0 = manual
 *   @prop {boolean=} withPlatter default false — tiny cards look silly on a platter
 *   @prop {(id:string)=>void=} onDismiss  called when projectable finishes exit
 */
export function createStatusProjectable({
  title = 'THINKING',
  detail = '',
  variant = STATUS_VARIANTS.thinking,
  pose: poseName = 'thought',
  ttlMs = 0,
  withPlatter = false,
  onDismiss,
} = {}) {
  const id = mintProjectableId('status');
  const pose = POSE[poseName] || POSE.thought;
  const panelPx = PANEL_PX[poseName] || PANEL_PX.thought;
  const worldSize = panelWorldSize(poseName);

  // ── DOM ───────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = `holo-status-wrap holo-status--${variant}`;
  wrap.dataset.projectableId = id;
  wrap.style.width  = panelPx.w + 'px';
  wrap.style.height = panelPx.h + 'px';

  const card = document.createElement('div');
  card.className = 'holo-status-card';

  const titleEl = document.createElement('div');
  titleEl.className = 'holo-status-title';
  titleEl.textContent = String(title || '').toUpperCase();
  card.appendChild(titleEl);

  const detailEl = document.createElement('div');
  detailEl.className = 'holo-status-detail';
  detailEl.textContent = String(detail || '');
  card.appendChild(detailEl);

  const iconEl = document.createElement('div');
  iconEl.className = 'holo-status-icon';
  iconEl.innerHTML = variantGlyph(variant);
  card.appendChild(iconEl);

  // Scan-line drawer for the entrance — same visual vocabulary as charts.
  const scan = document.createElement('div');
  scan.className = 'holo-status-scan';
  card.appendChild(scan);

  wrap.appendChild(card);

  // ── State ─────────────────────────────────────────────────────────────
  let phase = 'pending';
  let phaseStart = 0;
  let ttlStart = 0;               // absolute time at which TTL should fire
  let css3dObj = null;
  let chrome = null;

  const avatarTarget = { x: 0, y: 0, z: 0 };  // status doesn't lean Momo

  function enter({ avatarObj, scene, CSS3DObject, sceneCtl }) {
    ensureCSS();

    phase = 'entering';
    phaseStart = performance.now() / 1000;
    ttlStart = ttlMs > 0 ? phaseStart + ttlMs / 1000 : 0;

    const parent = avatarObj || scene;
    css3dObj = new CSS3DObject(wrap);
    css3dObj.position.set(pose.x, pose.y, pose.z);
    css3dObj.scale.setScalar(CSS3D_SCALE);
    css3dObj.rotation.order = 'YXZ';
    css3dObj.rotation.x = pose.tilt;
    css3dObj.userData.projectableId = id;
    parent.add(css3dObj);

    chrome = attachChrome(parent, pose, worldSize, { sceneCtl, withPlatter });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => wrap.classList.add('is-entering'));
    });
  }

  // Tick owns the phase machine: entering → live by elapsed time, live →
  // leaving when the TTL fires, leaving → dead once the chrome finishes
  // fading. No setTimeouts — that way state can't drift away from the
  // Choreographer if the world pauses.
  function tick(t, _dt, _camera, localYaw) {
    if (!css3dObj) return;
    css3dObj.rotation.set(pose.tilt, localYaw, 0);
    if (chrome) {
      chrome.tick(t);
      chrome.mirrorYaw(localYaw);
    }

    if (phase === 'entering') {
      const elapsed = (t - phaseStart) * 1000;
      if (elapsed >= ENTER_MS) {
        phase = 'live';
        wrap.classList.add('is-ready');
      }
    }

    if (phase === 'live' && ttlStart && t >= ttlStart) {
      exit();
    }

    if (phase === 'leaving') {
      const elapsed = (t - phaseStart) * 1000;
      if (elapsed > EXIT_MS + 40 && chrome && chrome.isDead()) {
        finalize();
      }
    }
  }

  function exit() {
    if (phase === 'dead' || phase === 'leaving') return;
    phase = 'leaving';
    phaseStart = performance.now() / 1000;
    ttlStart = 0;
    wrap.classList.remove('is-entering', 'is-ready');
    wrap.classList.add('is-leaving');
    if (chrome) chrome.fadeOut();
  }

  function finalize() {
    if (phase === 'dead') return;
    phase = 'dead';
    if (chrome) { try { chrome.dispose(); } catch (_) {} chrome = null; }
    if (css3dObj && css3dObj.parent) css3dObj.parent.remove(css3dObj);
    try { wrap.remove(); } catch (_) {}
    if (typeof onDismiss === 'function') {
      try { onDismiss(id); } catch (_) {}
    }
  }

  function dispose() { finalize(); }

  // Runtime updates — while a thinking card is up we may want to update
  // the detail line (e.g. "still working…" after a long pause).
  function update({ title: nt, detail: nd, variant: nv } = {}) {
    if (nt != null) titleEl.textContent = String(nt).toUpperCase();
    if (nd != null) detailEl.textContent = String(nd);
    if (nv && STATUS_VARIANTS[nv]) {
      wrap.className = `holo-status-wrap holo-status--${nv}`;
      iconEl.innerHTML = variantGlyph(nv);
    }
  }

  return {
    id,
    kind: 'status',
    sizeName: poseName,
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

function variantGlyph(variant) {
  switch (variant) {
    case STATUS_VARIANTS.thinking:
      return `<span class="holo-status-dot"></span><span class="holo-status-dot"></span><span class="holo-status-dot"></span>`;
    case STATUS_VARIANTS.complete:
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    case STATUS_VARIANTS.incoming:
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l8 6 8-6M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/></svg>`;
    case STATUS_VARIANTS.alert:
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>`;
    default:
      return `<span class="holo-status-dot"></span>`;
  }
}

function ensureCSS() {
  if (document.getElementById(STATUS_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STATUS_STYLE_ID;
  s.textContent = STATUS_CSS;
  document.head.appendChild(s);
}

const STATUS_CSS = `
  .holo-status-wrap {
    position: relative;
    opacity: 0;
    pointer-events: none;
    transition: opacity ${ENTER_MS}ms ease;
    perspective: 1200px;
    transform-style: preserve-3d;
  }
  .holo-status-wrap.is-entering { opacity: 1; }
  .holo-status-wrap.is-leaving {
    opacity: 0;
    transition: opacity ${EXIT_MS}ms ease;
  }

  .holo-status-card {
    position: relative;
    width: 100%; height: 100%;
    border-radius: 14px;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    background:
      linear-gradient(180deg, rgba(0,229,255,0.055) 0%, rgba(0,0,0,0) 42%),
      rgba(0, 0, 0, 0.38);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.34) inset,
      0 0 0 1px rgba(0, 229, 255, 0.07),
      0 10px 40px rgba(0, 0, 0, 0.5);
    isolation: isolate;
    overflow: hidden;
  }
  .holo-status-wrap.is-ready .holo-status-card {
    animation: status-breathe 3.6s ease-in-out infinite;
  }
  @keyframes status-breathe {
    0%, 100% {
      box-shadow:
        0 0 0 1px rgba(0, 229, 255, 0.28) inset,
        0 0 0 1px rgba(0, 229, 255, 0.04),
        0 10px 40px rgba(0, 0, 0, 0.5);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(0, 229, 255, 0.48) inset,
        0 0 0 3px rgba(0, 229, 255, 0.10),
        0 10px 40px rgba(0, 0, 0, 0.5);
    }
  }

  .holo-status-title {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 11px;
    letter-spacing: 0.22em;
    color: #00e5ff;
    text-shadow: 0 0 8px rgba(0, 229, 255, 0.55);
    opacity: 0.95;
  }
  .holo-status-detail {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 11px;
    letter-spacing: 0.05em;
    color: rgba(255,255,255,0.7);
    min-height: 14px;
  }
  .holo-status-icon {
    position: absolute;
    top: 12px;
    right: 14px;
    color: #00e5ff;
    display: flex;
    align-items: center;
    gap: 4px;
    filter: drop-shadow(0 0 6px rgba(0, 229, 255, 0.65));
  }

  /* Thinking variant: three pulsing dots staggered */
  .holo-status-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #00e5ff;
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.9);
    animation: status-dot-pulse 1.2s ease-in-out infinite;
  }
  .holo-status-dot:nth-child(2) { animation-delay: 0.15s; }
  .holo-status-dot:nth-child(3) { animation-delay: 0.30s; }
  @keyframes status-dot-pulse {
    0%, 80%, 100% { transform: scale(0.5); opacity: 0.4; }
    40%           { transform: scale(1.1); opacity: 1; }
  }

  /* Complete: cyan-green glow */
  .holo-status--complete .holo-status-icon { color: #5effc1; filter: drop-shadow(0 0 6px rgba(94, 255, 193, 0.75)); }
  .holo-status--complete .holo-status-title { color: #5effc1; text-shadow: 0 0 8px rgba(94, 255, 193, 0.6); }
  .holo-status--complete .holo-status-card  {
    box-shadow:
      0 0 0 1px rgba(94, 255, 193, 0.34) inset,
      0 0 0 1px rgba(94, 255, 193, 0.08),
      0 10px 40px rgba(0, 0, 0, 0.5);
  }

  /* Alert: pink accent */
  .holo-status--alert .holo-status-icon { color: #ff6b9a; filter: drop-shadow(0 0 6px rgba(255, 107, 154, 0.75)); }
  .holo-status--alert .holo-status-title { color: #ff6b9a; text-shadow: 0 0 8px rgba(255, 107, 154, 0.6); }
  .holo-status--alert .holo-status-card  {
    box-shadow:
      0 0 0 1px rgba(255, 107, 154, 0.34) inset,
      0 0 0 1px rgba(255, 107, 154, 0.08),
      0 10px 40px rgba(0, 0, 0, 0.5);
  }

  /* Entrance scan line — same vocabulary as chart cards */
  .holo-status-scan {
    position: absolute;
    left: 0; right: 0; top: 0;
    height: 2px;
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(0, 229, 255, 0.1) 10%,
      rgba(0, 229, 255, 0.95) 50%,
      rgba(0, 229, 255, 0.1) 90%,
      transparent 100%);
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.9);
    opacity: 0;
  }
  .holo-status-wrap.is-entering .holo-status-scan {
    animation: status-scan-paint ${ENTER_MS - 60}ms cubic-bezier(0.33, 1, 0.68, 1) forwards;
  }
  @keyframes status-scan-paint {
    0%   { opacity: 0; transform: translateY(0); }
    12%  { opacity: 1; }
    88%  { opacity: 1; }
    100% { opacity: 0; transform: translateY(var(--card-h, 120px)); }
  }

  @media (prefers-reduced-motion: reduce) {
    .holo-status-wrap.is-ready .holo-status-card { animation: none; }
    .holo-status-dot { animation: none; opacity: 0.85; }
  }
`;

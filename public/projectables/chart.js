// ChartProjectable — Momo's data card, mounted as an iframe sandwiched
// between the hologram chrome (wireframe + scan-line + platter) and the
// user's eye. Renders deterministic ECharts HTML served from /viz/:id.
//
// Robustness contract (don't regress):
//   - postMessage rejected unless e.source === iframe.contentWindow
//   - ready timer cleared on 'ready' and on dismount
//   - iframe sandbox is 'allow-scripts' only
//   - highlight commands deferred until iframe reports ready
//
// Lifecycle inherited from projectables/base.js:
//   pending → enter → entering → live → leaving → dead

import {
  mintProjectableId,
  POSE,
  PANEL_PX,
  CSS3D_SCALE,
  panelWorldSize,
  prefersReducedMotion,
} from './base.js';
import { attachChrome } from '../hologram-chrome.js';

const READY_TIMEOUT_MS = 7500;

// DOM-side fade envelope (iframe + card). Independent of chrome fade
// because the iframe has to finish loading before we unfade it — the
// chrome can fade in immediately.
const CARD_FADE_MS = 380;
const CARD_EXIT_MS = 360;

// Class hooks on the card so existing CSS in chart-layer's stylesheet
// (halo, corners, scan-line, shimmer, bug) picks them up unchanged.
const CARD_STYLE_ID = 'holo-chart-styles';

export function createChartProjectable({
  vizId,
  sizeName = 'wide',
  cached = false,
  onDismiss,       // optional: called when the projectable finishes exiting
} = {}) {
  const id = mintProjectableId('chart');

  // Size + pose.
  const pose = POSE[sizeName] || POSE.wide;
  const panelPx = PANEL_PX[sizeName] || PANEL_PX.wide;
  const worldSize = panelWorldSize(sizeName);

  // ── DOM: chart card + chrome-on-DOM (corners, scan, halo, bug) ──────
  const wrap = document.createElement('div');
  wrap.className = `chart-wrap chart-wrap-${sizeName} chart-wrap-3d`;
  wrap.dataset.size = sizeName;
  wrap.dataset.projectableId = id;

  const halo = document.createElement('div');
  halo.className = 'chart-halo';

  const depthBack = document.createElement('div');
  depthBack.className = 'chart-depth-back';
  const depthFront = document.createElement('div');
  depthFront.className = 'chart-depth-front';

  const card = document.createElement('div');
  card.className = 'chart-card';
  card.style.width  = panelPx.w + 'px';
  card.style.height = panelPx.h + 'px';
  card.style.setProperty('--card-h', panelPx.h + 'px');

  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const c = document.createElement('span');
    c.className = `chart-corner chart-corner-${corner}`;
    card.appendChild(c);
  }

  const bug = document.createElement('div');
  bug.className = 'chart-bug';
  bug.innerHTML = `<span class="chart-bug-dot"></span><span class="chart-bug-label">${cached ? 'CACHED' : 'LIVE'}</span>`;
  card.appendChild(bug);

  const raw = document.createElement('a');
  raw.className = 'chart-raw';
  raw.href = `/raw/${encodeURIComponent(vizId)}`;
  raw.target = '_blank';
  raw.rel = 'noopener';
  raw.title = 'View raw dataset for this chart';
  raw.textContent = '[ RAW ▸ ]';
  card.appendChild(raw);

  const scan = document.createElement('div');
  scan.className = 'chart-scan';
  card.appendChild(scan);

  const shimmer = document.createElement('div');
  shimmer.className = 'chart-shimmer';
  card.appendChild(shimmer);

  const iframe = document.createElement('iframe');
  iframe.src = `/viz/${encodeURIComponent(vizId)}`;
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'eager');
  iframe.setAttribute('width',  String(panelPx.w));
  iframe.setAttribute('height', String(panelPx.h));
  iframe.className = 'chart-iframe';
  card.appendChild(iframe);

  wrap.appendChild(halo);
  wrap.appendChild(depthBack);
  wrap.appendChild(card);
  wrap.appendChild(depthFront);

  // ── State machine ───────────────────────────────────────────────────
  let phase = 'pending';   // pending | entering | live | leaving | dead
  let phaseStart = 0;
  let bornAt = 0;
  let revealed = false;
  let readyTimer = 0;
  let css3dObj = null;
  let chrome = null;
  let pendingHighlight = null;
  let highlightDeadline = 0;       // wall-clock seconds; 0 = no pending retry
  let onMessageListener = null;

  // Chart is centered in front of Momo; tween her nowhere new. (Retained
  // for symmetry with other projectables that might want a side-tween.)
  const avatarTarget = { x: 0, y: 0, z: 0 };

  function enter({ avatarObj, scene, CSS3DObject, sceneCtl }) {
    ensureCSS();

    phase = 'entering';
    phaseStart = performance.now() / 1000;
    bornAt = phaseStart;

    const parent = avatarObj || scene;
    css3dObj = new CSS3DObject(wrap);
    css3dObj.position.set(pose.x, pose.y, pose.z);
    css3dObj.scale.setScalar(CSS3D_SCALE);
    css3dObj.rotation.order = 'YXZ';
    css3dObj.rotation.x = pose.tilt;
    css3dObj.userData.projectableId = id;
    parent.add(css3dObj);
    chrome = attachChrome(parent, pose, worldSize, { sceneCtl, withPlatter: true });

    // Glance bias — Momo briefly looks at what she's showing. Chart sits
    // below her face and forward, so bias is a soft down-and-centred
    // pupil nudge plus a tiny head tilt toward the card. Values are bell-
    // enveloped in updateAvatar so the glance starts, peaks, and settles.
    if (avatarObj && avatarObj.userData) {
      avatarObj.userData.lookBias = {
        x: 0,
        y: -0.042,
        tilt: 0.06,
        duration: 1.8,
        t0: performance.now() / 1000,
      };
    }

    // Kick the DOM entrance classes on the next two frames so the initial
    // hidden state is committed before the transition begins (browsers
    // otherwise collapse the two states into a single paint and skip the
    // animation).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => wrap.classList.add('is-entering'));
    });

    // Postmessage listener for iframe → parent signalling ('ready' / 'fail').
    onMessageListener = (e) => {
      const d = e.data;
      if (!d || d.holoViz !== true) return;
      if (e.source !== iframe.contentWindow) return;

      if (d.kind === 'ready') {
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; }
        revealCard();
      } else if (d.kind === 'fail') {
        console.warn('[chart projectable] viz failed:', d.detail);
        exit();
      }
    };
    window.addEventListener('message', onMessageListener);

    // Hard timeout — if the iframe never reports ready, dismount so the
    // stage doesn't hang on a blank card.
    readyTimer = setTimeout(() => {
      if (phase !== 'dead' && !revealed) {
        console.warn('[chart projectable] viz never reported ready; dismounting');
        exit();
      }
    }, READY_TIMEOUT_MS);
  }

  function revealCard() {
    if (revealed) return;
    revealed = true;
    wrap.classList.add('is-ready');
    shimmer.classList.remove('run');
    void shimmer.offsetWidth;  // force reflow so the anim restarts
    shimmer.classList.add('run');
    // If a highlight was requested before reveal, send it now.
    if (pendingHighlight) {
      postToIframe(pendingHighlight);
    }
    // Transition the state machine; chrome fade is independent.
    phase = 'live';
  }

  function tick(t, _dt, _camera, localYaw) {
    if (!css3dObj) return;
    css3dObj.rotation.set(pose.tilt, localYaw, 0);
    if (chrome) {
      chrome.tick(t);
      chrome.mirrorYaw(localYaw);
    }

    // Highlight pump — if a highlight arrived before the iframe was
    // ready, send it the moment `revealed` flips on. The budget matches
    // the iframe boot timeout so stale commands can't spin forever.
    if (pendingHighlight && revealed) {
      postToIframe(pendingHighlight);
      pendingHighlight = null;
    } else if (pendingHighlight && highlightDeadline && t > highlightDeadline) {
      pendingHighlight = null;
      highlightDeadline = 0;
    }

    // Exit animation — fade the DOM wrap out over CARD_EXIT_MS, then
    // tear down once chrome is dead too.
    if (phase === 'leaving') {
      const elapsed = (t - phaseStart) * 1000;
      if (elapsed > CARD_EXIT_MS + 80 && chrome && chrome.isDead()) {
        finalize();
      }
    }
  }

  function exit() {
    if (phase === 'dead' || phase === 'leaving') return;
    phase = 'leaving';
    phaseStart = performance.now() / 1000;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = 0; }
    wrap.classList.remove('is-entering', 'is-ready');
    wrap.classList.add('is-leaving');
    pendingHighlight = null;
    if (chrome) chrome.fadeOut();
  }

  function finalize() {
    if (phase === 'dead') return;
    phase = 'dead';
    if (onMessageListener) {
      window.removeEventListener('message', onMessageListener);
      onMessageListener = null;
    }
    if (chrome) { try { chrome.dispose(); } catch (_) {} chrome = null; }
    if (css3dObj && css3dObj.parent) css3dObj.parent.remove(css3dObj);
    try { wrap.remove(); } catch (_) {}
    if (typeof onDismiss === 'function') {
      try { onDismiss(id); } catch (_) {}
    }
  }

  function dispose() { finalize(); }

  function postToIframe(cmd) {
    const win = iframe.contentWindow;
    if (!win) return;
    try { win.postMessage(cmd, '*'); } catch (_) {}
  }

  function highlight({ dataIndex, seriesIndex, label } = {}) {
    if (phase === 'dead' || phase === 'leaving') return false;
    const cmd = {
      holoVizCmd: true,
      kind: 'highlight',
      dataIndex: Number.isFinite(dataIndex) ? dataIndex : undefined,
      seriesIndex: Number.isFinite(seriesIndex) ? seriesIndex : 0,
      label: label || undefined,
    };
    if (revealed) {
      postToIframe(cmd);
      pendingHighlight = null;
      highlightDeadline = 0;
    } else {
      // Queue for tick() to drain the moment revealed flips on. Deadline
      // is 3.5s past now — if the iframe never reports ready, tick drops
      // the pending command on its own.
      pendingHighlight = cmd;
      highlightDeadline = performance.now() / 1000 + 3.5;
    }
    pulseCard();
    return true;
  }

  function clearHighlight() {
    pendingHighlight = null;
    highlightDeadline = 0;
    postToIframe({ holoVizCmd: true, kind: 'clearHighlight' });
  }

  function pulseCard() {
    card.classList.remove('is-pulsing');
    void card.offsetWidth;
    card.classList.add('is-pulsing');
  }

  return {
    id,
    kind: 'chart',
    vizId,
    sizeName,
    avatarTarget,
    getObject3D: () => css3dObj,
    enter,
    tick,
    exit,
    dispose,
    highlight,
    clearHighlight,
    isDead: () => phase === 'dead',
  };
}

// ── One-time CSS injection ──────────────────────────────────────────────
// The chart card's decorative chrome lives in CSS (halo pulse, viewfinder
// corners, scan-line, shimmer, live-bug, depth planes). Inject once per
// document so the module stays drop-in and doesn't depend on the host
// page linking a stylesheet.
function ensureCSS() {
  if (document.getElementById(CARD_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = CARD_STYLE_ID;
  s.textContent = CHART_CSS;
  document.head.appendChild(s);
}

// Timing tokens (mirrored from old chart-layer.js — the CSS animations
// expect these millisecond budgets).
const T_SCAN_PAINT        = 180;
const T_IFRAME_FADE_DELAY = 140;
const T_IFRAME_FADE       = 380;
const T_SHIMMER           = 500;
const T_DISMISS           = 360;

const CHART_CSS = `
  /* Wrapper — in 3D mode we let the CSS3DObject matrix place it. */
  .chart-wrap {
    position: relative;
    pointer-events: none;
    opacity: 0;
    transition:
      opacity ${T_IFRAME_FADE}ms ease,
      transform 560ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: opacity, transform;
    perspective: 1200px;
    transform-style: preserve-3d;
    --tx: 0deg;
    --ty: 0deg;
  }
  .chart-wrap-3d {
    position: relative;
    top: auto; right: auto; left: auto; bottom: auto;
    transform: none;
  }
  .chart-wrap-3d.is-entering { opacity: 1; transform: none; }
  .chart-wrap-3d.is-leaving {
    opacity: 0;
    transition:
      opacity ${T_DISMISS}ms ease,
      transform ${T_DISMISS}ms cubic-bezier(0.4, 0, 1, 1);
  }

  .chart-halo {
    position: absolute; inset: -6px;
    border-radius: 22px;
    pointer-events: none;
    box-shadow:
      0 0 24px 2px rgba(0, 229, 255, 0.18),
      0 0 64px 8px rgba(0, 229, 255, 0.08);
    opacity: 0;
    transition: opacity 520ms ease;
  }
  .chart-wrap.is-ready .chart-halo {
    opacity: 1;
    animation: chart-halo-pulse 4s ease-in-out infinite;
  }
  @keyframes chart-halo-pulse {
    0%, 100% { box-shadow: 0 0 24px 2px rgba(0, 229, 255, 0.18), 0 0 64px 8px rgba(0, 229, 255, 0.07); }
    50%      { box-shadow: 0 0 28px 3px rgba(0, 229, 255, 0.22), 0 0 76px 10px rgba(0, 229, 255, 0.11); }
  }

  .chart-card {
    position: relative;
    border-radius: 18px;
    background:
      linear-gradient(180deg, rgba(0,229,255,0.035) 0%, rgba(0,0,0,0) 32%),
      rgba(0, 0, 0, 0.32);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.32) inset,
      0 0 0 1px rgba(0, 229, 255, 0.06),
      0 20px 60px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    pointer-events: auto;
    isolation: isolate;
    transform-style: preserve-3d;
    transform: rotateY(var(--tx)) rotateX(var(--ty));
    transition:
      transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
      box-shadow 240ms ease;
  }
  @media (prefers-reduced-transparency: reduce) {
    .chart-card {
      background:
        linear-gradient(180deg, rgba(0,229,255,0.05) 0%, rgba(0,0,0,0) 32%),
        rgba(0, 0, 0, 0.72);
    }
  }
  .chart-wrap.is-ready .chart-card { animation: card-breathe 8s ease-in-out infinite; }
  .chart-card:hover { animation-play-state: paused; }
  @keyframes card-breathe {
    0%, 100% { transform: rotateY(calc(var(--tx) + -0.6deg)) rotateX(calc(var(--ty) +  0.4deg)); }
    50%      { transform: rotateY(calc(var(--tx) +  0.6deg)) rotateX(calc(var(--ty) + -0.4deg)); }
  }
  .chart-card.is-pulsing { animation: card-pulse 900ms ease-out; }
  @keyframes card-pulse {
    0%   { box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.28) inset, 0 0 0 0 rgba(0, 229, 255, 0.55), 0 20px 60px rgba(0, 0, 0, 0.55); }
    50%  { box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.55) inset, 0 0 0 10px rgba(0, 229, 255, 0.0), 0 20px 60px rgba(0, 0, 0, 0.55); }
    100% { box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.28) inset, 0 0 0 1px rgba(0, 229, 255, 0.05), 0 20px 60px rgba(0, 0, 0, 0.55); }
  }

  .chart-depth-back, .chart-depth-front {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: 22px;
    opacity: 0;
    transition: opacity 520ms ease;
    transform-style: preserve-3d;
  }
  .chart-depth-back {
    transform: translateZ(-40px) scale(1.04);
    background: radial-gradient(
      ellipse at 50% 55%,
      rgba(0, 229, 255, 0.16) 0%,
      rgba(0, 229, 255, 0.06) 40%,
      rgba(0, 0, 0, 0) 72%);
    filter: blur(6px);
  }
  .chart-depth-front {
    transform: translateZ(8px);
    background: linear-gradient(
      105deg,
      rgba(0, 0, 0, 0) 0%,
      rgba(0, 0, 0, 0) 38%,
      rgba(0, 229, 255, 0.10) 50%,
      rgba(0, 0, 0, 0) 62%,
      rgba(0, 0, 0, 0) 100%);
    mix-blend-mode: screen;
  }
  .chart-wrap.is-ready .chart-depth-back,
  .chart-wrap.is-ready .chart-depth-front { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .chart-wrap.is-ready .chart-card { animation: none; }
    .chart-card { transition: none; }
  }

  .chart-iframe {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    border: 0; display: block;
    background: transparent;
    opacity: 0;
    transition: opacity ${T_IFRAME_FADE}ms ease ${T_IFRAME_FADE_DELAY}ms;
  }
  .chart-wrap.is-ready .chart-iframe { opacity: 1; }

  .chart-corner {
    position: absolute;
    width: 12px; height: 12px;
    pointer-events: none;
    z-index: 2;
    opacity: 0;
    transition: opacity 260ms ease 120ms;
  }
  .chart-wrap.is-entering .chart-corner { opacity: 0.85; }
  .chart-wrap.is-leaving .chart-corner { opacity: 0; transition-delay: 0ms; }
  .chart-corner::before, .chart-corner::after {
    content: ''; position: absolute;
    background: #00e5ff;
    box-shadow: 0 0 6px rgba(0, 229, 255, 0.75);
  }
  .chart-corner::before { width: 12px; height: 1px; }
  .chart-corner::after  { width: 1px;  height: 12px; }
  .chart-corner-tl { top: 6px; left: 6px; }
  .chart-corner-tl::before { top: 0; left: 0; }
  .chart-corner-tl::after  { top: 0; left: 0; }
  .chart-corner-tr { top: 6px; right: 6px; }
  .chart-corner-tr::before { top: 0; right: 0; }
  .chart-corner-tr::after  { top: 0; right: 0; }
  .chart-corner-bl { bottom: 6px; left: 6px; }
  .chart-corner-bl::before { bottom: 0; left: 0; }
  .chart-corner-bl::after  { bottom: 0; left: 0; }
  .chart-corner-br { bottom: 6px; right: 6px; }
  .chart-corner-br::before { bottom: 0; right: 0; }
  .chart-corner-br::after  { bottom: 0; right: 0; }

  .chart-bug {
    position: absolute;
    top: 10px; right: 26px;
    display: flex; align-items: center; gap: 5px;
    z-index: 3;
    opacity: 0;
    transition: opacity 320ms ease 260ms;
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 9px; letter-spacing: 1.5px;
    color: rgba(0, 229, 255, 0.85);
    text-shadow: 0 0 4px rgba(0, 229, 255, 0.6);
    pointer-events: none;
  }
  .chart-wrap.is-ready .chart-bug { opacity: 1; }
  .chart-bug-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #00e5ff;
    box-shadow: 0 0 8px #00e5ff, 0 0 2px #ffffff;
    animation: chart-bug-blink 1.8s ease-in-out infinite;
  }
  @keyframes chart-bug-blink {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.45; }
  }

  .chart-raw {
    position: absolute;
    bottom: 10px; right: 18px;
    z-index: 6;
    opacity: 0;
    pointer-events: none;
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 9px; letter-spacing: 1.5px;
    color: rgba(0, 229, 255, 0.78);
    text-shadow: 0 0 4px rgba(0, 229, 255, 0.5);
    text-decoration: none;
    padding: 3px 6px;
    border-radius: 4px;
    transition: opacity 320ms ease 280ms, color 160ms ease, background 160ms ease;
  }
  .chart-wrap.is-ready .chart-raw { opacity: 1; pointer-events: auto; }
  .chart-raw:hover {
    color: #d8f3e5;
    background: rgba(0, 229, 255, 0.12);
  }

  .chart-scan {
    position: absolute;
    left: 0; right: 0;
    top: 0;
    height: 2px;
    pointer-events: none;
    z-index: 4;
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(0, 229, 255, 0.1) 10%,
      rgba(0, 229, 255, 0.95) 50%,
      rgba(0, 229, 255, 0.1) 90%,
      transparent 100%);
    box-shadow:
      0 0 8px rgba(0, 229, 255, 0.9),
      0 0 24px rgba(0, 229, 255, 0.4);
    opacity: 0;
    transform: translateY(0);
  }
  .chart-wrap.is-entering .chart-scan {
    animation: chart-scan-paint ${T_SCAN_PAINT}ms cubic-bezier(0.33, 1, 0.68, 1) forwards;
  }
  .chart-wrap.is-leaving .chart-scan {
    animation: chart-scan-sweep ${T_DISMISS}ms ease forwards;
  }
  @keyframes chart-scan-paint {
    0%   { opacity: 0; transform: translateY(0); }
    12%  { opacity: 1; }
    88%  { opacity: 1; }
    100% { opacity: 0; transform: translateY(var(--card-h, 420px)); }
  }
  @keyframes chart-scan-sweep {
    0%   { opacity: 0.9; transform: translateY(var(--card-h, 420px)); }
    100% { opacity: 0;   transform: translateY(0); }
  }

  .chart-shimmer {
    position: absolute;
    top: 0; bottom: 0;
    left: -40%;
    width: 40%;
    pointer-events: none;
    z-index: 5;
    transform: skewX(-18deg) translateX(0);
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(255, 255, 255, 0.0) 30%,
      rgba(255, 255, 255, 0.22) 50%,
      rgba(255, 255, 255, 0.0) 70%,
      transparent 100%);
    mix-blend-mode: screen;
    opacity: 0;
  }
  .chart-shimmer.run {
    animation: chart-shimmer-sweep ${T_SHIMMER}ms cubic-bezier(0.33, 1, 0.68, 1) ${T_IFRAME_FADE_DELAY + 120}ms forwards;
  }
  @keyframes chart-shimmer-sweep {
    0%   { opacity: 0; transform: skewX(-18deg) translateX(0); }
    15%  { opacity: 1; }
    85%  { opacity: 1; }
    100% { opacity: 0; transform: skewX(-18deg) translateX(370%); }
  }
`;

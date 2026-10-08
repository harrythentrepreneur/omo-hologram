// Chart-layer — back-compat entry point that preserves the `installChartLayer`
// API three holo pages already wire into (reflector / avatar / cylinder)
// while delegating the actual work to the new Projectable abstraction.
//
// Routing:
//   • 3D hosts (scene + camera + CSS3DObject + CSS3DRenderer passed in):
//       installWorld(...) → window.__holoChart delegates mount/highlight/
//       dismount/update/renderCss/rebind to the world and a ChartProjectable.
//   • 2D hosts (no 3D DI — cylinder-warp, headless preview):
//       Keep the original DOM-docking path inline here: mount a card into
//       a chart-layer <div> inside #stage or <body> and use CSS keyframes
//       for the entrance/exit. The old Projectable lifecycle doesn't need
//       to run in this mode since there's no WebGL chrome to coordinate.
//
// The 2D path is intentionally the minimum viable card — holo_cylinder's
// polar-warp pipeline can't pre-distort DOM, so any extra decorative WebGL
// would surface on a plane above the warp rather than inside it. Keep it
// simple until we have a 3D-native replacement for that rig.

import { installWorld, getWorld } from './world.js';
import { createChartProjectable }  from './projectables/chart.js';
import { createStatusProjectable, STATUS_VARIANTS } from './projectables/status.js';
import { createMediaProjectable }  from './projectables/media.js';
import { createAgentProjectable }  from './projectables/agent.js';
import { createNotificationProjectable } from './projectables/notification.js';

// ── 2D-mode sizing presets ──────────────────────────────────────────────
// Only used when no 3D context is provided. Stage mounts compute pixel
// sizes per resize; body-level mounts fall back to absolute pixel dims
// from the mount() call.
const SIZE_PRESETS = {
  wide:   { wFrac: 0.56, hFrac: 0.42 },
  square: { wFrac: 0.44, hFrac: 0.44 },
  stat:   { wFrac: 0.28, hFrac: 0.18 },
};

const T_IFRAME_FADE = 380;
const T_DISMISS = 360;
const READY_TIMEOUT_MS = 7500;

// 2D mode supports up to MAX_CONCURRENT_2D charts on stage at once. When a
// new mount would exceed the cap, the oldest is dismounted. Layout stacks
// them vertically on the right edge, shrinking as count grows so they all
// fit in the column.
const MAX_CONCURRENT_2D = 3;

let installed = false;
const mounts2D = [];      // oldest first; array of mount ctx objects

export function installChartLayer({
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
  if (installed) return;
  installed = true;

  const use3D = !!(scene && camera && CSS3DObject && CSS3DRenderer);

  if (use3D) {
    // 3D routing: stand up the world, wire the legacy __holoChart API AND
    // the new __holoStage kind-based dispatcher.
    const world = installWorld({
      avatarObj, stageEl, scene, camera, renderer,
      webglCanvas, CSS3DObject, CSS3DRenderer, sceneCtl,
    });

    // ── Kind-based Projectable factory table ─────────────────────────────
    // Every server-side projection tool response carries { projectable_id,
    // kind, ...meta }. The dispatcher looks up the factory by kind, passes
    // the response through, and mounts. To add a new artifact type: drop a
    // file under projectables/ and add one line here.
    const FACTORIES = {
      chart: (r) => createChartProjectable({
        vizId: r.projectable_id || r.viz_id,
        sizeName: ['wide', 'square', 'stat'].includes(r.size) ? r.size : 'wide',
        cached: !!r.cached,
      }),
      status: (r) => createStatusProjectable({
        title: r.title || 'STATUS',
        detail: r.detail || '',
        variant: STATUS_VARIANTS[r.variant] || STATUS_VARIANTS.complete,
        pose: 'thought',
        ttlMs: Number.isInteger(r.ttl_ms) ? r.ttl_ms : 0,
        withPlatter: false,
      }),
      media: (r) => createMediaProjectable({
        dataUrl: r.dataUrl,
        mediaType: r.mediaType,
        caption: r.caption || '',
        filename: r.filename || null,
        sizeName: ['wide', 'square', 'stat'].includes(r.size) ? r.size : 'wide',
      }),
      agent: (r) => createAgentProjectable({
        name: r.name || 'Companion',
        role: r.role || 'generic',
        slot: r.slot || 'right',
        greeting: r.greeting || null,
      }),
      notification: (r) => createNotificationProjectable({
        title: r.title || 'NOTIFICATION',
        detail: r.detail || '',
        icon:   r.icon   || 'bell',
        accent: r.accent || 'cyan',
        ttlMs:  Number.isInteger(r.ttl_ms) ? r.ttl_ms : 4500,
      }),
    };

    // Unified stage dispatcher — the preferred entry point for any
    // projection-family tool response. window.__holoChart is kept below
    // for back-compat with existing tool-name-switch code in the holo
    // pages, but new call sites should use window.__holoStage.
    window.__holoStage = {
      mount: (response) => {
        if (!response || !response.kind) return null;
        const factory = FACTORIES[response.kind];
        if (!factory) { console.warn('[holo-stage] unknown kind', response.kind); return null; }
        const p = factory(response);
        world.mount(p);
        return p;
      },
      dismount: () => world.dismount(),
      getCurrent: () => world.getCurrent(),
      highlight: (opts = {}) => {
        const cur = world.getCurrent();
        if (!cur || cur.kind !== 'chart' || !cur.highlight) return false;
        if (opts.vizId && cur.vizId !== opts.vizId) return false;
        return !!cur.highlight(opts);
      },
      clearHighlight: () => {
        const cur = world.getCurrent();
        if (cur && cur.clearHighlight) cur.clearHighlight();
      },
      update:    (t, dt) => world.update(t, dt),
      renderCss: () => world.renderCss(),
      rebind:    (next)  => world.rebind(next),
    };

    // Legacy chart-only API. Delegates to the stage but preserves the
    // (vizId, size, dims) positional signature. Anything in the wild that
    // still imports chart-layer directly keeps working.
    window.__holoChart = {
      mount: (vizId, size, dims) => window.__holoStage.mount({
        kind: 'chart',
        projectable_id: vizId,
        size,
        cached: !!(dims && dims.cached),
      }),
      dismount: () => window.__holoStage.dismount(),
      highlight: (opts) => window.__holoStage.highlight(opts),
      clearHighlight: () => window.__holoStage.clearHighlight(),
      update: (t, dt) => window.__holoStage.update(t, dt),
      renderCss: () => window.__holoStage.renderCss(),
      rebind: (next) => window.__holoStage.rebind(next),
    };
    return;
  }

  // ── 2D DOM-only path (holo_avatar, holo_cylinder) ───────────────────
  injectStyles2D();

  const host = stageEl || document.body;
  const layer = document.createElement('div');
  layer.id = 'chart-layer';
  layer.className = stageEl ? 'chart-layer chart-layer-stage' : 'chart-layer chart-layer-body';
  host.appendChild(layer);

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.holoViz !== true) return;
    const ctx = mounts2D.find((m) => e.source === m.iframe.contentWindow);
    if (!ctx) return;
    if (d.kind === 'ready') {
      if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = 0; }
      ctx.wrap.classList.add('is-ready');
    } else if (d.kind === 'fail') {
      console.warn('[chart-layer] viz failed:', d.detail);
      dismount2D(ctx.vizId);
    }
  });

  if (stageEl) {
    const refit = () => {
      for (const ctx of mounts2D) fitToStage2D(ctx, stageEl);
    };
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
  }

  window.__holoChart = {
    mount: (vizId, size, dims) => mount2D(vizId, size, dims, { layer, stageEl, avatarObj }),
    dismount: (vizId) => dismount2D(vizId),
    highlight: (opts = {}) => highlight2D(opts),
    clearHighlight: (opts = {}) => clearHighlight2D(opts),
    // No per-frame tick or CSS3D render in 2D mode — host's RAF can skip.
    update: () => {},
    renderCss: () => {},
    rebind: () => {},
  };

  // __holoStage stub — in 2D mode we only route the chart kind (through
  // the legacy __holoChart path). Other kinds (status, media, agent)
  // are silently skipped because they'd need the 3D hologram column to
  // mean anything. Callers check nullish return to know the dispatch
  // didn't take.
  window.__holoStage = {
    mount: (response) => {
      if (!response || response.kind !== 'chart') return null;
      mount2D(response.projectable_id || response.viz_id, response.size, {
        width: response.width, height: response.height, cached: !!response.cached,
      }, { layer, stageEl, avatarObj });
      return { kind: 'chart', id: response.projectable_id };
    },
    dismount: (opts) => dismount2D(opts && opts.vizId),
    getCurrent: () => (mounts2D.length ? { kind: 'chart', id: mounts2D[mounts2D.length - 1].vizId } : null),
    highlight: (opts = {}) => highlight2D(opts),
    clearHighlight: (opts = {}) => clearHighlight2D(opts),
    update:    () => {},
    renderCss: () => {},
    rebind:    () => {},
  };
}

// ── 2D mount/dismount/highlight ──────────────────────────────────────────
// Multi-mount: up to MAX_CONCURRENT_2D charts on stage at once. Slot
// presets below decide where each one sits; 1 card stays right-centered
// (historical look), 2 cards sit side-by-side on left and right of the
// avatar, 3 cards add a smaller one on top. Mounts append; at the cap
// the oldest dismounts.
const SLOT_LAYOUTS = [
  [],
  [{ left: 78, top: 50, scale: 1.00 }],
  [{ left: 78, top: 50, scale: 0.88 }, { left: 22, top: 50, scale: 0.88 }],
  [{ left: 78, top: 55, scale: 0.72 }, { left: 22, top: 55, scale: 0.72 }, { left: 50, top: 18, scale: 0.58 }],
];
function mount2D(vizId, size, dims, { layer, stageEl, avatarObj }) {
  // Re-mount of a vizId already on stage → pulse and return.
  const existing = mounts2D.find((m) => m.vizId === vizId);
  if (existing) {
    pulseCard2D(existing);
    return;
  }

  // Evict oldest if we're at the cap.
  while (mounts2D.length >= MAX_CONCURRENT_2D) {
    const oldest = mounts2D.shift();
    startDismiss2D(oldest);
  }

  const sizeName = SIZE_PRESETS[size] ? size : 'wide';
  const cached = !!(dims && dims.cached);

  const wrap = document.createElement('div');
  wrap.className = `chart-wrap chart-wrap-${sizeName}`;
  wrap.dataset.size = sizeName;
  wrap.dataset.vizId = vizId;

  const halo = document.createElement('div'); halo.className = 'chart-halo';
  const card = document.createElement('div'); card.className = 'chart-card';
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
  // allow-popups + ...-to-escape-sandbox let legitimate outbound links
  // (e.g. google_doc_card's "Open in Drive" chip) open in a new tab.
  // The iframe itself stays same-origin-isolated — no parent access, no
  // storage, no top navigation.
  iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('loading', 'eager');
  iframe.className = 'chart-iframe';
  card.appendChild(iframe);

  wrap.appendChild(halo);
  wrap.appendChild(card);
  layer.appendChild(wrap);

  const ctx = { iframe, card, wrap, scan, shimmer, vizId, sizeName, timer: 0, avatarObj, stageEl };
  if (stageEl) fitToStage2D(ctx, stageEl);
  else {
    const w = dims?.width  ?? (sizeName === 'stat' ? 280 : sizeName === 'square' ? 480 : 720);
    const h = dims?.height ?? (sizeName === 'stat' ? 180 : sizeName === 'square' ? 480 : 420);
    applyCardSize2D(ctx, w, h);
  }

  mounts2D.push(ctx);
  repositionSlots2D();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => wrap.classList.add('is-entering'));
  });

  ctx.timer = setTimeout(() => {
    const stillMounted = mounts2D.indexOf(ctx) >= 0;
    if (stillMounted && !wrap.classList.contains('is-ready')) {
      console.warn('[chart-layer] viz never reported ready; dismounting');
      dismount2D(ctx.vizId);
    }
  }, READY_TIMEOUT_MS);
}

// dismount2D(): no arg → tear down every active chart. With a vizId →
// tear down just that one. Reflows the remaining slots so survivors
// smoothly grow back into the freed space.
function dismount2D(vizId) {
  if (vizId) {
    const idx = mounts2D.findIndex((m) => m.vizId === vizId);
    if (idx < 0) return;
    const [ctx] = mounts2D.splice(idx, 1);
    startDismiss2D(ctx);
    repositionSlots2D();
    return;
  }
  while (mounts2D.length) {
    const ctx = mounts2D.shift();
    startDismiss2D(ctx);
  }
}

function startDismiss2D(ctx) {
  if (!ctx) return;
  if (ctx.timer) { clearTimeout(ctx.timer); ctx.timer = 0; }
  const { wrap } = ctx;
  wrap.classList.remove('is-entering', 'is-ready');
  wrap.classList.add('is-leaving');
  setTimeout(() => { try { wrap.remove(); } catch (_) {} }, T_DISMISS + 40);
}

// Push every mount into its slot preset. Each wrap reads --slot-left /
// --slot-top / --slot-scale from CSS so the transition animates the
// reflow when the active count changes.
function repositionSlots2D() {
  const layout = SLOT_LAYOUTS[mounts2D.length] || [];
  mounts2D.forEach((ctx, i) => {
    const slot = layout[i] || layout[layout.length - 1];
    ctx.wrap.style.setProperty('--slot-left',  slot.left  + '%');
    ctx.wrap.style.setProperty('--slot-top',   slot.top   + '%');
    ctx.wrap.style.setProperty('--slot-scale', String(slot.scale));
  });
}

function highlight2D({ vizId, dataIndex, seriesIndex, label } = {}) {
  if (!mounts2D.length) return false;
  const ctx = vizId
    ? mounts2D.find((m) => m.vizId === vizId)
    : mounts2D[mounts2D.length - 1];
  if (!ctx) return false;
  const cmd = {
    holoVizCmd: true,
    kind: 'highlight',
    dataIndex: Number.isFinite(dataIndex) ? dataIndex : undefined,
    seriesIndex: Number.isFinite(seriesIndex) ? seriesIndex : 0,
    label: label || undefined,
  };
  try { ctx.iframe.contentWindow?.postMessage(cmd, '*'); } catch (_) {}
  pulseCard2D(ctx);
  return true;
}

function clearHighlight2D({ vizId } = {}) {
  const targets = vizId
    ? mounts2D.filter((m) => m.vizId === vizId)
    : mounts2D;
  for (const ctx of targets) {
    try {
      ctx.iframe.contentWindow?.postMessage({ holoVizCmd: true, kind: 'clearHighlight' }, '*');
    } catch (_) {}
  }
}

function pulseCard2D(ctx) {
  ctx.card.classList.remove('is-pulsing');
  void ctx.card.offsetWidth;
  ctx.card.classList.add('is-pulsing');
}

function fitToStage2D(ctx, stageEl) {
  const preset = SIZE_PRESETS[ctx.sizeName] || SIZE_PRESETS.wide;
  const sw = stageEl.clientWidth;
  const sh = stageEl.clientHeight;
  const w = Math.max(120, Math.round(sw * preset.wFrac));
  const h = Math.max(80,  Math.round(sh * preset.hFrac));
  applyCardSize2D(ctx, w, h);
}

function applyCardSize2D(ctx, width, height) {
  ctx.card.style.width  = width  + 'px';
  ctx.card.style.height = height + 'px';
  ctx.card.style.setProperty('--card-h', height + 'px');
  ctx.iframe.setAttribute('width',  String(width));
  ctx.iframe.setAttribute('height', String(height));
}

// ── 2D-only CSS ──────────────────────────────────────────────────────────
// The 3D-aware stylesheet lives in projectables/chart.js (one-time inject).
// We only need the 2D docking rules on top of it for holo_avatar +
// holo_cylinder. Both sets are compatible (same class names, same CSS
// cascade) — they stack harmlessly.
function injectStyles2D() {
  if (document.getElementById('chart-layer-styles-2d')) return;
  const s = document.createElement('style');
  s.id = 'chart-layer-styles-2d';
  s.textContent = CHART_2D_CSS;
  document.head.appendChild(s);
}

const CHART_2D_CSS = `
  .chart-layer { pointer-events: none; }
  .chart-layer-body  { position: fixed;    inset: 0; z-index: 20; }
  .chart-layer-stage { position: absolute; inset: 0; z-index: 20; }

  .chart-wrap {
    position: absolute;
    pointer-events: none;
    opacity: 0;
    --slot-left: 78%;
    --slot-top: 50%;
    --slot-scale: 1;
    left: var(--slot-left);
    top: var(--slot-top);
    transform: translate(-50%, -50%) scale(calc(var(--slot-scale) * 0.965));
    transition:
      left 520ms cubic-bezier(0.22, 1, 0.36, 1),
      top 520ms cubic-bezier(0.22, 1, 0.36, 1),
      opacity ${T_IFRAME_FADE}ms ease,
      transform 560ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: left, top, opacity, transform;
    perspective: 1200px;
    transform-style: preserve-3d;
    --tx: 0deg;
    --ty: 0deg;
  }

  .chart-wrap:not(.chart-wrap-3d).is-entering {
    opacity: 1;
    transform: translate(-50%, -50%) scale(var(--slot-scale));
  }
  .chart-wrap:not(.chart-wrap-3d).is-leaving {
    opacity: 0;
    transform: translate(-50%, -50%) scale(calc(var(--slot-scale) * 0.985));
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
  .chart-wrap.is-ready .chart-halo { opacity: 1; }

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
  }
  .chart-card.is-pulsing { animation: card-pulse 900ms ease-out; }
  @keyframes card-pulse {
    0%   { box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.28) inset, 0 0 0 0 rgba(0, 229, 255, 0.55), 0 20px 60px rgba(0, 0, 0, 0.55); }
    50%  { box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.55) inset, 0 0 0 10px rgba(0, 229, 255, 0.0), 0 20px 60px rgba(0, 0, 0, 0.55); }
    100% { box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.28) inset, 0 0 0 1px rgba(0, 229, 255, 0.05), 0 20px 60px rgba(0, 0, 0, 0.55); }
  }

  .chart-iframe {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    border: 0; display: block;
    background: transparent;
    opacity: 0;
    transition: opacity ${T_IFRAME_FADE}ms ease 140ms;
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
  }
  .chart-wrap.is-entering .chart-scan {
    animation: chart-scan-paint 180ms cubic-bezier(0.33, 1, 0.68, 1) forwards;
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
    animation: chart-shimmer-sweep 500ms cubic-bezier(0.33, 1, 0.68, 1) 260ms forwards;
  }
  @keyframes chart-shimmer-sweep {
    0%   { opacity: 0; transform: skewX(-18deg) translateX(0); }
    15%  { opacity: 1; }
    85%  { opacity: 1; }
    100% { opacity: 0; transform: skewX(-18deg) translateX(370%); }
  }
`;

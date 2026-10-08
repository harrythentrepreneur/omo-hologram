// MediaProjectable — images, doc thumbnails, short screenshots that Momo
// wants to project inside her hologram rather than answering "here's a
// link". The media bytes always arrive through a server-side ref (see
// src/tools/media.js); the browser only ever sees a data: URL that the
// tool response hands us. No cross-origin fetches, no arbitrary URLs.
//
// Structurally this is the simplest Projectable — a single <img> in a
// CSS3DObject, wrapped in the same hologram chrome as everything else so
// it reads as the same kind of object.

import {
  mintProjectableId,
  POSE,
  PANEL_PX,
  CSS3D_SCALE,
  panelWorldSize,
} from './base.js';
import { attachChrome } from '../hologram-chrome.js';

const MEDIA_STYLE_ID = 'holo-media-styles';
const ENTER_MS = 380;
const EXIT_MS  = 320;

export function createMediaProjectable({
  dataUrl,
  mediaType = 'image/png',
  caption = '',
  filename = null,
  sizeName = 'wide',
  onDismiss,
} = {}) {
  const id = mintProjectableId('media');
  const pose = POSE[sizeName] || POSE.wide;
  const panelPx = PANEL_PX[sizeName] || PANEL_PX.wide;
  const worldSize = panelWorldSize(sizeName);

  // ── DOM ───────────────────────────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = `holo-media-wrap holo-media-${sizeName}`;
  wrap.dataset.projectableId = id;
  wrap.style.width  = panelPx.w + 'px';
  wrap.style.height = panelPx.h + 'px';

  const card = document.createElement('div');
  card.className = 'holo-media-card';

  // Corner bracket viewfinders — shared vocabulary with chart cards so
  // the whole hologram column speaks with one visual voice.
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const c = document.createElement('span');
    c.className = `holo-media-corner holo-media-corner-${corner}`;
    card.appendChild(c);
  }

  const imgWrap = document.createElement('div');
  imgWrap.className = 'holo-media-img-wrap';
  const img = document.createElement('img');
  img.className = 'holo-media-img';
  img.alt = filename || caption || 'media';
  img.decoding = 'async';
  img.loading = 'eager';
  img.src = dataUrl;
  imgWrap.appendChild(img);
  card.appendChild(imgWrap);

  if (caption) {
    const cap = document.createElement('div');
    cap.className = 'holo-media-caption';
    cap.textContent = caption;
    card.appendChild(cap);
  }

  const scan = document.createElement('div');
  scan.className = 'holo-media-scan';
  card.appendChild(scan);

  wrap.appendChild(card);

  // ── State machine ─────────────────────────────────────────────────────
  let phase = 'pending';
  let phaseStart = 0;
  let css3dObj = null;
  let chrome = null;
  const avatarTarget = { x: 0, y: 0, z: 0 };

  function enter({ avatarObj, scene, CSS3DObject, sceneCtl }) {
    ensureCSS();

    phase = 'entering';
    phaseStart = performance.now() / 1000;

    const parent = avatarObj || scene;
    css3dObj = new CSS3DObject(wrap);
    css3dObj.position.set(pose.x, pose.y, pose.z);
    css3dObj.scale.setScalar(CSS3D_SCALE);
    css3dObj.rotation.order = 'YXZ';
    css3dObj.rotation.x = pose.tilt;
    css3dObj.userData.projectableId = id;
    parent.add(css3dObj);

    // Media carries a platter — the picture reads as something projected
    // onto a pane, not an overlay. Reuse the same chrome as charts.
    chrome = attachChrome(parent, pose, worldSize, { sceneCtl, withPlatter: true });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => wrap.classList.add('is-entering'));
    });

    // Promote to live once the image fires load OR the entrance envelope
    // elapses — whichever comes first. Decoding is usually instant for
    // data: URLs but we don't want to block on it.
    if (img.complete && img.naturalWidth > 0) {
      phase = 'live';
      wrap.classList.add('is-ready');
    } else {
      img.addEventListener('load', () => {
        if (phase === 'entering') {
          phase = 'live';
          wrap.classList.add('is-ready');
        }
      }, { once: true });
    }
  }

  function tick(t, _dt, _camera, localYaw) {
    if (!css3dObj) return;
    css3dObj.rotation.set(pose.tilt, localYaw, 0);
    if (chrome) {
      chrome.tick(t);
      chrome.mirrorYaw(localYaw);
    }

    // Tick-driven live promotion backstop — if the image never fired load
    // (blob storage hiccup) we still transition so exit works predictably.
    if (phase === 'entering') {
      const elapsed = (t - phaseStart) * 1000;
      if (elapsed > ENTER_MS + 120) {
        phase = 'live';
        wrap.classList.add('is-ready');
      }
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

  return {
    id,
    kind: 'media',
    sizeName,
    avatarTarget,
    getObject3D: () => css3dObj,
    enter,
    tick,
    exit,
    dispose,
    isDead: () => phase === 'dead',
  };
}

function ensureCSS() {
  if (document.getElementById(MEDIA_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = MEDIA_STYLE_ID;
  s.textContent = MEDIA_CSS;
  document.head.appendChild(s);
}

const MEDIA_CSS = `
  .holo-media-wrap {
    position: relative;
    opacity: 0;
    pointer-events: none;
    transition: opacity ${ENTER_MS}ms ease;
  }
  .holo-media-wrap.is-entering { opacity: 1; }
  .holo-media-wrap.is-leaving {
    opacity: 0;
    transition: opacity ${EXIT_MS}ms ease;
  }

  .holo-media-card {
    position: relative;
    width: 100%; height: 100%;
    border-radius: 16px;
    padding: 10px;
    background:
      linear-gradient(180deg, rgba(0,229,255,0.045) 0%, rgba(0,0,0,0) 32%),
      rgba(0, 0, 0, 0.32);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.32) inset,
      0 0 0 1px rgba(0, 229, 255, 0.06),
      0 20px 60px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .holo-media-img-wrap {
    flex: 1 1 auto;
    min-height: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 10px;
    overflow: hidden;
  }
  .holo-media-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    filter: drop-shadow(0 0 12px rgba(0, 229, 255, 0.22));
  }
  .holo-media-caption {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.82);
    text-align: center;
    padding: 2px 4px 4px;
  }

  .holo-media-corner {
    position: absolute;
    width: 12px; height: 12px;
    pointer-events: none;
    z-index: 2;
    opacity: 0;
    transition: opacity 260ms ease 120ms;
  }
  .holo-media-wrap.is-entering .holo-media-corner,
  .holo-media-wrap.is-ready .holo-media-corner { opacity: 0.85; }
  .holo-media-wrap.is-leaving .holo-media-corner { opacity: 0; transition-delay: 0ms; }
  .holo-media-corner::before, .holo-media-corner::after {
    content: ''; position: absolute;
    background: #00e5ff;
    box-shadow: 0 0 6px rgba(0, 229, 255, 0.75);
  }
  .holo-media-corner::before { width: 12px; height: 1px; }
  .holo-media-corner::after  { width: 1px;  height: 12px; }
  .holo-media-corner-tl { top: 6px; left: 6px; }
  .holo-media-corner-tl::before { top: 0; left: 0; }
  .holo-media-corner-tl::after  { top: 0; left: 0; }
  .holo-media-corner-tr { top: 6px; right: 6px; }
  .holo-media-corner-tr::before { top: 0; right: 0; }
  .holo-media-corner-tr::after  { top: 0; right: 0; }
  .holo-media-corner-bl { bottom: 6px; left: 6px; }
  .holo-media-corner-bl::before { bottom: 0; left: 0; }
  .holo-media-corner-bl::after  { bottom: 0; left: 0; }
  .holo-media-corner-br { bottom: 6px; right: 6px; }
  .holo-media-corner-br::before { bottom: 0; right: 0; }
  .holo-media-corner-br::after  { bottom: 0; right: 0; }

  .holo-media-scan {
    position: absolute;
    left: 0; right: 0; top: 0;
    height: 2px;
    z-index: 4;
    background: linear-gradient(90deg,
      transparent 0%,
      rgba(0, 229, 255, 0.1) 10%,
      rgba(0, 229, 255, 0.95) 50%,
      rgba(0, 229, 255, 0.1) 90%,
      transparent 100%);
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.9);
    opacity: 0;
  }
  .holo-media-wrap.is-entering .holo-media-scan {
    animation: holo-media-scan-paint 220ms cubic-bezier(0.33, 1, 0.68, 1) forwards;
  }
  @keyframes holo-media-scan-paint {
    0%   { opacity: 0; transform: translateY(0); }
    12%  { opacity: 1; }
    88%  { opacity: 1; }
    100% { opacity: 0; transform: translateY(var(--card-h, 420px)); }
  }

  @media (prefers-reduced-motion: reduce) {
    .holo-media-wrap { transition: none; }
  }
`;

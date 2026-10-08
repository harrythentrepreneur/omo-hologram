// qr_code — a QR-style code card. Renders as inline SVG: a square grid
// with the three canonical finder squares in the corners plus a data
// pattern derived deterministically from the input string. This is NOT a
// valid ISO-standard QR encoder — no `qrcode` package is available and a
// full Reed-Solomon pipeline is out of scope. The card is a holographic
// prop: same visual vocabulary, deterministic-from-input, scannable by
// eye-for-vibes, not by phones. If we later ship a real encoder, swap
// buildMatrix() for it — the template shell stays the same.
//
// Data shape:
//   {
//     data,           // string to "encode" (URL, handoff token, payment URI)
//     caption?,       // headline under the code (e.g. "Pay £12.40")
//     subtitle?,      // second line below caption
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';

// Grid size (modules per side). 25×25 is a common "QR version 2" size and
// makes the finder pattern read as QR-ish without being too dense.
const GRID = 25;

function coerce(data) {
  if (!data) return null;
  const s = String(data.data || data.text || data.url || '').trim();
  if (!s) return null;
  return {
    data: s,
    caption:  data.caption  ? String(data.caption).trim()  : '',
    subtitle: data.subtitle ? String(data.subtitle).trim() : '',
  };
}

// Deterministic 32-bit hash (FNV-1a style) seeded from the input string.
// Produces a 32-bit counter; we stretch it into a PRNG below.
function seed32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// xorshift32 — small PRNG. Deterministic per seed so the same string always
// produces the same "QR" pattern, which matters for caching.
function prng(seed) {
  let x = seed || 1;
  return function next() {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    return x >>> 0;
  };
}

// Build a GRID×GRID boolean matrix. Corners get finder squares (7×7 with
// inner 3×3 solid block); an alignment square goes in the bottom-right at
// offset 18,18 (size 5×5). The rest is filled from the PRNG with a
// 48% black-cell rate — looks balanced without being soupy.
function buildMatrix(text) {
  const m = Array.from({ length: GRID }, () => new Array(GRID).fill(false));
  const rnd = prng(seed32(text));

  // Random fill first.
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      m[y][x] = (rnd() & 0xff) < 122; // ~48%
    }
  }

  // Finder square: 7×7 ring + 3×3 centre, drawn three times at corners.
  const drawFinder = (ox, oy) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) m[oy + y][ox + x] = false;
    for (let y = 0; y < 7; y++) {
      m[oy + y][ox] = true; m[oy + y][ox + 6] = true;
      m[oy][ox + y] = true; m[oy + 6][ox + y] = true;
    }
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) m[oy + y][ox + x] = true;
  };
  drawFinder(0, 0);
  drawFinder(GRID - 7, 0);
  drawFinder(0, GRID - 7);

  // Quiet zone around each finder (1-module white gap).
  const quiet = (ox, oy, w, h) => {
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        if (y >= 0 && y < GRID && x >= 0 && x < GRID) m[y][x] = false;
      }
    }
  };
  quiet(7, 0, 1, 8);
  quiet(0, 7, 8, 1);
  quiet(GRID - 8, 0, 1, 8);
  quiet(GRID - 8, 7, 8, 1);
  quiet(7, GRID - 8, 1, 8);
  quiet(0, GRID - 8, 8, 1);
  // Redraw finders (the quiet sweep may have nicked them).
  drawFinder(0, 0);
  drawFinder(GRID - 7, 0);
  drawFinder(0, GRID - 7);

  // Alignment square bottom-right (5×5 ring + 1×1 centre).
  const ax = GRID - 7, ay = GRID - 7;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) m[ay + y][ax + x] = false;
  for (let y = 0; y < 5; y++) { m[ay + y][ax] = true; m[ay + y][ax + 4] = true; }
  for (let x = 0; x < 5; x++) { m[ay][ax + x] = true; m[ay + 4][ax + x] = true; }
  m[ay + 2][ax + 2] = true;

  return m;
}

function matrixToSvg(m, { cell = 10, quiet = 2 } = {}) {
  const side = GRID + quiet * 2;
  const size = side * cell;
  const parts = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!m[y][x]) continue;
      const px = (x + quiet) * cell;
      const py = (y + quiet) * cell;
      parts.push(`<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="1.2" ry="1.2"/>`);
    }
  }
  return `<svg class="holo-qr-svg" viewBox="0 0 ${size} ${size}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code">
    <rect x="0" y="0" width="${size}" height="${size}" fill="rgba(0, 229, 255, 0.04)" rx="8" ry="8"/>
    <g fill="#00e5ff">${parts.join('')}</g>
  </svg>`;
}

function truncateVisible(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1) + '…';
}

export function qrCodeTemplate({ dataset, intent }) {
  const q = coerce(dataset?.data);
  if (!q) {
    return { body: emptyStateBody(intent, 'Need a data string to encode.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'SCAN');

  const matrix = buildMatrix(q.data);
  const svg = matrixToSvg(matrix);

  const captionMarkup = q.caption
    ? `<div class="holo-qr-caption">${escapeHtml(q.caption)}</div>`
    : '';
  const subtitleMarkup = q.subtitle
    ? `<div class="holo-qr-subtitle">${escapeHtml(q.subtitle)}</div>`
    : '';
  const dataPreview = truncateVisible(q.data, 42);

  const body = `<div id="viz" class="holo-qr">
  <style>
    .holo-qr {
      width: 100%; height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 16px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, sans-serif;
    }
    .holo-qr-frame {
      position: relative;
      padding: 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.35);
      box-shadow:
        0 0 0 1px rgba(0, 229, 255, 0.35) inset,
        0 0 24px rgba(0, 229, 255, 0.25);
      max-width: min(60vh, 260px);
      max-height: 260px;
      display: flex;
    }
    .holo-qr-svg {
      width: 100%; height: 100%;
      display: block;
      filter: drop-shadow(0 0 6px rgba(0, 229, 255, 0.45));
    }
    .holo-qr-caption {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: rgba(255, 255, 255, 0.96);
      text-shadow: 0 0 8px rgba(0, 229, 255, 0.4);
      text-align: center;
      max-width: 90%;
    }
    .holo-qr-subtitle {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.18em;
      color: rgba(0, 229, 255, 0.85);
      text-transform: uppercase;
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.35);
      text-align: center;
    }
    .holo-qr-data {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.05em;
      color: rgba(255, 255, 255, 0.48);
      text-align: center;
      word-break: break-all;
      max-width: 90%;
    }
  </style>
  <div class="holo-qr-frame">${svg}</div>
  ${captionMarkup}
  ${subtitleMarkup}
  <div class="holo-qr-data">${escapeHtml(dataPreview)}</div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('qr_code: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

// map_snippet — a stylised location card: cyan grid background, pulse-
// dotted pin, label and address stack. Deliberately not a tile map —
// avoids network calls, off-palette tiles, and the reflector-safety
// issues that come with photographic imagery. Reads as "location here"
// without pretending to be a real-time map.
//
// Data shape:
//   {
//     label,                   // place title, e.g. "Monmouth Coffee"
//     address?,                // street line(s) under the label
//     lat?, lng?,              // rendered as a small mono tag next to the pin
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import { iconHTML } from './primitives.js';

function coerce(data) {
  if (!data) return null;
  const label = String(data.label || data.name || data.title || '').trim();
  if (!label) return null;
  const lat = Number(data.lat);
  const lng = Number(data.lng ?? data.lon);
  return {
    label,
    address: String(data.address || '').trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function fmtCoord(n, kind) {
  if (n == null) return '';
  const hemi = kind === 'lat' ? (n >= 0 ? 'N' : 'S') : (n >= 0 ? 'E' : 'W');
  return `${Math.abs(n).toFixed(4)}°${hemi}`;
}

export function mapSnippetTemplate({ dataset, intent }) {
  const m = coerce(dataset?.data);
  if (!m) {
    return { body: emptyStateBody(intent, 'Need a place label.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'LOCATION');

  const coordsLine = (m.lat != null && m.lng != null)
    ? `${fmtCoord(m.lat, 'lat')} · ${fmtCoord(m.lng, 'lng')}`
    : '';

  const body = `<div id="viz" class="holo-map">
  <style>
    .holo-map {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      padding: 14px 16px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, sans-serif;
      gap: 10px;
    }
    .holo-map-canvas {
      position: relative;
      flex: 1 1 auto;
      min-height: 120px;
      border-radius: 12px;
      background:
        linear-gradient(180deg, rgba(0,229,255,0.06), rgba(0,0,0,0.25)),
        rgba(0, 0, 0, 0.4);
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.28) inset;
      overflow: hidden;
    }
    .holo-map-grid {
      position: absolute; inset: 0;
      background-image:
        linear-gradient(rgba(0,229,255,0.14) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,229,255,0.14) 1px, transparent 1px);
      background-size: 28px 28px, 28px 28px;
      mask-image: radial-gradient(circle at 50% 55%, black 35%, transparent 75%);
    }
    .holo-map-scan {
      position: absolute; inset: 0;
      background: linear-gradient(180deg,
        transparent 0%,
        rgba(0,229,255,0.04) 48%,
        rgba(0,229,255,0.12) 50%,
        rgba(0,229,255,0.04) 52%,
        transparent 100%);
      animation: holo-map-scan 4s linear infinite;
      pointer-events: none;
    }
    @keyframes holo-map-scan {
      0%   { transform: translateY(-100%); }
      100% { transform: translateY(100%); }
    }
    .holo-map-pin {
      position: absolute;
      left: 50%; top: 55%;
      transform: translate(-50%, -100%);
      color: #ff66b3;
      filter: drop-shadow(0 0 8px rgba(255, 102, 179, 0.9));
    }
    .holo-map-pin svg { width: 28px; height: 28px; }
    .holo-map-ring {
      position: absolute;
      left: 50%; top: 55%;
      width: 14px; height: 14px;
      margin-left: -7px; margin-top: -2px;
      border-radius: 50%;
      border: 1px solid rgba(255, 102, 179, 0.8);
      box-shadow: 0 0 12px rgba(255, 102, 179, 0.6);
      animation: holo-map-ping 2.4s ease-out infinite;
    }
    @keyframes holo-map-ping {
      0%   { transform: scale(0.6); opacity: 0.9; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    .holo-map-coord {
      position: absolute;
      left: 12px; bottom: 10px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: rgba(0, 229, 255, 0.75);
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.35);
    }
    .holo-map-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 0 0 auto;
    }
    .holo-map-label {
      font-size: 16px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.96);
      text-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
      line-height: 1.2;
    }
    .holo-map-addr {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.72);
      line-height: 1.35;
    }
    .holo-map-addr .holo-icon {
      color: #00e5ff;
      flex: 0 0 auto;
    }
    @media (prefers-reduced-motion: reduce) {
      .holo-map-scan,
      .holo-map-ring { animation: none; }
    }
  </style>
  <div class="holo-map-canvas">
    <div class="holo-map-grid"></div>
    <div class="holo-map-scan"></div>
    <div class="holo-map-ring"></div>
    <div class="holo-map-pin">
      <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
        <path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z"/>
        <circle cx="12" cy="9" r="2.5" fill="#0a0f14" stroke="#0a0f14"/>
      </svg>
    </div>
    ${coordsLine ? `<div class="holo-map-coord">${escapeHtml(coordsLine)}</div>` : ''}
  </div>
  <div class="holo-map-info">
    <div class="holo-map-label">${escapeHtml(m.label)}</div>
    ${m.address ? `<div class="holo-map-addr">${iconHTML({ name: 'location', inline: true })}<span>${escapeHtml(m.address)}</span></div>` : ''}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('map_snippet: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

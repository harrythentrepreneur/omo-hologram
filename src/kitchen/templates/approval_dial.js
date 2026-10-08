// approval_dial — a circular dial indicator used when Momo needs an
// explicit voice confirmation for a destructive or irreversible action.
// The UI is a visual cue only; there's no interactive turn-to-confirm
// element (voice drives the decision). Reads as a gauge at rest with a
// needle at 12 o'clock, action label, risk chip, and a bottom-of-card
// "SAY 'CONFIRM'" hint.
//
// Data shape:
//   {
//     action,                  // headline: "Delete 12 emails", "Send £500"
//     detail,                  // single clarifying line
//     risk: 'low'|'med'|'high' // controls the palette
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';

const RISKS = { low: 'low', med: 'med', high: 'high' };

function coerce(data) {
  if (!data) return null;
  const action = String(data.action || '').trim();
  if (!action) return null;
  const risk = RISKS[String(data.risk || '').toLowerCase()] || 'med';
  return {
    action,
    detail: String(data.detail || '').trim(),
    risk,
  };
}

// risk → palette + needle angle. High risk sits "pre-rotated" toward 2
// o'clock so the dial reads more charged. Low risk sits at 12.
function riskMeta(risk) {
  switch (risk) {
    case 'low':
      return { accent: '#00e5ff', glow: 'rgba(0, 229, 255, 0.55)', label: 'LOW RISK',  angle: -15 };
    case 'high':
      return { accent: '#ff66b3', glow: 'rgba(255, 102, 179, 0.65)', label: 'HIGH RISK', angle: 55 };
    case 'med':
    default:
      return { accent: '#ffcf66', glow: 'rgba(255, 207, 102, 0.6)', label: 'CAUTION',    angle: 20 };
  }
}

export function approvalDialTemplate({ dataset, intent }) {
  const a = coerce(dataset?.data);
  if (!a) {
    return { body: emptyStateBody(intent, 'Need an action to approve.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'APPROVAL');

  const meta = riskMeta(a.risk);

  // SVG arcs: 270° background track, coloured risk arc overlay.
  // Center at (80, 80), radius 60. The arc sweeps from 7:30 (225°) through
  // 12 to 4:30 (315°, i.e. -45° or +315°) — a 270° range.
  const RADIUS = 60;
  const arcStart = 225;           // degrees from 3 o'clock
  const arcEnd = 315;             // 270° sweep
  const describeArc = (startDeg, endDeg, r) => {
    const toRad = (d) => (d - 90) * Math.PI / 180;
    const x1 = 80 + r * Math.cos(toRad(startDeg));
    const y1 = 80 + r * Math.sin(toRad(startDeg));
    const x2 = 80 + r * Math.cos(toRad(endDeg));
    const y2 = 80 + r * Math.sin(toRad(endDeg));
    const largeArc = (endDeg - startDeg + 360) % 360 > 180 ? 1 : 0;
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  const trackPath = describeArc(arcStart, arcStart + 270, RADIUS);
  const fillPct = a.risk === 'low' ? 0.33 : a.risk === 'med' ? 0.66 : 1.0;
  const fillEnd = arcStart + 270 * fillPct;
  const fillPath = describeArc(arcStart, fillEnd, RADIUS);

  const body = `<div id="viz" class="holo-dial holo-dial--${a.risk}">
  <style>
    .holo-dial {
      width: 100%; height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, sans-serif;
      --accent: ${meta.accent};
      --glow: ${meta.glow};
    }
    .holo-dial-ring {
      position: relative;
      width: 170px;
      height: 170px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .holo-dial-ring svg {
      width: 100%; height: 100%;
      filter: drop-shadow(0 0 6px var(--glow));
    }
    .holo-dial-track {
      fill: none;
      stroke: rgba(255, 255, 255, 0.08);
      stroke-width: 10;
      stroke-linecap: round;
    }
    .holo-dial-fill {
      fill: none;
      stroke: var(--accent);
      stroke-width: 10;
      stroke-linecap: round;
      filter: drop-shadow(0 0 6px var(--glow));
    }
    .holo-dial-needle {
      transform-origin: 80px 80px;
      transform: rotate(${meta.angle}deg);
      stroke: #ffffff;
      stroke-width: 3;
      stroke-linecap: round;
      filter: drop-shadow(0 0 6px var(--glow));
    }
    .holo-dial-hub {
      fill: var(--accent);
      filter: drop-shadow(0 0 8px var(--glow));
    }
    .holo-dial-center {
      position: absolute;
      top: 62%;
      left: 0; right: 0;
      text-align: center;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      color: var(--accent);
      text-shadow: 0 0 6px var(--glow);
      text-transform: uppercase;
    }
    .holo-dial-main {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      text-align: center;
      max-width: 92%;
    }
    .holo-dial-action {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: rgba(255, 255, 255, 0.98);
      text-shadow: 0 0 8px var(--glow);
      line-height: 1.25;
      word-wrap: break-word;
    }
    .holo-dial-detail {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.72);
      line-height: 1.35;
    }
    .holo-dial-hint {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 10px;
      border-radius: 999px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      color: var(--accent);
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
      text-shadow: 0 0 5px var(--glow);
      text-transform: uppercase;
    }
    .holo-dial-hint-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px var(--glow);
      animation: holo-dial-pulse 1.2s ease-in-out infinite;
    }
    @keyframes holo-dial-pulse {
      0%, 100% { opacity: 0.55; transform: scale(0.9); }
      50%      { opacity: 1;    transform: scale(1.15); }
    }
    @media (prefers-reduced-motion: reduce) {
      .holo-dial-hint-dot { animation: none; }
    }
  </style>
  <div class="holo-dial-ring">
    <svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <path class="holo-dial-track" d="${trackPath}"/>
      <path class="holo-dial-fill"  d="${fillPath}"/>
      <line class="holo-dial-needle" x1="80" y1="80" x2="80" y2="34"/>
      <circle class="holo-dial-hub" cx="80" cy="80" r="6"/>
    </svg>
    <div class="holo-dial-center">${escapeHtml(meta.label)}</div>
  </div>
  <div class="holo-dial-main">
    <div class="holo-dial-action">${escapeHtml(a.action)}</div>
    ${a.detail ? `<div class="holo-dial-detail">${escapeHtml(a.detail)}</div>` : ''}
  </div>
  <div class="holo-dial-hint">
    <span class="holo-dial-hint-dot"></span>
    <span>SAY “CONFIRM”</span>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('approval_dial: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

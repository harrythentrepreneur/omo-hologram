// status_ring — a circular progress indicator around a big percentage
// readout, with a status chip (ok / warn / error) underneath. Pure SVG:
// a background track + a stroke-dasharray-animated fill arc, no ECharts.
//
// Data shape:
//   { label, value_pct, status?: 'ok'|'warn'|'error' }
//
// `value_pct` clamps to [0, 100]. Status drives palette:
//   ok    → cyan   (default)
//   warn  → pink   (hologram pink, same as delta down)
//   error → pink with a pulsing halo
//
// CSP note: the SVG is inline, no external refs; the stroke-dasharray
// animation lives in the template's inline <style> so we don't need to
// add anything new to the CSP.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';

const STATUS_SET = new Set(['ok', 'warn', 'error']);

function coerceRing(data) {
  if (!data) return null;
  const label = String(data.label || data.title || '').trim();
  const raw = data.value_pct ?? data.valuePct ?? data.pct ?? data.value;
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  const status = STATUS_SET.has(String(data.status).toLowerCase())
    ? String(data.status).toLowerCase() : 'ok';
  return { label: label || 'STATUS', pct: clamped, status };
}

function statusMeta(status) {
  if (status === 'warn')  return { tag: 'WARN',  cls: 'warn',  chipCls: 'warn' };
  if (status === 'error') return { tag: 'ERROR', cls: 'error', chipCls: 'error' };
  return { tag: 'OK', cls: 'ok', chipCls: 'ok' };
}

export function statusRingTemplate({ dataset, intent }) {
  const r = coerceRing(dataset?.data);
  if (!r) return { body: emptyStateBody(intent, 'Need label + value_pct.'), exposedData: {}, needsEcharts: false };

  titleText(intent, 'STATUS');
  const meta = statusMeta(r.status);

  // Geometry: stroke-width 10, radius 60 → circumference 2π·60 ≈ 376.99.
  // dashoffset animates from full → (1 - pct) * circumference to draw the
  // arc. Start rotation -90deg so the fill begins at 12 o'clock.
  const R = 60;
  const CIRC = (2 * Math.PI * R).toFixed(3);
  const offset = ((1 - r.pct / 100) * (2 * Math.PI * R)).toFixed(3);
  const pctText = r.pct % 1 === 0 ? String(Math.round(r.pct)) : r.pct.toFixed(1);

  const body = `<div id="viz" class="holo-sr holo-sr--${meta.cls}">
  <style>
    .holo-sr {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 14px;
      height: 100%;
      font-family: "SF Pro Text", system-ui, sans-serif;
      --accent: #00e5ff;
      --glow: rgba(0, 229, 255, 0.6);
    }
    .holo-sr--warn  { --accent: #ff66b3; --glow: rgba(255, 102, 179, 0.65); }
    .holo-sr--error { --accent: #ff6b9a; --glow: rgba(255, 107, 154, 0.75); }
    .holo-sr-ring {
      position: relative;
      width: 176px; height: 176px;
      display: flex; align-items: center; justify-content: center;
    }
    .holo-sr-ring svg {
      width: 100%; height: 100%;
      transform: rotate(-90deg);
      filter: drop-shadow(0 0 6px var(--glow));
    }
    .holo-sr-track {
      fill: none;
      stroke: rgba(255, 255, 255, 0.08);
      stroke-width: 10;
    }
    .holo-sr-fill {
      fill: none;
      stroke: var(--accent);
      stroke-width: 10;
      stroke-linecap: round;
      stroke-dasharray: ${CIRC};
      stroke-dashoffset: ${CIRC};
      transition: stroke-dashoffset 1100ms cubic-bezier(0.22, 1, 0.36, 1);
      filter: drop-shadow(0 0 6px var(--glow));
    }
    .holo-sr-center {
      position: absolute;
      inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 4px;
    }
    .holo-sr-pct {
      font-family: "SF Pro Text", system-ui, sans-serif;
      font-size: 36px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: rgba(255, 255, 255, 0.98);
      text-shadow: 0 0 10px var(--glow);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .holo-sr-pct-sym {
      font-size: 18px;
      font-weight: 600;
      color: var(--accent);
      margin-left: 2px;
      vertical-align: top;
    }
    .holo-sr-label {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.7);
    }
    .holo-sr-chip {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 4px 11px;
      border-radius: 999px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: var(--accent);
      background: rgba(0, 229, 255, 0.08);
      border: 1px solid rgba(0, 229, 255, 0.3);
      text-shadow: 0 0 6px var(--glow);
    }
    .holo-sr--warn .holo-sr-chip,
    .holo-sr--error .holo-sr-chip {
      background: rgba(255, 102, 179, 0.08);
      border-color: rgba(255, 102, 179, 0.3);
    }
    .holo-sr-chip-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px var(--glow);
    }
    .holo-sr--error .holo-sr-chip-dot {
      animation: holo-sr-pulse 1.2s ease-in-out infinite;
    }
    @keyframes holo-sr-pulse {
      0%, 100% { transform: scale(0.9); opacity: 0.6; }
      50%      { transform: scale(1.2); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .holo-sr-fill { transition: none; }
      .holo-sr--error .holo-sr-chip-dot { animation: none; }
    }
  </style>
  <div class="holo-sr-ring">
    <svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <circle class="holo-sr-track" cx="80" cy="80" r="${R}"/>
      <circle class="holo-sr-fill"  cx="80" cy="80" r="${R}"/>
    </svg>
    <div class="holo-sr-center">
      <div class="holo-sr-pct">${escapeHtml(pctText)}<span class="holo-sr-pct-sym">%</span></div>
      <div class="holo-sr-label">${escapeHtml(r.label)}</div>
    </div>
  </div>
  <div class="holo-sr-chip">
    <span class="holo-sr-chip-dot"></span>
    <span>${escapeHtml(meta.tag)}</span>
  </div>
  <script>
  (function(){
    try {
      // Trigger the dashoffset animation after paint so the transition
      // actually runs (starting-value animation doesn't fire on first paint).
      requestAnimationFrame(function(){
        var fill = document.querySelector('.holo-sr-fill');
        if (fill) fill.style.strokeDashoffset = '${offset}';
      });
      window.__READY && window.__READY();
    } catch (e) { window.__FAIL && window.__FAIL('status_ring: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

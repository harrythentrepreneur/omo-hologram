// timer_ring — countdown snapshot card. A circular SVG ring that reads
// elapsedPct off the dataset, plus large mono digits (mm:ss) and the
// label below. Deliberately static: the ring does not tick in the iframe
// — a live countdown would need setInterval + visibility handling, and
// re-rendering the projectable on demand is cheaper + safer. Callers
// refresh by invoking the tool again.
//
// Data shape:
//   {
//     label,                  // e.g. "Pomodoro", "Focus", "Bake"
//     totalSec,               // duration in seconds
//     remainingSec,           // seconds left at snapshot time
//     startedAt?,             // ISO; informational only
//     elapsedPct,             // 0..100; pre-computed by the tool
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function coerce(data) {
  if (!data) return null;
  const label = String(data.label || data.title || '').trim();
  const totalSec = Math.max(0, Math.floor(Number(data.totalSec ?? data.total_sec ?? 0)));
  const remainingSec = Math.max(0, Math.floor(Number(data.remainingSec ?? data.remaining_sec ?? totalSec)));
  if (!label && !totalSec) return null;
  const computedPct = totalSec > 0 ? (1 - (remainingSec / totalSec)) * 100 : 0;
  const elapsedPct = clampPct(data.elapsedPct != null ? data.elapsedPct : computedPct);
  return {
    label: label || 'TIMER',
    totalSec,
    remainingSec,
    startedAt: data.startedAt || data.started_at || null,
    elapsedPct,
  };
}

function fmtClock(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtTotal(totalSec) {
  if (totalSec <= 0) return '';
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) {
    const m = Math.round(totalSec / 60);
    return `${m} min`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  return m ? `${h}h ${m}min` : `${h}h`;
}

export function timerRingTemplate({ dataset, intent }) {
  const t = coerce(dataset?.data);
  if (!t) {
    return { body: emptyStateBody(intent, 'Need a label and duration.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'TIMER');

  const RADIUS = 70;
  const circumference = 2 * Math.PI * RADIUS;
  // Ring FILLS as time elapses (cyan → pink near end).
  const filled = (t.elapsedPct / 100) * circumference;
  const remainingLen = circumference - filled;
  const tone = t.elapsedPct >= 85 ? 'pink' : 'cyan';
  const strokeColor = tone === 'pink' ? '#ff66b3' : '#00e5ff';

  const remainingClock = fmtClock(t.remainingSec);
  const totalLine = fmtTotal(t.totalSec);

  const body = `<div id="viz" class="holo-timer holo-timer--${tone}">
  <style>
    .holo-timer {
      width: 100%; height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 14px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, sans-serif;
    }
    .holo-timer-ring {
      position: relative;
      width: 180px;
      height: 180px;
      display: flex; align-items: center; justify-content: center;
      filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.35));
    }
    .holo-timer-ring svg {
      width: 100%; height: 100%;
      transform: rotate(-90deg);
    }
    .holo-timer-track {
      fill: none;
      stroke: rgba(0, 229, 255, 0.12);
      stroke-width: 8;
    }
    .holo-timer-fill {
      fill: none;
      stroke-width: 8;
      stroke-linecap: round;
      transition: stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .holo-timer-center {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    .holo-timer-clock {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 34px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: rgba(255, 255, 255, 0.96);
      text-shadow: 0 0 10px rgba(0, 229, 255, 0.45);
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .holo-timer--pink .holo-timer-clock {
      text-shadow: 0 0 10px rgba(255, 102, 179, 0.55);
    }
    .holo-timer-pct {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.78);
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.35);
      text-transform: uppercase;
    }
    .holo-timer--pink .holo-timer-pct {
      color: rgba(255, 102, 179, 0.85);
      text-shadow: 0 0 5px rgba(255, 102, 179, 0.4);
    }
    .holo-timer-meta {
      display: flex; flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .holo-timer-label {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.03em;
      color: rgba(255, 255, 255, 0.96);
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
      text-transform: uppercase;
    }
    .holo-timer-total {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.18em;
      color: rgba(0, 229, 255, 0.7);
      text-transform: uppercase;
    }
  </style>
  <div class="holo-timer-ring">
    <svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <circle class="holo-timer-track" cx="80" cy="80" r="${RADIUS}"/>
      <circle class="holo-timer-fill" cx="80" cy="80" r="${RADIUS}"
        stroke="${strokeColor}"
        stroke-dasharray="${circumference.toFixed(2)}"
        stroke-dashoffset="${remainingLen.toFixed(2)}"/>
    </svg>
    <div class="holo-timer-center">
      <div class="holo-timer-clock">${escapeHtml(remainingClock)}</div>
      <div class="holo-timer-pct">${Math.round(t.elapsedPct)}%</div>
    </div>
  </div>
  <div class="holo-timer-meta">
    <div class="holo-timer-label">${escapeHtml(t.label)}</div>
    ${totalLine ? `<div class="holo-timer-total">of ${escapeHtml(totalLine)}</div>` : ''}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('timer_ring: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

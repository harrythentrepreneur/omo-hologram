// kpi_card — a single big-number card with a uppercase label, optional
// delta chip, and an optional arrow/icon indicating trend direction. The
// simplest "one metric on stage" projection; lighter than `stat` because
// there's no sparkline.
//
// Data shape (flat):
//   { label, value, delta?, unit?, trend?: 'up'|'down'|'flat' }
//
// Pure-HTML card — no ECharts, no sparkline data. If you want a sparkline,
// use the existing `stat` template instead.

import { escapeHtml, titleText, emptyStateBody, isCurrencyDataset } from './shared.js';

const TREND_SET = new Set(['up', 'down', 'flat']);

function coerceKpi(data, dataset) {
  if (!data) return null;
  const label = String(data.label || data.title || '').trim();
  const rawValue = data.value ?? data.v ?? data.count ?? data.amount;
  if (!label && rawValue == null) return null;

  const unit = data.unit || (isCurrencyDataset(dataset) ? 'USD' : null);
  const trend = TREND_SET.has(String(data.trend).toLowerCase())
    ? String(data.trend).toLowerCase() : null;

  // Delta: accept numbers ("12.4" → +12.4%), pre-formatted strings ("+12%"),
  // or null.
  let delta = null;
  if (data.delta != null) {
    const s = String(data.delta).trim();
    if (s) delta = s;
  }

  return {
    label: label || 'KPI',
    value: rawValue,
    unit,
    trend,
    delta,
  };
}

// Format the hero number server-side. Mirrors the runtime fmt() in HELPERS_JS
// because this card doesn't ship ECharts and doesn't animate.
function formatValue(v, unit) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const cur = unit === 'GBP' ? '£' : unit === 'USD' ? '$' : '';
  const abs = Math.abs(n);
  const opts = abs >= 10000
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: abs < 10 ? 2 : 0 };
  try {
    return cur + new Intl.NumberFormat('en-US', opts).format(n);
  } catch {
    return cur + String(Math.round(n));
  }
}

// Format a raw delta number or pass through a pre-formatted string.
function formatDelta(delta) {
  if (delta == null) return null;
  const s = String(delta).trim();
  if (!s) return null;
  // Already has + or - prefix or a percentage/unit.
  if (/^[+\-±]/.test(s) || /%$/.test(s) || /[a-zA-Z]/.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function trendGlyph(trend, deltaText) {
  // If delta is explicitly negative, force down. If positive, force up.
  if (deltaText && /^-/.test(deltaText)) trend = 'down';
  else if (deltaText && /^\+/.test(deltaText)) trend = trend || 'up';
  if (trend === 'up')   return { arrow: '▲', cls: '' };        // green (default .holo-delta)
  if (trend === 'down') return { arrow: '▼', cls: 'down' };    // pink
  if (trend === 'flat') return { arrow: '—', cls: 'flat' };    // muted
  return null;
}

export function kpiCardTemplate({ dataset, intent }) {
  const k = coerceKpi(dataset?.data, dataset);
  if (!k) return { body: emptyStateBody(intent, 'Need label + value.'), exposedData: {}, needsEcharts: false };

  titleText(intent, 'KPI');
  const heroText = formatValue(k.value, k.unit);
  const deltaText = formatDelta(k.delta);
  const trend = trendGlyph(k.trend, deltaText);

  const chipMarkup = deltaText
    ? `<span class="holo-delta ${trend && trend.cls ? trend.cls : ''}">${trend ? `<span class="holo-kpic-arrow">${trend.arrow}</span>` : ''}${escapeHtml(deltaText)}</span>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-kpic {
      display: flex; flex-direction: column;
      justify-content: center; align-items: flex-start;
      gap: 10px;
      height: 100%;
      padding: 4px 0;
    }
    .holo-kpic-label {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: rgba(0, 229, 255, 0.82);
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
    }
    .holo-kpic-row {
      display: flex; align-items: baseline; gap: 12px;
      flex-wrap: wrap;
    }
    .holo-kpic-arrow {
      font-size: 9px;
      line-height: 1;
      margin-right: 2px;
    }
    .holo-delta.flat {
      color: rgba(255, 255, 255, 0.55);
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.16);
    }
  </style>
  <div class="holo-kpic">
    <div class="holo-kpic-label">${escapeHtml(k.label)}</div>
    <div class="holo-kpic-row">
      <div class="holo-stat">${escapeHtml(heroText)}</div>
      ${chipMarkup}
    </div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('kpi_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

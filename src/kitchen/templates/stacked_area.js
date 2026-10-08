// Multi-series stacked area over time. Cyan base stack, pink accent on
// top. For "what mix made up this total" over time — revenue by channel,
// signups by source, errors by service.
//
// Accepts:
//   data.xs = [t0, t1, ...]                         // shared x-axis
//   data.series = [{ name, values: [v0, v1, ...] }] // up to 4 series; arrays match xs length
// OR
//   data.series = [{ name, points: [{t, v}] }]      // per-series timestamps (all must match)
//
// More than 4 series are folded into the last "OTHER" bucket so the
// hologram stays legible.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, isCurrencyDataset } from './shared.js';

const MAX_SERIES = 4;

function coerceStacked(data) {
  if (!data || !Array.isArray(data.series) || !data.series.length) return null;

  let xs = Array.isArray(data.xs) ? data.xs.map(String)
         : Array.isArray(data.categories) ? data.categories.map(String)
         : null;

  // Build from per-series points: take xs from the first series, require
  // every other series to line up on matching labels.
  if (!xs) {
    const first = data.series[0];
    if (!Array.isArray(first?.points)) return null;
    xs = first.points.map((p) => String(p.t ?? p.x ?? ''));
  }
  if (!xs.length) return null;

  const rawSeries = data.series.map((s) => {
    const name = String(s.name || s.label || 'SERIES').slice(0, 32);
    let values = null;
    if (Array.isArray(s.values)) {
      values = s.values.map(Number);
    } else if (Array.isArray(s.points)) {
      const idx = new Map(s.points.map((p) => [String(p.t ?? p.x ?? ''), Number(p.v ?? p.value ?? p.y ?? 0)]));
      values = xs.map((x) => Number(idx.get(x) || 0));
    } else {
      return null;
    }
    // Normalise length: pad with 0 or truncate.
    if (values.length < xs.length) {
      values = values.concat(Array(xs.length - values.length).fill(0));
    } else if (values.length > xs.length) {
      values = values.slice(0, xs.length);
    }
    values = values.map((v) => (Number.isFinite(v) ? v : 0));
    return { name, values };
  }).filter(Boolean);
  if (!rawSeries.length) return null;

  if (rawSeries.length <= MAX_SERIES) return { xs, series: rawSeries };

  // Fold remaining series into a synthetic 'OTHER' bucket.
  const kept = rawSeries.slice(0, MAX_SERIES - 1);
  const tail = rawSeries.slice(MAX_SERIES - 1);
  const otherValues = xs.map((_, i) => tail.reduce((acc, s) => acc + (s.values[i] || 0), 0));
  kept.push({ name: 'OTHER', values: otherValues });
  return { xs, series: kept };
}

export function stackedAreaTemplate({ dataset, intent }) {
  const s = coerceStacked(dataset?.data);
  if (!s) return { body: emptyStateBody(intent, 'Need series with shared x-axis.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'STACKED');
  const exposedData = { xs: s.xs, series: s.series };

  // Palette: cyan → ice → pink. The top (last) series gets pink.
  // Built inside the iframe script so ECharts has access to
  // echarts.graphic.LinearGradient.
  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var xs  = (window.__DATA && window.__DATA["xs"]) || [];
      var series = (window.__DATA && window.__DATA["series"]) || [];
      if (!xs.length || !series.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var currency = ${JSON.stringify(currency)};

      // Palette stops (alpha on the top for a hologram glow look).
      var stops = [
        { top: '#6ff2ff', bot: 'rgba(0,229,255,0.05)', stroke: '#00e5ff', glow: 'rgba(0,229,255,0.55)' },
        { top: 'rgba(111,242,255,0.85)', bot: 'rgba(0,229,255,0.03)', stroke: 'rgba(111,242,255,0.9)', glow: 'rgba(111,242,255,0.45)' },
        { top: 'rgba(174,239,255,0.75)', bot: 'rgba(174,239,255,0.02)', stroke: 'rgba(174,239,255,0.9)', glow: 'rgba(174,239,255,0.4)' },
        { top: '#ff66b3', bot: 'rgba(255,102,179,0.05)', stroke: '#ff66b3', glow: 'rgba(255,102,179,0.55)' }
      ];
      // Ensure the "top" (last) series gets the pink accent.
      var echSeries = series.map(function(s, i){
        var isLast = (i === series.length - 1);
        var pal = isLast ? stops[3] : stops[Math.min(i, 2)];
        return {
          name: s.name,
          type: 'line',
          stack: 'total',
          smooth: true,
          showSymbol: false,
          symbol: 'none',
          lineStyle: { width: 1.5, color: pal.stroke, shadowColor: pal.glow, shadowBlur: 8 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: pal.top },
              { offset: 1, color: pal.bot }
            ])
          },
          emphasis: { focus: 'series' },
          data: s.values
        };
      });

      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 800, animationEasing: 'cubicOut',
        grid: { top: 24, right: 8, bottom: 24, left: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(0,0,0,0.92)',
          borderColor: '#00e5ff', borderWidth: 1,
          textStyle: { color: '#fff', fontSize: 12 },
          extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
          valueFormatter: function(v){ return fmt(v, { currency: currency }); }
        },
        legend: {
          top: 0, right: 4,
          icon: 'circle', itemGap: 14,
          textStyle: { color: 'rgba(255,255,255,0.55)', fontSize: 10 },
          data: echSeries.map(function(s){ return s.name; })
        },
        xAxis: {
          type: 'category', data: xs, boundaryGap: false,
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10 }
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } },
          axisLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10,
            formatter: function(v){ return fmt(v, { compact: true, currency: currency }); } }
        },
        series: echSeries
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('stacked_area: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

// Day-of-week × week intensity heatmap. Takes a daily timeseries and
// buckets each day into a 7-wide × ceil(N/7)-tall cyan-intensity grid.
// Patterns (weekend spikes, slow Mondays, a bad week) pop at a glance.
//
// Layout: weeks stack vertically, Sun–Sat across. The most recent week
// sits at the bottom so the card reads like a calendar growing toward
// "now". Zero days render as faint cells so the grid shape stays legible.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceTimeseries, isCurrencyDataset } from './shared.js';

// Build a weeks×7 matrix from a list of daily {t, v} points. We index
// days by their UTC weekday (0=Sun..6=Sat) and walk forward from the
// first timestamp's week start, padding leading/trailing cells so every
// row is exactly 7 wide.
function buildMatrix(ts) {
  const sorted = ts.slice().sort((a, b) => String(a.t).localeCompare(String(b.t)));
  // Parse ISO dates; fall back to index-only if parsing fails.
  const dated = sorted.map((p, i) => {
    const d = new Date(p.t + 'T12:00:00Z');
    return {
      t: p.t,
      v: p.v,
      idx: i,
      wday: Number.isFinite(d.getUTCDay()) ? d.getUTCDay() : (i % 7),
      ts: Number.isFinite(d.getTime()) ? d.getTime() : null,
    };
  });
  // If no valid timestamps, bail to empty grid.
  if (!dated.some((x) => x.ts != null)) return null;

  const firstValid = dated.find((x) => x.ts != null);
  const firstWeekStart = firstValid.ts - firstValid.wday * 86400000;

  const cells = [];
  for (const d of dated) {
    if (d.ts == null) continue;
    const dayOffset = Math.round((d.ts - firstWeekStart) / 86400000);
    const row = Math.floor(dayOffset / 7);
    const col = dayOffset % 7;
    cells.push({ row, col, v: d.v, t: d.t });
  }
  const rows = Math.max(1, cells.reduce((m, c) => Math.max(m, c.row), 0) + 1);
  // Normalise rows so newest sits at the bottom, oldest at the top.
  // ECharts' yAxis renders bottom-up by default, so we reverse the row
  // index to invert.
  for (const c of cells) c.row = rows - 1 - c.row;
  return { cells, rows };
}

export function heatmapTemplate({ dataset, intent }) {
  const ts = coerceTimeseries(dataset?.data);
  if (!ts || ts.length < 7) {
    return { body: emptyStateBody(intent, 'Need at least a week of daily data.'), exposedData: {} };
  }
  const matrix = buildMatrix(ts);
  if (!matrix) {
    return { body: emptyStateBody(intent, 'Could not parse dates for heatmap.'), exposedData: {} };
  }
  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'PATTERN');
  const values = matrix.cells.map((c) => c.v);
  const maxV = values.length ? Math.max(...values) : 1;
  const exposedData = { cells: matrix.cells, rows: matrix.rows, maxV };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var data = (window.__DATA && window.__DATA) || {};
      var cells = data["cells"] || [];
      var rows  = data["rows"]  || 1;
      var maxV  = data["maxV"]  || 1;
      if (!cells.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var currency = ${JSON.stringify(currency)};
      var heatData = cells.map(function(c){ return [c.col, c.row, c.v, c.t]; });

      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 700, animationEasing: 'cubicOut',
        animationDelay: function(i){ return i * 8; },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.92)',
          borderColor: '#00e5ff', borderWidth: 1,
          textStyle: { color: '#fff', fontSize: 12 },
          extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
          formatter: function(p){
            var v = p.value[2];
            var t = p.value[3] || '';
            return '<b>' + t + '</b><br/>' + fmt(v, { currency: currency });
          }
        },
        grid: { top: 24, right: 12, bottom: 10, left: 30, containLabel: true },
        xAxis: {
          type: 'category',
          data: ['SUN','MON','TUE','WED','THU','FRI','SAT'],
          position: 'top',
          axisLine:  { show: false },
          axisTick:  { show: false },
          splitLine: { show: false },
          axisLabel: {
            color: 'rgba(255,255,255,0.55)',
            fontSize: 9, letterSpacing: 2, fontWeight: 600
          }
        },
        yAxis: {
          type: 'category',
          data: Array.from({ length: rows }, function(_, i){ return 'W' + (rows - i); }),
          axisLine:  { show: false },
          axisTick:  { show: false },
          splitLine: { show: false },
          axisLabel: {
            color: 'rgba(255,255,255,0.35)',
            fontSize: 9, fontFamily: '"SF Mono", monospace'
          }
        },
        visualMap: {
          min: 0, max: maxV,
          show: false,
          inRange: {
            color: [
              'rgba(0, 229, 255, 0.05)',
              'rgba(0, 229, 255, 0.28)',
              'rgba(0, 229, 255, 0.55)',
              'rgba(111, 242, 255, 0.9)',
              '#6ff2ff'
            ]
          }
        },
        series: [{
          type: 'heatmap',
          data: heatData,
          itemStyle: {
            borderRadius: 4,
            borderColor: 'rgba(0, 229, 255, 0.12)',
            borderWidth: 1,
            shadowColor: 'rgba(0, 229, 255, 0.35)',
            shadowBlur: 4
          },
          emphasis: {
            itemStyle: {
              borderColor: '#00e5ff',
              borderWidth: 1.5,
              shadowBlur: 14,
              shadowColor: 'rgba(0, 229, 255, 0.9)'
            }
          },
          progressive: 0
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('heatmap: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

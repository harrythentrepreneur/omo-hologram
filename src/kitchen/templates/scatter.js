// x/y scatter. Cyan glowing dots; optional per-series colouring (cyan +
// one pink accent series). For correlation shapes, anomaly spotting,
// "did the metric wiggle with X".
//
// Accepts:
//   data.points = [{ x, y, label? }]                — single series
//   data.series = [{ name, points: [{x,y}] }]       — up to 2 series
//   data = [{x, y}]                                 — bare array fallback
//
// Second series is rendered in pink. More than 2 series → the third+ are
// ignored (palette discipline — see generatorThemeBlock).

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, isCurrencyDataset } from './shared.js';

function coerceScatter(data) {
  if (!data) return null;
  if (Array.isArray(data.series) && data.series.length) {
    const s = data.series.slice(0, 2).map((ser, i) => {
      const pts = (Array.isArray(ser.points) ? ser.points : [])
        .map((p) => coercePoint(p)).filter(Boolean);
      return { name: String(ser.name || (i === 0 ? 'PRIMARY' : 'SECONDARY')), points: pts };
    }).filter((s) => s.points.length);
    return s.length ? s : null;
  }
  const raw = Array.isArray(data.points) ? data.points
            : Array.isArray(data) ? data
            : null;
  if (!raw) return null;
  const pts = raw.map((p) => coercePoint(p)).filter(Boolean);
  if (!pts.length) return null;
  return [{ name: 'PRIMARY', points: pts }];
}

function coercePoint(p) {
  if (!p) return null;
  const x = Number(p.x ?? p[0]);
  const y = Number(p.y ?? p[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const label = p.label != null ? String(p.label) : null;
  return { x, y, label };
}

export function scatterTemplate({ dataset, intent }) {
  const series = coerceScatter(dataset?.data);
  if (!series) return { body: emptyStateBody(intent, 'Need x/y points.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'SCATTER');
  const exposedData = { series };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var series = (window.__DATA && window.__DATA["series"]) || [];
      if (!series.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var currency = ${JSON.stringify(currency)};

      var palette = [
        { color: '#00e5ff', glow: 'rgba(0,229,255,0.65)' },
        { color: '#ff66b3', glow: 'rgba(255,102,179,0.65)' }
      ];
      var echSeries = series.slice(0, 2).map(function(s, i){
        var pal = palette[i];
        return {
          name: s.name || ('S'+(i+1)),
          type: 'scatter',
          data: (s.points || []).map(function(p){ return [p.x, p.y, p.label]; }),
          symbolSize: 10,
          itemStyle: {
            color: pal.color,
            shadowColor: pal.glow,
            shadowBlur: 12,
            borderColor: 'rgba(255,255,255,0.65)',
            borderWidth: 1
          },
          emphasis: {
            itemStyle: { shadowBlur: 20 }
          }
        };
      });

      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 700, animationEasing: 'cubicOut',
        animationDelay: function(i){ return i * 18; },
        grid: { top: 16, right: 16, bottom: 28, left: 40, containLabel: true },
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(0,0,0,0.92)',
          borderColor: '#00e5ff', borderWidth: 1,
          textStyle: { color: '#fff', fontSize: 12 },
          extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
          formatter: function(p){
            var v = p.value;
            var lbl = v[2] ? '<b>' + v[2] + '</b><br/>' : '';
            return lbl + 'x: ' + fmt(v[0], { currency: currency }) +
                   '<br/>y: ' + fmt(v[1], { currency: currency });
          }
        },
        xAxis: {
          type: 'value', scale: true,
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } },
          axisLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10,
            formatter: function(v){ return fmt(v, { compact: true }); } }
        },
        yAxis: {
          type: 'value', scale: true,
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } },
          axisLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10,
            formatter: function(v){ return fmt(v, { compact: true }); } }
        },
        legend: series.length > 1 ? {
          top: 4, right: 8,
          icon: 'circle',
          itemGap: 16,
          textStyle: { color: 'rgba(255,255,255,0.55)', fontSize: 10 }
        } : undefined,
        series: echSeries
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('scatter: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

// Goal gauge. One KPI rendered as a 270° arc — cyan fill from start to
// current, pink tick at the target, big count-up in the centre. For "am
// I on track to hit my number" questions (monthly revenue goal, ROAS
// target, daily orders).
//
// Accepts either:
//   data.gauge = { value, target, unit?, label? }         — canonical
//   data.value + data.target + data.unit + data.label     — flat
// Falls back to summing a timeseries for `value` against an implied
// 'target' that the dataset summary might carry (total * 1.15 by default).

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, isCurrencyDataset, coerceTimeseries } from './shared.js';

function coerceGauge(dataset) {
  if (!dataset?.data) return null;
  const d = dataset.data;
  if (d.gauge && typeof d.gauge === 'object') {
    return {
      value: Number(d.gauge.value) || 0,
      target: Number(d.gauge.target) || 0,
      unit: d.gauge.unit || d.unit || null,
      label: d.gauge.label || null,
    };
  }
  if (Number.isFinite(Number(d.value)) && Number.isFinite(Number(d.target))) {
    return {
      value: Number(d.value),
      target: Number(d.target),
      unit: d.unit || null,
      label: d.label || null,
    };
  }
  // Fallback: a timeseries with no explicit target. Default target =
  // max historical day × 1.2 so the gauge has something to aim at; the
  // model can pass explicit target if the user mentions a goal.
  const ts = coerceTimeseries(d);
  if (ts && ts.length) {
    const total = ts.reduce((a, r) => a + r.v, 0);
    const peak = ts.reduce((m, r) => (r.v > m ? r.v : m), ts[0].v);
    return {
      value: total,
      target: Math.max(total, Math.round(peak * ts.length * 0.8)),
      unit: d.unit || null,
      label: null,
    };
  }
  return null;
}

export function gaugeTemplate({ dataset, intent }) {
  const g = coerceGauge(dataset);
  if (!g || g.target <= 0) {
    return { body: emptyStateBody(intent, 'Need { value, target } or a gauge block.'), exposedData: {} };
  }
  const currency = (g.unit === 'GBP' || g.unit === 'USD') ? g.unit
                 : isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'GOAL');
  const exposedData = { gauge: g };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div style="position:relative;flex:1 1 auto;min-height:0;">
    <div class="holo-chart" id="chart" style="position:absolute;inset:0;"></div>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;">
      <div class="holo-stat holo-stat--md" id="hero">0</div>
      <div class="holo-sub" id="sub" style="margin-top:6px;">OF 0</div>
      <span class="holo-delta" id="chip" style="margin-top:8px;">+0%</span>
    </div>
  </div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var g = (window.__DATA && window.__DATA["gauge"]) || null;
      if (!g) { window.__FAIL && window.__FAIL('empty'); return; }
      var value = Number(g.value) || 0;
      var target = Number(g.target) || 1;
      var pct = Math.max(0, Math.min(1, value / target));
      var currency = ${JSON.stringify(currency)};

      animateCountUp(document.getElementById('hero'), value,
        { duration: 1000, format: function(v){ return fmt(v, { currency: currency, compact: true }); } });
      document.getElementById('sub').textContent =
        'OF ' + fmt(target, { currency: currency, compact: true });
      var chip = document.getElementById('chip');
      chip.textContent = (pct * 100).toFixed(1) + '% TO GOAL';
      if (pct < 0.5) chip.classList.add('down');

      // ECharts gauge — open-arc, thick stroke, progress gradient. We
      // compose THREE data series so the pink target tick is authored
      // independently of the cyan progress arc and the faint track.
      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 1000, animationEasing: 'cubicOut',
        series: [
          // Background track (full arc).
          {
            type: 'gauge',
            startAngle: 225, endAngle: -45,
            min: 0, max: 1,
            radius: '92%',
            progress: { show: false },
            pointer: { show: false },
            axisLine: {
              lineStyle: {
                width: 10,
                color: [[1, 'rgba(0, 229, 255, 0.10)']]
              }
            },
            splitLine: { show: false },
            axisTick:  { show: false },
            axisLabel: { show: false },
            title:     { show: false },
            detail:    { show: false },
            data: [{ value: 1 }]
          },
          // Progress arc.
          {
            type: 'gauge',
            startAngle: 225, endAngle: -45,
            min: 0, max: 1,
            radius: '92%',
            progress: {
              show: true,
              width: 10,
              roundCap: true,
              itemStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 1, 1, [
                  { offset: 0, color: '#6ff2ff' },
                  { offset: 1, color: '#00e5ff' }
                ]),
                shadowColor: 'rgba(0, 229, 255, 0.6)',
                shadowBlur: 14
              }
            },
            pointer: { show: false },
            axisLine:  { lineStyle: { width: 0 } },
            splitLine: { show: false },
            axisTick:  { show: false },
            axisLabel: { show: false },
            title:     { show: false },
            detail:    { show: false },
            data: [{ value: pct }]
          },
          // Target tick (pink).
          {
            type: 'gauge',
            startAngle: 225, endAngle: -45,
            min: 0, max: 1,
            radius: '92%',
            progress: { show: false },
            axisLine:  { lineStyle: { width: 0 } },
            splitLine: { show: false },
            axisTick:  { show: false },
            axisLabel: { show: false },
            title:     { show: false },
            detail:    { show: false },
            pointer: {
              show: true,
              length: '10%',
              width: 3,
              offsetCenter: [0, '-90%'],
              itemStyle: {
                color: '#ff66b3',
                shadowColor: 'rgba(255, 102, 179, 0.6)',
                shadowBlur: 10
              }
            },
            data: [{ value: 1 }]  // always anchor at target
          }
        ]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('gauge: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

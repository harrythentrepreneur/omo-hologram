// Waterfall decomposition. Starts with an opening bar, walks up/down
// through named contributors, lands on a closing bar. Positive deltas
// cyan, negative pink. Perfect for "what moved the number" explanations:
// month-start revenue → +new launches → -returns → +email bump → today.
//
// Input shapes:
//   data.steps = [{label, value, type?}]   // type: 'start' | 'delta' | 'end'
//   // if 'type' omitted, we infer: first=start, last=end, middle=delta
//   data.opening + data.closing + data.deltas=[{label, value}]  // alt
//
// The ECharts trick: we use a stacked bar with an invisible "base" series
// sitting under the coloured series so each middle bar floats at the
// running total from the prior step.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, isCurrencyDataset } from './shared.js';

function coerceWaterfall(data) {
  if (!data) return null;
  if (Array.isArray(data.steps) && data.steps.length >= 3) {
    return data.steps.map((s, i, arr) => ({
      label: String(s.label || s.name || ''),
      value: Number(s.value ?? s.v ?? 0),
      type:  s.type
        || (i === 0 ? 'start' : (i === arr.length - 1 ? 'end' : 'delta')),
    }));
  }
  const opening = Number(data.opening);
  const closing = Number(data.closing);
  const deltas = Array.isArray(data.deltas) ? data.deltas : null;
  if (Number.isFinite(opening) && deltas && deltas.length) {
    const steps = [{ label: data.opening_label || 'START', value: opening, type: 'start' }];
    for (const d of deltas) {
      steps.push({
        label: String(d.label || d.name || ''),
        value: Number(d.value ?? d.v ?? 0),
        type:  'delta',
      });
    }
    const closingVal = Number.isFinite(closing)
      ? closing
      : opening + deltas.reduce((a, d) => a + (Number(d.value ?? d.v ?? 0)), 0);
    steps.push({ label: data.closing_label || 'END', value: closingVal, type: 'end' });
    return steps;
  }
  return null;
}

// Walks the steps to produce (base, delta) pairs for ECharts stacking.
// START/END rows anchor at 0 with value shown directly; middle rows have
// a base equal to the running total minus the delta (for positives) or
// plus the delta (for negatives). `running` tracks the hypothetical
// balance so the END bar lands on its canonical value.
function stackPairs(steps) {
  const rows = [];
  let running = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'start') {
      rows.push({ ...s, base: 0, barValue: s.value, sign: 0 });
      running = s.value;
    } else if (s.type === 'end') {
      rows.push({ ...s, base: 0, barValue: s.value, sign: 0 });
      running = s.value;
    } else {
      const v = s.value;
      if (v >= 0) {
        rows.push({ ...s, base: running, barValue: v, sign: 1 });
        running += v;
      } else {
        rows.push({ ...s, base: running + v, barValue: -v, sign: -1 });
        running += v;
      }
    }
  }
  return rows;
}

export function waterfallTemplate({ dataset, intent }) {
  const steps = coerceWaterfall(dataset?.data);
  if (!steps) {
    return { body: emptyStateBody(intent, 'Need waterfall steps or opening/deltas/closing.'), exposedData: {} };
  }
  const rows = stackPairs(steps);
  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'WATERFALL');
  const exposedData = { rows };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var rows = (window.__DATA && window.__DATA["rows"]) || [];
      if (!rows.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var currency = ${JSON.stringify(currency)};
      var labels = rows.map(function(r){ return r.label; });
      var bases  = rows.map(function(r){ return r.base; });
      var vals   = rows.map(function(r, i){
        // Anchor bars (start/end) get the full height painted in the
        // visible series; middle deltas only paint the delta slice above
        // the invisible base.
        if (r.sign === 0) return { value: r.barValue, itemStyle: anchorStyle() };
        if (r.sign > 0)   return { value: r.barValue, itemStyle: positiveStyle() };
        return                { value: r.barValue, itemStyle: negativeStyle() };
      });

      function anchorStyle() {
        return {
          borderRadius: [4,4,0,0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(255,255,255,0.85)' },
            { offset: 1, color: 'rgba(0, 229, 255, 0.55)' }
          ]),
          shadowColor: 'rgba(0, 229, 255, 0.35)', shadowBlur: 10
        };
      }
      function positiveStyle() {
        return {
          borderRadius: [4,4,0,0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: '#6ff2ff' },
            { offset: 1, color: 'rgba(0, 229, 255, 0.35)' }
          ]),
          shadowColor: 'rgba(0, 229, 255, 0.35)', shadowBlur: 8
        };
      }
      function negativeStyle() {
        return {
          borderRadius: [0,0,4,4],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(255, 102, 179, 0.45)' },
            { offset: 1, color: '#ff66b3' }
          ]),
          shadowColor: 'rgba(255, 102, 179, 0.45)', shadowBlur: 8
        };
      }

      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 800, animationEasing: 'cubicOut',
        animationDelay: function(i){ return i * 50; },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0, 229, 255, 0.08)' } },
          backgroundColor: 'rgba(0,0,0,0.92)',
          borderColor: '#00e5ff', borderWidth: 1,
          textStyle: { color: '#fff', fontSize: 12 },
          extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
          formatter: function(ps){
            var idx = ps[0] && ps[0].dataIndex;
            var row = rows[idx];
            if (!row) return '';
            var sign = row.sign > 0 ? '+' : (row.sign < 0 ? '−' : '');
            var signed = row.sign === 0 ? fmt(row.barValue, { currency: currency })
                                        : sign + fmt(row.barValue, { currency: currency });
            return '<b>' + row.label + '</b><br/>' + signed;
          }
        },
        grid: { top: 24, right: 12, bottom: 30, left: 12, containLabel: true },
        xAxis: {
          type: 'category',
          data: labels,
          axisLine:  { show: false },
          axisTick:  { show: false },
          splitLine: { show: false },
          axisLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 10, interval: 0 }
        },
        yAxis: {
          type: 'value',
          show: true,
          axisLine:  { show: false },
          axisTick:  { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)', type: 'dashed' } },
          axisLabel: {
            color: 'rgba(255,255,255,0.45)', fontSize: 10,
            formatter: function(v){ return fmt(v, { compact: true, currency: currency }); }
          }
        },
        series: [
          // Invisible base — lifts the coloured delta bars to their floating start.
          {
            type: 'bar',
            stack: 'wf',
            data: bases,
            itemStyle: { color: 'transparent' },
            emphasis: { itemStyle: { color: 'transparent' } },
            silent: true,
            barCategoryGap: '32%'
          },
          // The visible series — anchor bars, positive deltas, negative deltas.
          {
            type: 'bar',
            stack: 'wf',
            data: vals,
            label: {
              show: true,
              position: 'top',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 10,
              fontWeight: 600,
              formatter: function(p){
                var r = rows[p.dataIndex];
                if (!r) return '';
                if (r.sign === 0) return fmt(r.barValue, { compact: true, currency: currency });
                var sign = r.sign > 0 ? '+' : '−';
                return sign + fmt(r.barValue, { compact: true, currency: currency });
              }
            }
          }
        ]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('waterfall: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

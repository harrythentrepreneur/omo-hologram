// Current vs previous period. Accepts either an explicit split
// ({curr:[...], prev:[...]}) or a single timeseries we halve. Ghost
// dashed previous, solid cyan current on top with area fill.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceTimeseries, isCurrencyDataset } from './shared.js';

export function comparisonTemplate({ dataset, intent }) {
  let curr = null, prev = null;
  const d = dataset?.data;
  if (d && Array.isArray(d.curr)) {
    curr = coerceTimeseries({ series: d.curr });
    prev = Array.isArray(d.prev) ? coerceTimeseries({ series: d.prev }) : null;
  } else {
    const ts = coerceTimeseries(d);
    if (ts && ts.length >= 4) {
      const mid = Math.floor(ts.length / 2);
      prev = ts.slice(0, mid);
      curr = ts.slice(mid);
    }
  }
  if (!curr || !curr.length) {
    return { body: emptyStateBody(intent, 'Need a timeseries dataset.'), exposedData: {} };
  }
  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'VS PREVIOUS');
  const exposedData = { curr, prev };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div style="display:flex;align-items:baseline;gap:10px;">
    <div class="holo-stat" id="hero">0</div>
    <span class="holo-delta" id="chip">+0%</span>
  </div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var curr = (window.__DATA && window.__DATA["curr"]) || [];
      var prev = (window.__DATA && window.__DATA["prev"]) || null;
      if (!curr.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var cy = curr.map(function(r){return r.v});
      var currTotal = 0; for (var i = 0; i < cy.length; i++) currTotal += cy[i];
      var prevTotal = 0;
      if (prev && prev.length) for (var j = 0; j < prev.length; j++) prevTotal += prev[j].v;
      else prevTotal = cy[0] || 0;
      var pct = prevTotal !== 0 ? ((currTotal - prevTotal) / Math.abs(prevTotal)) * 100 : 0;
      var currency = ${JSON.stringify(currency)};
      animateCountUp(document.getElementById('hero'), currTotal,
        { duration:900, format:function(v){ return fmt(v,{currency:currency}); } });
      var chip = document.getElementById('chip');
      chip.textContent = (pct>=0?'+':'') + pct.toFixed(1) + '%';
      if (pct < 0) chip.classList.add('down');
      var series = [];
      if (prev && prev.length) series.push({
        type:'line', smooth:true, showSymbol:false, data: prev.map(function(r){return r.v}), z:0,
        lineStyle:{ width:1, color:'rgba(0,229,255,0.35)', type:'dashed' }
      });
      series.push({
        type:'line', smooth:true, showSymbol:false, data: cy, z:2,
        lineStyle:{ width:1.5, color:'#00e5ff', shadowColor:'rgba(0,229,255,0.45)', shadowBlur:10 },
        areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
          { offset:0, color:'rgba(0,229,255,0.22)' },
          { offset:1, color:'rgba(0,229,255,0.00)' }]) }
      });
      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor:'transparent',
        animation:true, animationDuration:800, animationEasing:'cubicOut',
        grid:{ top:4, right:4, bottom:4, left:4 },
        xAxis:{ type:'category', show:false, data: curr.map(function(r){return r.t}), boundaryGap:false },
        yAxis:{ show:false },
        series: series
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('comparison: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

// Big count-up number + ±% delta chip + sparkline underneath. Stat cards
// want the latest value as the hero; the sparkline provides shape at a
// glance without competing with the number.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceTimeseries, isCurrencyDataset } from './shared.js';

export function statTemplate({ dataset, intent }) {
  const ts = coerceTimeseries(dataset?.data);
  if (!ts) return { body: emptyStateBody(intent, 'Need a timeseries dataset.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'SUMMARY');
  const exposedData = { ts };

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
      var rows = (window.__DATA && window.__DATA["ts"]) || [];
      if (!rows.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var ys = rows.map(function(r){return r.v});
      var hero = ys[ys.length-1] || 0;
      var first = ys[0] || 0;
      var pct = first !== 0 ? ((hero-first)/Math.abs(first))*100 : 0;
      var currency = ${JSON.stringify(currency)};
      animateCountUp(document.getElementById('hero'), hero,
        { duration:900, format:function(v){ return fmt(v,{currency:currency}); } });
      var chip = document.getElementById('chip');
      chip.textContent = (pct>=0?'+':'') + pct.toFixed(1) + '%';
      if (pct < 0) chip.classList.add('down');
      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor:'transparent',
        animation:true, animationDuration:800, animationEasing:'cubicOut',
        grid:{ top:4, right:4, bottom:4, left:4 },
        xAxis:{ type:'category', show:false, data: rows.map(function(r){return r.t}), boundaryGap:false },
        yAxis:{ show:false },
        series:[{
          type:'line', smooth:true, showSymbol:false, data: ys,
          lineStyle:{ width:1.5, color:'#00e5ff' },
          areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
            { offset:0, color:'rgba(0,229,255,0.22)' },
            { offset:1, color:'rgba(0,229,255,0.00)' }]) }
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('stat: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

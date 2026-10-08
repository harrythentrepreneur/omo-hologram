// Composition donut with centre hero count-up. Thick ring, padded slices,
// labels only when slice >=10%.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceCategorical, isCurrencyDataset } from './shared.js';

export function donutTemplate({ dataset, intent }) {
  const rows = coerceCategorical(dataset?.data);
  if (!rows) return { body: emptyStateBody(intent, 'Need a categorical dataset.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'BREAKDOWN');
  const exposedData = { slices: rows };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div style="position:relative;flex:1 1 auto;min-height:0;">
    <div class="holo-chart" id="chart" style="position:absolute;inset:0;"></div>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;">
      <div class="holo-stat holo-stat--md" id="hero">0</div>
      <div class="holo-sub" style="margin-top:4px;">TOTAL</div>
    </div>
  </div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var rows = (window.__DATA && window.__DATA["slices"]) || [];
      if (!rows.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var total = 0;
      for (var i = 0; i < rows.length; i++) total += rows[i].v;
      var currency = ${JSON.stringify(currency)};
      animateCountUp(document.getElementById('hero'), total,
        { duration: 900, format: function(v){ return fmt(v,{currency:currency}); } });
      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor:'transparent',
        animation:true, animationDuration:800, animationEasing:'cubicOut',
        tooltip:{ trigger:'item', backgroundColor:'rgba(0,0,0,0.92)', borderColor:'#00e5ff',
          borderWidth:1, textStyle:{ color:'#fff', fontSize:12 },
          extraCssText:'backdrop-filter:blur(8px);border-radius:8px;',
          valueFormatter:function(v){ return fmt(v,{currency:currency}); } },
        color:['#00e5ff','#aeefff','rgba(255,255,255,0.35)','rgba(255,255,255,0.18)','#ff66b3'],
        series:[{
          type:'pie', radius:['62%','82%'], center:['50%','50%'],
          padAngle:2, itemStyle:{ borderRadius:4, borderColor:'transparent' },
          label:{ show:true, color:'rgba(255,255,255,0.94)', fontSize:11,
            formatter:function(p){ return p.percent >= 10 ? p.name+' '+p.percent.toFixed(0)+'%' : ''; } },
          labelLine:{ length:8, length2:12, lineStyle:{ color:'rgba(255,255,255,0.35)' } },
          data: rows.map(function(r){ return { name:r.label, value:r.v }; })
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('donut: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

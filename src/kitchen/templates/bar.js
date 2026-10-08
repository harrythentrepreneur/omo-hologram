// Vertical categorical bars. Cyan gradient body, pink gradient on the peak
// bar, rounded top corners, inline value labels above each bar.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceCategorical, isCurrencyDataset } from './shared.js';

export function barTemplate({ dataset, intent }) {
  const rows = coerceCategorical(dataset?.data);
  if (!rows) return { body: emptyStateBody(intent, 'Need a categorical dataset.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'BREAKDOWN');
  const exposedData = { bars: rows };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var rows = (window.__DATA && window.__DATA["bars"]) || [];
      if (!rows.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var peak = 0;
      for (var i = 0; i < rows.length; i++) if (rows[i].v > rows[peak].v) peak = i;
      var currency = ${JSON.stringify(currency)};
      var data = rows.map(function(r, i){
        if (i === peak) return { value: r.v, itemStyle:{ borderRadius:[6,6,0,0],
          color: new echarts.graphic.LinearGradient(0,0,0,1,[
            { offset:0, color:'#ff66b3' }, { offset:1, color:'rgba(255,102,179,0.25)' }]) } };
        return { value: r.v };
      });
      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor:'transparent',
        animation:true, animationDuration:800, animationEasing:'cubicOut',
        animationDelay:function(i){ return i*30; },
        grid:{ top:24, right:8, bottom:24, left:8, containLabel:true },
        tooltip:{ trigger:'axis', backgroundColor:'rgba(0,0,0,0.92)', borderColor:'#00e5ff',
          borderWidth:1, textStyle:{ color:'#fff', fontSize:12 },
          extraCssText:'backdrop-filter:blur(8px);border-radius:8px;',
          valueFormatter:function(v){ return fmt(v,{currency:currency}); } },
        xAxis:{ type:'category', data: rows.map(function(r){return r.label}),
          axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
          axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10 } },
        yAxis:{ show:false },
        series:[{
          type:'bar', barWidth:'58%', data: data,
          label:{ show:true, position:'top', color:'rgba(255,255,255,0.94)',
            fontSize:11, fontWeight:600,
            formatter:function(p){ return fmt(p.value,{compact:true,currency:currency}); } },
          itemStyle:{ borderRadius:[6,6,0,0],
            color: new echarts.graphic.LinearGradient(0,0,0,1,[
              { offset:0, color:'#00e5ff' }, { offset:1, color:'rgba(0,229,255,0.25)' }]) }
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('bar: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

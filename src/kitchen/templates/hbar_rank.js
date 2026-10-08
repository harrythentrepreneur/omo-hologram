// Horizontal leaderboard — top-N rows, rank 1 on top with a pink gradient,
// inline value labels to the right. Sorted descending by value, capped
// at 8 rows so the card doesn't squeeze.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceCategorical, isCurrencyDataset } from './shared.js';

export function hbarRankTemplate({ dataset, intent }) {
  const rows = coerceCategorical(dataset?.data);
  if (!rows) return { body: emptyStateBody(intent, 'Need a categorical dataset.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'LEADERBOARD');
  const exposedData = { rows };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var raw = (window.__DATA && window.__DATA["rows"]) || [];
      if (!raw.length) { window.__FAIL && window.__FAIL('empty'); return; }
      raw = raw.slice().sort(function(a,b){return b.v-a.v}).slice(0, 8);
      // ECharts renders yAxis category bottom-up; reverse so rank 1 sits on top.
      var rows = raw.slice().reverse();
      var topIdx = rows.length - 1;
      var currency = ${JSON.stringify(currency)};
      var data = rows.map(function(r, i){
        if (i === topIdx) return { value:r.v, itemStyle:{ borderRadius:[4,4,4,4],
          color: new echarts.graphic.LinearGradient(1,0,0,0,[
            { offset:0, color:'#ff66b3' }, { offset:1, color:'rgba(255,102,179,0.25)' }]) } };
        return { value:r.v };
      });
      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor:'transparent',
        animation:true, animationDuration:800, animationEasing:'cubicOut',
        animationDelay:function(i){ return i*40; },
        grid:{ top:4, right:72, bottom:4, left:8, containLabel:true },
        xAxis:{ type:'value', show:false, splitLine:{show:false} },
        yAxis:{ type:'category', data: rows.map(function(r){return r.label}),
          axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
          axisLabel:{ color:'rgba(255,255,255,0.94)', fontSize:11, fontWeight:500 } },
        series:[{
          type:'bar', barWidth: 14, data: data,
          label:{ show:true, position:'right', color:'rgba(255,255,255,0.94)',
            fontSize:11, fontWeight:600,
            formatter:function(p){ return fmt(p.value,{compact:true,currency:currency}); } },
          itemStyle:{ borderRadius:[4,4,4,4],
            color: new echarts.graphic.LinearGradient(1,0,0,0,[
              { offset:0, color:'#00e5ff' }, { offset:1, color:'rgba(0,229,255,0.20)' }]) }
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('hbar: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

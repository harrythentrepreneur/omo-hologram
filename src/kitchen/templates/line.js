// Timeseries trend. Smooth cyan line + area gradient, glowing last-point
// dot, ±percentage chip in the header, dashed "PEAK" mark-line when the
// peak isn't the last point.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceTimeseries, isCurrencyDataset } from './shared.js';

export function lineTemplate({ dataset, intent }) {
  const ts = coerceTimeseries(dataset?.data);
  if (!ts) return { body: emptyStateBody(intent, 'Need a timeseries dataset.'), exposedData: {} };

  const currency = isCurrencyDataset(dataset) ? 'USD' : null;
  const title = titleText(intent, 'TREND');
  const exposedData = { ts };

  const body = `<div id="viz">
  <div class="holo-head">
    <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
    <span class="holo-delta" id="chip">+0%</span>
  </div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var rows = (window.__DATA && window.__DATA["ts"]) || [];
      if (!rows.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var xs = rows.map(function(r){return r.t}), ys = rows.map(function(r){return r.v});
      var last = ys.length - 1;
      var first = ys[0] || 0, curLast = ys[last] || 0;
      var pct = first !== 0 ? ((curLast - first) / Math.abs(first)) * 100 : 0;
      var chip = document.getElementById('chip');
      chip.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
      if (pct < 0) chip.classList.add('down');
      var peakIdx = 0;
      for (var i = 0; i < ys.length; i++) if (ys[i] > ys[peakIdx]) peakIdx = i;
      var chart = echarts.init(document.getElementById('chart'));
      var currency = ${JSON.stringify(currency)};
      chart.setOption({
        backgroundColor:'transparent',
        animation:true, animationDuration:800, animationEasing:'cubicOut',
        grid:{ top:8, right:8, bottom:24, left:8, containLabel:true },
        tooltip:{ trigger:'axis', backgroundColor:'rgba(0,0,0,0.92)', borderColor:'#00e5ff',
          borderWidth:1, textStyle:{ color:'#fff', fontSize:12 },
          extraCssText:'backdrop-filter:blur(8px);border-radius:8px;',
          valueFormatter:function(v){ return fmt(v,{currency:currency}); } },
        xAxis:{ type:'category', data: xs, boundaryGap:false,
          axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
          axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10 } },
        yAxis:{ type:'value',
          axisLine:{show:false}, axisTick:{show:false},
          splitLine:{ lineStyle:{ color:'rgba(255,255,255,0.08)', type:'dashed' } },
          axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10,
            formatter:function(v){ return fmt(v,{compact:true,currency:currency}); } } },
        series:[{
          type:'line', smooth:true, showSymbol:false,
          data: ys.map(function(v,i){ return i===last
            ? { value:v, symbol:'circle', symbolSize:8,
                itemStyle:{ color:'#00e5ff', shadowColor:'rgba(0,229,255,0.9)', shadowBlur:18, borderColor:'#fff', borderWidth:1.5 } }
            : v; }),
          lineStyle:{ width:2, color:'#00e5ff', shadowColor:'rgba(0,229,255,0.45)', shadowBlur:12 },
          areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
            { offset:0, color:'rgba(0,229,255,0.28)' },
            { offset:1, color:'rgba(0,229,255,0.00)' }]) },
          markLine: peakIdx !== last ? {
            symbol:'none',
            lineStyle:{ color:'rgba(0,229,255,0.45)', type:'dashed', width:1 },
            label:{ color:'#00e5ff', fontSize:10, formatter:'PEAK' },
            data:[[{ xAxis: xs[peakIdx], yAxis: 'min' },{ xAxis: xs[peakIdx], yAxis: ys[peakIdx] }]]
          } : undefined
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('line: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

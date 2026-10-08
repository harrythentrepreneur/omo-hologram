// Three KPI cells side by side. Synthesises total/average/peak from a
// primary timeseries when the dataset only carries one; honours an
// explicit data.kpis array of { title, value, trend, currency } otherwise.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceTimeseries, isCurrencyDataset } from './shared.js';

export function kpiGridTemplate({ dataset, intent }) {
  let kpis = null;
  const d = dataset?.data;
  if (d && Array.isArray(d.kpis) && d.kpis.length) {
    kpis = d.kpis.slice(0, 3).map((k) => ({
      title: String(k.title || '').toUpperCase().slice(0, 24) || '—',
      value: Number(k.value) || 0,
      trend: Array.isArray(k.trend) ? k.trend.map(Number) : [],
      currency: k.currency || (isCurrencyDataset(dataset) ? 'USD' : null),
    }));
  } else {
    const ts = coerceTimeseries(d);
    if (ts && ts.length) {
      const values = ts.map((r) => r.v);
      const total = values.reduce((a, b) => a + b, 0);
      const avg = Math.round(total / values.length);
      const peak = values.reduce((m, v) => (v > m ? v : m), values[0]);
      const cur = isCurrencyDataset(dataset) ? 'USD' : null;
      kpis = [
        { title: 'TOTAL',   value: total, trend: values, currency: cur },
        { title: 'AVERAGE', value: avg,   trend: values, currency: cur },
        { title: 'PEAK',    value: peak,  trend: values, currency: cur },
      ];
    }
  }
  if (!kpis) return { body: emptyStateBody(intent, 'Need a timeseries dataset for KPI grid.'), exposedData: {} };

  const title = titleText(intent, 'OVERVIEW');
  const exposedData = { kpis };

  const cells = kpis.map((_, i) => `
    <div class="holo-kpi">
      <div class="holo-title" id="t-${i}"></div>
      <div class="holo-stat holo-stat--md" id="hero-${i}">0</div>
      <div class="holo-chart-mini" id="chart-${i}"></div>
    </div>`).join('');

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div class="holo-kpi-grid">${cells}
  </div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var kpis = ((window.__DATA && window.__DATA["kpis"]) || []).slice(0, 3);
      if (!kpis.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var charts = [];
      kpis.forEach(function(k, i){
        var titleEl = document.getElementById('t-'+i);
        if (titleEl) titleEl.textContent = String(k.title || '');
        var heroEl = document.getElementById('hero-'+i);
        var cur = k.currency || null;
        animateCountUp(heroEl, Number(k.value)||0,
          { duration:900, format:function(v){ return fmt(v,{currency:cur}); } });
        var mount = document.getElementById('chart-'+i);
        var trend = k.trend || [];
        if (!mount || !trend.length) return;
        var chart = echarts.init(mount);
        chart.setOption({
          backgroundColor:'transparent',
          animation:true, animationDuration:800, animationEasing:'cubicOut',
          grid:{ top:2, right:2, bottom:2, left:2 },
          xAxis:{ type:'category', show:false, data: trend.map(function(_,j){return j}), boundaryGap:false },
          yAxis:{ show:false },
          series:[{
            type:'line', smooth:true, showSymbol:false, data: trend,
            lineStyle:{ width:1.5, color:'#00e5ff' },
            areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
              { offset:0, color:'rgba(0,229,255,0.22)' },
              { offset:1, color:'rgba(0,229,255,0.00)' }]) }
          }]
        });
        charts.push(chart);
      });
      window.addEventListener('resize', function(){ charts.forEach(function(c){ try { c.resize(); } catch(e){} }); });
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('kpi: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

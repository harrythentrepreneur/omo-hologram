// Conversion funnel. Stepped tapering bars with drop-off percentages
// between each stage — the shape immediately tells you where the leak
// is. Top stage cyan, worst-drop stage lit in pink so the weakest
// conversion point catches the eye.
//
// Accepts either:
//   data.steps = [{label, count}]          — canonical
//   data.rows  = [{label|name, value|v}]   — categorical fallback
// plus an optional data.kpi for the overall "end-to-end" conversion tag
// at the top of the card.

import { HELPERS_JS, escapeHtml, titleText, emptyStateBody, isCurrencyDataset } from './shared.js';

function coerceFunnelSteps(data) {
  if (!data) return null;
  const raw = Array.isArray(data.steps) ? data.steps
            : Array.isArray(data.rows)  ? data.rows
            : Array.isArray(data)       ? data
            : null;
  if (!raw || raw.length < 2) return null;
  const steps = raw.map((r) => {
    const label = r.label ?? r.name ?? r.stage ?? r.key ?? '—';
    const count = Number(r.count ?? r.value ?? r.v ?? r.users ?? r.n ?? 0);
    return { label: String(label), count: Number.isFinite(count) ? count : 0 };
  }).filter((r) => r.label);
  return steps.length >= 2 ? steps : null;
}

export function funnelTemplate({ dataset, intent }) {
  const steps = coerceFunnelSteps(dataset?.data);
  if (!steps) {
    return { body: emptyStateBody(intent, 'Need at least two funnel steps.'), exposedData: {} };
  }
  const title = titleText(intent, 'FUNNEL');
  const exposedData = { steps };

  const body = `<div id="viz">
  <div class="holo-title holo-title--ruled">${escapeHtml(title)}</div>
  <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;">
    <div class="holo-stat holo-stat--md" id="end-to-end">0%</div>
    <span class="holo-sub">END-TO-END</span>
  </div>
  <div class="holo-chart" id="chart"></div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var steps = (window.__DATA && window.__DATA["steps"]) || [];
      if (steps.length < 2) { window.__FAIL && window.__FAIL('empty'); return; }
      var first = steps[0].count || 1;
      var last  = steps[steps.length - 1].count || 0;
      var e2e   = first > 0 ? (last / first) * 100 : 0;
      animateCountUp(document.getElementById('end-to-end'), e2e,
        { duration: 900, format: function(v){ return v.toFixed(1) + '%'; } });

      // Per-step drop-off — used to pick the worst conversion point and
      // to populate the side labels on the ECharts funnel.
      var drops = steps.map(function(s, i){
        if (i === 0) return { step: s.label, drop: 0, converted: 100 };
        var prev = steps[i-1].count || 1;
        var converted = prev > 0 ? (s.count / prev) * 100 : 0;
        return { step: s.label, converted: converted, drop: 100 - converted };
      });
      var worstIdx = 1;
      for (var i = 2; i < drops.length; i++) {
        if (drops[i].drop > drops[worstIdx].drop) worstIdx = i;
      }

      var chart = echarts.init(document.getElementById('chart'));
      chart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 900, animationEasing: 'cubicOut',
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(0,0,0,0.92)',
          borderColor: '#00e5ff', borderWidth: 1,
          textStyle: { color: '#fff', fontSize: 12 },
          extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
          formatter: function(p){
            var i = p.dataIndex;
            var dropTxt = i === 0 ? '' : '<br/><span style="opacity:0.7">drop ' + drops[i].drop.toFixed(1) + '%</span>';
            return '<b>' + p.name + '</b><br/>' + fmt(p.value) + dropTxt;
          }
        },
        series: [{
          type: 'funnel',
          left: '8%', right: '8%',
          top: 8, bottom: 8,
          minSize: '28%',
          maxSize: '100%',
          sort: 'none',
          gap: 3,
          label: {
            show: true,
            position: 'inside',
            color: '#021014',
            fontWeight: 700,
            fontSize: 12,
            formatter: function(p){
              return p.name + '  ' + fmt(p.value, { compact: true });
            }
          },
          labelLine: { show: false },
          itemStyle: {
            borderWidth: 1,
            borderColor: 'rgba(0, 229, 255, 0.45)',
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 20,
              shadowColor: 'rgba(0, 229, 255, 0.8)',
            }
          },
          data: steps.map(function(s, i){
            var isWorst = (i === worstIdx && drops[i].drop > 0);
            var color = isWorst
              ? new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                  { offset: 0, color: '#ff66b3' },
                  { offset: 1, color: 'rgba(255, 102, 179, 0.55)' }])
              : new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                  { offset: 0, color: '#6ff2ff' },
                  { offset: 1, color: 'rgba(0, 229, 255, 0.55)' }]);
            return {
              name: s.label,
              value: s.count,
              itemStyle: { color: color }
            };
          })
        }]
      });
      __onResize(chart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('funnel: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

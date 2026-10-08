// daily_brief — Momo's morning CEO report. One wide card that composes:
//   • greeting + date kicker
//   • hero revenue count-up with a delta chip
//   • three KPI cells with sparklines (revenue/orders/AOV, 7-day)
//   • 30-day revenue line with peak marker
//   • micro-leaderboard (top 3 products) + channel-mix mini donut
//   • attention-flag pills (low stock / big swing / ROAS watch)
//
// Drop-in for `get_daily_snapshot` — that data tool is shaped specifically
// for this template. It also gracefully handles a plain timeseries if
// the user asks for a "daily brief" on something niche like ads or one
// product's trajectory.

import {
  HELPERS_JS, escapeHtml, titleText, emptyStateBody, coerceTimeseries, isCurrencyDataset,
} from './shared.js';
import {
  statHeroHTML, kpiCellHTML, alertPillHTML, greetingHeaderHTML, microLeaderHTML,
} from './primitives.js';

// Shape-coerce the snapshot. If the caller passed a raw timeseries
// (e.g. wants a "brief" of ads spend only), synthesise a minimal
// snapshot so the template still paints something dignified instead of
// emptying to NO DATA.
function coerceSnapshot(dataset) {
  const d = dataset?.data;
  if (!d) return null;
  // Full snapshot: produced by get_daily_snapshot.
  if (d.headline && Array.isArray(d.kpis) && Array.isArray(d.revenue_series)) {
    return d;
  }
  // Degraded: minimal brief synthesised from whatever we have.
  const ts = coerceTimeseries(d);
  if (!ts) return null;
  const values = ts.map((r) => r.v);
  const total = values.reduce((a, b) => a + b, 0);
  const avg = Math.round(total / Math.max(1, values.length));
  const last = values[values.length - 1] || 0;
  const prev = values[values.length - 2] || 0;
  const cur = isCurrencyDataset(dataset) ? 'USD' : null;
  return {
    date: ts[ts.length - 1].t,
    unit: cur,
    greeting: null,
    headline: {
      revenue: last,
      orders: null,
      aov: null,
      delta_pct: prev > 0 ? Number((((last - prev) / Math.abs(prev)) * 100).toFixed(1)) : 0,
    },
    kpis: [
      { title: 'TOTAL',   value: total, trend: values, delta_pct: 0, currency: cur },
      { title: 'AVERAGE', value: avg,   trend: values, delta_pct: 0, currency: cur },
      { title: 'PEAK',    value: Math.max(...values, 0), trend: values, delta_pct: 0, currency: cur },
    ],
    revenue_series: ts,
    top_products: [],
    channel_mix: [],
    flags: [],
  };
}

export function dailyBriefTemplate({ dataset, intent }) {
  const snap = coerceSnapshot(dataset);
  if (!snap) {
    return { body: emptyStateBody(intent, 'Need a snapshot dataset or timeseries.'), exposedData: {} };
  }
  const currency = snap.unit || (isCurrencyDataset(dataset) ? 'USD' : null);
  const title = titleText(intent, 'DAILY BRIEF');

  // Flag pills — pre-render server-side since there's no dynamic state
  // the client needs to populate; this keeps the template script lean.
  const flagsMarkup = (snap.flags || []).slice(0, 3)
    .map((f) => alertPillHTML({ kind: f.kind || 'info', text: f.text || '' }))
    .join(' ');

  // KPI row — three cells with sparkline mounts. Runtime script fills in
  // count-up + mini chart per cell.
  const kpiCells = snap.kpis.slice(0, 3).map((k, i) =>
    kpiCellHTML({
      id: `kpi-${i}`,
      title: k.title || '',
      heroFallback: '0',
      chartId: `kpi-chart-${i}`,
    })
  ).join('');

  const exposedData = {
    headline: snap.headline,
    kpis: snap.kpis.slice(0, 3),
    revenue_series: snap.revenue_series,
    top_products: (snap.top_products || []).slice(0, 3),
    channel_mix: (snap.channel_mix || []).slice(0, 5),
    date: snap.date || '',
    greeting: snap.greeting || '',
  };

  const body = `<div id="viz">
  <div class="holo-brief">
    ${greetingHeaderHTML({
      text: title,
      date: (snap.greeting ? snap.greeting + ' · ' : '') + (snap.date || ''),
    })}

    <div style="display:flex;align-items:baseline;gap:12px;">
      ${statHeroHTML({ id: 'today-hero', chipId: 'today-chip', valueFallback: '0', chipFallback: '+0%', align: 'baseline' })}
      <span class="holo-sub" style="margin-left:auto;">TODAY</span>
    </div>

    <div class="holo-brief-kpis">${kpiCells}</div>

    <div class="holo-chart" id="revenue-chart" style="min-height:0;"></div>

    <div class="holo-brief-footer">
      ${microLeaderHTML({ id: 'top', title: 'TOP PRODUCTS · 30D' })}
      <div style="position:relative;min-height:0;">
        <div class="holo-title" style="margin-bottom:6px;">CHANNEL MIX</div>
        <div id="mix-chart" style="position:absolute;inset:20px 0 0 0;"></div>
      </div>
    </div>

    ${flagsMarkup ? `<div class="holo-brief-flags">${flagsMarkup}</div>` : ''}
  </div>
  <script>
  (function(){
    ${HELPERS_JS}
    try {
      var D = window.__DATA || {};
      var head = D.headline || {};
      var kpis = D.kpis || [];
      var series = D.revenue_series || [];
      var top = D.top_products || [];
      var mix = D.channel_mix || [];
      if (!series.length) { window.__FAIL && window.__FAIL('empty'); return; }
      var currency = ${JSON.stringify(currency)};

      // ── Hero: today's revenue + delta chip ────────────────────────
      animateCountUp(document.getElementById('today-hero'), Number(head.revenue) || 0,
        { duration: 900, format: function(v){ return fmt(v, { currency: currency }); } });
      var todayChip = document.getElementById('today-chip');
      var dpct = Number(head.delta_pct) || 0;
      todayChip.textContent = (dpct >= 0 ? '+' : '') + dpct.toFixed(1) + '%';
      if (dpct < 0) todayChip.classList.add('down');

      // ── KPI cells: title + count-up + sparkline each ─────────────
      kpis.forEach(function(k, i){
        var valEl  = document.getElementById('kpi-' + i + '-v');
        var subEl  = document.getElementById('kpi-' + i + '-sub');
        var curK   = k.currency || null;
        animateCountUp(valEl, Number(k.value) || 0,
          { duration: 900, format: function(v){ return fmt(v, { currency: curK, compact: true }); } });
        if (subEl) subEl.textContent = '';
        var mount = document.getElementById('kpi-chart-' + i);
        if (!mount || !k.trend || !k.trend.length) return;
        var chart = echarts.init(mount);
        chart.setOption({
          backgroundColor: 'transparent',
          animation: true, animationDuration: 700, animationEasing: 'cubicOut',
          grid: { top: 2, right: 2, bottom: 2, left: 2 },
          xAxis: { type: 'category', show: false, data: k.trend.map(function(_,j){return j}), boundaryGap: false },
          yAxis: { show: false },
          series: [{
            type: 'line', smooth: true, showSymbol: false, data: k.trend,
            lineStyle: { width: 1.5, color: '#00e5ff' },
            areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[
              { offset: 0, color: 'rgba(0,229,255,0.22)' },
              { offset: 1, color: 'rgba(0,229,255,0.00)' }]) }
          }]
        });
      });

      // ── Revenue chart: 30-day smooth line with peak marker ───────
      var xs = series.map(function(r){return r.t});
      var ys = series.map(function(r){return r.v});
      var peakIdx = 0;
      for (var i = 0; i < ys.length; i++) if (ys[i] > ys[peakIdx]) peakIdx = i;
      var revChart = echarts.init(document.getElementById('revenue-chart'));
      revChart.setOption({
        backgroundColor: 'transparent',
        animation: true, animationDuration: 900, animationEasing: 'cubicOut',
        grid: { top: 14, right: 8, bottom: 20, left: 30, containLabel: true },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(0,0,0,0.92)',
          borderColor: '#00e5ff', borderWidth: 1,
          textStyle: { color: '#fff', fontSize: 11 },
          extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
          valueFormatter: function(v){ return fmt(v, { currency: currency }); }
        },
        xAxis: {
          type: 'category', data: xs, boundaryGap: false,
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: {
            color: 'rgba(255,255,255,0.45)', fontSize: 9,
            interval: Math.max(0, Math.floor(xs.length / 6) - 1),
            formatter: function(v){ return String(v).slice(5); }
          }
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false }, axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)', type: 'dashed' } },
          axisLabel: {
            color: 'rgba(255,255,255,0.45)', fontSize: 9,
            formatter: function(v){ return fmt(v, { compact: true, currency: currency }); }
          }
        },
        series: [{
          type: 'line', smooth: true, showSymbol: false,
          data: ys.map(function(v, i){ return i === ys.length - 1
            ? { value: v, symbol: 'circle', symbolSize: 7,
                itemStyle: { color: '#00e5ff', shadowColor: 'rgba(0,229,255,0.9)',
                             shadowBlur: 16, borderColor: '#fff', borderWidth: 1.5 } }
            : v; }),
          lineStyle: { width: 1.8, color: '#00e5ff', shadowColor: 'rgba(0,229,255,0.45)', shadowBlur: 10 },
          areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[
            { offset: 0, color: 'rgba(0,229,255,0.22)' },
            { offset: 1, color: 'rgba(0,229,255,0.00)' }]) },
          markLine: peakIdx !== ys.length - 1 ? {
            symbol: 'none',
            lineStyle: { color: 'rgba(255, 102, 179, 0.55)', type: 'dashed', width: 1 },
            label: { color: '#ff66b3', fontSize: 9, formatter: 'PEAK', letterSpacing: 2 },
            data: [[{ xAxis: xs[peakIdx], yAxis: 'min' }, { xAxis: xs[peakIdx], yAxis: ys[peakIdx] }]]
          } : undefined
        }]
      });

      // ── Top-products micro leaderboard ───────────────────────────
      var topMax = top.reduce(function(m, r){ return r.v > m ? r.v : m; }, 1);
      top.forEach(function(r, i){
        var lab = document.getElementById('top-l' + i);
        var val = document.getElementById('top-v' + i);
        var bar = document.getElementById('top-b' + i);
        if (lab) lab.textContent = r.label;
        if (val) val.textContent = fmt(r.v, { currency: currency, compact: true });
        if (bar) setTimeout(function(){
          bar.style.width = Math.max(2, (r.v / topMax) * 100) + '%';
        }, 120);
      });

      // ── Channel mix mini donut ───────────────────────────────────
      if (mix.length) {
        var mixChart = echarts.init(document.getElementById('mix-chart'));
        mixChart.setOption({
          backgroundColor: 'transparent',
          animation: true, animationDuration: 800, animationEasing: 'cubicOut',
          tooltip: {
            trigger: 'item',
            backgroundColor: 'rgba(0,0,0,0.92)',
            borderColor: '#00e5ff', borderWidth: 1,
            textStyle: { color: '#fff', fontSize: 11 },
            extraCssText: 'backdrop-filter:blur(8px);border-radius:8px;',
            valueFormatter: function(v){ return fmt(v, { currency: currency }); }
          },
          color: ['#00e5ff','#6ff2ff','rgba(255,255,255,0.4)','rgba(255,255,255,0.2)','#ff66b3'],
          series: [{
            type: 'pie',
            radius: ['58%','82%'],
            padAngle: 2,
            itemStyle: { borderRadius: 3, borderColor: 'transparent' },
            label: {
              color: 'rgba(255,255,255,0.85)', fontSize: 10,
              formatter: function(p){ return p.percent >= 14 ? p.name + ' ' + p.percent.toFixed(0) + '%' : ''; }
            },
            labelLine: { length: 6, length2: 6, lineStyle: { color: 'rgba(255,255,255,0.3)' } },
            data: mix.map(function(r){ return { name: r.label, value: r.v }; })
          }]
        });
        window.addEventListener('resize', function(){ try { mixChart.resize(); } catch(e){} });
      }

      __onResize(revChart);
      window.__READY && window.__READY();
    } catch (err) {
      window.__FAIL && window.__FAIL('daily_brief: ' + (err && err.message || err));
    }
  })();
  </script>
</div>`;
  return { body, exposedData };
}

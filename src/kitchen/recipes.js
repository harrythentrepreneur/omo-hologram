// Canonical ECharts option recipes the generator pattern-matches against.
// Kept as compact strings so we can cheaply inject them into the system prompt.
// Do NOT expand these with real data — they reference __DATA["..."] illustratively.

export const RECIPE_LINE_AREA = `
// LINE + AREA (wide). Assumes __DATA.ts = [{t:"2024-01-01", v:123}, ...]
const rows = window.__DATA["ts"];
const xs = rows.map(r => r.t), ys = rows.map(r => r.v);
const last = ys.length - 1;
const chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor: 'transparent',
  animation: true, animationDuration: 800, animationEasing: 'cubicOut',
  grid: { top: 8, right: 8, bottom: 24, left: 8, containLabel: true },
  tooltip: { trigger:'axis', backgroundColor:'rgba(0,0,0,0.92)', borderColor:'#00e5ff',
    borderWidth:1, textStyle:{ color:'#fff', fontSize:12 },
    extraCssText:'backdrop-filter:blur(8px);border-radius:8px;' },
  xAxis: { type:'category', data: xs, boundaryGap:false,
    axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
    axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10 } },
  yAxis: { type:'value',
    axisLine:{show:false}, axisTick:{show:false},
    splitLine:{ lineStyle:{ color:'rgba(255,255,255,0.08)', type:'dashed' } },
    axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10 } },
  series: [{
    type:'line', smooth:true, showSymbol:false,
    data: ys.map((v,i) => i===last
      ? { value:v, symbol:'circle', symbolSize:8,
          itemStyle:{ color:'#00e5ff', shadowColor:'rgba(0,229,255,0.9)', shadowBlur:18, borderColor:'#fff', borderWidth:1.5 } }
      : v),
    lineStyle:{ width:2, color:'#00e5ff', shadowColor:'rgba(0,229,255,0.45)', shadowBlur:12 },
    areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
      { offset:0, color:'rgba(0,229,255,0.28)' },
      { offset:1, color:'rgba(0,229,255,0.00)' } ]) }
  }]
});`;

export const RECIPE_BARS = `
// BARS with one pink peak. __DATA.bars = [{label:"Mon", v:12}, ...]
const rows = window.__DATA["bars"];
const peak = rows.reduce((m,r,i)=> r.v > rows[m].v ? i : m, 0);
const data = rows.map((r,i) => i===peak
  ? { value:r.v, itemStyle:{ borderRadius:[6,6,0,0],
      color: new echarts.graphic.LinearGradient(0,0,0,1,[
        { offset:0, color:'#ff66b3' }, { offset:1, color:'rgba(255,102,179,0.25)' }]) } }
  : { value:r.v });
const chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor:'transparent',
  animation:true, animationDuration:800, animationEasing:'cubicOut',
  animationDelay: i => i*30,
  grid:{ top:16, right:8, bottom:24, left:8, containLabel:true },
  xAxis:{ type:'category', data: rows.map(r=>r.label),
    axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
    axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10 } },
  yAxis:{ show:false },
  series:[{
    type:'bar', barWidth:'58%', data,
    label:{ show:true, position:'top', color:'rgba(255,255,255,0.94)',
      fontSize:11, fontWeight:600, formatter: p => p.value },
    itemStyle:{ borderRadius:[6,6,0,0],
      color: new echarts.graphic.LinearGradient(0,0,0,1,[
        { offset:0, color:'#00e5ff' }, { offset:1, color:'rgba(0,229,255,0.25)' }]) }
  }]
});`;

export const RECIPE_DONUT = `
// DONUT (thick ring, centre hero). __DATA.split = [{name:"Direct", v:42}, ...]
const rows = window.__DATA["split"];
const total = rows.reduce((s,r)=> s+r.v, 0);
document.getElementById('center').textContent = total.toLocaleString();
const chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor:'transparent',
  animation:true, animationDuration:800, animationEasing:'cubicOut',
  tooltip:{ trigger:'item', backgroundColor:'rgba(0,0,0,0.92)',
    borderColor:'#00e5ff', borderWidth:1, textStyle:{ color:'#fff' } },
  color:['#00e5ff','#aeefff','rgba(255,255,255,0.35)','rgba(255,255,255,0.18)'],
  series:[{
    type:'pie', radius:['62%','82%'], center:['50%','50%'],
    padAngle:2, itemStyle:{ borderRadius:4, borderColor:'transparent' },
    label:{ show:true, color:'rgba(255,255,255,0.94)', fontSize:11,
      formatter: p => p.percent >= 10 ? p.name+' '+p.percent.toFixed(0)+'%' : '' },
    labelLine:{ length:8, length2:12, lineStyle:{ color:'rgba(255,255,255,0.35)' } },
    data: rows.map(r => ({ name:r.name, value:r.v }))
  }]
});`;

export const RECIPE_STAT_SPARK = `
// STAT CARD (360x220): hero (count-up) + delta + sparkline. __DATA.ts = [{t,v},...]
function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':'';
  var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
  try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
function animateCountUp(el,target,o){o=o||{};var d=o.duration||900,f=o.format||function(v){return Math.round(v).toLocaleString()};
  var s=performance.now();function tick(n){var t=Math.min(1,(n-s)/d),e=1-Math.pow(1-t,3);
  el.textContent=f(target*e);if(t<1)requestAnimationFrame(tick);else el.textContent=f(target)}requestAnimationFrame(tick)}
const rows = window.__DATA["ts"];
const ys = rows.map(r=>r.v);
const hero = ys[ys.length-1];
const prev = ys[0] || 1;
const pct  = ((hero-prev)/Math.abs(prev))*100;
animateCountUp(document.getElementById('hero'), hero, { format: function(v){ return fmt(v,{currency:'USD'}); } });
const chip = document.getElementById('chip');
chip.textContent = (pct>=0?'+':'') + pct.toFixed(1) + '%';
if (pct < 0) chip.classList.add('down');
const chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor:'transparent',
  animation:true, animationDuration:800, animationEasing:'cubicOut',
  grid:{ top:4, right:4, bottom:4, left:4 },
  xAxis:{ type:'category', show:false, data: rows.map(r=>r.t), boundaryGap:false },
  yAxis:{ show:false },
  series:[{
    type:'line', smooth:true, showSymbol:false, data: ys,
    lineStyle:{ width:1.5, color:'#00e5ff' },
    areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
      { offset:0, color:'rgba(0,229,255,0.22)' },
      { offset:1, color:'rgba(0,229,255,0.00)' }]) }
  }]
});`;

// Hero + ghost baseline trace. Expects __DATA.curr = [{t,v}]; __DATA.prev optional.
export const RECIPE_COMPARISON_STAT = `
// COMPARISON STAT (stat/wide). __DATA.curr = [{t,v},...]; optional __DATA.prev same length.
function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':'';
  var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
  try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
function animateCountUp(el,target,o){o=o||{};var d=o.duration||900,f=o.format||function(v){return Math.round(v).toLocaleString()};
  var s=performance.now();function tick(n){var t=Math.min(1,(n-s)/d),e=1-Math.pow(1-t,3);
  el.textContent=f(target*e);if(t<1)requestAnimationFrame(tick);else el.textContent=f(target)}requestAnimationFrame(tick)}
const curr = window.__DATA["curr"] || [];
const prev = window.__DATA["prev"] || null;
const cy = curr.map(r=>r.v);
const hero = cy[cy.length-1] || 0;
const prevTotal = prev ? prev.reduce(function(a,r){return a+r.v},0) : (cy[0]||1);
const currTotal = cy.reduce(function(a,v){return a+v},0);
const pct = prev ? ((currTotal-prevTotal)/Math.abs(prevTotal||1))*100 : ((hero-cy[0])/Math.abs(cy[0]||1))*100;
animateCountUp(document.getElementById('hero'), hero, { format: function(v){ return fmt(v,{currency:'USD'}); } });
const chip = document.getElementById('chip');
chip.textContent = (pct>=0?'+':'') + pct.toFixed(1) + '%';
if (pct < 0) chip.classList.add('down');
const series = [];
if (prev) series.push({
  type:'line', smooth:true, showSymbol:false, data: prev.map(r=>r.v), z: 0,
  lineStyle:{ width:1, color:'rgba(0,229,255,0.35)', type:'dashed' }
});
series.push({
  type:'line', smooth:true, showSymbol:false, data: cy, z: 2,
  lineStyle:{ width:1.5, color:'#00e5ff', shadowColor:'rgba(0,229,255,0.45)', shadowBlur:10 },
  areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
    { offset:0, color:'rgba(0,229,255,0.22)' },
    { offset:1, color:'rgba(0,229,255,0.00)' }]) }
});
const chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor:'transparent',
  animation:true, animationDuration:800, animationEasing:'cubicOut',
  grid:{ top:4, right:4, bottom:4, left:4 },
  xAxis:{ type:'category', show:false, data: curr.map(r=>r.t), boundaryGap:false },
  yAxis:{ show:false },
  series: series
});`;

// Horizontal bar leaderboard, top row highlighted pink.
export const RECIPE_HBAR_RANK = `
// HBAR RANK (wide). __DATA.rows = [{label, v}, ...] sorted desc by caller.
function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':'';
  var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
  try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
const raw = (window.__DATA["rows"] || []).slice().sort(function(a,b){return b.v-a.v}).slice(0, 8);
// ECharts renders yAxis category bottom-up, so reverse so rank 1 is on top.
const rows = raw.slice().reverse();
const topIdx = rows.length - 1;
const data = rows.map(function(r,i){
  if (i === topIdx) return { value:r.v, itemStyle:{ borderRadius:[4,4,4,4],
    color: new echarts.graphic.LinearGradient(1,0,0,0,[
      { offset:0, color:'#ff66b3' }, { offset:1, color:'rgba(255,102,179,0.25)' }]) } };
  return { value:r.v };
});
const chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor:'transparent',
  animation:true, animationDuration:800, animationEasing:'cubicOut',
  animationDelay: function(i){ return i*40; },
  grid:{ top:4, right:56, bottom:4, left:8, containLabel:true },
  xAxis:{ type:'value', show:false, splitLine:{show:false} },
  yAxis:{ type:'category', data: rows.map(function(r){return r.label}),
    axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
    axisLabel:{ color:'rgba(255,255,255,0.94)', fontSize:11, fontWeight:500 } },
  series:[{
    type:'bar', barWidth: 14, data: data,
    label:{ show:true, position:'right', color:'rgba(255,255,255,0.94)',
      fontSize:11, fontWeight:600, formatter: function(p){ return fmt(p.value,{currency:'USD'}); } },
    itemStyle:{ borderRadius:[4,4,4,4],
      color: new echarts.graphic.LinearGradient(1,0,0,0,[
        { offset:0, color:'#00e5ff' }, { offset:1, color:'rgba(0,229,255,0.20)' }]) }
  }]
});`;

// Three-up KPI grid: three titles, three heroes (count-up), three sparklines.
export const RECIPE_KPI_GRID_3UP = `
// KPI GRID 3-UP (wide). __DATA.kpis = [{title, value, trend:[v,v,...], currency?}, ...]
function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':'';
  var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
  try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
function animateCountUp(el,target,o){o=o||{};var d=o.duration||900,f=o.format||function(v){return Math.round(v).toLocaleString()};
  var s=performance.now();function tick(n){var t=Math.min(1,(n-s)/d),e=1-Math.pow(1-t,3);
  el.textContent=f(target*e);if(t<1)requestAnimationFrame(tick);else el.textContent=f(target)}requestAnimationFrame(tick)}
const kpis = (window.__DATA["kpis"] || []).slice(0,3);
const charts = [];
kpis.forEach(function(k, i){
  var heroEl = document.getElementById('hero-'+i);
  var cur = k.currency || 'USD';
  animateCountUp(heroEl, Number(k.value)||0, { format: function(v){ return fmt(v,{currency:cur}); } });
  var el = document.getElementById('chart-'+i);
  var trend = k.trend || [];
  var chart = echarts.init(el);
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
window.addEventListener('resize', function(){ charts.forEach(function(c){ c.resize(); }); });`;

// Compact block to embed in the system prompt.
export function recipesBlock() {
  return `
RECIPES (pattern-match — adapt dataset ids, labels, size)

--- LINE + AREA (wide/square) ---
${RECIPE_LINE_AREA.trim()}

--- STAT + SPARKLINE (stat 360x220) ---
${RECIPE_STAT_SPARK.trim()}

--- COMPARISON STAT (stat/wide; ghost trace for previous period) ---
// Use when intent mentions "vs last week / previous period / comparison".
// DOM: .holo-title + .holo-stat#hero + .holo-delta#chip + .holo-chart#chart.
// Dataset convention: __DATA.curr (required), __DATA.prev (optional).
${RECIPE_COMPARISON_STAT.trim()}

--- HBAR RANK (wide; top-N leaderboard) ---
// Use for "top products / top customers / ranking / leaderboard".
// DOM: .holo-title + .holo-chart#chart (no separate y-axis line).
// Dataset convention: __DATA.rows = [{label, v}, ...] (sorted desc; top 8 kept).
${RECIPE_HBAR_RANK.trim()}

--- KPI GRID 3-UP (wide; three micro-stats side-by-side) ---
// Use for "overview / dashboard / three-stat / summary / snapshot".
// DOM: .holo-title + <div class="holo-kpi-grid"> with THREE .holo-kpi children,
//      each containing .holo-title, .holo-stat.holo-stat--md#hero-N,
//      and <div class="holo-chart-mini" id="chart-N"></div>.
// Dataset convention: __DATA.kpis = [{title, value, trend:[...], currency?}, x3].
${RECIPE_KPI_GRID_3UP.trim()}
`;
}

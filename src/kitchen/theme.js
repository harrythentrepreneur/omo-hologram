export const PALETTE = {
  cyan:    '#00e5ff',
  cyanSoft:'#6ff2ff',
  pink:    '#ff66b3',
  ice:     '#aeefff',
  up:      '#5effc1',
  down:    '#ff6b9a',
  text:    'rgba(255,255,255,0.94)',
  textDim: 'rgba(255,255,255,0.55)',
  textMut: 'rgba(255,255,255,0.38)',
  grid:    'rgba(255,255,255,0.08)',
  rule:    'rgba(0,229,255,0.45)',
  ghost:   'rgba(0,229,255,0.35)',
};

export const FONT_STACK = "'Inter','SF Pro Text',system-ui,-apple-system,sans-serif";
export const MONO_STACK = "'JetBrains Mono','SF Mono',ui-monospace,Menlo,monospace";

// Sanitiser rejects any external reference outside this list.
export const ALLOWED_SCRIPT_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com'];
export const ECHARTS_SRC = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js';

export const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: 100%; height: 100%;
    background: transparent !important;
    color: ${PALETTE.text};
    font-family: ${FONT_STACK};
    font-weight: 500;
    font-feature-settings: 'ss01','cv11','tnum','salt','cpsp';
    letter-spacing: 0.005em;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    overflow: hidden;
  }
  #viz {
    width: 100%; height: 100%;
    position: relative;
    padding: 24px 16px;
    display: flex; flex-direction: column;
  }
  h1,h2,h3,h4 { margin: 0; font-weight: 600; letter-spacing: 0.02em; }

  /* Micro-label above a chart or stat. Uppercase, spaced, cyan. */
  .holo-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: ${PALETTE.cyan};
    text-shadow: 0 0 12px rgba(0,229,255,0.55);
    margin: 0 0 10px 0;
    opacity: 0.95;
    position: relative;
  }
  /* Opt-in cyan underline modifier. */
  .holo-title--ruled {
    padding-bottom: 6px;
    margin-bottom: 12px;
  }
  .holo-title--ruled::after {
    content: '';
    position: absolute;
    left: 0; bottom: 0;
    width: 24px; height: 1px;
    background: ${PALETTE.rule};
    box-shadow: 0 0 6px rgba(0,229,255,0.55);
  }

  /* Hero number. Gradient fill, tight line-height, tabular numerals. */
  .holo-stat {
    font-family: ${FONT_STACK};
    font-size: clamp(40px, 10vw, 64px);
    font-weight: 700;
    line-height: 0.95;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum','cv11','ss01','salt','cpsp';
    background: linear-gradient(180deg, #ffffff 0%, ${PALETTE.cyanSoft} 60%, ${PALETTE.cyan} 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    text-shadow: 0 0 28px rgba(0,229,255,0.28);
    margin: 0;
    /* Reserve room so count-up doesn't jitter — tabular numerals do the rest. */
    font-variant-ligatures: none;
  }
  .holo-stat--md { font-size: clamp(28px, 5.5vw, 36px); line-height: 1; }
  .holo-stat--sm { font-size: clamp(20px, 4vw, 24px); line-height: 1; }

  /* Muted caption / axis-adjacent copy. */
  .holo-sub {
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: ${PALETTE.textDim};
    margin-top: 6px;
  }

  /* Soft sentence-case caption, no uppercase. */
  .holo-caption {
    font-size: 12px;
    letter-spacing: 0.01em;
    color: ${PALETTE.textMut};
    margin-top: 4px;
  }

  /* Delta chip — up +18.2%  or  down -4.1% */
  .holo-delta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-feature-settings: 'tnum','cv11';
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(94,255,193,0.10);
    color: ${PALETTE.up};
    border: 1px solid rgba(94,255,193,0.28);
    letter-spacing: 0.02em;
    line-height: 1;
  }
  .holo-delta.down {
    background: rgba(255,107,154,0.10);
    color: ${PALETTE.down};
    border-color: rgba(255,107,154,0.28);
  }

  /* Flex layout for multi-stat compositions. */
  .holo-kpi-grid {
    display: flex;
    gap: 28px;
    align-items: stretch;
    flex-wrap: nowrap;
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
  }
  .holo-kpi {
    display: flex; flex-direction: column; gap: 6px;
    flex: 1 1 0; min-width: 0;
  }
  .holo-kpi + .holo-kpi {
    border-left: 1px solid rgba(0,229,255,0.12);
    padding-left: 28px;
  }

  /* Chart region fills remaining space inside #viz. */
  .holo-chart { flex: 1 1 auto; min-height: 0; width: 100%; }
  /* Mini sparkline for KPI-grid cells. */
  .holo-chart-mini {
    width: 100%;
    min-height: 32px;
    max-height: 56px;
    flex: 0 0 44px;
    margin-top: 6px;
  }

  /* Header row: title left, delta chip right. */
  .holo-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 10px;
  }

  /* Ghost trace (previous period) — dashed cyan-alpha 1px. */
  .holo-baseline {
    stroke: ${PALETTE.ghost};
    stroke-dasharray: 3 3;
    stroke-width: 1;
    fill: none;
  }

  /* Annotation label next to a vertical rule. */
  .holo-anno {
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: ${PALETTE.cyan};
    opacity: 0.85;
  }
`;

// ─── Runtime-inlined helpers (canonical) ─────────────────────────────
// HELPERS_JS is the single minified block that every deterministic
// template inlines into its iframe. It bundles `fmt`, `animateCountUp`,
// and `__onResize` — keep it lean because it ships in every viz
// document. The expanded COUNTUP_JS / FMT_JS below are the same code
// pretty-printed; they live on only as Gemini-facing documentation in
// generatorThemeBlock(). If you edit the maths in one, edit both.
export const HELPERS_JS = `
function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':(o.currency==='GBP'?'£':'');
  var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
  try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
function animateCountUp(el,target,o){o=o||{};var d=o.duration||900,f=o.format||function(v){return Math.round(v).toLocaleString()};
  var s=performance.now();function tick(n){var t=Math.min(1,(n-s)/d),e=1-Math.pow(1-t,3);
  el.textContent=f(target*e);if(t<1)requestAnimationFrame(tick);else el.textContent=f(target)}requestAnimationFrame(tick)}
function __onResize(chart){window.addEventListener('resize',function(){try{chart.resize()}catch(e){}})}
`.trim();

// A tiny count-up helper that recipes inline verbatim. Keep it small.
// Documented in the generator RULES so Gemini copies the exact call shape.
export const COUNTUP_JS = `function animateCountUp(el, target, opts){
  opts = opts || {};
  var dur = opts.duration || 900;
  var fmt = opts.format || function(v){ return Math.round(v).toLocaleString(); };
  var start = performance.now();
  var from = 0;
  function tick(now){
    var t = Math.min(1, (now - start) / dur);
    var eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = fmt(target);
  }
  requestAnimationFrame(tick);
}`;

// Shared number formatter recipes inline. |v|>=1000 → compact; else full.
export const FMT_JS = `function fmt(v, o){
  o = o || {};
  var n = Number(v) || 0;
  var abs = Math.abs(n);
  var cur = o.currency ? (o.currency === 'USD' ? '$' : (o.currency === 'GBP' ? '£' : '')) : '';
  var opts;
  if (o.compact || abs >= (o.compactAt || 10000)) {
    opts = { notation: 'compact', maximumFractionDigits: 1 };
  } else {
    opts = { maximumFractionDigits: abs < 10 ? 2 : 0 };
  }
  try { return cur + new Intl.NumberFormat('en-US', opts).format(n); }
  catch(e){ return cur + String(Math.round(n)); }
}`;

export function generatorThemeBlock() {
  return `
PALETTE (use ONLY these; no other colours)
  primary:   ${PALETTE.cyan}        (strokes, titles, accent glow)
  accent:    ${PALETTE.pink}        (one highlight max, e.g. peak bar)
  ice:       ${PALETTE.ice}         (optional gradient stop)
  up/down:   ${PALETTE.up} / ${PALETTE.down}   (delta chips only)
  text:      ${PALETTE.text}        (primary text)
  dim:       ${PALETTE.textDim}     (axis labels, captions)
  mute:      ${PALETTE.textMut}     (tertiary text, inactive)
  grid:      ${PALETTE.grid}        (split lines only; NEVER vertical grid)
  ghost:     ${PALETTE.ghost}       (dashed baseline / previous-period trace)

BACKGROUND
  MUST stay transparent. Never set background-color on body/html/#viz/containers/ECharts backgroundColor.

TYPOGRAPHY (classes already in BASE_CSS)
  .holo-title            — micro uppercase cyan label ABOVE every chart
  .holo-title--ruled     — optional modifier: adds a 24px cyan underline
  .holo-stat             — hero number (gradient, 40-64px, tabular)
  .holo-stat--md / --sm  — smaller hero variants for KPI grids (~36px / ~24px)
  .holo-sub              — uppercase dim caption
  .holo-caption          — sentence-case muted caption
  .holo-delta            — pill: up +X%  /  add class "down" for red down-X%
  .holo-kpi-grid / .holo-kpi — multi-stat layouts (divider between kpi cells is built-in)
  .holo-head             — flex row (title left, delta right)
  .holo-chart            — chart div; flexes to fill remaining height
  .holo-chart-mini       — short sparkline container (44px) for KPI grid cells
  .holo-baseline         — class for SVG baseline traces (ghost/previous-period)

NUMBER LANGUAGE (one grammar across every chart)
  - Hero numbers: thousands-separated; switch to compact (1 dp) when |v| >= 10,000.
  - Axis labels: always compact when |v| >= 1,000.
  - Currency prefix: ONLY money datasets (orders / revenue / payouts / invoices / charges / ads_performance / top_products / channel_mix / revenue_breakdown — or any dataset with a 'USD' / 'GBP' \`unit\` field) get a currency prefix. Default to USD ($). NEVER prefix a currency on analytics / counts / ratios / sessions.
  - Always use tabular numerals (classes already do this).
  - Inline this helper verbatim and reuse it everywhere:
      function fmt(v,o){/* see FMT_JS — compact >=1000, currency-aware */}

COUNT-UP (hero numerics only)
  Required for .holo-stat heroes on stat-size cards. Inline this helper and call it:
      function animateCountUp(el, target, opts){ /* 900ms, ease-out cubic, rAF */ }
      animateCountUp(heroEl, target, { duration: 900, format: function(v){ return fmt(v,{currency:'USD'}); } });
  Do NOT set textContent to the final value before calling; the helper lands exactly on target.

LAYOUT
  #viz has padding 24/16 built-in. ECharts grid: { top:8, right:8, bottom:24, left:8, containLabel:true }.
  For stat-size (360x220): lead with <div class="holo-title"> + <div class="holo-stat"> + optional <span class="holo-delta">, then a sparkline in .holo-chart.
  For wide (720x420): title row + kpi-grid optional + full chart.
  Always include a <div class="holo-title"> as the first child of #viz.

ECHARTS GLOBALS
  backgroundColor: 'transparent'
  textStyle: { fontFamily: "'Inter','SF Pro Text',system-ui,sans-serif", color: '${PALETTE.text}' }
  animation: true, animationDuration: 800, animationEasing: 'cubicOut',
  animationDelay: (i) => i * 30     // stagger
  grid: { top: 8, right: 8, bottom: 24, left: 8, containLabel: true }
  tooltip: {
    backgroundColor: 'rgba(0,0,0,0.92)',
    borderColor: '${PALETTE.cyan}', borderWidth: 1,
    textStyle: { color: '#fff', fontSize: 12 },
    padding: [8,10], extraCssText: 'backdrop-filter: blur(8px); border-radius:8px;'
  }

AXES
  xAxis/yAxis axisLine.show: false, axisTick.show: false
  splitLine: { lineStyle: { color: '${PALETTE.grid}', type: 'dashed' } }  // horizontal only
  xAxis.splitLine.show: false  (NEVER vertical grid lines)
  axisLabel: { color: '${PALETTE.textDim}', fontSize: 10, fontWeight: 500 }

LINE / AREA
  smooth: true, showSymbol: false,
  lineStyle: { width: 2, color: '${PALETTE.cyan}', shadowColor: 'rgba(0,229,255,0.45)', shadowBlur: 12 },
  areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[
    { offset: 0, color: 'rgba(0,229,255,0.28)' },
    { offset: 1, color: 'rgba(0,229,255,0.00)' }
  ]) },
  // Glow dot on LAST point only:
  endLabel omitted; use markPoint with last [x,y] OR set showSymbol:true + symbolSize:0 with a per-point itemStyle for the final index: size 8, shadowBlur 18.

GHOST / BASELINE (previous period)
  Add a second line series with:
    lineStyle: { width: 1, color: '${PALETTE.ghost}', type: 'dashed' },
    showSymbol: false, areaStyle: null, z: 0,
  and render BEFORE the solid current-period series so the cyan line sits on top.

BARS
  barWidth: '58%', itemStyle: {
    borderRadius: [6,6,0,0],
    color: new echarts.graphic.LinearGradient(0,0,0,1,[
      { offset: 0, color: '${PALETTE.cyan}' },
      { offset: 1, color: 'rgba(0,229,255,0.25)' }
    ])
  }
  Hide yAxis when label is attached directly (series.label.show:true, position:'top', color:text, fontWeight:600).
  Highlight peak bar with pink gradient — exactly one bar, via data: [{value, itemStyle:{...pink gradient}}].

HORIZONTAL BAR RANK (leaderboards)
  yAxis.type: 'category', xAxis.type: 'value', xAxis.show: false, yAxis.axisLine.show:false, yAxis.axisTick.show:false, yAxis.splitLine.show:false.
  series.label.show: true, position: 'right', color: text, formatter fmt-aware.
  Sort data desc before handing to ECharts; top row gets the pink gradient.

DONUT
  type: 'pie', radius: ['62%','82%']  (THICK ring; never pie),
  padAngle: 2, itemStyle.borderRadius: 4,
  label: { show: segment>=10%, color: text, formatter: '{b}  {d}%' },
  labelLine: { length: 8, length2: 12, lineStyle: { color: 'rgba(255,255,255,0.35)' } }
  Put a .holo-stat absolute-centred inside the donut container for the hero total.

SPARKLINE (inside .holo-chart for stat cards; inside .holo-chart-mini for KPI grid)
  grid: { top:4,right:4,bottom:4,left:4 }, xAxis.show:false, yAxis.show:false,
  line only, 1.5px stroke, gradient area 0.22->0, no tooltip.

ANNOTATIONS
  Mark "the moment" (peak, launch, spike) with markLine:
    { symbol:'none', lineStyle:{ color:'${PALETTE.rule}', type:'dashed', width:1 },
      label:{ color:'${PALETTE.cyan}', fontSize:10, letterSpacing:2, formatter:'PEAK' } }
  One annotation max per chart.

MOTION
  animationDuration: 800, animationEasing: 'cubicOut',
  animationDelay: (i)=> i*30, animationDurationUpdate: 400.
  Line draws left->right (default). Bars rise from zero (default). Donut sweeps (default).
  Hero numbers animate via animateCountUp (~900ms, ease-out cubic).

DISCIPLINE
  - Cyan primary everywhere. Pink used on AT MOST ONE element per chart.
  - No rainbow palettes, no multi-colour series unless 2 series and the second is pink (or the dashed ghost baseline).
  - No chart borders, no legend borders. Legend icon: 'circle', itemGap: 16, textStyle.color: dim.
  - Numbers: tabular. Use the fmt() helper everywhere. Currency prefix ONLY on money datasets (orders/revenue/payouts/invoices/ads_performance) = USD ($) by default. NEVER on analytics / counts / ratios.
`;
}

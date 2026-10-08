// Gemini → HTML fragment. We use a NON-THINKING flash model (lite-preview)
// with thinkingBudget: 0 — chart HTML is pattern work, not reasoning, and
// thinking would just add 1-3s of latency per render. This is the path
// every chart goes through by default (VIZ_DEFAULT_CUSTOM=1), so latency
// matters a lot here.

import { GoogleGenAI } from '@google/genai';
import { generatorThemeBlock } from './theme.js';
import { recipesBlock } from './recipes.js';
import { checkShapeMatch } from './validator.js';

// Defaults to `gemini-3.1-flash-lite`. thinkingBudget: 0 below keeps it
// pattern-mode (no extended reasoning latency). Override via VIZ_GEN_MODEL
// only with another non-thinking model.
const GEN_MODEL = process.env.VIZ_GEN_MODEL || 'gemini-3.1-flash-lite';
const REQUEST_TIMEOUT_MS = 20_000;
const THEME_BLOCK = generatorThemeBlock();
const RECIPES_BLOCK = recipesBlock();

let genAI;
function client() {
  if (genAI) return genAI;
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set; cannot generate viz');
  genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genAI;
}

const RULES_BLOCK = `RULES
1. Output ONLY the HTML fragment. No markdown fences, no commentary. First char '<'.
2. Structure: <div id="viz"> containing in order:
     a) <div class="holo-title">SHORT UPPERCASE LABEL</div>   (always)
     b) optional hero block: <div class="holo-stat" id="hero">…</div> plus <span class="holo-delta" id="chip">…</span>
     c) <div id="chart" class="holo-chart"></div>             (the ECharts mount) OR a .holo-kpi-grid with multiple mounts for KPI-grid
   Then exactly one <script> that initialises the chart(s).
3. NEVER write dataset numeric values literally. Always read via window.__DATA["<id>"]. (Constants like 0, 1, 100, Math.PI are fine.)
4. NEVER use: fetch, XMLHttpRequest, WebSocket, eval, new Function, dynamic import(), localStorage, sessionStorage, document.cookie, window.parent, window.top, inline on* handlers.
5. NEVER load external scripts or stylesheets. ECharts is already loaded.
6. On success call window.__READY() after chart.setOption. On unrecoverable failure call window.__FAIL("short reason") and stop.
7. If a required __DATA ref is missing or empty, call __FAIL and return.
8. The chart must fill #chart; attach a 'resize' listener that calls chart.resize() (for KPI grid, resize each sub-chart).
9. Animation: duration 800ms, easing 'cubicOut', animationDelay (i)=> i*30 for series.
10. Inline the shared number formatter EXACTLY. Use it everywhere a number becomes text:
      function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':(o.currency==='GBP'?'£':'');
        var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
        try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
    Money datasets (kind: orders / revenue / payouts / invoices / charges / ads_performance / top_products / channel_mix / revenue_breakdown — or any dataset whose \`unit\` field is 'USD' / 'GBP') carry USD by default — pass { currency: 'USD' }. NEVER prefix a currency symbol on a non-money dataset (visits, sessions, page views, counts, ratios, percentages) — pass {} or {compact:true} instead.
11. Hero numbers (.holo-stat) on stat-size cards and KPI-grid cells MUST count up. Inline this helper and call it:
      function animateCountUp(el,target,o){o=o||{};var d=o.duration||900,f=o.format||function(v){return Math.round(v).toLocaleString()};
        var s=performance.now();function tick(n){var t=Math.min(1,(n-s)/d),e=1-Math.pow(1-t,3);
        el.textContent=f(target*e);if(t<1)requestAnimationFrame(tick);else el.textContent=f(target)}requestAnimationFrame(tick)}
      animateCountUp(heroEl, target, { duration: 900, format: function(v){ return fmt(v,{currency:'USD'}); } });
    Do NOT pre-set the hero's textContent; the helper lands on target.

AESTHETIC REQUIREMENTS (non-negotiable)
A. Every chart includes a .holo-title as the first element. Prefer .holo-title.holo-title--ruled for titles above hero-size cards.
B. When size is 'stat' (360×220): include a .holo-stat hero + .holo-delta chip + sparkline in #chart. Count-up required.
C. Line/area charts ALWAYS use smooth:true, 2px cyan stroke, and a LinearGradient areaStyle from rgba(0,229,255,0.28) → rgba(0,229,255,0). Final point gets a glow symbol (size 8, shadowBlur 18).
D. Bar charts ALWAYS use borderRadius:[6,6,0,0], a vertical cyan gradient fill, barWidth ~58%, and hide yAxis when data labels sit on bars. Highlight exactly ONE bar (the peak) with a pink gradient if useful.
E. Donuts are THICK RINGS (radius ['62%','82%']), padAngle 2, borderRadius 4, labels only for segments ≥10%.
F. Exactly ONE accent element may be pink. Everything else is cyan / white-alpha / dashed cyan-alpha ghost.
G. No vertical grid lines. Horizontal splitLine is dashed rgba(255,255,255,0.08). No chart borders.
H. Tooltip uses backgroundColor: 'rgba(0,0,0,0.92)', cyan border, blurred backdrop.
I. If a clear "moment" exists (peak, launch, spike), add ONE markLine with a short uppercase label.
J. Numbers: tabular. Always format via the inlined fmt() helper; use { currency:'USD' } ONLY for money datasets (orders/revenue/payouts/invoices/ads_spend/products). For everything else (analytics, visits, sessions, counts, ratios) pass {} — no currency prefix.
K. Backgrounds on ANY element (body, html, #viz, inner divs, ECharts backgroundColor, tooltip bg, any container) must be either \`transparent\` or pure black (\`#000\` / \`rgb(0,0,0)\` / \`rgba(0,0,0,*)\`). NO greys, NO navies, NO dark blues. The chart sits on a pitch-black reflector stage — any non-black pixel reflects as haze.
L. For "vs / compared to / previous period / last week/month" intents: use the comparison-stat pattern with a dashed ghost trace on z:0 and the solid cyan line on z:2.
M. For "top N / leaderboard / ranking" intents: use the hbar-rank pattern (horizontal bars, value label right, no axes, pink gradient on rank-1 row).
N. For "overview / snapshot / dashboard / three-stat" intents: use the KPI-grid-3up pattern (three .holo-kpi cells, each with its own mini sparkline).

RESPONSE FORMAT
Just the HTML fragment. First character '<'.`;

// Two gold-standard exemplars. Gemini pattern-matches these hard.
// Keep them tight; they live inside a template literal so any backtick in
// the HTML itself is escaped with \`.
const EXEMPLARS_BLOCK = `EXEMPLARS — GOLD STANDARD. Match this quality bar.

--- EXEMPLAR 1 — wide line+area with ghost baseline (720x420) ---
<div id="viz">
  <div class="holo-head">
    <div class="holo-title holo-title--ruled">REVENUE · LAST 30 DAYS</div>
    <span class="holo-delta" id="chip">+0%</span>
  </div>
  <div id="chart" class="holo-chart"></div>
</div>
<script>
(function(){
  function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':'';
    var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
    try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
  var ds = window.__DATA["orde_XXXX"];
  if(!ds || !ds.series || !ds.series.length){ window.__FAIL('no data'); return; }
  var xs = ds.series.map(function(r){return r.t});
  var ys = ds.series.map(function(r){return r.v});
  var last = ys.length - 1;
  var prev = ds.prev ? ds.prev.map(function(r){return r.v}) : null;
  var first = ys[0]||1, curLast = ys[last]||0;
  var pct = ((curLast - first) / Math.abs(first||1)) * 100;
  var chip = document.getElementById('chip');
  chip.textContent = (pct>=0?'+':'') + pct.toFixed(1) + '%';
  if (pct < 0) chip.classList.add('down');
  var series = [];
  if (prev) series.push({
    type:'line', smooth:true, showSymbol:false, data: prev, z:0,
    lineStyle:{ width:1, color:'rgba(0,229,255,0.35)', type:'dashed' }
  });
  series.push({
    type:'line', smooth:true, showSymbol:false, z:2,
    data: ys.map(function(v,i){ return i===last
      ? { value:v, symbol:'circle', symbolSize:8,
          itemStyle:{ color:'#00e5ff', shadowColor:'rgba(0,229,255,0.9)', shadowBlur:18, borderColor:'#fff', borderWidth:1.5 } }
      : v; }),
    lineStyle:{ width:2, color:'#00e5ff', shadowColor:'rgba(0,229,255,0.45)', shadowBlur:12 },
    areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
      { offset:0, color:'rgba(0,229,255,0.28)' },
      { offset:1, color:'rgba(0,229,255,0.00)' }]) }
  });
  var chart = echarts.init(document.getElementById('chart'));
  chart.setOption({
    backgroundColor:'transparent',
    animation:true, animationDuration:800, animationEasing:'cubicOut',
    animationDelay: function(i){ return i*30; },
    grid:{ top:8, right:8, bottom:24, left:8, containLabel:true },
    tooltip:{ trigger:'axis', backgroundColor:'rgba(0,0,0,0.92)', borderColor:'#00e5ff',
      borderWidth:1, textStyle:{ color:'#fff', fontSize:12 },
      extraCssText:'backdrop-filter:blur(8px);border-radius:8px;',
      valueFormatter: function(v){ return fmt(v,{currency:'USD'}); } },
    xAxis:{ type:'category', data: xs, boundaryGap:false,
      axisLine:{show:false}, axisTick:{show:false}, splitLine:{show:false},
      axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10 } },
    yAxis:{ type:'value',
      axisLine:{show:false}, axisTick:{show:false},
      splitLine:{ lineStyle:{ color:'rgba(255,255,255,0.08)', type:'dashed' } },
      axisLabel:{ color:'rgba(255,255,255,0.55)', fontSize:10,
        formatter: function(v){ return fmt(v,{compact:true,currency:'USD'}); } } },
    series: series
  });
  window.addEventListener('resize', function(){ chart.resize(); });
  window.__READY();
})();
</script>

--- EXEMPLAR 2 — stat card with count-up hero (360x220) ---
<div id="viz">
  <div class="holo-title holo-title--ruled">TODAY · REVENUE</div>
  <div style="display:flex;align-items:baseline;gap:10px;">
    <div class="holo-stat" id="hero">0</div>
    <span class="holo-delta" id="chip">+0%</span>
  </div>
  <div id="chart" class="holo-chart"></div>
</div>
<script>
(function(){
  function fmt(v,o){o=o||{};var n=Number(v)||0,a=Math.abs(n),c=o.currency==='USD'?'$':'';
    var opts=(o.compact||a>=10000)?{notation:'compact',maximumFractionDigits:1}:{maximumFractionDigits:a<10?2:0};
    try{return c+new Intl.NumberFormat('en-US',opts).format(n)}catch(e){return c+String(Math.round(n))}}
  function animateCountUp(el,target,o){o=o||{};var d=o.duration||900,f=o.format||function(v){return Math.round(v).toLocaleString()};
    var s=performance.now();function tick(n){var t=Math.min(1,(n-s)/d),e=1-Math.pow(1-t,3);
    el.textContent=f(target*e);if(t<1)requestAnimationFrame(tick);else el.textContent=f(target)}requestAnimationFrame(tick)}
  var ds = window.__DATA["orde_XXXX"];
  if(!ds || !ds.series || !ds.series.length){ window.__FAIL('no data'); return; }
  var ys = ds.series.map(function(r){return r.v});
  var hero = ys[ys.length-1]||0;
  var first = ys[0]||1;
  var pct = ((hero-first)/Math.abs(first||1))*100;
  animateCountUp(document.getElementById('hero'), hero,
    { duration: 900, format: function(v){ return fmt(v,{currency:'USD'}); } });
  var chip = document.getElementById('chip');
  chip.textContent = (pct>=0?'+':'') + pct.toFixed(1) + '%';
  if (pct < 0) chip.classList.add('down');
  var chart = echarts.init(document.getElementById('chart'));
  chart.setOption({
    backgroundColor:'transparent',
    animation:true, animationDuration:800, animationEasing:'cubicOut',
    grid:{ top:4, right:4, bottom:4, left:4 },
    xAxis:{ type:'category', show:false, data: ds.series.map(function(r){return r.t}), boundaryGap:false },
    yAxis:{ show:false },
    series:[{
      type:'line', smooth:true, showSymbol:false, data: ys,
      lineStyle:{ width:1.5, color:'#00e5ff' },
      areaStyle:{ color: new echarts.graphic.LinearGradient(0,0,0,1,[
        { offset:0, color:'rgba(0,229,255,0.22)' },
        { offset:1, color:'rgba(0,229,255,0.00)' }]) }
    }]
  });
  window.addEventListener('resize', function(){ chart.resize(); });
  window.__READY();
})();
</script>`;

function customModeBlock() {
  return `
CUSTOM MODE — YOU ARE THE DESIGNER
This is the default path for every chart in the system. Every render is a one-off, bespoke design composed for THIS user's THIS intent over THEIR REAL business data. There is no template to fall back on — you are the design system.

WHO THIS IS FOR
The viewer runs a small direct-to-consumer business: Stripe payments, Meta + Google ads, Gmail/Drive. The numbers you'll see are their actual revenue, ad spend, payouts, customers, emails, calendar events — pulled live from connected APIs seconds ago. Treat the data with the seriousness of someone reading their own bank statement on a hologram.

DESIGN BAR
- Linear / Vercel / Stripe Dashboard / Apple Health / Bloomberg Terminal — that tier of craft, not a generic chart library default.
- Every pixel is intentional. Whitespace is composed, not accidental. Hierarchy is clear at a glance: ONE hero, secondary supporting numbers, tertiary axis/caption.
- Hero number leads. Always. The user should know the answer in 0.5s, then read the chart for texture.
- Glow, depth, and motion sell the hologram illusion — but never at the cost of readability.

REAL DATA — NON-NEGOTIABLE
- Every number on screen is read from window.__DATA[id] at runtime. The sample shown in the prompt is for shape only — the live values may be larger, smaller, signed differently, sparser. Read the array. Do the math in JS.
- NEVER write a literal dataset value into the markup or the script. Computed constants (0, 1, 100, Math.PI, axis min) are fine; observed values are not.
- If the dataset is missing, empty, malformed for what the intent asks: call window.__FAIL("short reason") rather than fudging a render.
- Currency: datasets whose kind matches money (orders / revenue / payouts / invoices / charges / ads_performance / top_products / channel_mix / revenue_breakdown), OR whose \`unit\` field is 'USD' / 'GBP', are money — prefix the symbol via fmt(v, { currency: 'USD' }) (or 'GBP' if explicitly set). EVERYTHING else (analytics, visits, sessions, page views, ratios, percentages, counts) is dimensionless — call fmt(v, {}) with NO currency. NEVER stick a $ or £ on a count.
- Dates / times: read the t/date/timestamp/time field as-is. Parse only if you need to reformat the axis label.

CREATIVE LATITUDE — MAKE ANYTHING
You are not picking from a catalog. Compose whatever best tells the story for THIS intent over THIS data. The list below is examples, NOT a menu — feel free to invent compositions that aren't on it. If the user's intent calls for something unusual, build it.
- Split panels, mosaics, asymmetric grids, magazine-style layouts.
- KPI strips, hero+sparkline rings, donut-encircling-a-stat, ladder dashboards.
- Two charts side-by-side, current-vs-prior overlays, correlated dual-axis.
- Chart + ranked list, chart + annotated callout, chart + structured caption.
- Pure SVG: sankey, network graph, flow diagram, journey map, funnel pictograph, world map (data-bound), radial bars, polar / radar, ribbon, chord, treemap, voronoi, isotype/pictograph rows of glyphs.
- Calendar heatmaps, day-of-week strips, hour-of-day rings.
- Annotated narratives with multiple markLines for beats (LAUNCH, SPIKE, DROP, TODAY).
- Mixed media: chart + badge row + status pill + tiny avatar grid.
- Pure typography: a single huge number with a one-line interpretation, no chart at all, when that's the most truthful answer.
- Custom shapes built in inline SVG — gauges, dials, progress arcs, signal bars, waveforms, timelines with custom tick glyphs.
- ASCII-style or terminal-aesthetic layouts when the user's tone calls for it.
You can mix and match. You can make stuff up. Build for THIS render, not for reuse.

HARD RULES THAT STILL APPLY
- Output ONLY the HTML fragment (no <html>/<head>/<body>, no markdown fences). First char '<'.
- Use BASE_CSS classes — .holo-title (always first child of #viz), .holo-stat, .holo-stat--md, .holo-stat--sm, .holo-sub, .holo-caption, .holo-delta, .holo-kpi-grid, .holo-kpi, .holo-head, .holo-chart, .holo-chart-mini, .holo-baseline, .holo-anno. Don't reinvent typography.
- Palette: cyan #00e5ff (primary, ~80% of ink), pink #ff66b3 (one accent only — peak/winner/highlight), white-alpha (text), up #5effc1 / down #ff6b9a (delta chips ONLY). NO greys, NO navies, NO blues, NO browns, NO coloured backgrounds.
- Backgrounds: transparent or pure black (#000 / rgba(0,0,0,*)). The hologram reflects every off-black pixel as visible haze.
- Banned APIs: fetch, XMLHttpRequest, WebSocket, eval, new Function, dynamic import, localStorage, sessionStorage, document.cookie, window.parent/top, inline on* handlers, nested iframes, off-allowlist <script src>.
- ECharts 5 is loaded globally (window.echarts). Use it for any quantitative chart. If the viz is pure text/SVG/CSS, you don't need ECharts — still call __READY().
- Inline the fmt() and animateCountUp() helpers exactly as specified above. Use fmt() for every number that becomes text. Use animateCountUp() for every hero number.
- Always start #viz with a .holo-title (short, uppercase, ≤32 chars). The user should know what they're looking at before they look at the numbers.
- Always call window.__READY() once render is complete. On failure, window.__FAIL("short reason").
- Animations: ECharts default 800ms cubicOut, staggered series. Hero numbers count up over ~900ms.

WHAT MAKES A RENDER BEAUTIFUL (not just correct)
- Negative space. Don't fill the canvas — let the hero breathe.
- Tabular numerals for every digit. Heroes use .holo-stat (gradient cyan).
- Exactly one accent in pink. Peak bar, winning row, target tick — ONE.
- Line/area: 2px cyan stroke, gradient area 0.28→0, glow dot only on the LAST point.
- Dashed horizontal splitLine, never vertical grid. Axes faint, labels in dim white.
- Tooltips: black 92% bg, cyan 1px border, blurred backdrop, fmt'd values.
- Annotations: at most ONE markLine per chart, short uppercase label (PEAK / LAUNCH / SPIKE / TODAY).
- Comparison: previous period as a dashed cyan-alpha ghost trace under the solid current line.

REMEMBER
Each render is unique. The user is voice-talking to omo right now and watching this hologram appear in front of them. Make it the chart they'd screenshot.
`;
}

function buildSystemPrompt(width, height, mode) {
  const customBlock = mode === 'custom' ? customModeBlock() : '';
  return `You generate a single self-contained HTML fragment that renders a PREMIUM data visualization inside a transparent hologram display. Target: Linear / Vercel / Stripe / Apple Health dashboard quality.

ENVIRONMENT
- Output is injected into the <body> of a sandboxed iframe. FRAGMENT only — no <html>, <head>, <body>.
- Container: ${width} × ${height} CSS pixels. Host stage is pitch black; iframe background MUST stay transparent.
- Globals:
    • window.echarts  — ECharts 5.
    • window.__DATA   — map of dataset id → dataset. Sole source of numeric data.
    • window.__READY  — call after chart.setOption resolves.
    • window.__FAIL   — call with (message) on unrecoverable failure.
- BASE_CSS provides classes: .holo-title (+ --ruled modifier) .holo-stat (+ --md/--sm) .holo-sub .holo-caption .holo-delta .holo-kpi-grid .holo-kpi .holo-head .holo-chart .holo-chart-mini .holo-anno .holo-baseline — USE THEM.

SIZE GUIDANCE
- wide  (720×420): title row + full chart (line, bar, area, hbar-rank, kpi-grid-3up).
- square(480×480): title + donut OR title + hero + chart.
- stat  (360×220): .holo-title + .holo-stat hero (count-up) + .holo-delta chip + sparkline.

INTENT → RECIPE CHEATSHEET
- "trend / over time / last N days" → LINE + AREA (wide) or STAT + SPARKLINE (stat).
- "vs / compared to / previous period / last week/month" → COMPARISON STAT with dashed ghost baseline.
- "top N / leaderboard / ranking / best / biggest" → HBAR RANK (horizontal bars, right-aligned value label, no axes).
- "overview / snapshot / three-stat / summary / dashboard" → KPI GRID 3-UP (three cells with mini sparklines).
- "breakdown / share / split / mix / composition" → DONUT (thick ring, centre hero).
- "by day / week / category" with bars-ish data → BARS (one pink peak).

THEME${THEME_BLOCK}
${RECIPES_BLOCK}
${EXEMPLARS_BLOCK}
${RULES_BLOCK}
${customBlock}`;
}

function buildUserPrompt({ intent, datasets, size, previousError, shapeHint, mode }) {
  const lines = datasets.length
    ? datasets.map((d) => {
        const head = `  • "${d.id}" (${d.kind}) — shape: ${d.shape}`;
        if (d.preview === undefined || d.preview === null) return head;
        let previewText;
        try { previewText = JSON.stringify(d.preview); } catch { previewText = '<unserialisable>'; }
        if (previewText && previewText.length > 1200) previewText = previewText.slice(0, 1200) + '…';
        return `${head}\n    sample: ${previewText}`;
      }).join('\n')
    : '  (none)';
  const sizeName = size && size.width === 360 ? 'stat'
                 : size && size.width === 480 ? 'square'
                 : 'wide';
  const intro = mode === 'custom'
    ? `Intent: ${intent}\nMode: CUSTOM (freeform — no template fits; compose what best serves the intent).`
    : `Intent: ${intent}`;
  const base = `${intro}
Size: ${sizeName} (${size?.width}×${size?.height})

Datasets at window.__DATA (sample shown for shape only — read the full data via window.__DATA[id] at runtime; never hardcode values):
${lines}

Produce the premium HTML fragment now. Remember: .holo-title first, transparent bg, cyan primary, one pink accent max, fmt() + animateCountUp() inlined where numbers are rendered.`;
  const parts = [base];
  if (shapeHint) {
    parts.push(`Shape hint: ${shapeHint}\nPick a framing compatible with the dataset shapes above.`);
  }
  if (previousError) {
    parts.push(`Previous attempt rejected: ${previousError}\nFix that issue. Output only HTML, starting with '<'.`);
  }
  return parts.join('\n\n');
}

// The SDK may not honour AbortSignal passed via config, so race it ourselves.
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

const FENCE_RE = /^```(?:html)?\s*|\s*```\s*$/gi;

export async function generateHtml({ intent, datasets, size, previousError, mode = 'fallback' }) {
  const { width, height } = size || {};

  // Soft shape check — if the intent + dataset shapes clearly mismatch, fold
  // the reason into the prompt as guidance so the model picks a different
  // framing. Only hard-blocks when the mismatch is unambiguous (rare).
  // Skipped in custom mode: freeform requests routinely break shape
  // expectations on purpose ("show me X however looks best").
  let shapeHint = null;
  if (mode !== 'custom') {
    const sm = checkShapeMatch({ intent, datasets });
    if (!sm.ok) shapeHint = sm.reason;
  }

  const userText = buildUserPrompt({ intent, datasets, size, previousError, shapeHint, mode });
  let response;
  try {
    response = await withTimeout(
      client().models.generateContent({
        model: GEN_MODEL,
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        config: {
          systemInstruction: buildSystemPrompt(width, height, mode),
          // Custom mode wants more creative spread; chart-fallback wants
          // the recipe-faithful path.
          temperature: mode === 'custom' ? 0.7 : 0.5,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      REQUEST_TIMEOUT_MS,
      'generator',
    );
  } catch (err) {
    throw new Error(`generator failed: ${err?.message || err}`);
  }

  return (response.text || '').trim().replace(FENCE_RE, '').trim();
}

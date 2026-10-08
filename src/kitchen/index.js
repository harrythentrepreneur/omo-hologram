// Kitchen pipeline (template-first).
//
// Entry point: renderViz({ intent, data_refs, size, chart_type }).
//
// Default path — deterministic server-side templates:
//   1. Resolve data_refs against the dataset store.
//   2. If chart_type wasn't supplied, auto-pick one from dataset kind+size+intent.
//   3. Run the template function (a pure (dataset, intent, size) → body fragment).
//   4. Wrap the fragment in the iframe shell (CSP, ECharts, __DATA, __READY bridge).
//   5. Cache by (chart_type, data_refs, size, intent-slug).
//
// Fallback path — Gemini generator (kept for intents with no matching template):
//   - Same sanitiser + validator + reflector-safety flow as before.
//   - Triggered when a template throws (unsupported dataset shape) or when
//     chart_type === 'auto_fallback' is explicitly requested.
//
// Why templates are exempt from the reflector-safety check:
//   The templates in src/kitchen/templates.js only emit palette colours
//   (cyan / pink / white-alpha) — there's no off-palette code path to
//   exercise the runtime check. The sanitiser/validator are still a net
//   around the Gemini fallback; on the template hot path they'd just be
//   redundant byte scanning.

import { generateHtml } from './generator.js';
import { sanitise } from './sanitiser.js';
import { validate } from './validator.js';
import { getHtml, putHtml } from './cache.js';
import { BASE_CSS, ECHARTS_SRC, ALLOWED_SCRIPT_HOSTS } from './theme.js';
import { PRIMITIVES_CSS } from './templates/primitives.js';
import { shapeOf, previewOf, jsonForScript } from '../util.js';
import { SIZES } from '../sizes.js';
import * as store from '../store/datasets.js';
import { TEMPLATES, CHART_TYPES as TEMPLATE_CHART_TYPES, pickChartType } from './templates.js';
import { createHash } from 'node:crypto';

const MAX_FALLBACK_ATTEMPTS = 3;

// `custom` is the freeform/escape hatch: it always routes to the Gemini
// generator with no template attempted. Use when the model wants to
// build a viz no template covers — still constrained to real data
// (data_refs), brand palette (validator), and the iframe shell.
export const CUSTOM_CHART_TYPE = 'custom';
export const CHART_TYPES = [...TEMPLATE_CHART_TYPES, CUSTOM_CHART_TYPE];

// Custom-first default: when no chart_type is supplied, charts go through
// Gemini ("the LLM designs every chart for what we need"). Text cards,
// widgets, and primitives keep their fast template path — those are
// already on-brand and don't benefit from a Gemini round-trip.
//
// Set VIZ_DEFAULT_CUSTOM=0 to revert to the prior template-first
// auto-pick across every category.
const VIZ_DEFAULT_CUSTOM = (process.env.VIZ_DEFAULT_CUSTOM ?? '1') !== '0';
const CHART_CATEGORY = 'chart';

// Heuristic: does this dataset look like quantitative chart data (array
// of records with a numeric value, or a top-level series/slices/rows
// array)? Used to upgrade card-shaped auto-picks to custom when the
// data is obviously chartable — e.g. "revenue vs last week" routing
// to comparison_table when it should be a comparison chart.
function isLikelyChartData(datasets) {
  for (const d of datasets || []) {
    const shape = String(d?.shape || '');
    if (!shape) continue;
    if (/\b(series|slices|rows|points|kpis|steps|xs|values)\b\s*:[^,}]*\[\]/i.test(shape)) return true;
    if (/\[\]/.test(shape) && /\b(value|v|count|amount|pence|revenue|orders|total|qty|spend|roas)\s*:\s*number\b/i.test(shape)) return true;
  }
  return false;
}

// 'unsafe-inline' is required for the chart's inline <script>. The iframe's
// outer sandbox attribute still blocks same-origin and parent access.
const CSP = [
  `default-src 'none'`,
  `script-src ${ALLOWED_SCRIPT_HOSTS.map((h) => `https://${h}`).join(' ')} 'unsafe-inline'`,
  `style-src 'unsafe-inline'`,
  `img-src data: https:`,
  `font-src data: https:`,
  `connect-src 'none'`,
  `frame-src 'none'`,
  `object-src 'none'`,
  `base-uri 'none'`,
].join('; ');

const BOOTSTRAP = `<script src="${ECHARTS_SRC}"></script>`;
export const IFRAME_READY_TIMEOUT_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sizeNameOf(size) {
  if (!size) return 'wide';
  if (size.width === 360) return 'stat';
  if (size.width === 480) return 'square';
  return 'wide';
}

function slugIntent(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 128);
}

// Cache key: (chart_type, data_refs, size, intent-slug). Because the
// templates are deterministic in (data, intent, size), the same call yields
// the same cached HTML verbatim.
function templateFingerprint({ chart_type, data_refs, size, intent }) {
  const key = JSON.stringify({
    t: chart_type,
    d: [...data_refs].sort(),
    s: sizeNameOf(size),
    i: slugIntent(intent),
  });
  return 'tpl_' + createHash('sha256').update(key).digest('hex').slice(0, 14);
}

function fallbackFingerprint({ intent, shapes, size, mode = 'fallback' }) {
  const key = JSON.stringify({
    mode: mode === 'custom' ? 'cus' : 'gen',
    i: slugIntent(intent),
    shapes,
    s: sizeNameOf(size),
  });
  const prefix = mode === 'custom' ? 'cus_' : 'gen_';
  return prefix + createHash('sha256').update(key).digest('hex').slice(0, 14);
}

export async function renderViz({
  intent,
  data_refs = [],
  size = SIZES.wide,
  chart_type,
}) {
  // 1. Resolve data_refs.
  const datasets = [];
  for (const id of data_refs) {
    const entry = store.get(id);
    if (!entry) return { ok: false, error: `unknown data_ref "${id}" (expired or never stored)` };
    datasets.push({
      id,
      kind: entry.kind,
      data: entry.data,
      shape: shapeOf(entry.data),
      preview: previewOf(entry.data),
    });
  }

  // 2. Decide chart type.
  //
  // Caller passed an explicit chart_type → honour it.
  // Caller didn't → run pickChartType to figure out the best framing,
  // then (if VIZ_DEFAULT_CUSTOM is on) upgrade chart-family picks to
  // 'custom' so Gemini designs the chart bespoke for the user's intent.
  // Cards / widgets / primitives keep their fast deterministic template.
  const callerSpecifiedType = chart_type && CHART_TYPES.includes(chart_type);
  let type = callerSpecifiedType
    ? chart_type
    : pickChartType({ datasets, size, intent });

  let autoUpgradedToCustom = false;
  if (!callerSpecifiedType && VIZ_DEFAULT_CUSTOM && type !== CUSTOM_CHART_TYPE) {
    const cat = WIDGET_CATALOG[type]?.category;
    // Upgrade to custom when:
    // (a) the auto-pick landed on a chart-family template, OR
    // (b) the dataset shape is clearly chartable — even if intent regex
    //     dragged us toward a text card (e.g. "revenue vs last week"
    //     hitting comparison_table when the data is timeseries).
    if (cat === CHART_CATEGORY || isLikelyChartData(datasets)) {
      type = CUSTOM_CHART_TYPE;
      autoUpgradedToCustom = true;
    }
  }

  if (type === CUSTOM_CHART_TYPE) {
    const result = await fallbackToGenerator({
      intent, data_refs, datasets, size,
      reason: autoUpgradedToCustom
        ? 'custom-first default: Gemini designing the chart for this intent'
        : 'custom chart_type — freeform viz requested',
      mode: 'custom',
    });
    // Hard fallback: if Gemini bombed (network, retries exhausted) AND
    // we auto-upgraded to custom, drop back to the deterministic
    // template auto-pick so the user always gets something on stage.
    // Caller-specified custom is honoured strictly — surface the error.
    if (result.ok || !autoUpgradedToCustom) return result;
    const fallbackType = pickChartType({ datasets, size, intent });
    if (fallbackType === CUSTOM_CHART_TYPE) return result;
    type = fallbackType;
  }

  // 3. Cache check.
  const fp = templateFingerprint({ chart_type: type, data_refs, size, intent });
  const cached = getHtml(fp);
  if (cached) return { ok: true, html: cached, fingerprint: fp, cached: true, chart_type: type };

  // 4. Run the template.
  const tpl = TEMPLATES[type];
  // Catalog lookup — widgets with `supports_fallback: false` should NOT
  // fall through to the Gemini generator (its prompt is chart-shaped and
  // would produce nonsense for cards/widgets). Chart-family widgets still
  // fall back as before.
  const catalogEntry = WIDGET_CATALOG[type] || null;
  const canFallback = catalogEntry ? catalogEntry.supports_fallback !== false : true;

  if (!tpl) {
    if (!canFallback) return { ok: false, error: `unknown widget type: ${type}` };
    return fallbackToGenerator({
      intent, data_refs, datasets, size,
      reason: `unknown chart_type: ${type}`,
    });
  }

  let rendered;
  try {
    rendered = tpl({
      dataset: datasets[0],
      datasets,
      intent,
      size,
    });
  } catch (err) {
    // Template blew up — try Gemini for charts that declare fallback support;
    // surface the error for widgets that don't.
    if (!canFallback) return { ok: false, error: `template "${type}" failed: ${err?.message || err}` };
    return fallbackToGenerator({
      intent, data_refs, datasets, size,
      reason: `template "${type}" failed: ${err?.message || err}`,
    });
  }

  if (!rendered || typeof rendered.body !== 'string') {
    if (!canFallback) return { ok: false, error: `template "${type}" produced no body` };
    return fallbackToGenerator({
      intent, data_refs, datasets, size,
      reason: `template "${type}" produced no body`,
    });
  }

  // 5. Assemble + cache. We publish BOTH the template's exposedData (ts,
  // slices, etc.) AND the raw data_refs keyed by id — the latter keeps
  // compatibility with anything that still reads window.__DATA[id].
  const dataMap = {};
  for (const d of datasets) dataMap[d.id] = d.data;
  Object.assign(dataMap, rendered.exposedData || {});

  // Text-only templates (email/event/payout/etc.) don't need ECharts.
  // Passing `needsEcharts: false` from the template skips the ~300 KB
  // CDN fetch — the iframe still boots, calls __READY, and lives inside
  // the same CSP/sandbox.
  const needsEcharts = rendered.needsEcharts !== false;
  const assembled = assembleDocument({ body: rendered.body, dataMap, size, needsEcharts });
  putHtml(fp, assembled);
  return { ok: true, html: assembled, fingerprint: fp, cached: false, chart_type: type };
}

// ─── Gemini fallback ──────────────────────────────────────────────────
// Same behaviour as the pre-template pipeline. Sanitiser + validator +
// reflector-safety still run here because we cannot trust model output.
//
// mode: 'fallback' (default) — a template failed; pick the best chart-
//       shaped framing for the data.
// mode: 'custom'   — the caller explicitly asked for freeform; the
//       generator gets a wider creative brief but still must honour the
//       brand palette and reference data via __DATA[id].
async function fallbackToGenerator({ intent, data_refs, datasets, size, reason, mode = 'fallback' }) {
  const shapes = datasets.map(({ id, shape }) => ({ id, shape }));
  const fp = fallbackFingerprint({ intent, shapes, size, mode });
  const cached = getHtml(fp);
  if (cached) return { ok: true, html: cached, fingerprint: fp, cached: true, chart_type: mode === 'custom' ? 'custom' : 'generator' };

  // Pass id, kind, shape — and a small data preview so the generator can
  // build any layout it wants over the *real* fields. previewOf trims
  // nested arrays to the first few items to keep the prompt compact.
  const genInput = {
    intent,
    datasets: datasets.map(({ id, kind, shape, preview }) => ({ id, kind, shape, preview })),
    size,
    mode,
  };

  let feedback = reason ? `template fallback triggered: ${reason}` : null;
  let lastNetErr = null;
  let fragment = null;

  for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
    let html;
    try {
      html = await generateHtml({ ...genInput, previousError: feedback });
      lastNetErr = null;
    } catch (err) {
      lastNetErr = String(err?.message || err);
      await sleep(200 * (attempt + 1));
      continue;
    }
    const san = sanitise(html);
    if (!san.ok) { feedback = `sanitiser rejected output: ${san.reason}. Reissue without that pattern.`; continue; }
    const val = validate(html);
    if (!val.ok) { feedback = `validator rejected output: ${val.reason}. Fix that and reissue.`; continue; }
    fragment = html;
    break;
  }

  if (!fragment) {
    return {
      ok: false,
      error: lastNetErr ?? `viz generation failed after ${MAX_FALLBACK_ATTEMPTS} retries: ${feedback ?? 'unknown'}`,
    };
  }

  const dataMap = {};
  for (const d of datasets) dataMap[d.id] = d.data;

  const assembled = assembleDocument({ body: fragment, dataMap, size });
  putHtml(fp, assembled);
  return { ok: true, html: assembled, fingerprint: fp, cached: false, chart_type: mode === 'custom' ? 'custom' : 'generator' };
}

// ─── Iframe shell ─────────────────────────────────────────────────────
// Owns <head>, CSP, ECharts, __DATA injection, __READY/__FAIL bridge, and
// the holo highlight postMessage handler. Templates and the Gemini
// generator only ever produce the body fragment — this is the security
// boundary. Do not move document-shell concerns into templates.
function assembleDocument({ body, dataMap, size, needsEcharts = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CSP)}">
<meta name="viewport" content="width=${size.width}, initial-scale=1">
<style>${BASE_CSS}${PRIMITIVES_CSS}</style>
${needsEcharts ? BOOTSTRAP : ''}
<script>
(function () {
  var reported = false;
  function post(kind, detail) {
    if (reported) return; reported = true;
    try { parent.postMessage({ holoViz: true, kind: kind, detail: detail || null }, '*'); } catch (e) {}
  }
  window.__READY = function () { post('ready'); };
  window.__FAIL  = function (msg) { post('fail', String(msg || 'unknown')); };
  window.addEventListener('error', function (e) { post('fail', (e && e.message) || 'runtime error'); });
  window.addEventListener('unhandledrejection', function (e) { post('fail', 'promise: ' + ((e && e.reason && e.reason.message) || e.reason)); });
  setTimeout(function () { post('fail', 'timeout waiting for __READY'); }, ${IFRAME_READY_TIMEOUT_MS});

  // ── holo highlight bridge ────────────────────────────────────────
  // Parent page posts { holoVizCmd: true, kind, ... } when Momo calls
  // highlight_viz / dismiss_viz. We dispatch via ECharts' own APIs.
  function findChart() {
    if (!window.echarts || !window.echarts.getInstanceByDom) return null;
    var nodes = document.querySelectorAll('div, canvas, section, main, body');
    for (var i = 0; i < nodes.length; i++) {
      var inst = window.echarts.getInstanceByDom(nodes[i]);
      if (inst) return inst;
    }
    return null;
  }
  var activeLabel = null;
  function clearLabel(chart) {
    if (!chart || !activeLabel) return;
    try { chart.setOption({ graphic: [{ id: activeLabel, $action: 'remove' }] }); } catch (e) {}
    activeLabel = null;
  }
  function runCmd(cmd) {
    var chart = findChart();
    if (!chart) return;
    try {
      if (cmd.kind === 'clearHighlight') {
        chart.dispatchAction({ type: 'downplay' });
        clearLabel(chart);
        return;
      }
      if (cmd.kind === 'highlight') {
        chart.dispatchAction({ type: 'downplay' });
        clearLabel(chart);
        var action = {
          type: 'highlight',
          seriesIndex: (typeof cmd.seriesIndex === 'number') ? cmd.seriesIndex : 0,
        };
        if (typeof cmd.dataIndex === 'number') action.dataIndex = cmd.dataIndex;
        chart.dispatchAction(action);
        if (cmd.label && typeof cmd.dataIndex === 'number') {
          activeLabel = 'holo-hl-' + Date.now();
          try {
            var px = null;
            try {
              px = chart.convertToPixel(
                { seriesIndex: action.seriesIndex },
                [action.dataIndex, 0]
              );
            } catch (_e) { px = null; }
            var rect = chart.getDom().getBoundingClientRect();
            var x = (px && isFinite(px[0])) ? px[0] : rect.width / 2;
            var y = (px && isFinite(px[1])) ? (px[1] - 28) : 24;
            if (y < 12) y = 12;
            chart.setOption({
              graphic: [{
                id: activeLabel,
                type: 'group',
                left: x - 40, top: y,
                z: 100,
                silent: true,
                children: [
                  { type: 'rect', shape: { width: 80, height: 20, r: 10 },
                    style: { fill: 'rgba(0,0,0,0.85)', stroke: '#00e5ff', lineWidth: 1,
                             shadowBlur: 12, shadowColor: 'rgba(0,229,255,0.9)' } },
                  { type: 'text', left: 'center', top: 'middle',
                    style: { text: String(cmd.label).toUpperCase(), fill: '#00e5ff',
                             font: 'bold 10px sans-serif',
                             textShadowBlur: 6, textShadowColor: '#00e5ff' } }
                ]
              }]
            });
          } catch (_lblErr) {}
        }
      }
    } catch (e) {}
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.holoVizCmd !== true) return;
    runCmd(d);
  });
})();
window.__DATA = ${jsonForScript(dataMap)};
</script>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

// Re-exported so callers that imported from here keep working.
// CHART_TYPES is exported above (line 43, extended with CUSTOM_CHART_TYPE);
// only re-exporting pickChartType here.
export { pickChartType };

// ─── Widget catalog ───────────────────────────────────────────────────
// Typed description of every hologram-widget type the kitchen can render.
// Other modules (session.js, tools/viz.js, the smoke test) read this to
// build function schemas / pick a fallback path / validate inputs.
//
// Fields:
//   category           — 'chart' | 'widget' | 'card' | 'primitive'
//   description        — one-sentence data/purpose summary (kept tight so
//                        the Gemini function schema stays lean)
//   data_shape         — freeform string describing the canonical input
//   supports_fallback  — whether the kitchen will retry through the Gemini
//                        generator if the template errors. Pure-HTML cards
//                        default to false (no meaningful fallback for an
//                        email view).
//   needs_echarts      — whether the iframe should load the ECharts CDN.
//                        Mirrors the per-template `needsEcharts: false` flag.
//   size_hint          — recommended SIZE name (wide/square/stat).
//
// When adding a widget: create the template, register it in
// templates/index.js::TEMPLATES, AND add an entry here. If the catalog
// and the template registry drift, the function schema Gemini sees will
// diverge from what render_viz actually accepts.
export const WIDGET_CATALOG = Object.freeze({
  // ─── Chart family (data-vis; needs ECharts) ─────────────────────────
  line: {
    category: 'chart',
    description: 'Smooth timeseries line with area gradient, last-point dot, peak mark-line.',
    data_shape: '{ series: [{t, value}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  bar: {
    category: 'chart',
    description: 'Vertical categorical bars with pink-accent peak.',
    data_shape: '{ rows|slices: [{label, value}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  donut: {
    category: 'chart',
    description: 'Thick-ring donut with centre total for composition shares.',
    data_shape: '{ slices: [{label, value}], total? }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'square',
  },
  stat: {
    category: 'chart',
    description: 'Big hero number + sparkline + delta chip.',
    data_shape: '{ series: [{t, value}] } OR { value, delta?, trend? }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'stat',
  },
  hbar_rank: {
    category: 'chart',
    description: 'Horizontal leaderboard, top row highlighted pink.',
    data_shape: '{ rows: [{label, value}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  comparison: {
    category: 'chart',
    description: 'Current vs previous period — cyan line over dashed ghost baseline.',
    data_shape: '{ current: [{t,v}], previous: [{t,v}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  kpi_grid: {
    category: 'chart',
    description: 'Three side-by-side KPI cells with micro sparklines.',
    data_shape: '{ kpis: [{title, value, trend:[...]}] } OR timeseries',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  funnel: {
    category: 'chart',
    description: 'Conversion funnel with end-to-end % and worst-drop highlight.',
    data_shape: '{ steps: [{label, count}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  gauge: {
    category: 'chart',
    description: '270-degree arc gauge toward a target, with pink target tick.',
    data_shape: '{ value, target, unit? } OR { gauge: {...} }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'square',
  },
  heatmap: {
    category: 'chart',
    description: 'Day-of-week × week intensity grid over a daily timeseries.',
    data_shape: '{ series: [{t, value}] } (>= 7 days)',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  waterfall: {
    category: 'chart',
    description: 'Bridge/waterfall showing contribution of each delta to a total.',
    data_shape: '{ steps: [{label, value, kind?}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  scatter: {
    category: 'chart',
    description: 'x/y scatter for correlation; up to two series (cyan + pink).',
    data_shape: '{ points: [{x,y,label?}] } OR { series: [{name,points}] }',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
  stacked_area: {
    category: 'chart',
    description: 'Multi-series stacked area over time; top series pink, rest cyan.',
    data_shape: '{ xs: [...], series: [{name, values:[...]}] } (max 4 series)',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },

  // ─── Compound dashboards (need ECharts) ─────────────────────────────
  daily_brief: {
    category: 'chart',
    description: 'Morning brief: greeting, three KPI cells, flags, micro-leaderboard.',
    data_shape: 'daily_snapshot or timeseries',
    supports_fallback: false,
    needs_echarts: true,
    size_hint: 'wide',
  },

  // ─── Hologram-widget family (pure-HTML, no ECharts) ─────────────────
  email_thread: {
    category: 'widget',
    description: 'Condensed email thread or inbox list — participants + latest messages along a cyan spine.',
    data_shape: '{ emails: [{from, subject, preview, time, unread?}] } OR { subject, messages }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  email_detail: {
    category: 'widget',
    description: 'Single email expanded — header + sanitised body (HTML or text).',
    data_shape: '{ from, to, subject, body_html? | body_text, time }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  kpi_card: {
    category: 'widget',
    description: 'Single hero metric with label, optional delta chip and trend glyph.',
    data_shape: '{ label, value, delta?, unit?, trend?: up|down|flat }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'stat',
  },
  timeline: {
    category: 'widget',
    description: 'Vertical event ladder with time markers along a cyan spine.',
    data_shape: '{ events: [{time, label, source?, icon?}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  notification_card: {
    category: 'widget',
    description: 'Stack of recent notifications: source icon, title, body, timestamp.',
    data_shape: '{ items: [{source, title, body, time}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  status_ring: {
    category: 'widget',
    description: 'Circular progress ring with hero percentage and ok/warn/error status chip.',
    data_shape: '{ label, value_pct, status?: ok|warn|error }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'square',
  },

  // ─── Existing card family (pre-mission text cards; pure-HTML) ───────
  email_card: {
    category: 'card',
    description: 'Single-email preview card (inbound peek).',
    data_shape: '{ sender, subject, snippet, timestamp, ... }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  message_card: {
    category: 'card',
    description: 'Slack/SMS/DM bubble with source + timestamp.',
    data_shape: '{ sender, body, timestamp, channel? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  payout_card: {
    category: 'card',
    description: 'Stripe-style payout summary card.',
    data_shape: '{ amount, currency, status, period, source }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  invoice_card: {
    category: 'card',
    description: 'Single invoice: vendor, buyer, line items, total, due.',
    data_shape: '{ vendor, buyer, items, total, due_date, ... }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  receipt_card: {
    category: 'card',
    description: 'Order receipt / purchase confirmation.',
    data_shape: '{ merchant, items, total, order_id, ... }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  event_card: {
    category: 'card',
    description: 'Calendar event: title, time, location, attendees.',
    data_shape: '{ title, start, end, location?, attendees? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  agenda_card: {
    category: 'card',
    description: 'Day plan: list of scheduled events.',
    data_shape: '{ date, events: [{time, title, location?}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  task_card: {
    category: 'card',
    description: 'Single task with priority, due date, owner.',
    data_shape: '{ title, priority, due, owner, status }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  checklist_card: {
    category: 'card',
    description: 'Ordered checklist with completion progress bar.',
    data_shape: '{ title, items: [{label, done?}], progress_pct? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  profile_card: {
    category: 'card',
    description: 'Person or contact profile with avatar, role, contacts.',
    data_shape: '{ name, role?, email?, phone?, ... }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  article_card: {
    category: 'card',
    description: 'Short article/document summary card.',
    data_shape: '{ title, excerpt, source?, reading_time? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  quote_card: {
    category: 'card',
    description: 'Pull-quote or testimonial with attribution.',
    data_shape: '{ text, author?, source? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },

  // ─── Long-form text family ──────────────────────────────────────────
  report_card: {
    category: 'card',
    description: 'Structured report: summary + sections + recommendation.',
    data_shape: '{ title, summary, sections, recommendation? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  memo_card: {
    category: 'card',
    description: 'Internal memo: header + body + call-to-action.',
    data_shape: '{ title, body, cta? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  meeting_notes: {
    category: 'card',
    description: 'Meeting notes with attendees, decisions, action items.',
    data_shape: '{ title, attendees, decisions, actions }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  changelog_card: {
    category: 'card',
    description: 'Release notes / changelog entry by version.',
    data_shape: '{ version, date, entries: [{kind, text}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  pros_cons_card: {
    category: 'card',
    description: 'Two-column decision matrix: pros vs cons.',
    data_shape: '{ question, pros: [...], cons: [...] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  swot_card: {
    category: 'card',
    description: '2x2 SWOT grid (strengths / weaknesses / opportunities / threats).',
    data_shape: '{ strengths, weaknesses, opportunities, threats }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  comparison_table: {
    category: 'card',
    description: 'Side-by-side feature/option comparison table.',
    data_shape: '{ columns, rows, highlight_column? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  faq_card: {
    category: 'card',
    description: 'Frequently asked questions Q&A list.',
    data_shape: '{ title, items: [{q, a}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  bio_card: {
    category: 'card',
    description: 'Person biography: hero + facts + summary.',
    data_shape: '{ name, headline, facts, summary }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  case_study_card: {
    category: 'card',
    description: 'Case study: problem, approach, outcome.',
    data_shape: '{ title, problem, approach, outcome, metrics? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  how_to_card: {
    category: 'card',
    description: 'Numbered step-by-step walkthrough.',
    data_shape: '{ title, steps: [{title, body?}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  glossary_card: {
    category: 'card',
    description: 'Glossary of terms with short definitions.',
    data_shape: '{ title, terms: [{term, def}] }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },

  // ─── Primitive family (small utility cards) ─────────────────────────
  notification_pill: {
    category: 'primitive',
    description: 'Ambient single-line toast notification (tight pill).',
    data_shape: '{ icon?, title, detail, accent? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'stat',
  },
  qr_code: {
    category: 'primitive',
    description: 'Inline QR code projection.',
    data_shape: '{ text, label? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'square',
  },
  map_snippet: {
    category: 'primitive',
    description: 'Static map snippet for a location pin.',
    data_shape: '{ lat, lng, label? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  timer_ring: {
    category: 'primitive',
    description: 'Countdown ring to a target time or duration.',
    data_shape: '{ ends_at, label? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'square',
  },
  now_playing: {
    category: 'primitive',
    description: 'Currently-playing media card (song/podcast/video).',
    data_shape: '{ title, artist?, cover?, progress_pct? }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },
  approval_dial: {
    category: 'primitive',
    description: 'Voice-confirm dial for a pending destructive action.',
    data_shape: '{ action, detail, risk: low|med|high }',
    supports_fallback: false,
    needs_echarts: false,
    size_hint: 'wide',
  },

  // ─── Freeform escape hatch ──────────────────────────────────────────
  // Always routes to the Gemini generator with a wider creative brief.
  // Use ONLY when no other catalog entry fits — viz still must read
  // numbers from window.__DATA[id] (real data) and stay on-palette.
  custom: {
    category: 'custom',
    description: 'Freeform — Gemini composes any layout over the supplied data_refs. Use only when no other widget fits; still on-brand and data-faithful.',
    data_shape: 'any',
    supports_fallback: true,
    needs_echarts: true,
    size_hint: 'wide',
  },
});

// Text-first widget types — render_viz relaxes its numeric-token guard
// for these because the intent string is often the only text the user
// has written. Keeps the chart-intent guard strict.
export const TEXT_FIRST_WIDGETS = Object.freeze([
  'email_thread',
  'email_detail',
  'notification_card',
]);

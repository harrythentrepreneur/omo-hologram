import { renderViz, CHART_TYPES, WIDGET_CATALOG, TEXT_FIRST_WIDGETS } from '../../kitchen/index.js';
import { SIZES, SIZE_NAMES } from '../../sizes.js';
import * as projectables from '../../store/projectables.js';

// Build a tight, enum-aware description for the chart_type field in the
// render_viz schema. We keep the name `chart_type` for back-compat even
// though the catalog now covers cards, widgets, and primitives too —
// every callsite and the Gemini session config already knows that key.
// Description is "type: one-liner" per widget, separated with "; " so
// the schema stays parseable but informative.
const CHART_TYPE_DESCRIPTION = (() => {
  const parts = Object.entries(WIDGET_CATALOG)
    .map(([name, meta]) => `${name}=${meta.description}`)
    .join(' | ');
  return `Which hologram widget template to use. Covers charts, text cards, and primitives. Options: ${parts}. Omit to let the server auto-pick from dataset shape.`;
})();

// Bridge for legacy /viz/:id fetch — the express route looks up the
// projectable by id and returns the stored HTML. We treat the chart kind's
// payload as the canonical chart HTML.
export function getViz(id) {
  const entry = projectables.get(id);
  if (!entry || entry.kind !== 'chart') return null;
  return { html: entry.payload, meta: entry.meta };
}

export const definition = {
  type: 'function',
  name: 'render_viz',
  description:
    'Render a deterministic, data-faithful chart on the hologram stage. Describe the chart (intent) for the micro-label, pass data_refs from earlier data-tool calls, and ideally pass chart_type to pick the template. Never pass literal numbers — always reference datasets by id. Returns a viz_id that the client mounts automatically; you only need to narrate what the chart shows.',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'Short phrase used as the chart\'s uppercase title and to nudge auto-picking (e.g. "Last 30 days revenue", "Top products", "Channel mix"). Keep it tight — it becomes the HOLO-TITLE.',
      },
      data_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Dataset ids returned by previous data tools. At least one.',
      },
      size: {
        type: 'string',
        enum: SIZE_NAMES,
        description: 'wide = 720×420 (trends, bars, leaderboards, kpi-grids), square = 480×480 (donuts), stat = 360×220 (big-number cards).',
      },
      chart_type: {
        type: 'string',
        enum: CHART_TYPES,
        description: CHART_TYPE_DESCRIPTION,
      },
    },
    required: ['intent', 'data_refs'],
    additionalProperties: false,
  },
};

const MAX_NUMERIC_TOKENS_IN_INTENT = 8;

// Short-window dedup so two render_viz calls with identical args (model
// emits the same call twice in quick succession, or Gemini Live retransmits
// a toolCall) collapse to a single projectable_id. Without this we mint a
// fresh id on every call, the client sees two distinct vizIds, and the 2D
// chart-layer's same-vizId guard misses — both cards mount side-by-side.
const FINGERPRINT_DEDUP_WINDOW_MS = 8000;
const recentFingerprints = new Map(); // fingerprint -> { id, ts }
function rememberFingerprint(fp, id) {
  const now = Date.now();
  recentFingerprints.set(fp, { id, ts: now });
  // Opportunistic GC — keep the map from growing unbounded.
  if (recentFingerprints.size > 64) {
    for (const [k, v] of recentFingerprints) {
      if (now - v.ts > FINGERPRINT_DEDUP_WINDOW_MS) recentFingerprints.delete(k);
    }
  }
}
function lookupFingerprint(fp) {
  const entry = recentFingerprints.get(fp);
  if (!entry) return null;
  if (Date.now() - entry.ts > FINGERPRINT_DEDUP_WINDOW_MS) {
    recentFingerprints.delete(fp);
    return null;
  }
  if (!projectables.has(entry.id)) {
    recentFingerprints.delete(fp);
    return null;
  }
  return entry.id;
}

export async function run(args) {
  const intent = String(args.intent || '').trim();
  const data_refs = Array.isArray(args.data_refs) ? args.data_refs : [];
  const sizeName = SIZE_NAMES.includes(args.size) ? args.size : 'wide';
  const size = SIZES[sizeName];
  const chart_type = CHART_TYPES.includes(args.chart_type) ? args.chart_type : undefined;

  if (!intent) return { error: 'intent is required' };
  if (data_refs.length === 0) return { error: 'data_refs must contain at least one dataset id' };

  // Lots of literal numbers in the intent means the model is trying to
  // bypass the dataset-by-id rule. Reject and re-prompt.
  //
  // Exception: text-first widgets (email_thread, email_detail,
  // notification_card) are about text, not charts — the numeric-token
  // guard doesn't apply there. The hallucination risk is about a model
  // encoding chart data into the intent string, which doesn't happen for
  // those widget types.
  const isTextFirst = chart_type && TEXT_FIRST_WIDGETS.includes(chart_type);
  if (!isTextFirst) {
    const numericTokens = (intent.match(/\b-?\d+(?:\.\d+)?\b/g) || []).length;
    if (numericTokens > MAX_NUMERIC_TOKENS_IN_INTENT) {
      return { error: 'intent contains too many literal numbers — describe the chart qualitatively and reference datasets by id' };
    }
  }

  let result;
  try {
    result = await renderViz({ intent, data_refs, size, chart_type });
  } catch (err) {
    return { error: `viz render failed: ${err?.message || err}` };
  }
  if (!result.ok) return { error: result.error };

  // If this exact render was just produced, reuse the prior projectable_id
  // so the client's same-vizId mount guard kicks in (pulse instead of a
  // duplicate card).
  let projectable_id = result.fingerprint ? lookupFingerprint(result.fingerprint) : null;
  if (!projectable_id) {
    projectable_id = projectables.put('chart', {
      payload: result.html,
      meta: { intent, fingerprint: result.fingerprint, chart_type: result.chart_type, size: sizeName, data_refs },
    });
    if (result.fingerprint) rememberFingerprint(result.fingerprint, projectable_id);
  }

  return {
    // Unified projection response (new canonical shape).
    projectable_id,
    kind: 'chart',
    // Legacy alias — some clients still read viz_id. Preserves back-compat
    // while the client dispatcher moves to kind-based routing.
    viz_id: projectable_id,
    size: sizeName,
    width: size.width,
    height: size.height,
    chart_type: result.chart_type,
    cached: result.cached,
    note: 'Chart is being mounted on stage. Narrate what it shows in one or two short, cute sentences.',
  };
}

// ─── highlight_viz ────────────────────────────────────────────────────
// Pulses a specific bar/point/slice on the live card with a cyan ring
// and optional uppercase label. The actual DOM work happens browser-side
// (parent page → chart iframe via postMessage); this tool's role is to
// validate the viz_id is still live and echo the parameters back so the
// browser-side dispatcher can forward them to window.__holoChart.
export const highlightDefinition = {
  type: 'function',
  name: 'highlight_viz',
  description:
    'Pulse a specific data point on the currently-mounted chart while you narrate it — the visual equivalent of pointing with your finger. Use it the moment you mention a bar, day, or segment. dataIndex is 0-based (day 17 of a 30-day series → data_index: 16). seriesIndex defaults to 0 (single-series charts can omit it). label is a short uppercase tag (≤14 chars) that floats beside the pulse, e.g. "SPIKE", "TOP SKU", "第17天".',
  parameters: {
    type: 'object',
    properties: {
      viz_id: {
        type: 'string',
        description: 'The viz_id returned by a prior render_viz call.',
      },
      data_index: {
        type: 'integer',
        description: '0-based index of the data point within the series to highlight.',
      },
      series_index: {
        type: 'integer',
        description: '0-based index of the series (multi-series charts). Defaults to 0.',
      },
      label: {
        type: 'string',
        description: 'Optional short tag rendered near the pulse. Kept uppercase, ≤14 chars.',
      },
    },
    required: ['viz_id'],
    additionalProperties: false,
  },
};

export async function runHighlight(args) {
  const viz_id = String(args.viz_id || args.projectable_id || '').trim();
  if (!viz_id) return { error: 'viz_id is required' };
  const entry = projectables.get(viz_id);
  if (!entry || entry.kind !== 'chart') return { error: 'viz not found or expired' };

  const data_index = Number.isInteger(args.data_index) ? args.data_index : null;
  const series_index = Number.isInteger(args.series_index) ? args.series_index : 0;
  let label = args.label == null ? null : String(args.label).trim().slice(0, 14);
  if (label === '') label = null;

  return {
    ok: true,
    viz_id,
    data_index,
    series_index,
    label,
  };
}

// ─── dismiss_viz ──────────────────────────────────────────────────────
// Closes whatever chart is on stage. Tool-side this is basically a
// no-op that signals the client to call window.__holoChart.dismount().
// Safe to call with a stale or absent viz_id — the stage state lives on
// the client, the server just forwards intent.
export const dismissDefinition = {
  type: 'function',
  name: 'dismiss_viz',
  description:
    'Close the chart currently on the hologram stage when you are done narrating it or the user has moved on. Omit viz_id to dismiss whatever is showing. This is a no-op if the stage is already empty.',
  parameters: {
    type: 'object',
    properties: {
      viz_id: {
        type: 'string',
        description: 'Optional. The viz_id to dismiss. If omitted, closes whatever is on stage.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export async function runDismiss(args) {
  const viz_id = args && (args.viz_id || args.projectable_id)
    ? String(args.viz_id || args.projectable_id).trim()
    : null;
  // We never hard-fail: the stage is purely client state, and the card
  // might already be gone. Tell the client to dismount whatever it has.
  if (viz_id && !projectables.has(viz_id)) {
    return { ok: true, viz_id, note: 'viz not in store (already expired); client will dismount any active card' };
  }
  return { ok: true, viz_id: viz_id || null };
}

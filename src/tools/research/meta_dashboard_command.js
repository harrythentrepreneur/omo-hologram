// meta_dashboard_command — voice-driven sort/filter/time-scope on the
// Meta dashboard.
//
// Returns a structured command that the holo-pane dispatcher forwards into
// the /hq iframe via postMessage. The HQ page applies it to the
// Adsets-to-Action panel client-side without a network round-trip — voice
// flows like "sort by ROAS" or "filter to active only" feel instant.
//
// Four ops:
//   sort       — { field: spend|roas|ctr|cpc|cpa|cost_per_lead|conversions|frequency|name, direction: asc|desc }
//   filter     — { predicates: [{field, op, value}, ...] }
//                field ∈ status|bucket|country|spend|roas|ctr|frequency|conversions|leads
//                op    ∈ eq|ne|gt|gte|lt|lte|contains
//   time_scope — { preset?: today|yesterday|last_3|last_7|last_14|last_28|mtd|last_month|custom,
//                  start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' }
//   reset      — { target: filters|sort|time|all }
//
// Result shape is intentionally narrow — the iframe handler decides how to
// apply it. Keeps the tool side focused on grammar, not state.

const SORT_FIELDS = new Set([
  'spend', 'roas', 'ctr', 'cpc', 'cpa', 'cost_per_lead',
  'conversions', 'leads', 'frequency', 'name', 'action',
]);

const FILTER_FIELDS = new Set([
  'status', 'bucket', 'country', 'spend', 'roas', 'ctr',
  'cpc', 'cpa', 'frequency', 'conversions', 'leads',
  'campaign', 'optimization_goal',
]);

const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']);

export const definition = {
  type: 'function',
  name: 'meta_dashboard_command',
  description:
    'Voice-driven sort, filter, time-window, and hierarchical drill control for the Meta Ads dashboard. Use whenever the user wants to reorder, narrow, rescope, or drill into what\'s on screen — "sort by ROAS", "filter to active only", "only Australian campaigns", "ROAS above 3", "show me yesterday", "show November 1 to November 15", "clear filters", "show me the campaigns table", "show me all the adsets", "drill into US DCT #1", "go back". Operations: op="sort" (field+direction); op="filter" (predicates AND together); op="time_scope" (preset OR custom start+end YYYY-MM-DD); op="navigate" (level + optional name to drill in, "back" to go up — Scaling tab only); op="reset" (target=filters|sort|time|nav|all). The Scaling tab is a hierarchical browser: campaigns → adsets → ads, click a row to drill in. Voice can drive it via op="navigate" — pass level=campaigns/adsets/ads to switch view, or pass level + name (e.g. level="adsets", name="US DCT #1") to drill into a named campaign\'s adsets, or level="back" to go up one rung. Bucket values: SCALE|KILL|WATCH. Country: ISO-2. Time presets: today, yesterday, last_3, last_7, last_14, last_28, mtd, last_month, custom. Resolve natural language like "November" or "last Monday" into ISO dates yourself before calling. Returns the structured command immediately; the page applies it without a server round-trip when possible. Pair with show_pane(slot=meta) when the panel isn\'t open yet.',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['sort', 'filter', 'time_scope', 'navigate', 'reset'],
        description: 'sort = reorder rows; filter = narrow rows; time_scope = change the active date range; navigate = switch hierarchy level / drill in / go back on the Scaling browser; reset = clear sort/filter/time/nav state.',
      },
      field: {
        type: 'string',
        enum: [
          'spend', 'roas', 'ctr', 'cpc', 'cpa', 'cost_per_lead',
          'conversions', 'leads', 'frequency', 'name', 'action',
        ],
        description: 'For op=sort: which metric to sort by. For numeric metrics, default direction is "desc" (higher = better — except cpc/cpa/cost_per_lead/frequency where lower is better, default "asc").',
      },
      direction: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction. Optional — sensible default per field if omitted.',
      },
      predicates: {
        type: 'array',
        description: 'For op=filter: list of {field, op, value} predicates that AND together. Examples: [{field:"status",op:"eq",value:"ACTIVE"}], [{field:"bucket",op:"eq",value:"KILL"},{field:"country",op:"eq",value:"AU"}], [{field:"roas",op:"gte",value:3}].',
        items: {
          type: 'object',
          properties: {
            field: {
              type: 'string',
              enum: [
                'status', 'bucket', 'country', 'spend', 'roas', 'ctr',
                'cpc', 'cpa', 'frequency', 'conversions', 'leads',
                'campaign', 'optimization_goal',
              ],
            },
            op: {
              type: 'string',
              enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'],
            },
            value: { description: 'String, number, or boolean depending on field.' },
          },
          required: ['field', 'op', 'value'],
        },
      },
      target: {
        type: 'string',
        enum: ['filters', 'sort', 'time', 'nav', 'all'],
        description: 'For op=reset: what to clear. Default "all". "nav" resets the Scaling-tab browser back to "all campaigns".',
      },
      level: {
        type: 'string',
        enum: ['campaigns', 'adsets', 'ads', 'back'],
        description: 'For op=navigate: which level of the Scaling browser to view. "back" goes up one rung in the breadcrumb. Pair with `name` to drill into a specific entity (e.g. level="adsets", name="US DCT #1" → shows that campaign\'s adsets).',
      },
      name: {
        type: 'string',
        description: 'For op=navigate: optional entity name to drill into. Matched case-insensitively against campaign names (when level="adsets") or adset names (when level="ads"). Substring match — "DCT #1" finds "US DCT #1" / "Retargeting DCT #1 v2" etc.',
      },
      preset: {
        type: 'string',
        enum: ['today', 'yesterday', 'last_3', 'last_7', 'last_14', 'last_28', 'mtd', 'last_month', 'custom'],
        description: 'For op=time_scope: a named window. "custom" means use the start/end you provide. "mtd" = month-to-date (1st through today). "last_month" = the previous calendar month in full.',
      },
      start: {
        type: 'string',
        description: 'For op=time_scope with preset=custom (or omitted): start date in YYYY-MM-DD. Inclusive. The model should resolve natural language like "November 1" or "last Monday" into ISO before calling.',
      },
      end: {
        type: 'string',
        description: 'For op=time_scope with preset=custom (or omitted): end date in YYYY-MM-DD. Inclusive. Defaults to today if start is given without end.',
      },
    },
    required: ['op'],
  },
};

// Resolve a time-window preset into concrete YYYY-MM-DD bounds (inclusive).
// Returns { start, end, label } or null when the preset is unknown.
// Uses LOCAL date components so "today" matches the user's wall clock —
// not UTC, which would slip a day for any timezone east of Greenwich.
function resolvePreset(preset) {
  const today = new Date();
  const isoLocal = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const dayOffset = (n) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
    return isoLocal(d);
  };
  const t = isoLocal(today);
  switch (String(preset || '').toLowerCase()) {
    case 'today':       return { start: t, end: t, label: 'today' };
    case 'yesterday':   return { start: dayOffset(1), end: dayOffset(1), label: 'yesterday' };
    case 'last_3':      return { start: dayOffset(2), end: t, label: 'last 3 days' };
    case 'last_7':      return { start: dayOffset(6), end: t, label: 'last 7 days' };
    case 'last_14':     return { start: dayOffset(13), end: t, label: 'last 14 days' };
    case 'last_28':     return { start: dayOffset(27), end: t, label: 'last 28 days' };
    case 'mtd': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start: isoLocal(first), end: t, label: 'month to date' };
    }
    case 'last_month': {
      const lastPrev  = new Date(today.getFullYear(), today.getMonth(), 0);  // day 0 of this month = last day of prev
      const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
      return { start: isoLocal(firstPrev), end: isoLocal(lastPrev), label: lastPrev.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toLowerCase() };
    }
    default: return null;
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function run(args = {}) {
  const op = String(args.op || '').toLowerCase();
  if (!['sort', 'filter', 'time_scope', 'navigate', 'reset'].includes(op)) {
    return { ok: false, error: `unknown op "${args.op}" — use sort, filter, time_scope, navigate, or reset` };
  }

  if (op === 'sort') {
    const field = String(args.field || '').toLowerCase();
    if (!SORT_FIELDS.has(field)) {
      return { ok: false, error: `unknown sort field "${args.field}". Allowed: ${[...SORT_FIELDS].join(', ')}` };
    }
    // Default direction: desc for "higher is better", asc for "lower is better".
    const inverted = new Set(['cpc', 'cpa', 'cost_per_lead', 'frequency']);
    let direction = String(args.direction || '').toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') {
      direction = inverted.has(field) ? 'asc' : 'desc';
    }
    return {
      ok: true,
      kind: 'meta_dashboard_command',
      command: { op: 'sort', field, direction },
      // Short narration the model can speak.
      summary: `sorted by ${field} ${direction}`,
    };
  }

  if (op === 'filter') {
    const raw = Array.isArray(args.predicates) ? args.predicates : [];
    const predicates = [];
    const errors = [];
    for (const p of raw) {
      const f = String(p?.field || '').toLowerCase();
      const o = String(p?.op || '').toLowerCase();
      if (!FILTER_FIELDS.has(f)) { errors.push(`bad field "${p?.field}"`); continue; }
      if (!FILTER_OPS.has(o)) { errors.push(`bad op "${p?.op}"`); continue; }
      let value = p?.value;
      // Bucket values: normalise to upper-case enum.
      if (f === 'bucket') value = String(value || '').toUpperCase();
      if (f === 'status') value = String(value || '').toUpperCase();
      if (f === 'country') value = String(value || '').toUpperCase();
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) value = parseFloat(value);
      predicates.push({ field: f, op: o, value });
    }
    if (errors.length && !predicates.length) {
      return { ok: false, error: 'no valid predicates · ' + errors.join('; ') };
    }
    return {
      ok: true,
      kind: 'meta_dashboard_command',
      command: { op: 'filter', predicates },
      summary: predicates.length
        ? predicates.map((p) => `${p.field} ${p.op} ${p.value}`).join(' · ')
        : 'no filter applied',
    };
  }

  if (op === 'time_scope') {
    const preset = args.preset ? String(args.preset).toLowerCase() : null;
    let start = args.start ? String(args.start).trim() : null;
    let end = args.end ? String(args.end).trim() : null;
    let label = null;

    // If a named preset is given (and isn't "custom"), resolve to bounds.
    if (preset && preset !== 'custom') {
      const r = resolvePreset(preset);
      if (!r) return { ok: false, error: `unknown preset "${preset}"` };
      start = r.start; end = r.end; label = r.label;
    } else {
      // Custom or implicit (start/end provided without preset). Validate ISO.
      if (start && !ISO_RE.test(start)) return { ok: false, error: `start must be YYYY-MM-DD; got "${args.start}"` };
      if (end && !ISO_RE.test(end))   return { ok: false, error: `end must be YYYY-MM-DD; got "${args.end}"` };
      if (!start && !end) return { ok: false, error: 'time_scope custom requires at least a start date (YYYY-MM-DD)' };
      // Default end to today if only start was given.
      if (!end) end = new Date().toISOString().slice(0, 10);
      // If start > end, swap so the model can be sloppy about order.
      if (start > end) { const tmp = start; start = end; end = tmp; }
      label = start === end ? start : `${start} → ${end}`;
    }

    return {
      ok: true,
      kind: 'meta_dashboard_command',
      command: { op: 'time_scope', preset: preset || 'custom', start, end, label },
      summary: `time scope: ${label}`,
    };
  }

  if (op === 'navigate') {
    const level = String(args.level || '').toLowerCase();
    if (!['campaigns', 'adsets', 'ads', 'back'].includes(level)) {
      return { ok: false, error: `navigate.level must be campaigns/adsets/ads/back; got "${args.level}"` };
    }
    const name = args.name ? String(args.name).trim() : null;
    return {
      ok: true,
      kind: 'meta_dashboard_command',
      command: { op: 'navigate', level, name: name || null },
      summary: level === 'back'
        ? 'going up one level'
        : name
          ? `drilling into ${name} → ${level}`
          : `showing ${level} table`,
    };
  }

  // reset
  const target = String(args.target || 'all').toLowerCase();
  return {
    ok: true,
    kind: 'meta_dashboard_command',
    command: { op: 'reset', target: ['filters', 'sort', 'time', 'nav', 'all'].includes(target) ? target : 'all' },
    summary: target === 'sort' ? 'sort cleared' :
             target === 'filters' ? 'filters cleared' :
             target === 'time' ? 'time scope reset to default (last 7 days)' :
             target === 'nav' ? 'browser reset to all campaigns' :
             'sort, filters, time scope, and browser cleared',
  };
}

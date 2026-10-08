// Reflector-safety allowlist. The chart iframe is mounted over a pitch-black
// Pepper's Ghost / reflector stage. Any non-black, non-palette pixel reflects
// into the air as visible haze, breaking the hologram illusion. We therefore
// reject generated HTML whose backgrounds aren't transparent, pure black, or a
// cyan/pink/up/down palette tint.
//
// Palette RGBs used by the allowlist:
//   cyan  #00e5ff  → rgb(0,229,255)
//   pink  #ff66b3  → rgb(255,102,179)
//   up    #5effc1  → rgb(94,255,193)
//   down  #ff6b9a  → rgb(255,107,154)
const BG_VALUE_ALLOWLIST = String.raw`(transparent|none|#000|#000000|rgba?\(\s*0\s*,\s*0\s*,\s*0[^)]*\)|rgba?\(\s*0\s*,\s*229\s*,\s*255[^)]*\)|rgba?\(\s*255\s*,\s*102\s*,\s*179[^)]*\)|rgba?\(\s*94\s*,\s*255\s*,\s*193[^)]*\)|rgba?\(\s*255\s*,\s*107\s*,\s*154[^)]*\))`;

// `background-color: <value>;`  — value must match allowlist exactly.
const BG_COLOR_RE = new RegExp(
  String.raw`background-color\s*:\s*([^;"'}\n]+)`,
  'gi',
);

// `background: <value>;`  — allow allowlisted flat colours OR any
// linear-gradient(...) (we trust stop colours here for a first pass).
const BG_SHORTHAND_RE = new RegExp(
  String.raw`background\s*:\s*([^;"'}\n]+)`,
  'gi',
);

// ECharts option:  backgroundColor: '<value>'  or  backgroundColor: "<value>"
// (only the option-key form; NOT the CSS `background-color`).
const ECHARTS_BG_RE = new RegExp(
  String.raw`\bbackgroundColor\s*:\s*(['"])([^'"]+)\1`,
  'gi',
);

const VALUE_ALLOWED_RE = new RegExp(`^\\s*${BG_VALUE_ALLOWLIST}\\s*$`, 'i');

function isAllowedBgValue(v) {
  return VALUE_ALLOWED_RE.test(v);
}

function isAllowedShorthandValue(v) {
  const trimmed = v.trim();
  if (/^linear-gradient\s*\(/i.test(trimmed)) return true;
  return isAllowedBgValue(trimmed);
}

function checkReflectorSafety(html) {
  let m;
  BG_COLOR_RE.lastIndex = 0;
  while ((m = BG_COLOR_RE.exec(html)) !== null) {
    const val = m[1].trim();
    if (!isAllowedBgValue(val)) {
      return `reflector-unsafe background: background-color: ${val}`;
    }
  }
  BG_SHORTHAND_RE.lastIndex = 0;
  while ((m = BG_SHORTHAND_RE.exec(html)) !== null) {
    // Skip matches that are actually `background-color:` (already checked above).
    const fullMatchStart = m.index;
    const preceding = html.slice(Math.max(0, fullMatchStart - 1), fullMatchStart + 'background'.length + 1);
    if (/background-/i.test(preceding)) continue;
    const val = m[1].trim();
    if (!isAllowedShorthandValue(val)) {
      return `reflector-unsafe background: background: ${val}`;
    }
  }
  ECHARTS_BG_RE.lastIndex = 0;
  while ((m = ECHARTS_BG_RE.exec(html)) !== null) {
    const val = m[2].trim();
    if (!isAllowedBgValue(val)) {
      return `reflector-unsafe background: backgroundColor: '${val}'`;
    }
  }
  return null;
}

// ── Shape-intent match ─────────────────────────────────────────────────
// Heuristics only — reject only when the intent obviously asks for a chart
// kind that none of the available datasets can support. When in doubt, pass.
const INTENT_DONUT = /\b(donut|doughnut|ring|breakdown\s+by|split|share|pie|mix|composition|proportion)\b/i;
const INTENT_TREND = /\b(trend|over\s+time|last\s+\d+\s+(day|days|week|weeks|month|months)|daily|weekly|monthly|timeseries|time\s*series|time-?line|series)\b/i;
const INTENT_RANK  = /\b(top\s+\d+|leaderboard|ranking|rank|largest|biggest|smallest|best|worst)\b/i;

// Probe a dataset shape string like "{slices:{label:string, value:number}[](5), unit:string, total:number}"
// looking for arrays of objects with certain keys. Be permissive on the naming.
function hasCategoricalShape(shape) {
  if (!shape || typeof shape !== 'string') return false;
  // Look for "{...name|label|category|key...value|v|count|pence|amount...}[]"
  return /\{[^}]*\b(name|label|category|key|channel)\b[^}]*\b(value|v|count|pence|amount|revenue|orders|total)\b[^}]*\}\s*\[\]/i.test(shape);
}
function hasTimeseriesShape(shape) {
  if (!shape || typeof shape !== 'string') return false;
  return /\{[^}]*\b(t|date|day|time|ts|timestamp)\b[^}]*\b(v|value|count|pence|amount|revenue)\b[^}]*\}\s*\[\]/i.test(shape);
}
function hasArrayShape(shape) {
  return typeof shape === 'string' && /\[\]/.test(shape);
}

export function checkShapeMatch({ intent, datasets }) {
  if (!intent || !Array.isArray(datasets) || datasets.length === 0) {
    return { ok: true };
  }
  const shapes = datasets.map((d) => d.shape || '').join(' || ');
  const anyCategorical = datasets.some((d) => hasCategoricalShape(d.shape));
  const anyTimeseries  = datasets.some((d) => hasTimeseriesShape(d.shape));
  const anyArray       = datasets.some((d) => hasArrayShape(d.shape));

  if (INTENT_DONUT.test(intent) && !anyCategorical) {
    return {
      ok: false,
      reason: `intent asks for a donut/breakdown but no dataset exposes a categorical [{name|label, value}] shape (available shapes: ${shapes}). Pick a line/bar framing or request a categorical dataset first.`,
    };
  }
  if (INTENT_TREND.test(intent) && !anyTimeseries && !anyArray) {
    return {
      ok: false,
      reason: `intent asks for a trend/time-series but no dataset exposes a [{t|date, v|value}] shape (available shapes: ${shapes}). Pick a different framing or request a timeseries dataset first.`,
    };
  }
  if (INTENT_RANK.test(intent) && !anyArray) {
    return {
      ok: false,
      reason: `intent asks for a ranking/leaderboard but no dataset contains an array of items (available shapes: ${shapes}).`,
    };
  }
  return { ok: true };
}

// NOTE (template refactor): the template hot path no longer calls validate().
// Its output is palette-safe by construction (see src/kitchen/templates.js).
// validate() is now only invoked on the Gemini fallback output — where model
// drift can still slip in off-palette colours or forbidden patterns.
export function validate(html) {
  if (!/<div\b[^>]*\bid\s*=\s*["']viz["']/i.test(html)) {
    return { ok: false, reason: 'missing <div id="viz"> container' };
  }
  if (!/<script\b/i.test(html)) {
    return { ok: false, reason: 'missing <script> — chart will not render' };
  }
  if (!/\b__DATA\b/.test(html)) {
    return { ok: false, reason: 'output does not reference window.__DATA' };
  }
  const reflectorFail = checkReflectorSafety(html);
  if (reflectorFail) {
    return { ok: false, reason: reflectorFail };
  }
  return { ok: true };
}

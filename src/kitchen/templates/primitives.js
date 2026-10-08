// Template primitives — small HTML-fragment builders that compound
// templates (daily_brief, reports, dashboards) compose out of. Every
// primitive owns a single visual idiom: a KPI cell, a stat hero, a delta
// chip, a section divider, an alert pill. Keep the vocabulary here
// disciplined — the whole library looks unified when every template
// reaches for the same primitives instead of reinventing them inline.
//
// Everything here is pure string concatenation — no DOM, no dependencies.
// The iframe's inline <script> fills in runtime values (count-up, chart
// init) against ids the primitive wrote.
//
// Naming: every primitive is a `<noun>HTML` function returning a string,
// and accepts an `id` hook so the surrounding template's script can find
// its elements. If you add a new one, match that pattern.

import { escapeHtml } from './shared.js';

// ── Stat hero ──────────────────────────────────────────────────────────
// Big count-up number + optional delta chip. Used in stat cards and as
// the first element in compound templates that want a "headline" feel.
export function statHeroHTML({
  id = 'hero',
  chipId = 'chip',
  valueFallback = '0',
  chipFallback = '',
  align = 'start',       // start | baseline (for multi-stat alignment)
} = {}) {
  const baseline = align === 'baseline' ? 'align-items:baseline;' : '';
  const chipMarkup = chipId
    ? `<span class="holo-delta" id="${chipId}">${escapeHtml(chipFallback || '+0%')}</span>`
    : '';
  return `<div style="display:flex;${baseline}gap:10px;">
    <div class="holo-stat" id="${id}">${escapeHtml(valueFallback)}</div>
    ${chipMarkup}
  </div>`;
}

// ── KPI cell ───────────────────────────────────────────────────────────
// Title + medium hero + sparkline slot. Three of these sit in a
// kpi-grid row. The template's script fills hero via animateCountUp and
// initialises the sparkline against the `chartId` mount.
export function kpiCellHTML({
  id,
  title = '',
  heroFallback = '0',
  subline = '',              // optional small caption under hero
  chartId = null,            // if set, reserves a mini chart mount
} = {}) {
  if (!id) throw new Error('kpiCellHTML: id required');
  const sublineMarkup = subline ? `<div class="holo-sub" id="${id}-sub">${escapeHtml(subline)}</div>` : '';
  const chartMarkup = chartId ? `<div class="holo-chart-mini" id="${chartId}"></div>` : '';
  return `<div class="holo-kpi">
    <div class="holo-title" id="${id}-t">${escapeHtml(title)}</div>
    <div class="holo-stat holo-stat--md" id="${id}-v">${escapeHtml(heroFallback)}</div>
    ${sublineMarkup}
    ${chartMarkup}
  </div>`;
}

// ── Delta chip (standalone) ────────────────────────────────────────────
// When a primitive doesn't already emit one. The template's script sets
// textContent + toggles '.down' for negative deltas.
export function deltaChipHTML({ id, fallback = '+0%' } = {}) {
  if (!id) throw new Error('deltaChipHTML: id required');
  return `<span class="holo-delta" id="${id}">${escapeHtml(fallback)}</span>`;
}

// ── Section divider ────────────────────────────────────────────────────
// Thin cyan hairline with an optional uppercase label. Used to partition
// compound templates into visual bands without a heavy border.
export function sectionDividerHTML({ label = '' } = {}) {
  const labelMarkup = label
    ? `<span class="holo-section-label">${escapeHtml(label)}</span>`
    : '';
  return `<div class="holo-section">${labelMarkup}<span class="holo-section-rule"></span></div>`;
}

// ── Alert pill ─────────────────────────────────────────────────────────
// Small rounded chip with a tinted dot + short text. Variants mirror the
// status projectable palette so alerts read as siblings across kinds.
//   'good'  → cyan-green (things are going well)
//   'warn'  → pink       (attention)
//   'info'  → cyan       (neutral facts)
export function alertPillHTML({ kind = 'info', text = '' } = {}) {
  const variant = ['good', 'warn', 'info'].includes(kind) ? kind : 'info';
  return `<span class="holo-alert holo-alert--${variant}">
    <span class="holo-alert-dot"></span>
    <span class="holo-alert-text">${escapeHtml(text)}</span>
  </span>`;
}

// ── Greeting header ────────────────────────────────────────────────────
// The top line of a daily_brief — small date stamp above an uppercase
// greeting. If you pass dateId/textId, the template can overwrite them
// at runtime (e.g. localised date string).
export function greetingHeaderHTML({
  textId = 'greeting-text',
  dateId = 'greeting-date',
  text = 'MORNING',
  date = '',
} = {}) {
  return `<div class="holo-greet">
    <div class="holo-greet-kicker" id="${dateId}">${escapeHtml(date)}</div>
    <div class="holo-greet-line"  id="${textId}">${escapeHtml(text)}</div>
  </div>`;
}

// ── Card header (kicker + title + optional right slot) ───────────────
// The canonical top of every text-card template. `kicker` is the tiny
// uppercase label above the title (e.g. "EMAIL · 9:42 AM", "PAYOUT · APR
// 24"), `title` is the hero line, and `right` is an optional slot for a
// timestamp chip, status pill, or tag. Pass pre-escaped HTML strings for
// `right` — primitives are composable so you can drop a tag or tsChip in.
export function cardHeaderHTML({
  title = '',
  kicker = '',
  right = '',
  titleId = null,
  kickerId = null,
} = {}) {
  const titleAttr = titleId ? ` id="${titleId}"` : '';
  const kickerAttr = kickerId ? ` id="${kickerId}"` : '';
  const kickerMarkup = kicker
    ? `<div class="holo-card-kicker"${kickerAttr}>${escapeHtml(kicker)}</div>`
    : (kickerId ? `<div class="holo-card-kicker"${kickerAttr}></div>` : '');
  const rightMarkup = right ? `<div class="holo-card-head-right">${right}</div>` : '';
  return `<div class="holo-card-head">
    <div class="holo-card-head-left">
      ${kickerMarkup}
      <div class="holo-card-title"${titleAttr}>${escapeHtml(title)}</div>
    </div>
    ${rightMarkup}
  </div>`;
}

// ── Person chip: avatar bubble + name (+ optional role/subtitle) ─────
// Initials are derived from the name; the bubble hue is deterministic
// from a cheap hash so the same person gets the same colour across cards.
// Pass an explicit `avatarUrl` to override with a real image (pre-stashed
// media projectable).
export function personChipHTML({
  id = null,
  name = '',
  role = '',
  avatarUrl = null,
  size = 'md',                  // sm | md | lg
} = {}) {
  const cls = `holo-person holo-person--${size}`;
  const avatarAttr = id ? ` id="${id}-avatar"` : '';
  const nameAttr   = id ? ` id="${id}-name"`   : '';
  const roleAttr   = id ? ` id="${id}-role"`   : '';
  const initials = deriveInitials(name);
  const hue = hashHue(name);
  const avatarInner = avatarUrl
    ? `<img class="holo-person-img" src="${escapeHtml(avatarUrl)}" alt="">`
    : `<span class="holo-person-initials">${escapeHtml(initials)}</span>`;
  const avatarStyle = avatarUrl
    ? ''
    : ` style="--h: ${hue}"`;
  const roleMarkup = role || id
    ? `<div class="holo-person-role"${roleAttr}>${escapeHtml(role)}</div>`
    : '';
  return `<div class="${cls}">
    <div class="holo-person-avatar"${avatarAttr}${avatarStyle}>${avatarInner}</div>
    <div class="holo-person-meta">
      <div class="holo-person-name"${nameAttr}>${escapeHtml(name)}</div>
      ${roleMarkup}
    </div>
  </div>`;
}

// ── Timestamp chip ─────────────────────────────────────────────────────
// A compact uppercase timestamp used in card headers. Render server-side
// so the brief reads the moment it paints; templates can also replace it
// at runtime via an id hook.
export function timestampHTML({
  id = null,
  text = '',
  tone = 'default',             // default | muted | accent
} = {}) {
  const idAttr = id ? ` id="${id}"` : '';
  return `<span class="holo-ts holo-ts--${tone}"${idAttr}>${escapeHtml(text)}</span>`;
}

// ── Tag / label chip ───────────────────────────────────────────────────
// Small inline tag. Used for attachments, priorities, status, category
// labels. Tone controls the accent colour; default is cyan.
export function tagHTML({
  label = '',
  tone = 'cyan',                // cyan | pink | ice | muted
} = {}) {
  const t = ['cyan', 'pink', 'ice', 'muted'].includes(tone) ? tone : 'cyan';
  return `<span class="holo-tag holo-tag--${t}">${escapeHtml(label)}</span>`;
}

// ── Key-value metadata row ─────────────────────────────────────────────
// Left uppercase label, right monospace value. Used throughout text
// cards for metadata blocks (invoice vendor/buyer, event location/time,
// profile contact info).
export function keyValueRowHTML({
  label = '',
  value = '',
  labelId = null,
  valueId = null,
  icon = null,                  // optional icon name from ICON_SET
} = {}) {
  const labelAttr = labelId ? ` id="${labelId}"` : '';
  const valueAttr = valueId ? ` id="${valueId}"` : '';
  const iconMarkup = icon ? iconHTML({ name: icon, inline: true }) : '';
  return `<div class="holo-kv">
    <div class="holo-kv-label"${labelAttr}>${iconMarkup}<span>${escapeHtml(label)}</span></div>
    <div class="holo-kv-value"${valueAttr}>${escapeHtml(value)}</div>
  </div>`;
}

// ── Bullet / numbered list ─────────────────────────────────────────────
// Pass an array of strings; optionally an ordered list. Marker style
// matches the hologram language (cyan bullet, pink for highlighted).
export function bulletListHTML({
  items = [],
  id = null,
  ordered = false,
  marker = 'cyan',              // cyan | pink | check | arrow
} = {}) {
  const tag = ordered ? 'ol' : 'ul';
  const idAttr = id ? ` id="${id}"` : '';
  const list = items.map((it, i) => {
    const text = typeof it === 'string' ? it : (it?.label || '');
    const tone = typeof it === 'object' && it?.tone ? it.tone : '';
    const toneClass = tone === 'pink' ? ' holo-li--pink' : '';
    return `<li class="holo-li${toneClass}" data-i="${i}">${escapeHtml(text)}</li>`;
  }).join('');
  return `<${tag} class="holo-list holo-list--${marker}"${idAttr}>${list}</${tag}>`;
}

// ── Progress bar ───────────────────────────────────────────────────────
// Simple horizontal fill; percent drives the fill width. Used for task
// completion, goal progress, checklist progress. Runtime CSS transition
// animates the fill change, so passing 0 initially and updating via the
// template's script gives the "fills in on mount" feel.
export function progressBarHTML({
  id,
  label = '',
  pct = 0,
  tone = 'cyan',
} = {}) {
  if (!id) throw new Error('progressBarHTML: id required');
  const t = ['cyan', 'pink'].includes(tone) ? tone : 'cyan';
  const labelMarkup = label
    ? `<div class="holo-progress-label"><span id="${id}-l">${escapeHtml(label)}</span><span id="${id}-p">${Math.round(pct)}%</span></div>`
    : '';
  return `<div class="holo-progress holo-progress--${t}">
    ${labelMarkup}
    <div class="holo-progress-track"><div class="holo-progress-fill" id="${id}-f" style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>
  </div>`;
}

// ── Quote block ───────────────────────────────────────────────────────
// Large cyan opening quote mark, italic body, attribution below. Used
// for pull quotes, testimonials, article excerpts.
export function quoteBlockHTML({
  text = '',
  author = '',
  source = '',
} = {}) {
  const attr = [author, source].filter(Boolean).map(escapeHtml).join(' · ');
  const attrMarkup = attr ? `<div class="holo-quote-attr">— ${attr}</div>` : '';
  return `<figure class="holo-quote">
    <span class="holo-quote-mark" aria-hidden="true">“</span>
    <blockquote class="holo-quote-body">${escapeHtml(text)}</blockquote>
    ${attrMarkup}
  </figure>`;
}

// ── Section heading (within-card H2) ──────────────────────────────────
// A subdued-but-legible band to partition long-form content: uppercase
// cyan label, 1px cyan hairline afterwards. Use inside report/memo/
// bio templates where the card needs more structure than a single block.
export function sectionHeadingHTML({
  label = '',
  tone = 'cyan',                // cyan | pink | muted
  id = null,
} = {}) {
  const t = ['cyan', 'pink', 'muted'].includes(tone) ? tone : 'cyan';
  const idAttr = id ? ` id="${id}"` : '';
  return `<div class="holo-h2 holo-h2--${t}"${idAttr}>
    <span class="holo-h2-label">${escapeHtml(label)}</span>
    <span class="holo-h2-rule"></span>
  </div>`;
}

// ── Numbered step list (how-to, release notes, walkthroughs) ──────────
// Each step is a big cyan numeral + a title + an optional body line.
// Items shape: [{ title, body? }] OR plain strings.
export function stepListHTML({
  id = null,
  items = [],
  startNumber = 1,
  tone = 'cyan',
} = {}) {
  const t = ['cyan', 'pink'].includes(tone) ? tone : 'cyan';
  const idAttr = id ? ` id="${id}"` : '';
  const rows = items.map((it, i) => {
    const n = startNumber + i;
    const title = typeof it === 'string' ? it : (it?.title || it?.label || '');
    const body = typeof it === 'object' && it?.body ? it.body : '';
    const bodyMarkup = body ? `<div class="holo-step-body">${escapeHtml(body)}</div>` : '';
    return `<li class="holo-step">
      <span class="holo-step-num">${String(n).padStart(2, '0')}</span>
      <div class="holo-step-main">
        <div class="holo-step-title">${escapeHtml(title)}</div>
        ${bodyMarkup}
      </div>
    </li>`;
  }).join('');
  return `<ol class="holo-steps holo-steps--${t}"${idAttr}>${rows}</ol>`;
}

// ── Compact comparison table ──────────────────────────────────────────
// For side-by-side feature comparisons, risk registers, etc. Columns is
// an array of {label, highlight?} objects; rows is an array of string[]
// whose length matches columns. If `highlightColumnIndex` is provided,
// that column's header and cells get a cyan accent.
export function tableHTML({
  columns = [],
  rows = [],
  highlightColumnIndex = -1,
  id = null,
} = {}) {
  const idAttr = id ? ` id="${id}"` : '';
  const head = columns.map((c, i) => {
    const label = typeof c === 'string' ? c : (c?.label || '');
    const tone = (i === highlightColumnIndex || (typeof c === 'object' && c?.highlight))
      ? ' holo-th--accent' : '';
    return `<th class="holo-th${tone}">${escapeHtml(label)}</th>`;
  }).join('');
  const body = rows.map((r) => {
    const cells = (Array.isArray(r) ? r : []).map((c, i) => {
      const tone = i === highlightColumnIndex ? ' holo-td--accent' : '';
      return `<td class="holo-td${tone}">${escapeHtml(String(c == null ? '' : c))}</td>`;
    }).join('');
    return `<tr class="holo-tr">${cells}</tr>`;
  }).join('');
  return `<table class="holo-table"${idAttr}>
    <thead><tr class="holo-tr">${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

// ── Callout box ───────────────────────────────────────────────────────
// A light boxed aside used to highlight a recommendation / warning /
// key takeaway inside a longer card. Three tones: info=cyan, good=ice-
// green, warn=pink. Always renders with a small glyph on the left.
export function calloutHTML({
  title = '',
  body = '',
  kind = 'info',               // info | good | warn
} = {}) {
  const k = ['info', 'good', 'warn'].includes(kind) ? kind : 'info';
  const iconName = k === 'warn' ? 'warning' : k === 'good' ? 'check' : 'bolt';
  const titleMarkup = title
    ? `<div class="holo-callout-title">${escapeHtml(title)}</div>`
    : '';
  return `<div class="holo-callout holo-callout--${k}">
    <div class="holo-callout-icon">${iconHTML({ name: iconName })}</div>
    <div class="holo-callout-main">
      ${titleMarkup}
      <div class="holo-callout-body">${escapeHtml(body)}</div>
    </div>
  </div>`;
}

// ── Inline SVG icon set ────────────────────────────────────────────────
// A small, curated set of single-colour SVG glyphs. currentColor so
// palette tinting works (cyan default, tone-specific overrides via
// wrapping class). Keep this list tight — one new icon per new feature,
// not a library.
const ICONS = {
  mail:     '<path d="M4 7l8 6 8-6M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  user:     '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  money:    '<path d="M12 2v20M17 5.5C17 4 15 3 12 3s-5 1-5 3 2 3 5 3 5 1 5 3-2 3-5 3-5-1-5-3"/>',
  tag:      '<path d="M20.59 13.41 13 21a2 2 0 0 1-2.83 0L2 12.83V4a2 2 0 0 1 2-2h8.83L21 10.17a2 2 0 0 1-.41 3.24z"/><circle cx="7" cy="7" r="1.5"/>',
  check:    '<polyline points="20 6 9 17 4 12"/>',
  circle:   '<circle cx="12" cy="12" r="9"/>',
  phone:    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.68A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.91.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7a2 2 0 0 1 1.72 2.03z"/>',
  location: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  clock:    '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  paperclip:'<path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.57-8.57a4 4 0 0 1 5.66 5.66l-8.57 8.57a2 2 0 0 1-2.83-2.83l7.07-7.07"/>',
  star:     '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  bolt:     '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  globe:    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  hashtag:  '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  file:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  warning:  '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
};
export const ICON_NAMES = Object.keys(ICONS);

// Emit an SVG icon. `inline: true` shrinks it for use beside text in a
// kv-row; `inline: false` (default) renders at 18px for header slots.
export function iconHTML({ name, inline = false } = {}) {
  const body = ICONS[name];
  if (!body) return '';
  const size = inline ? 12 : 18;
  const sw = inline ? 1.6 : 1.8;
  const cls = `holo-icon${inline ? ' holo-icon--inline' : ''}`;
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// Deterministic initials from a name — up to 2 chars, CJK-friendly
// (if the first char is non-Latin, we just return it singly).
function deriveInitials(name) {
  const s = String(name || '').trim();
  if (!s) return '—';
  if (/^[一-鿿]/.test(s)) return s[0];     // CJK: first char
  const parts = s.split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last  = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || s[0].toUpperCase();
}

// Tiny deterministic-hash hue in [0, 360). Used to colour person avatars
// consistently per name without a colour table.
function hashHue(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ── Micro leaderboard (top-3 rows) ─────────────────────────────────────
// A tiny in-place top-N list built as a flex column. No ECharts — just
// HTML bars sized in CSS from the template's script. Used inside compound
// cards where a full hbar_rank template would be too heavy.
export function microLeaderHTML({
  id,
  title = '',
  rowCount = 3,
} = {}) {
  if (!id) throw new Error('microLeaderHTML: id required');
  const rows = Array.from({ length: rowCount }).map((_, i) => `
    <div class="holo-ml-row" data-row="${i}">
      <span class="holo-ml-label" id="${id}-l${i}"></span>
      <span class="holo-ml-bar"><span class="holo-ml-bar-fill" id="${id}-b${i}"></span></span>
      <span class="holo-ml-value" id="${id}-v${i}"></span>
    </div>`).join('');
  return `<div class="holo-ml" id="${id}">
    <div class="holo-title" id="${id}-t">${escapeHtml(title)}</div>
    ${rows}
  </div>`;
}

// ── CSS for the new primitives ─────────────────────────────────────────
// Merged into theme.js::BASE_CSS via getPrimitivesCSS() so every viz
// document picks them up. Keep it tight — shipped in every iframe.
export const PRIMITIVES_CSS = `
  /* Section divider */
  .holo-section {
    display: flex; align-items: center; gap: 10px;
    margin: 10px 0 6px 0;
  }
  .holo-section-rule {
    flex: 1; height: 1px;
    background: linear-gradient(90deg, rgba(0,229,255,0.45), rgba(0,229,255,0));
    box-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
  }
  .holo-section-label {
    font-size: 9px; font-weight: 600; letter-spacing: 0.22em;
    color: rgba(0, 229, 255, 0.85);
    text-transform: uppercase;
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.4);
  }

  /* Alert pills */
  .holo-alert {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px 3px 7px;
    border-radius: 999px;
    font-size: 10px; letter-spacing: 0.12em;
    font-family: "SF Mono", ui-monospace, monospace;
    border: 1px solid transparent;
    line-height: 1;
    white-space: nowrap;
  }
  .holo-alert-dot {
    width: 6px; height: 6px; border-radius: 50%;
    box-shadow: 0 0 6px currentColor;
  }
  .holo-alert-text { color: rgba(255, 255, 255, 0.92); }
  .holo-alert--good {
    color: #5effc1;
    background: rgba(94, 255, 193, 0.10);
    border-color: rgba(94, 255, 193, 0.32);
  }
  .holo-alert--good .holo-alert-text { color: #b8ffe2; }
  .holo-alert--warn {
    color: #ff6b9a;
    background: rgba(255, 107, 154, 0.10);
    border-color: rgba(255, 107, 154, 0.32);
  }
  .holo-alert--warn .holo-alert-text { color: #ffc3d7; }
  .holo-alert--info {
    color: #00e5ff;
    background: rgba(0, 229, 255, 0.10);
    border-color: rgba(0, 229, 255, 0.32);
  }
  .holo-alert--info .holo-alert-text { color: #b8f3ff; }

  /* Greeting header */
  .holo-greet {
    display: flex; flex-direction: column; gap: 4px;
    margin-bottom: 10px;
  }
  .holo-greet-kicker {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.24em;
    color: rgba(0, 229, 255, 0.75);
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
    text-transform: uppercase;
  }
  .holo-greet-line {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0.03em;
    background: linear-gradient(180deg, #ffffff 0%, #6ff2ff 60%, #00e5ff 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    text-shadow: 0 0 18px rgba(0, 229, 255, 0.28);
    text-transform: uppercase;
  }

  /* Micro leaderboard */
  .holo-ml { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .holo-ml .holo-title { margin-bottom: 4px; }
  .holo-ml-row {
    display: grid;
    grid-template-columns: 1fr 1.8fr auto;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-family: "SF Pro Text", system-ui, sans-serif;
    min-width: 0;
  }
  .holo-ml-label {
    color: rgba(255, 255, 255, 0.92);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .holo-ml-value {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 11px;
    color: rgba(0, 229, 255, 0.95);
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
    font-variant-numeric: tabular-nums;
  }
  .holo-ml-bar {
    display: block;
    height: 6px;
    border-radius: 3px;
    background: rgba(0, 229, 255, 0.08);
    position: relative;
    overflow: hidden;
  }
  .holo-ml-bar-fill {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 0%;
    background: linear-gradient(90deg, #00e5ff 0%, rgba(0,229,255,0.25) 100%);
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.55);
    border-radius: 3px;
    transition: width 900ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .holo-ml-row[data-row="0"] .holo-ml-bar-fill {
    background: linear-gradient(90deg, #ff66b3 0%, rgba(255,102,179,0.25) 100%);
    box-shadow: 0 0 8px rgba(255, 102, 179, 0.55);
  }
  .holo-ml-row[data-row="0"] .holo-ml-value { color: #ffc3d7; text-shadow: 0 0 6px rgba(255, 107, 154, 0.4); }

  /* Compound-card layouts */
  .holo-brief {
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    gap: 10px;
    height: 100%;
  }
  .holo-brief-kpis {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    padding-bottom: 4px;
  }
  .holo-brief-kpis .holo-kpi { gap: 4px; }
  .holo-brief-kpis .holo-kpi + .holo-kpi {
    border-left: 1px solid rgba(0, 229, 255, 0.16);
    padding-left: 16px;
  }
  .holo-brief-footer {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 16px;
    align-items: stretch;
    min-height: 0;
  }
  .holo-brief-flags {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .holo-ml-bar-fill { transition: none; }
  }

  /* ── Text-card primitives ──────────────────────────────────────────── */
  /* Card header: kicker + title + optional right slot */
  .holo-card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .holo-card-head-left  { min-width: 0; flex: 1 1 auto; }
  .holo-card-head-right { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; }
  .holo-card-kicker {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 9px;
    letter-spacing: 0.24em;
    color: rgba(0, 229, 255, 0.75);
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .holo-card-title {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.01em;
    line-height: 1.15;
    color: rgba(255, 255, 255, 0.96);
    text-shadow: 0 0 12px rgba(0, 229, 255, 0.22);
    word-break: break-word;
  }

  /* Person chip */
  .holo-person {
    display: inline-flex; align-items: center; gap: 10px;
    min-width: 0;
  }
  .holo-person-avatar {
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%;
    background: hsl(var(--h, 200), 80%, 40%);
    color: #021014;
    font-family: "SF Mono", ui-monospace, monospace;
    font-weight: 700;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
    box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.35), 0 0 10px rgba(0, 229, 255, 0.2);
    overflow: hidden;
  }
  .holo-person-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .holo-person-initials { line-height: 1; }
  .holo-person--sm .holo-person-avatar { width: 24px; height: 24px; font-size: 10px; }
  .holo-person--md .holo-person-avatar { width: 32px; height: 32px; font-size: 11px; }
  .holo-person--lg .holo-person-avatar { width: 48px; height: 48px; font-size: 14px; }
  .holo-person-meta { min-width: 0; line-height: 1.2; }
  .holo-person-name {
    color: rgba(255, 255, 255, 0.94);
    font-size: 13px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .holo-person-role {
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Timestamp chip */
  .holo-ts {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.14em;
    color: rgba(0, 229, 255, 0.85);
    text-shadow: 0 0 5px rgba(0, 229, 255, 0.35);
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(0, 229, 255, 0.08);
    border: 1px solid rgba(0, 229, 255, 0.22);
    line-height: 1;
    white-space: nowrap;
  }
  .holo-ts--muted   { color: rgba(255, 255, 255, 0.55); border-color: rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.05); text-shadow: none; }
  .holo-ts--accent  { color: #ff66b3; border-color: rgba(255, 102, 179, 0.32); background: rgba(255, 102, 179, 0.08); text-shadow: 0 0 5px rgba(255, 102, 179, 0.4); }

  /* Tag chip */
  .holo-tag {
    display: inline-flex; align-items: center; gap: 4px;
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.10em;
    padding: 2px 7px;
    border-radius: 4px;
    line-height: 1.4;
    white-space: nowrap;
  }
  .holo-tag--cyan  { color: #00e5ff; background: rgba(0, 229, 255, 0.08); border: 1px solid rgba(0, 229, 255, 0.26); }
  .holo-tag--pink  { color: #ff66b3; background: rgba(255, 102, 179, 0.08); border: 1px solid rgba(255, 102, 179, 0.26); }
  .holo-tag--ice   { color: #e8f9ff; background: rgba(174, 239, 255, 0.10); border: 1px solid rgba(174, 239, 255, 0.22); }
  .holo-tag--muted { color: rgba(255,255,255,0.55); background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.14); }

  /* Key-value row */
  .holo-kv {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr;
    align-items: baseline;
    gap: 12px;
    padding: 4px 0;
    border-bottom: 1px dashed rgba(0, 229, 255, 0.08);
    font-family: "SF Pro Text", system-ui, sans-serif;
  }
  .holo-kv:last-child { border-bottom: none; }
  .holo-kv-label {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.18em;
    color: rgba(0, 229, 255, 0.72);
    text-transform: uppercase;
  }
  .holo-kv-value {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.92);
    font-variant-numeric: tabular-nums;
    text-align: right;
    word-break: break-word;
  }

  /* Bullet list */
  .holo-list {
    margin: 6px 0;
    padding-left: 18px;
    font-family: "SF Pro Text", system-ui, sans-serif;
  }
  .holo-li {
    margin: 4px 0;
    color: rgba(255, 255, 255, 0.88);
    font-size: 12.5px;
    line-height: 1.45;
    position: relative;
    list-style: none;
  }
  .holo-li::before {
    content: "";
    position: absolute;
    left: -16px; top: 0.6em;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #00e5ff;
    box-shadow: 0 0 6px rgba(0, 229, 255, 0.65);
  }
  .holo-list--pink  .holo-li::before { background: #ff66b3; box-shadow: 0 0 6px rgba(255, 102, 179, 0.65); }
  .holo-list--check .holo-li::before {
    width: 8px; height: 8px; border-radius: 2px;
    background: transparent;
    border: 1px solid rgba(0, 229, 255, 0.65);
    box-shadow: none;
    top: 0.45em;
  }
  .holo-list--arrow .holo-li::before {
    content: "▸";
    width: auto; height: auto;
    background: transparent; box-shadow: none;
    color: #00e5ff;
    font-size: 11px;
    top: -0.05em;
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.65);
  }
  .holo-li--pink { color: #ffc3d7; }
  .holo-li--pink::before { background: #ff66b3 !important; box-shadow: 0 0 6px rgba(255, 102, 179, 0.65); }
  ol.holo-list .holo-li::before { display: none; }
  ol.holo-list { list-style: decimal; color: rgba(0, 229, 255, 0.75); padding-left: 22px; }
  ol.holo-list .holo-li { list-style-position: outside; }
  ol.holo-list .holo-li::marker {
    color: rgba(0, 229, 255, 0.85);
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
  }

  /* Progress bar */
  .holo-progress {
    display: flex; flex-direction: column; gap: 4px;
    margin: 6px 0;
  }
  .holo-progress-label {
    display: flex; justify-content: space-between;
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    color: rgba(0, 229, 255, 0.75);
    text-transform: uppercase;
  }
  .holo-progress-track {
    height: 6px;
    border-radius: 3px;
    background: rgba(0, 229, 255, 0.08);
    overflow: hidden;
    position: relative;
  }
  .holo-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00e5ff 0%, rgba(0,229,255,0.25) 100%);
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.55);
    border-radius: 3px;
    transition: width 900ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .holo-progress--pink .holo-progress-fill {
    background: linear-gradient(90deg, #ff66b3 0%, rgba(255,102,179,0.25) 100%);
    box-shadow: 0 0 8px rgba(255, 102, 179, 0.55);
  }

  /* Quote block */
  .holo-quote {
    margin: 4px 0;
    padding: 6px 4px 6px 18px;
    position: relative;
    border-left: 1px solid rgba(0, 229, 255, 0.35);
  }
  .holo-quote-mark {
    position: absolute;
    left: 4px; top: -4px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 28px;
    line-height: 1;
    color: rgba(0, 229, 255, 0.6);
    text-shadow: 0 0 10px rgba(0, 229, 255, 0.5);
  }
  .holo-quote-body {
    margin: 0;
    padding: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-style: italic;
    font-size: 15px;
    line-height: 1.45;
    color: rgba(255, 255, 255, 0.94);
  }
  .holo-quote-attr {
    margin-top: 6px;
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.15em;
    color: rgba(0, 229, 255, 0.72);
    text-transform: uppercase;
  }

  /* Icons */
  .holo-icon {
    color: #00e5ff;
    filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.4));
    flex: 0 0 auto;
  }
  .holo-icon--inline {
    filter: drop-shadow(0 0 3px rgba(0, 229, 255, 0.3));
    opacity: 0.82;
    margin-right: 2px;
  }

  /* Meta row — horizontal list of icon+text items (e.g. event location, attendees count) */
  .holo-meta-row {
    display: flex; flex-wrap: wrap; gap: 14px;
    align-items: center;
    font-family: "SF Pro Text", system-ui, sans-serif;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.75);
  }
  .holo-meta-item {
    display: inline-flex; align-items: center; gap: 5px;
  }

  /* Tag row (gap between multiple tags) */
  .holo-tag-row {
    display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center;
  }

  /* Body text — for snippets, summaries, notes, captions */
  .holo-body {
    font-family: "SF Pro Text", system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.85);
    word-wrap: break-word;
  }
  .holo-body--muted { color: rgba(255, 255, 255, 0.62); }
  .holo-body--lg    { font-size: 14px; line-height: 1.55; }
  .holo-body em     { color: #6ff2ff; font-style: italic; }
  .holo-body strong { color: rgba(255, 255, 255, 0.98); font-weight: 700; }

  /* Divider utility that doesn't need a label */
  .holo-hairline {
    height: 1px;
    background: linear-gradient(90deg, rgba(0,229,255,0.3), rgba(0,229,255,0));
    margin: 10px 0;
  }

  /* Card content area — most text cards use a column flex so sections stack */
  .holo-stack {
    display: flex; flex-direction: column;
    min-height: 0;
  }
  .holo-stack--md { gap: 10px; }
  .holo-stack--sm { gap: 6px; }
  .holo-stack--lg { gap: 14px; }

  /* Row utilities */
  .holo-row { display: flex; align-items: center; gap: 10px; }
  .holo-row--wrap { flex-wrap: wrap; }
  .holo-row--between { justify-content: space-between; }
  .holo-spacer { flex: 1 1 auto; }

  /* ── Long-form primitives ───────────────────────────────────────── */

  /* Section heading (H2 inside a card) */
  .holo-h2 {
    display: flex; align-items: center; gap: 10px;
    margin: 8px 0 4px 0;
  }
  .holo-h2-label {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .holo-h2-rule {
    flex: 1; height: 1px;
    background: linear-gradient(90deg, currentColor, transparent);
    opacity: 0.45;
  }
  .holo-h2--cyan  { color: #00e5ff; text-shadow: 0 0 6px rgba(0, 229, 255, 0.4); }
  .holo-h2--pink  { color: #ff66b3; text-shadow: 0 0 6px rgba(255, 102, 179, 0.4); }
  .holo-h2--muted { color: rgba(255, 255, 255, 0.55); text-shadow: none; }

  /* Numbered step list */
  .holo-steps {
    list-style: none;
    margin: 4px 0;
    padding: 0;
    display: flex; flex-direction: column; gap: 10px;
    counter-reset: hstep;
  }
  .holo-step {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px;
    align-items: start;
  }
  .holo-step-num {
    display: inline-flex;
    align-items: center; justify-content: center;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border-radius: 6px;
    font-family: "SF Mono", ui-monospace, monospace;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.06em;
    color: #00e5ff;
    background: rgba(0, 229, 255, 0.06);
    border: 1px solid rgba(0, 229, 255, 0.32);
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.25) inset;
    font-variant-numeric: tabular-nums;
  }
  .holo-steps--pink .holo-step-num {
    color: #ff66b3;
    background: rgba(255, 102, 179, 0.08);
    border-color: rgba(255, 102, 179, 0.38);
    box-shadow: 0 0 8px rgba(255, 102, 179, 0.25) inset;
  }
  .holo-step-main { min-width: 0; }
  .holo-step-title {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.94);
    line-height: 1.35;
  }
  .holo-step-body {
    margin-top: 3px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.72);
    line-height: 1.45;
  }

  /* Compact table */
  .holo-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-family: "SF Pro Text", system-ui, sans-serif;
    font-size: 12px;
    table-layout: auto;
  }
  .holo-th {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(0, 229, 255, 0.3);
    color: rgba(0, 229, 255, 0.82);
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .holo-th--accent {
    color: #ff66b3;
    border-bottom-color: rgba(255, 102, 179, 0.4);
    text-shadow: 0 0 6px rgba(255, 102, 179, 0.3);
  }
  .holo-td {
    padding: 7px 10px;
    border-bottom: 1px dashed rgba(0, 229, 255, 0.08);
    color: rgba(255, 255, 255, 0.9);
    font-variant-numeric: tabular-nums;
    vertical-align: top;
  }
  .holo-td--accent {
    color: #ffc3d7;
    background: rgba(255, 102, 179, 0.045);
  }
  .holo-tr:last-child .holo-td { border-bottom: none; }

  /* Callout box */
  .holo-callout {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid;
    font-family: "SF Pro Text", system-ui, sans-serif;
  }
  .holo-callout--info {
    background: rgba(0, 229, 255, 0.06);
    border-color: rgba(0, 229, 255, 0.32);
  }
  .holo-callout--good {
    background: rgba(94, 255, 193, 0.07);
    border-color: rgba(94, 255, 193, 0.35);
  }
  .holo-callout--warn {
    background: rgba(255, 102, 179, 0.07);
    border-color: rgba(255, 102, 179, 0.35);
  }
  .holo-callout-icon {
    display: inline-flex; align-items: center;
    padding-top: 2px;
  }
  .holo-callout--info .holo-callout-icon { color: #00e5ff; }
  .holo-callout--good .holo-callout-icon { color: #5effc1; }
  .holo-callout--warn .holo-callout-icon { color: #ff6b9a; }
  .holo-callout-title {
    font-family: "SF Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 3px;
  }
  .holo-callout--info .holo-callout-title { color: #00e5ff; text-shadow: 0 0 5px rgba(0, 229, 255, 0.35); }
  .holo-callout--good .holo-callout-title { color: #5effc1; text-shadow: 0 0 5px rgba(94, 255, 193, 0.35); }
  .holo-callout--warn .holo-callout-title { color: #ff6b9a; text-shadow: 0 0 5px rgba(255, 107, 154, 0.35); }
  .holo-callout-body {
    font-size: 12.5px;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.88);
  }

  /* Two-column layout utility for pros/cons, before/after, etc. */
  .holo-two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    min-height: 0;
  }
  .holo-two-col--div > * + * {
    padding-left: 16px;
    border-left: 1px solid rgba(0, 229, 255, 0.14);
    margin-left: -16px;
    padding-left: 16px;
  }

  /* 2×2 grid utility for SWOT / matrices */
  .holo-quad {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 10px;
    min-height: 0;
  }
  .holo-quad-cell {
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(0, 229, 255, 0.04);
    border: 1px solid rgba(0, 229, 255, 0.2);
    min-width: 0; min-height: 0;
    overflow: hidden;
  }
  .holo-quad-cell--accent {
    background: rgba(255, 102, 179, 0.06);
    border-color: rgba(255, 102, 179, 0.26);
  }
`;

// comparison_table — side-by-side option comparison for questions like
// "compare Plan A vs Plan B" or "these three vendors".
//
// Data shape:
//   {
//     title:   "CRM vendors"
//     subject: "Q2 CRM vendors"                // optional header timestamp
//     criteria: ["Price", "Uptime", "Support"] // rows (8 max)
//     options: [
//       { label: "Vendor A", values: [ "£12/mo", "99.99%", "24/7" ] },
//       { label: "Vendor B", values: [ "£18/mo", "99.90%", "Bus hrs" ] }
//     ],
//     winner: 0                                 // optional — index of best
//   }
//
// The "winner" column gets an accent highlight. A muted footer announces
// the pick. No pink accents here — the accent column uses the cyan-pink
// table primitives already (we allow it because the table primitive does).

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, tableHTML, timestampHTML, iconHTML,
} from './primitives.js';

const MAX_ROWS = 7;
const MAX_CRITERIA = 8;

function coerce(data) {
  if (!data) return null;
  const title = String(data.title || '').trim();

  const criteria = Array.isArray(data.criteria)
    ? data.criteria.filter(Boolean).map(String).slice(0, MAX_CRITERIA)
    : [];

  const options = Array.isArray(data.options)
    ? data.options.map(coerceOption).filter(Boolean)
    : [];

  if (!criteria.length || !options.length) return null;

  let winner = null;
  if (Number.isInteger(data.winner) && data.winner >= 0 && data.winner < options.length) {
    winner = data.winner;
  }

  return {
    title,
    subject: data.subject ? String(data.subject).trim() : '',
    criteria,
    options,
    winner,
  };
}

function coerceOption(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = String(raw.label || raw.name || '').trim();
  if (!label) return null;
  const values = Array.isArray(raw.values) ? raw.values : [];
  return { label, values };
}

// Present a value cell: pass through strings, format plain numbers.
function cellValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.abs(v) >= 1000
      ? v.toLocaleString('en-GB')
      : String(v);
  }
  return String(v);
}

export function comparisonTableTemplate({ dataset, intent }) {
  const cmp = coerce(dataset?.data);
  if (!cmp) {
    return {
      body: emptyStateBody(intent, 'Need criteria plus at least one option.'),
      exposedData: {},
      needsEcharts: false,
    };
  }

  const title = cmp.title || titleText(intent, 'COMPARISON');

  const right = cmp.subject
    ? timestampHTML({ text: cmp.subject, tone: 'muted' })
    : '';

  const visibleCriteria = cmp.criteria.slice(0, MAX_ROWS);
  const overflow = cmp.criteria.length - visibleCriteria.length;

  const columns = [
    { label: 'CRITERION' },
    ...cmp.options.map((o, i) => ({
      label: o.label.toUpperCase(),
      highlight: cmp.winner != null && i === cmp.winner,
    })),
  ];

  const rows = visibleCriteria.map((c, ci) => [
    c,
    ...cmp.options.map((o) => cellValue(o.values[ci])),
  ]);

  const highlightColumnIndex = cmp.winner != null ? cmp.winner + 1 : -1;

  const table = tableHTML({
    columns,
    rows,
    highlightColumnIndex,
  });

  const overflowTail = overflow > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;margin-top:4px;">+ ${overflow} more row${overflow === 1 ? '' : 's'}</div>`
    : '';

  const winnerFooter = cmp.winner != null
    ? `<div class="holo-cmp-footer">
         ${iconHTML({ name: 'check' })}
         <span><strong>${escapeHtml(cmp.options[cmp.winner].label)}</strong> — winner</span>
       </div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-cmp-wrap {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
    .holo-cmp-wrap .holo-table {
      font-size: 11.5px;
    }
    .holo-cmp-wrap .holo-td { padding: 6px 10px; }
    .holo-cmp-wrap .holo-th { padding: 6px 10px; }
    .holo-cmp-wrap .holo-td:first-child {
      color: rgba(0, 229, 255, 0.85);
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .holo-cmp-footer {
      display: inline-flex;
      align-self: flex-end;
      align-items: center;
      gap: 6px;
      font-family: "SF Pro Text", system-ui, sans-serif;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.85);
      padding: 2px 0;
    }
    .holo-cmp-footer strong {
      color: #6ff2ff;
      font-weight: 700;
    }
    .holo-cmp-footer .holo-icon { color: #5effc1; }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'COMPARISON', right })}
    <div class="holo-cmp-wrap">
      ${table}
      ${overflowTail}
    </div>
    <div class="holo-spacer"></div>
    ${winnerFooter}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('comparison_table: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

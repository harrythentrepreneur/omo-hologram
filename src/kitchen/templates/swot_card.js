// swot_card — classic 2×2 SWOT analysis: Strengths, Weaknesses,
// Opportunities, Threats. The Weaknesses cell uses the ONE permitted
// pink accent; the other three quadrants stay cyan.
//
// Data shape:
//   {
//     title:    "Q2 market entry"
//     subject:  "Halo Display product line"    // optional — rendered in header
//     strengths:     ["brand recall", ...]     // 2–4 each
//     weaknesses:    ["thin ops", ...]
//     opportunities: ["EU partnership", ...]
//     threats:       ["RGB-display price drop", ...]
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, bulletListHTML, iconHTML, timestampHTML,
} from './primitives.js';

const MAX_PER_CELL = 3;

function coerce(data) {
  if (!data) return null;
  const title = String(data.title || '').trim();
  const strengths     = asList(data.strengths);
  const weaknesses    = asList(data.weaknesses);
  const opportunities = asList(data.opportunities);
  const threats       = asList(data.threats);
  const total = strengths.length + weaknesses.length + opportunities.length + threats.length;
  if (!title && !total) return null;

  return {
    title,
    subject: data.subject ? String(data.subject).trim() : '',
    strengths, weaknesses, opportunities, threats,
  };
}

function asList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map(String);
}

// A single quadrant cell. `accent: true` marks it as the pink cell
// (weaknesses). `iconName` is drawn in the header.
function cellHTML({ label, iconName, items, marker, accent = false }) {
  const visible = items.slice(0, MAX_PER_CELL);
  const overflow = items.length - visible.length;
  const list = visible.length
    ? bulletListHTML({ items: visible, marker })
    : `<div class="holo-body holo-body--muted" style="font-size:11.5px;">— none —</div>`;
  const tail = overflow > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:10.5px;margin-top:2px;">+ ${overflow}</div>`
    : '';
  const cellCls = accent ? 'holo-quad-cell holo-quad-cell--accent' : 'holo-quad-cell';
  const headCls = accent ? 'holo-swot-head holo-swot-head--pink' : 'holo-swot-head';

  return `<div class="${cellCls}">
    <div class="${headCls}">
      ${iconHTML({ name: iconName })}
      <span>${escapeHtml(label)}</span>
    </div>
    ${list}
    ${tail}
  </div>`;
}

export function swotCardTemplate({ dataset, intent }) {
  const swot = coerce(dataset?.data);
  if (!swot) {
    return {
      body: emptyStateBody(intent, 'Need SWOT quadrants.'),
      exposedData: {},
      needsEcharts: false,
    };
  }

  const title = swot.title || titleText(intent, 'SWOT');
  const right = swot.subject
    ? timestampHTML({ text: swot.subject, tone: 'muted' })
    : '';

  const strengthsCell = cellHTML({
    label: 'STRENGTHS',
    iconName: 'bolt',
    items: swot.strengths,
    marker: 'arrow',
  });
  const weaknessesCell = cellHTML({
    label: 'WEAKNESSES',
    iconName: 'warning',
    items: swot.weaknesses,
    marker: 'pink',
    accent: true,
  });
  const opportunitiesCell = cellHTML({
    label: 'OPPORTUNITIES',
    iconName: 'star',
    items: swot.opportunities,
    marker: 'check',
  });
  const threatsCell = cellHTML({
    label: 'THREATS',
    iconName: 'globe',
    items: swot.threats,
    marker: 'arrow',
  });

  const body = `<div id="viz">
  <style>
    .holo-swot-grid {
      flex: 1 1 auto;
      min-height: 0;
    }
    .holo-swot-grid .holo-quad-cell {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
    }
    .holo-swot-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.22em;
      color: #00e5ff;
      text-transform: uppercase;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.4);
      margin-bottom: 2px;
    }
    .holo-swot-head--pink {
      color: #ff66b3;
      text-shadow: 0 0 6px rgba(255, 102, 179, 0.4);
    }
    .holo-swot-head--pink .holo-icon {
      color: #ff66b3;
      filter: drop-shadow(0 0 4px rgba(255, 102, 179, 0.45));
    }
    .holo-swot-grid .holo-list {
      margin: 2px 0 0 0;
      padding-left: 16px;
    }
    .holo-swot-grid .holo-li {
      font-size: 11.5px;
      line-height: 1.35;
      margin: 2px 0;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'SWOT', right })}
    <div class="holo-quad holo-swot-grid">
      ${strengthsCell}
      ${weaknessesCell}
      ${opportunitiesCell}
      ${threatsCell}
    </div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('swot_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

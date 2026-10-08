// pros_cons_card — two-column pros-vs-cons analysis for decisions.
// "Should we launch next week?" / "Pros and cons of raising prices."
//
// Data shape:
//   {
//     title:    "Launch next week"
//     subtitle: "Is the ship date worth the risk?"    // optional framing line
//     pros:     ["faster feedback", "beats competitor", ...]     // 3–5 typical
//     cons:     ["QA still red", "no docs",            ...]     // 3–5 typical
//     recommendation: {
//       verdict: 'go' | 'hold' | 'mixed',
//       reason:  "ship only the stable surface"
//     }
//   }
//
// Palette uses the ONE permitted pink on the cons column. The recommendation
// callout colour tracks the verdict (go=good/ice, hold=warn/pink, mixed=info).

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, bulletListHTML,
  calloutHTML, tagHTML,
} from './primitives.js';

const MAX_ITEMS = 5;

function coerce(data) {
  if (!data) return null;
  const title = String(data.title || '').trim();
  const pros = Array.isArray(data.pros) ? data.pros.filter(Boolean).map(String) : [];
  const cons = Array.isArray(data.cons) ? data.cons.filter(Boolean).map(String) : [];
  if (!title && !pros.length && !cons.length) return null;

  return {
    title,
    subtitle: data.subtitle ? String(data.subtitle) : '',
    pros,
    cons,
    recommendation: coerceRecommendation(data.recommendation),
  };
}

function coerceRecommendation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const verdict = String(raw.verdict || '').toLowerCase();
  if (!['go', 'hold', 'mixed'].includes(verdict)) return null;
  return {
    verdict,
    reason: raw.reason ? String(raw.reason).trim() : '',
  };
}

// Map the verdict to the right-slot tag tone.
function verdictTagTone(verdict) {
  if (verdict === 'go')   return 'ice';
  if (verdict === 'hold') return 'pink';
  return 'muted';
}

// Map the verdict to the callout box kind.
function verdictCalloutKind(verdict) {
  if (verdict === 'go')   return 'good';
  if (verdict === 'hold') return 'warn';
  return 'info';
}

// Render one column: section heading + bullets + overflow tail.
function columnHTML({ label, tone, items, marker }) {
  const visible = items.slice(0, MAX_ITEMS);
  const overflow = items.length - visible.length;
  const list = visible.length
    ? bulletListHTML({ items: visible, marker })
    : `<div class="holo-body holo-body--muted" style="font-size:12px;">— none —</div>`;
  const tail = overflow > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;margin-top:2px;">+ ${overflow} more</div>`
    : '';
  return `<div class="holo-pc-col">
    ${sectionHeadingHTML({ label, tone })}
    ${list}
    ${tail}
  </div>`;
}

export function prosConsCardTemplate({ dataset, intent }) {
  const pc = coerce(dataset?.data);
  if (!pc) {
    return {
      body: emptyStateBody(intent, 'Need a title plus pros or cons.'),
      exposedData: {},
      needsEcharts: false,
    };
  }

  const title = pc.title || titleText(intent, 'DECISION');

  const right = pc.recommendation
    ? tagHTML({
        label: pc.recommendation.verdict.toUpperCase(),
        tone: verdictTagTone(pc.recommendation.verdict),
      })
    : '';

  const subtitleMarkup = pc.subtitle
    ? `<div class="holo-body holo-body--muted" style="font-size:12.5px;margin-top:-4px;">${escapeHtml(pc.subtitle)}</div>`
    : '';

  const proCol = columnHTML({
    label: 'PROS',
    tone: 'cyan',
    items: pc.pros,
    marker: 'check',
  });

  const conCol = columnHTML({
    label: 'CONS',
    tone: 'pink',
    items: pc.cons,
    marker: 'pink',
  });

  const recMarkup = pc.recommendation
    ? calloutHTML({
        kind: verdictCalloutKind(pc.recommendation.verdict),
        title: 'RECOMMENDATION',
        body: pc.recommendation.reason
          ? `${pc.recommendation.verdict.toUpperCase()} — ${pc.recommendation.reason}`
          : pc.recommendation.verdict.toUpperCase(),
      })
    : '';

  const body = `<div id="viz">
  <style>
    .holo-pc-col {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 4px;
    }
    .holo-pc-col .holo-list { margin-top: 4px; }
    .holo-two-col.holo-pc-grid {
      align-items: start;
      gap: 20px;
    }
    .holo-pc-grid .holo-pc-col + .holo-pc-col {
      padding-left: 20px;
      border-left: 1px solid rgba(0, 229, 255, 0.14);
      margin-left: -20px;
      padding-left: 20px;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'DECISION', right })}
    ${subtitleMarkup}
    <div class="holo-two-col holo-pc-grid">
      ${proCol}
      ${conCol}
    </div>
    <div class="holo-spacer"></div>
    ${recMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('pros_cons_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

// how_to_card — a step-by-step guide. For "how do I reset my password",
// "walk me through exporting the report". Renders a numbered step list
// with optional intro, tips, and a caveats callout.
//
// Data shape (all fields optional except `title` + `steps`):
//   {
//     title:           "Export the weekly report"   // required — hero line
//     difficulty?:     'easy' | 'moderate' | 'hard'
//     estimated_time?: "5 min"  OR  5  (minutes — coerced)
//     intro?:          "one-line what-and-why"
//     steps:           [{ title, body? } | string]  // up to 6 steps
//     tips?:           ["string", …]                // 1–3 optional tips
//     caveats?:        "single warning string"
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, bulletListHTML,
  stepListHTML, calloutHTML, timestampHTML,
} from './primitives.js';

function coerceHowTo(data) {
  if (!data) return null;
  const title = String(data.title || data.name || '').trim();
  const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
  if (!title || !stepsRaw.length) return null;

  const steps = stepsRaw
    .filter(Boolean)
    .map(coerceStep)
    .filter((s) => s && s.title);

  if (!steps.length) return null;

  return {
    title,
    difficulty: normaliseDifficulty(data.difficulty),
    time: fmtDuration(data.estimated_time ?? data.time ?? data.duration),
    intro: String(data.intro || data.summary || '').trim(),
    steps,
    tips: Array.isArray(data.tips)
      ? data.tips.filter(Boolean).map(String).slice(0, 3)
      : [],
    caveats: String(data.caveats || data.warning || '').trim(),
  };
}

function coerceStep(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { title: raw.trim(), body: '' };
  return {
    title: String(raw.title || raw.label || raw.step || '').trim(),
    body:  String(raw.body  || raw.detail || raw.description || '').trim(),
  };
}

function normaliseDifficulty(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'easy' || s === 'moderate' || s === 'hard') return s;
  return '';
}

function fmtDuration(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 60 ? `${Math.round(raw)} MIN` : `${Math.round(raw / 60)} HR`;
  }
  return String(raw).toUpperCase();
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function howToCardTemplate({ dataset, intent }) {
  const h = coerceHowTo(dataset?.data);
  if (!h) {
    return { body: emptyStateBody(intent, 'Need a how-to with a title and steps.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(h.title, 'HOW-TO');

  const rightChips = [];
  if (h.difficulty) {
    const tone = h.difficulty === 'hard' ? 'accent'
               : h.difficulty === 'easy' ? 'muted'
               : 'default';
    rightChips.push(timestampHTML({ text: h.difficulty.toUpperCase(), tone }));
  }
  if (h.time) {
    rightChips.push(timestampHTML({ text: h.time, tone: 'default' }));
  }
  const right = rightChips.length
    ? `<div class="holo-howto-meta">${rightChips.join('')}</div>`
    : '';

  const introMarkup = h.intro
    ? `<div class="holo-body holo-body--lg">${escapeHtml(truncate(h.intro, 180))}</div>`
    : '';

  const maxVisible = h.steps.length > 6 ? 5 : 6;
  const visibleSteps = h.steps.slice(0, maxVisible);
  const overflow = h.steps.length - visibleSteps.length;
  const overflowMarkup = overflow > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;margin-top:-4px;">+ ${overflow} more step${overflow === 1 ? '' : 's'}</div>`
    : '';

  const stepsMarkup = stepListHTML({ items: visibleSteps, tone: 'cyan' });

  const tipsMarkup = h.tips.length
    ? `${sectionHeadingHTML({ label: 'TIPS', tone: 'cyan' })}
       ${bulletListHTML({ items: h.tips.slice(0, 3), marker: 'arrow' })}`
    : '';

  const caveatsMarkup = h.caveats
    ? calloutHTML({ kind: 'warn', title: 'HEADS UP', body: truncate(h.caveats, 180) })
    : '';

  const body = `<div id="viz">
  <style>
    .holo-howto-meta {
      display: flex; align-items: center; gap: 5px;
    }
    /* Tighten the step list so 6 items fit comfortably */
    .holo-stack .holo-steps { gap: 8px; }
    .holo-stack .holo-step-num { min-width: 24px; height: 24px; font-size: 11px; }
    .holo-stack .holo-step-title { font-size: 12.5px; }
    .holo-stack .holo-step-body { font-size: 11.5px; line-height: 1.4; }
  </style>
  <div class="holo-stack holo-stack--sm" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'HOW-TO', right })}
    ${introMarkup}
    ${stepsMarkup}
    ${overflowMarkup}
    ${tipsMarkup}
    <div class="holo-spacer"></div>
    ${caveatsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('how_to_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

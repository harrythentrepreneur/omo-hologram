// quote_card — a hero-quote card. The quote IS the visual, centred
// vertically; attribution and an optional "why this matters" sit beneath.
//
// Data shape (required: text):
//   {
//     text:      "The future is already here..."
//     author:    "William Gibson"
//     source:    "The Economist, 2003"
//     context:   "Why this matters: …"         // muted subcopy (optional)
//     published: "2003-07-12"                   // ISO (optional)
//   }

import { escapeHtml, emptyStateBody } from './shared.js';
import { quoteBlockHTML } from './primitives.js';

function coerceQuote(data) {
  if (!data) return null;
  const text = String(data.text || data.quote || data.body || '').trim();
  if (!text) return null;
  return {
    text,
    author:    String(data.author || data.speaker || '').trim(),
    source:    String(data.source || data.publication || '').trim(),
    context:   String(data.context || data.why || data.note || '').trim(),
    published: formatPublished(data.published || data.date),
  };
}

function formatPublished(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return date.toUpperCase();
}

export function quoteCardTemplate({ dataset, intent }) {
  const q = coerceQuote(dataset?.data);
  if (!q) {
    return { body: emptyStateBody(intent, 'Need quote text.'), exposedData: {}, needsEcharts: false };
  }

  // The kicker line sits above the quote instead of a full cardHeader —
  // quote cards are hero-led, not title-led.
  const kickerText = q.published
    ? (q.source ? `${q.source.toUpperCase()} · ${q.published}` : q.published)
    : (q.source ? q.source.toUpperCase() : 'QUOTE');
  const kickerMarkup = `<div class="holo-card-kicker">${escapeHtml(kickerText)}</div>`;

  const quoteMarkup = quoteBlockHTML({
    text: q.text,
    author: q.author,
    source: q.source && !q.published ? '' : q.source, // avoid duplicating source in kicker + attribution
  });

  const contextMarkup = q.context
    ? `<div class="holo-quote-context">
         <span class="holo-quote-context-label">WHY THIS MATTERS</span>
         <div class="holo-body holo-body--muted">${escapeHtml(q.context)}</div>
       </div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-quote-card {
      display: flex; flex-direction: column;
      height: 100%;
      min-height: 0;
      gap: 10px;
    }
    .holo-quote-hero {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      min-height: 0;
    }
    .holo-quote-hero .holo-quote { width: 100%; }
    .holo-quote-hero .holo-quote-body { font-size: 17px; line-height: 1.5; }
    .holo-quote-context {
      display: flex; flex-direction: column; gap: 4px;
      padding-top: 6px;
      border-top: 1px dashed rgba(0, 229, 255, 0.18);
    }
    .holo-quote-context-label {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.75);
      text-transform: uppercase;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
    }
  </style>
  <div class="holo-quote-card">
    ${kickerMarkup}
    <div class="holo-quote-hero">${quoteMarkup}</div>
    ${contextMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('quote_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

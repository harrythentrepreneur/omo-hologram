// faq_card — Q&A layout for explainer / FAQ content. For prompts like
// "give me a quick FAQ on the refund policy" or "common questions about
// onboarding".
//
// Data shape:
//   {
//     title: "Refund Policy"
//     intro: "The short version is: yes, we refund."   // optional 1-line framing
//     items: [
//       { q: "When can I ask for a refund?", a: "Within 30 days of purchase." },
//       { q: "What if I used the product?",   a: "Partial refund, pro-rated."  }
//     ]
//   }
//
// Pure cyan accents (no pink). Items cap at 4 visible; overflow becomes
// a muted tail line.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, timestampHTML,
} from './primitives.js';

const MAX_ITEMS = 4;

function coerce(data) {
  if (!data) return null;
  const title = String(data.title || '').trim();
  const items = Array.isArray(data.items)
    ? data.items.map(coerceItem).filter(Boolean)
    : [];
  if (!title && !items.length) return null;

  return {
    title,
    intro: data.intro ? String(data.intro).trim() : '',
    items,
  };
}

function coerceItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const q = String(raw.q || raw.question || '').trim();
  const a = String(raw.a || raw.answer || '').trim();
  if (!q && !a) return null;
  return { q, a };
}

// Shorten very long answers so they fit the wide card without wrapping
// to a full page.
function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

function itemHTML({ q, a }) {
  const question = escapeHtml(q || '—');
  const answer = escapeHtml(truncate(a, 220));
  return `<div class="holo-faq-item">
    <div class="holo-faq-q">
      <span class="holo-faq-mark">Q.</span>
      <span class="holo-faq-q-text">${question}</span>
    </div>
    <div class="holo-faq-a">${answer}</div>
  </div>`;
}

export function faqCardTemplate({ dataset, intent }) {
  const faq = coerce(dataset?.data);
  if (!faq) {
    return {
      body: emptyStateBody(intent, 'Need at least one Q&A pair.'),
      exposedData: {},
      needsEcharts: false,
    };
  }

  const title = faq.title || titleText(intent, 'FAQ');
  const count = faq.items.length;
  const right = count > 0
    ? timestampHTML({
        text: `${count} QUESTION${count === 1 ? '' : 'S'}`,
        tone: 'muted',
      })
    : '';

  const intro = faq.intro
    ? `<div class="holo-body holo-body--muted" style="font-size:12.5px;margin-top:-4px;">${escapeHtml(faq.intro)}</div>`
    : '';

  const visible = faq.items.slice(0, MAX_ITEMS);
  const overflow = faq.items.length - visible.length;
  const itemsMarkup = visible.map(itemHTML).join('');

  const overflowTail = overflow > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;margin-top:4px;">+ ${overflow} more</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-faq-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
      overflow: hidden;
    }
    .holo-faq-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding-top: 0;
    }
    .holo-faq-item + .holo-faq-item {
      border-top: 1px dashed rgba(0, 229, 255, 0.12);
      padding-top: 8px;
    }
    .holo-faq-q {
      display: flex;
      gap: 10px;
      align-items: baseline;
    }
    .holo-faq-mark {
      flex: 0 0 auto;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 12px;
      font-weight: 700;
      color: #00e5ff;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.45);
      letter-spacing: 0.02em;
    }
    .holo-faq-q-text {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(111, 242, 255, 0.95);
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.25);
      line-height: 1.4;
    }
    .holo-faq-a {
      padding-left: 26px;
      font-family: "SF Pro Text", system-ui, sans-serif;
      font-size: 12.5px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.86);
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'FAQ', right })}
    ${intro}
    <div class="holo-faq-list">
      ${itemsMarkup}
      ${overflowTail}
    </div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('faq_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

// glossary_card — a term + definition list. For "jargon cheat-sheet"
// or "quick glossary of ads lingo". Custom two-column layout: uppercase
// cyan monospace term on the left, white-alpha definition on the right,
// dashed cyan hairline between entries.
//
// Data shape (all fields optional except `title` + `terms`):
//   {
//     title: "Ads Terminology"                     // required — hero line
//     intro?: "one-line framing"
//     terms: [{ term, definition }]                // 4–8 entries typical
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import { cardHeaderHTML, timestampHTML } from './primitives.js';

function coerceGlossary(data) {
  if (!data) return null;
  const title = String(data.title || data.name || '').trim();
  const termsRaw = Array.isArray(data.terms) ? data.terms
                  : Array.isArray(data.entries) ? data.entries
                  : [];
  if (!title || !termsRaw.length) return null;

  const terms = termsRaw
    .map(coerceTerm)
    .filter((t) => t && t.term && t.definition);

  if (!terms.length) return null;

  return {
    title,
    intro: String(data.intro || data.summary || '').trim(),
    terms,
  };
}

function coerceTerm(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return null;
  return {
    term:       String(raw.term || raw.name || raw.key || '').trim(),
    definition: String(raw.definition || raw.meaning || raw.desc || raw.description || '').trim(),
  };
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function glossaryCardTemplate({ dataset, intent }) {
  const g = coerceGlossary(dataset?.data);
  if (!g) {
    return { body: emptyStateBody(intent, 'Need a glossary with a title and terms.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(g.title, 'GLOSSARY');
  const totalTerms = g.terms.length;
  const right = timestampHTML({
    text: `${totalTerms} TERM${totalTerms === 1 ? '' : 'S'}`,
    tone: 'muted',
  });

  const introMarkup = g.intro
    ? `<div class="holo-body holo-body--muted">${escapeHtml(truncate(g.intro, 160))}</div>`
    : '';

  const MAX_VISIBLE = 5;
  const visible = g.terms.slice(0, MAX_VISIBLE);
  const overflow = g.terms.length - visible.length;

  const termsMarkup = `<div class="holo-glossary">
    ${visible.map((t) => `<div class="holo-glossary-row">
      <div class="holo-glossary-term">${escapeHtml(t.term)}</div>
      <div class="holo-glossary-def">${escapeHtml(truncate(t.definition, 180))}</div>
    </div>`).join('')}
  </div>`;

  const overflowMarkup = overflow > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${overflow} more term${overflow === 1 ? '' : 's'}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-glossary {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .holo-glossary-row {
      display: grid;
      grid-template-columns: minmax(80px, 140px) 1fr;
      gap: 14px;
      align-items: baseline;
      min-width: 0;
    }
    .holo-glossary-row + .holo-glossary-row {
      border-top: 1px dashed rgba(0, 229, 255, 0.10);
      padding-top: 8px;
      margin-top: 8px;
    }
    .holo-glossary-term {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.16em;
      color: #00e5ff;
      text-transform: uppercase;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
      word-break: break-word;
      line-height: 1.3;
    }
    .holo-glossary-def {
      font-family: "SF Pro Text", system-ui, sans-serif;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.88);
      line-height: 1.45;
      word-break: break-word;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'GLOSSARY', right })}
    ${introMarkup}
    ${termsMarkup}
    <div class="holo-spacer"></div>
    ${overflowMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('glossary_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

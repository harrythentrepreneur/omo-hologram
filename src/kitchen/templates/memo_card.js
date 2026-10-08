// memo_card — classic office memo format for short formal communications.
// Use for "a memo on the pricing change", "send a memo to the team".
//
// Data shape:
//   {
//     to:   [{ name }] | string                  // recipients
//     from: { name, role? } | string             // author
//     date?,                                     // ISO or pre-formatted
//     re,                                        // subject line (required)
//     body,                                      // main memo text
//     cc?:  [{ name }] | string,
//     priority?: 'urgent' | 'normal' | 'fyi'
//   }
//
// Body text is split on blank lines → paragraphs, then truncated to the
// first 2–3 paragraphs (~360 chars) with a fade overlay when overflowing.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, keyValueRowHTML, tagHTML,
} from './primitives.js';

const MAX_BODY_CHARS = 360;
const MAX_PARAGRAPHS = 3;

function formatDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).toUpperCase();
}

function coercePerson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s ? { name: s, role: null } : null;
  }
  const name = raw.name || raw.display_name || raw.email || '';
  if (!name) return null;
  return { name: String(name), role: raw.role || raw.title || null };
}

function coercePeopleList(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((s) => ({ name: s }));
  }
  if (Array.isArray(raw)) {
    return raw.map((p) => {
      if (typeof p === 'string') return { name: p.trim() };
      return { name: String(p?.name || p?.display_name || p?.email || '').trim() };
    }).filter((p) => p.name);
  }
  return [];
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

function splitParagraphs(text) {
  if (!text) return [];
  return String(text)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function coerceMemo(data) {
  if (!data) return null;
  const re = String(data.re || data.subject || data.title || '').trim();
  const body = String(data.body || data.text || data.content || '').trim();
  if (!re && !body) return null;

  return {
    re: re || '(no subject)',
    from: coercePerson(data.from || data.author || data.sender),
    to: coercePeopleList(data.to || data.recipients || data.recipient),
    cc: coercePeopleList(data.cc),
    date: formatDate(data.date || data.sent_at || data.published || new Date().toISOString()),
    body,
    priority: ['urgent', 'normal', 'fyi'].includes(String(data.priority || '').toLowerCase())
      ? String(data.priority).toLowerCase() : 'normal',
  };
}

export function memoCardTemplate({ dataset, intent }) {
  const memo = coerceMemo(dataset?.data);
  if (!memo) {
    return { body: emptyStateBody(intent, 'Need a memo with re and body.'), exposedData: {}, needsEcharts: false };
  }

  const titleDisplay = titleText(memo.re, 'MEMO');

  let right = '';
  if (memo.priority === 'urgent') {
    right = tagHTML({ label: 'URGENT', tone: 'pink' });
  } else if (memo.priority === 'fyi') {
    right = tagHTML({ label: 'FYI', tone: 'muted' });
  }

  // Meta block — classic memo header rows
  const toList = memo.to.length
    ? memo.to.map((p) => p.name).join(', ')
    : '';
  const ccList = memo.cc.length
    ? memo.cc.map((p) => p.name).join(', ')
    : '';
  const fromName = memo.from ? memo.from.name : '';

  const metaRows = [];
  if (toList) metaRows.push(keyValueRowHTML({ label: 'TO', value: truncate(toList, 80) }));
  if (fromName) metaRows.push(keyValueRowHTML({ label: 'FROM', value: truncate(fromName, 60) }));
  if (memo.date) metaRows.push(keyValueRowHTML({ label: 'DATE', value: memo.date }));
  metaRows.push(keyValueRowHTML({ label: 'RE', value: truncate(memo.re, 70) }));
  if (ccList) metaRows.push(keyValueRowHTML({ label: 'CC', value: truncate(ccList, 80) }));

  const metaMarkup = `<div class="holo-memo-meta">${metaRows.join('')}</div>`;

  // Body: split on blank lines; truncate at paragraph boundary or char cap
  const paragraphs = splitParagraphs(memo.body);
  let visibleParagraphs = paragraphs.slice(0, MAX_PARAGRAPHS);
  let runningChars = 0;
  const kept = [];
  for (const p of visibleParagraphs) {
    if (runningChars + p.length > MAX_BODY_CHARS) {
      const remaining = MAX_BODY_CHARS - runningChars;
      if (remaining > 40) kept.push(truncate(p, remaining));
      break;
    }
    kept.push(p);
    runningChars += p.length;
  }
  const overflowed = kept.length < paragraphs.length
    || kept.map((k) => k.length).reduce((a, b) => a + b, 0) < paragraphs.map((p) => p.length).reduce((a, b) => a + b, 0);

  const bodyParagraphs = kept.length
    ? kept.map((p) => `<div class="holo-body holo-memo-para">${escapeHtml(p)}</div>`).join('')
    : '';

  const bodyMarkup = bodyParagraphs
    ? `<div class="holo-memo-body${overflowed ? ' holo-memo-body--fade' : ''}">${bodyParagraphs}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-memo-meta {
      padding: 6px 0 4px 0;
      border-top: 1px solid rgba(0, 229, 255, 0.22);
      border-bottom: 1px solid rgba(0, 229, 255, 0.22);
      margin-bottom: 4px;
    }
    .holo-memo-meta .holo-kv { padding: 3px 0; }
    .holo-memo-meta .holo-kv:last-child { border-bottom: none; }
    .holo-memo-meta .holo-kv-value { text-align: left; font-size: 12.5px; }
    .holo-memo-body {
      position: relative;
      overflow: hidden;
      display: flex; flex-direction: column; gap: 10px;
      max-height: 150px;
    }
    .holo-memo-body--fade::after {
      content: '';
      position: absolute;
      left: 0; right: 0; bottom: 0; height: 2.2em;
      background: linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.6));
      pointer-events: none;
    }
    .holo-memo-para { font-size: 12.5px; line-height: 1.5; }
    .holo-memo-para:first-letter {
      color: #6ff2ff;
      font-weight: 600;
    }
  </style>
  <div class="holo-stack holo-stack--sm" style="height:100%;">
    ${cardHeaderHTML({ title: titleDisplay, kicker: 'MEMO', right })}
    ${metaMarkup}
    ${bodyMarkup}
    <div class="holo-spacer"></div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('memo_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

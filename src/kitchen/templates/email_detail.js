// email_detail — a single email expanded. Header (sender / to / subject /
// time) followed by the full body. If `body_html` is supplied, it goes
// through a local regex-based sanitizer that strips script/iframe/object/
// embed/link tags, inline event handlers, javascript: urls, and external
// image sources before reaching the DOM. `body_text` is escaped verbatim
// and rendered with line-break preservation.
//
// Data shape:
//   { from, to, subject, body_html? | body_text, time }
// `from` and `to` can be strings, { name, email }, or an array of those.
//
// Defence-in-depth:
//   - This template runs inside the iframe shell which already enforces a
//     strict CSP (no connect-src, limited script-src, no frame-src). The
//     regex sanitizer here is a v1, "belt and braces" pass. For v2, swap
//     it for a proper DOMPurify port if we ever import one.
//   - External images are rejected, not rewritten. The iframe's img-src
//     allows https: and data:, but in an email context we still can't
//     trust remote images (tracking pixels). Dropping is the safest v1.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import { cardHeaderHTML, personChipHTML, timestampHTML, keyValueRowHTML } from './primitives.js';

function coerceParty(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.map(coerceParty).filter(Boolean);
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*([^<]+)?<?([^>]+@[^>]+)?>?\s*$/);
    const name = (m?.[1] || raw).trim() || (m?.[2] || '');
    return { name, email: (m?.[2] || '').trim() || null };
  }
  return {
    name: raw.name || raw.display_name || raw.email || '',
    email: raw.email || null,
  };
}

function partyLabel(p) {
  if (!p) return '';
  if (Array.isArray(p)) return p.map(partyLabel).filter(Boolean).join(', ');
  if (p.name && p.email) return `${p.name} <${p.email}>`;
  return p.name || p.email || '';
}

function formatTimestamp(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${time} · ${date.toUpperCase()}`;
}

// ── HTML sanitizer (v1, regex-based) ───────────────────────────────────
// Strips dangerous tags and attribute patterns from model-supplied email
// HTML. This runs server-side, before the fragment is inlined into the
// iframe. It's intentionally conservative — when in doubt, we strip.
//
// Kept regex-only (no DOM parser) so we don't introduce a new dependency
// just for this template. The iframe CSP is still the primary defence.
export function sanitiseEmailHtml(html) {
  if (!html || typeof html !== 'string') return '';

  let s = html;

  // Strip whole-element dangerous tags (content included).
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
  s = s.replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '');
  s = s.replace(/<embed\b[^>]*\/?>/gi, '');
  s = s.replace(/<link\b[^>]*\/?>/gi, '');
  s = s.replace(/<meta\b[^>]*\/?>/gi, '');
  s = s.replace(/<base\b[^>]*\/?>/gi, '');

  // Strip self-closing script/iframe tags (XHTML-style).
  s = s.replace(/<script\b[^>]*\/>/gi, '');
  s = s.replace(/<iframe\b[^>]*\/>/gi, '');

  // Drop HTML comments (can hide conditionals / scripts on some clients).
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Strip external <img src="http..."> — only data: is kept. Tracking
  // pixels and leaks are the main risk here. An iframe CSP allows https:
  // but in email context we want stricter.
  s = s.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    // Strip event handlers regardless.
    let cleaned = attrs.replace(/\s(on\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Drop src unless it's a data: URL.
    cleaned = cleaned.replace(/\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_m, _q, dq, sq, nq) => {
      const url = (dq ?? sq ?? nq ?? '').trim();
      return /^data:/i.test(url) ? ` src="${url.replace(/"/g, '&quot;')}"` : '';
    });
    return `<img${cleaned}>`;
  });

  // Strip ALL inline event handlers on any element.
  s = s.replace(/\s(on\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Neutralise javascript:/vbscript:/data:text/html: URLs on hrefs.
  s = s.replace(/\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (_m, _q, dq, sq, nq) => {
    const url = (dq ?? sq ?? nq ?? '').trim();
    if (/^\s*(javascript|vbscript|data\s*:\s*text\/html):/i.test(url)) return '';
    return ` href="${url.replace(/"/g, '&quot;')}"`;
  });

  // Strip form elements — we don't want submit buttons or input fields on
  // stage. (These don't execute JS but they're out of scope for email
  // projection.)
  s = s.replace(/<form\b[^>]*>[\s\S]*?<\/form\s*>/gi, '');
  s = s.replace(/<(input|button|select|textarea)\b[^>]*>/gi, '');

  // Length cap — email bodies on hologram are preview-sized, not book-sized.
  const MAX_LEN = 12_000;
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + '…';

  return s;
}

export function emailDetailTemplate({ dataset, intent }) {
  const d = dataset?.data;
  if (!d) return { body: emptyStateBody(intent, 'Need an email detail.'), exposedData: {}, needsEcharts: false };

  const from = coerceParty(d.from || d.sender);
  const to   = coerceParty(d.to);
  const subject = String(d.subject || d.title || '').trim();
  const ts = formatTimestamp(d.time || d.timestamp || d.received_at || d.date);

  if (!subject && !from && !d.body_html && !d.body_text) {
    return { body: emptyStateBody(intent, 'Need an email detail.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(subject || intent, 'EMAIL');
  const kicker = ts ? `EMAIL · ${ts}` : 'EMAIL';

  // Body: prefer sanitized HTML if provided, else escape-rendered text.
  let bodyMarkup = '';
  if (d.body_html) {
    const safe = sanitiseEmailHtml(d.body_html);
    bodyMarkup = `<div class="holo-body holo-email-body holo-email-body--html">${safe}</div>`;
  } else if (d.body_text) {
    const escaped = escapeHtml(String(d.body_text));
    bodyMarkup = `<div class="holo-body holo-email-body holo-email-body--text">${escaped}</div>`;
  }

  const fromChip = from && !Array.isArray(from)
    ? personChipHTML({ name: from.name || from.email || '—', role: from.email, size: 'md' })
    : '';

  const toLabel = partyLabel(to);
  const toRow = toLabel
    ? keyValueRowHTML({ label: 'TO', value: toLabel, icon: 'user' })
    : '';

  const right = ts ? timestampHTML({ text: ts.split(' · ')[0] || ts, tone: 'default' }) : '';

  const body = `<div id="viz">
  <style>
    .holo-email-body {
      margin-top: 4px;
      max-height: 220px;
      overflow: hidden;
      position: relative;
      padding-right: 4px;
    }
    .holo-email-body::after {
      content: '';
      position: absolute; left: 0; right: 0; bottom: 0; height: 2em;
      background: linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.55));
      pointer-events: none;
    }
    .holo-email-body--html p,
    .holo-email-body--html div { margin: 0 0 6px 0; }
    .holo-email-body--html a {
      color: #6ff2ff;
      text-decoration: underline;
      text-decoration-color: rgba(111, 242, 255, 0.35);
    }
    .holo-email-body--html img {
      max-width: 100%;
      height: auto;
      filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.18));
    }
    .holo-email-body--text { white-space: pre-wrap; }
    .holo-email-from { margin: 4px 0 8px 0; }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker, right })}
    ${fromChip ? `<div class="holo-email-from">${fromChip}</div>` : ''}
    ${toRow}
    ${bodyMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('email_detail: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

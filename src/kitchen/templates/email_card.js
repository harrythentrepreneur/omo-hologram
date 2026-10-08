// email_card — a single inbound email preview, the reference pattern for
// every text-card template in this library.
//
// Data shape (all fields optional except `subject` OR `sender`):
//   {
//     sender:   { name, email, role? }    // or `from` string
//     to:       [{ name, email }]         // optional recipient list
//     subject:  "Re: the deck"            // hero line
//     snippet:  "Hey — quick ping..."     // body excerpt (plain text)
//     timestamp: "2026-04-24T09:42:00Z"   // ISO or already-formatted string
//     unread:   true/false
//     starred:  true/false
//     attachments: [{ name, mediaType? }] // renders as tags
//     labels:   ["WORK", "URGENT"]        // tag row under subject
//     threadCount: 3                       // shows "+ 2 more" if > 1
//   }
//
// This is a TEXT CARD: no ECharts, no chart.setOption, no data-vis math.
// Everything is server-rendered HTML composed from primitives + a tiny
// inline script that just signals __READY. Sub-agents should use this
// file as the canonical pattern for their cluster.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, personChipHTML, timestampHTML, tagHTML,
  iconHTML, bulletListHTML,
} from './primitives.js';

// Coerce input leniently — connectors may land data in a few shapes.
function coerceEmail(data) {
  if (!data) return null;
  const subject = data.subject || data.title || '';
  const sender  = coerceSender(data.sender || data.from);
  if (!subject && !sender) return null;

  return {
    sender,
    subject,
    snippet: String(data.snippet || data.preview || data.body || '').trim(),
    timestamp: formatTimestamp(data.timestamp || data.received_at || data.date),
    unread: !!data.unread,
    starred: !!data.starred,
    attachments: Array.isArray(data.attachments) ? data.attachments
                  : Array.isArray(data.files) ? data.files.map((f) => ({ name: f }))
                  : [],
    labels: Array.isArray(data.labels) ? data.labels.filter(Boolean).map(String) : [],
    threadCount: Number.isInteger(data.threadCount) ? data.threadCount
                  : Number.isInteger(data.thread_length) ? data.thread_length : 1,
  };
}

function coerceSender(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    // "Sarah Chen <sarah@acme.co>" form
    const m = raw.match(/^\s*([^<]+)?<?([^>]+@[^>]+)?>?\s*$/);
    return {
      name:  (m?.[1] || raw).trim() || (m?.[2] || ''),
      email: (m?.[2] || '').trim() || null,
      role:  null,
    };
  }
  return {
    name:  raw.name || raw.display_name || raw.email || '',
    email: raw.email || null,
    role:  raw.role || raw.title || null,
  };
}

// Format a timestamp for the kicker chip. Accepts ISO strings and returns
// a short uppercase form like "9:42 AM · APR 24". If parsing fails, hands
// the raw string back so connector-provided pre-formatted values survive.
function formatTimestamp(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${time} · ${date.toUpperCase()}`;
}

export function emailCardTemplate({ dataset, intent }) {
  const email = coerceEmail(dataset?.data);
  if (!email) {
    return { body: emptyStateBody(intent, 'Need an email object.'), exposedData: {}, needsEcharts: false };
  }
  const title = titleText(intent, 'EMAIL');
  const kicker = email.timestamp
    ? `EMAIL · ${email.timestamp}`
    : 'EMAIL';

  // Right slot: star icon if starred + unread dot
  const rightParts = [];
  if (email.unread) {
    rightParts.push('<span class="holo-unread-dot" aria-label="unread"></span>');
  }
  if (email.starred) {
    rightParts.push(`<span class="holo-starred">${iconHTML({ name: 'star' })}</span>`);
  }
  const right = rightParts.join('');

  const senderMarkup = email.sender
    ? personChipHTML({ name: email.sender.name, role: email.sender.email || email.sender.role })
    : '';

  const labelRow = email.labels.length
    ? `<div class="holo-tag-row">${email.labels.slice(0, 4).map((l) => tagHTML({ label: l, tone: 'cyan' })).join('')}</div>`
    : '';

  const snippetMarkup = email.snippet
    ? `<div class="holo-body holo-body--muted">${escapeHtml(truncate(email.snippet, 280))}</div>`
    : '';

  const attachmentRow = email.attachments.length
    ? `<div class="holo-tag-row" style="margin-top:6px;">
         ${iconHTML({ name: 'paperclip', inline: true })}
         ${email.attachments.slice(0, 4).map((a) => {
           const n = typeof a === 'string' ? a : (a?.name || 'file');
           return tagHTML({ label: n, tone: 'muted' });
         }).join('')}
       </div>`
    : '';

  const threadFooter = email.threadCount > 1
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">
         ${iconHTML({ name: 'mail', inline: true })} + ${email.threadCount - 1} more in thread
       </div>`
    : '';

  // Custom CSS slot for the unread dot + starred glow — kept inline here
  // rather than in primitives.js because these are email-only semantics.
  const body = `<div id="viz">
  <style>
    .holo-unread-dot {
      display: inline-block;
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #ff66b3;
      box-shadow: 0 0 10px #ff66b3, 0 0 2px #fff;
      animation: holo-unread-pulse 2s ease-in-out infinite;
    }
    @keyframes holo-unread-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(0.75); opacity: 0.6; }
    }
    .holo-starred { color: #ffd66b; filter: drop-shadow(0 0 6px rgba(255, 214, 107, 0.7)); display: inline-flex; }
    .holo-starred .holo-icon { color: inherit; }
    .holo-email-sender { margin: 4px 0 10px 0; }
    .holo-email-snippet { max-height: 7.2em; overflow: hidden; position: relative; }
    .holo-email-snippet::after {
      content: '';
      position: absolute; left: 0; right: 0; bottom: 0; height: 1.8em;
      background: linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.55));
      pointer-events: none;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: email.subject || '(no subject)', kicker, right })}
    <div class="holo-email-sender">${senderMarkup}</div>
    ${labelRow}
    <div class="holo-email-snippet">${snippetMarkup}</div>
    ${attachmentRow}
    <div class="holo-spacer"></div>
    ${threadFooter}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('email_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

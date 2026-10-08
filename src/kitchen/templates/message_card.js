// message_card — a chat-style single-message card. The message body is
// the hero; no big title. Supports Slack/SMS/iMessage/Discord/WhatsApp
// channels with reaction pills.
//
// Data shape (required: from + text):
//   {
//     from:      { name, email? } | "Sarah Chen <sarah@acme.co>"
//     channel:   "Slack #general" | "SMS" | "WhatsApp"
//     text:      "yo — just landed, grabbing my bag now"
//     timestamp: "2026-04-24T09:42:00Z"        // ISO
//     app:       "slack" | "sms" | "imessage" | "discord" | "whatsapp"
//     reactions: [{ emoji, count }]
//   }

import { escapeHtml, emptyStateBody } from './shared.js';
import { personChipHTML, timestampHTML } from './primitives.js';

function coerceMessage(data) {
  if (!data) return null;
  const sender = coerceSender(data.from || data.sender || data.author);
  const text = String(data.text || data.body || data.message || '').trim();
  if (!sender || !text) return null;

  const reactionsRaw = Array.isArray(data.reactions) ? data.reactions : [];
  const reactions = reactionsRaw
    .map((r) => ({
      emoji: String(r?.emoji || r?.e || '').trim(),
      count: Number(r?.count ?? r?.n ?? 1),
    }))
    .filter((r) => r.emoji && Number.isFinite(r.count) && r.count > 0)
    .slice(0, 8);

  return {
    sender,
    text,
    channel:   String(data.channel || '').trim(),
    timestamp: formatTimestamp(data.timestamp || data.received_at || data.date),
    app:       String(data.app || '').toLowerCase().trim(),
    reactions,
  };
}

function coerceSender(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*([^<]+)?<?([^>]+@[^>]+)?>?\s*$/);
    return {
      name:  (m?.[1] || raw).trim() || (m?.[2] || ''),
      email: (m?.[2] || '').trim() || null,
    };
  }
  return {
    name:  raw.name || raw.display_name || raw.email || '',
    email: raw.email || null,
  };
}

function formatTimestamp(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${time} · ${date.toUpperCase()}`;
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

// Tint colour for the channel kicker based on app. Stays within the palette —
// cyan default, pink accent reserved for attention-worthy channels.
function appAccent(app) {
  switch (app) {
    case 'slack':   return 'cyan';
    case 'sms':
    case 'imessage':return 'ice';
    case 'whatsapp':return 'cyan';
    case 'discord': return 'ice';
    default:        return 'cyan';
  }
}

export function messageCardTemplate({ dataset, intent }) {
  const m = coerceMessage(dataset?.data);
  if (!m) {
    return { body: emptyStateBody(intent, 'Need a message with sender and text.'), exposedData: {}, needsEcharts: false };
  }

  const kickerText = m.channel ? m.channel.toUpperCase() : 'MESSAGE';
  const accent = appAccent(m.app);
  const kickerRow = `<div class="holo-msg-head">
    <div class="holo-card-kicker holo-msg-kicker holo-msg-kicker--${accent}">${escapeHtml(kickerText)}</div>
    ${m.timestamp ? timestampHTML({ text: m.timestamp, tone: 'muted' }) : ''}
  </div>`;

  const senderRow = `<div class="holo-msg-sender">
    ${personChipHTML({ name: m.sender.name, role: m.sender.email || '', size: 'sm' })}
  </div>`;

  const textMarkup = `<div class="holo-body holo-msg-body">${escapeHtml(truncate(m.text, 420))}</div>`;

  const reactionsMarkup = m.reactions.length
    ? `<div class="holo-msg-reactions">
         ${m.reactions.map((r) => `<span class="holo-msg-reaction">
           <span class="holo-msg-reaction-emoji">${escapeHtml(r.emoji)}</span>
           <span class="holo-msg-reaction-count">${escapeHtml(String(r.count))}</span>
         </span>`).join('')}
       </div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-msg-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
      margin-bottom: 2px;
    }
    .holo-msg-kicker { margin-bottom: 0; }
    .holo-msg-kicker--ice { color: #6ff2ff; text-shadow: 0 0 6px rgba(111, 242, 255, 0.35); }
    .holo-msg-sender { margin: 2px 0; }
    .holo-msg-body {
      font-size: 15.5px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.94);
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
      position: relative;
      max-height: 6.2em;
    }
    .holo-msg-body::after {
      content: '';
      position: absolute; left: 0; right: 0; bottom: 0; height: 1.6em;
      background: linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.5));
      pointer-events: none;
    }
    .holo-msg-reactions {
      display: flex; flex-wrap: wrap; gap: 6px;
      align-items: center;
      margin-top: 4px;
    }
    .holo-msg-reaction {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.08);
      border: 1px solid rgba(0, 229, 255, 0.24);
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      line-height: 1;
    }
    .holo-msg-reaction-emoji { font-size: 12px; line-height: 1; }
    .holo-msg-reaction-count {
      color: rgba(0, 229, 255, 0.95);
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.35);
      font-variant-numeric: tabular-nums;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${kickerRow}
    ${senderRow}
    ${textMarkup}
    <div class="holo-spacer"></div>
    ${reactionsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('message_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

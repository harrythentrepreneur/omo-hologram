// email_thread — a condensed thread view. Subject is hero, participants
// sit as small chips, and the latest 3 messages render as compact rows
// along a cyan thread-spine.
//
// Data shape (required: subject + messages):
//   {
//     subject:      "Re: the deck"
//     participants: [{ name, email? }]         // compact chip row
//     messages:     [{ sender: { name, email? } | "Sarah <s@a>",
//                      snippet, timestamp }]   // earliest first
//     unread_count: 2
//     starred:      true
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, personChipHTML, timestampHTML, iconHTML,
} from './primitives.js';

function coerceThread(data) {
  if (!data) return null;

  // Shape A: canonical thread — { subject, messages: [...] }.
  // Shape B: mission-spec email list — { emails: [{ from, subject, preview, time, unread? }] }.
  //   We fold that into a thread view where the shared subject is the
  //   most common subject across emails (or "Inbox" if none), and each
  //   email becomes a "message" row.
  if (Array.isArray(data.emails) && data.emails.length && !Array.isArray(data.messages)) {
    const emails = data.emails;
    // Pick a subject: most recent distinct subject, or a generic header.
    const firstSubject = emails.find((e) => e?.subject)?.subject || 'Inbox';
    const participants = emails.map((e) => coerceSender(e?.from)).filter(Boolean);
    const messages = emails.map((e) => ({
      sender: coerceSender(e?.from),
      snippet: String(e?.preview || e?.snippet || e?.body || e?.subject || '').trim(),
      timestamp: formatTimestamp(e?.time || e?.timestamp || e?.received_at || e?.date),
    })).filter((m) => m.sender || m.snippet);
    return {
      subject: firstSubject,
      participants,
      messages,
      unreadCount: emails.filter((e) => e?.unread).length,
      starred: !!data.starred,
    };
  }

  const subject = String(data.subject || data.title || '').trim();
  const messagesRaw = Array.isArray(data.messages) ? data.messages : [];
  if (!subject && !messagesRaw.length) return null;

  const participantsRaw = Array.isArray(data.participants) ? data.participants : [];
  const participants = participantsRaw
    .map((p) => coerceSender(p))
    .filter(Boolean);

  const messages = messagesRaw
    .map((m) => ({
      sender:    coerceSender(m?.sender || m?.from),
      snippet:   String(m?.snippet || m?.body || m?.preview || '').trim(),
      timestamp: formatTimestamp(m?.timestamp || m?.received_at || m?.date),
    }))
    .filter((m) => m.sender || m.snippet);

  return {
    subject,
    participants,
    messages,
    unreadCount: Number.isInteger(data.unread_count) ? data.unread_count
                 : Number.isInteger(data.unreadCount) ? data.unreadCount : 0,
    starred: !!data.starred,
  };
}

function coerceSender(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*([^<]+)?<?([^>]+@[^>]+)?>?\s*$/);
    const name = (m?.[1] || raw).trim() || (m?.[2] || '');
    return {
      name,
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

export function emailThreadTemplate({ dataset, intent }) {
  const t = coerceThread(dataset?.data);
  if (!t || !t.messages.length) {
    return { body: emptyStateBody(intent, 'Need a thread with messages.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(t.subject || '(no subject)', 'THREAD');
  const kicker = `THREAD · ${t.messages.length} MESSAGE${t.messages.length === 1 ? '' : 'S'}`;

  const rightParts = [];
  if (t.unreadCount > 0) {
    rightParts.push(timestampHTML({ text: `${t.unreadCount} UNREAD`, tone: 'accent' }));
  }
  if (t.starred) {
    rightParts.push(`<span class="holo-starred">${iconHTML({ name: 'star' })}</span>`);
  }
  const right = rightParts.join('');

  const shownParticipants = t.participants.slice(0, 4);
  const extraParticipants = Math.max(0, t.participants.length - shownParticipants.length);
  const participantsRow = t.participants.length
    ? `<div class="holo-row holo-row--wrap holo-thread-participants">
         ${shownParticipants.map((p) => personChipHTML({ name: p.name, size: 'sm' })).join('')}
         ${extraParticipants > 0
           ? `<span class="holo-thread-more">+${extraParticipants}</span>`
           : ''}
       </div>`
    : '';

  const latest = t.messages.slice(-3);
  const messageRows = latest.map((m) => {
    const senderName = m.sender?.name || '—';
    const snippet = m.snippet ? escapeHtml(truncate(m.snippet, 100)) : '';
    const ts = m.timestamp ? escapeHtml(m.timestamp) : '';
    return `<div class="holo-thread-row">
      <div class="holo-thread-row-main">
        <div class="holo-thread-sender">${escapeHtml(senderName)}</div>
        ${snippet ? `<div class="holo-thread-snippet">${snippet}</div>` : ''}
      </div>
      ${ts ? `<div class="holo-thread-ts">${ts}</div>` : ''}
    </div>`;
  }).join('');

  const earlierCount = Math.max(0, t.messages.length - latest.length);
  const earlierFooter = earlierCount > 0
    ? `<div class="holo-body holo-body--muted holo-thread-earlier">+ ${earlierCount} earlier</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-starred { color: #ffd66b; filter: drop-shadow(0 0 6px rgba(255, 214, 107, 0.7)); display: inline-flex; }
    .holo-starred .holo-icon { color: inherit; }
    .holo-thread-participants { gap: 6px 8px; }
    .holo-thread-more {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      color: rgba(255, 255, 255, 0.55);
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.14);
    }
    .holo-thread-list {
      display: flex; flex-direction: column;
      gap: 8px;
      padding-left: 10px;
      border-left: 1px solid rgba(0, 229, 255, 0.28);
      box-shadow: inset 1px 0 6px rgba(0, 229, 255, 0.08);
    }
    .holo-thread-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: baseline;
      min-width: 0;
    }
    .holo-thread-row-main { min-width: 0; }
    .holo-thread-sender {
      font-size: 13px;
      font-weight: 600;
      color: #6ff2ff;
      text-shadow: 0 0 6px rgba(111, 242, 255, 0.25);
      line-height: 1.25;
    }
    .holo-thread-snippet {
      font-family: "SF Pro Text", system-ui, sans-serif;
      font-size: 12.5px;
      line-height: 1.4;
      color: rgba(255, 255, 255, 0.82);
      margin-top: 2px;
      word-break: break-word;
    }
    .holo-thread-ts {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      color: rgba(255, 255, 255, 0.5);
      white-space: nowrap;
      text-align: right;
    }
    .holo-thread-earlier {
      font-size: 11px;
      padding-left: 10px;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker, right })}
    ${participantsRow}
    <div class="holo-thread-list">${messageRows}</div>
    <div class="holo-spacer"></div>
    ${earlierFooter}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('email_thread: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

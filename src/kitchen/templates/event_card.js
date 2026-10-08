// event_card — a single calendar event: when, where, who, what.
// Sibling to email_card / payout_card; pure server-rendered text card.
//
// Data shape (all optional except `title`):
//   {
//     title,                           // hero line
//     start, end,                      // ISO datetime strings
//     location?,                       // string or { name, address? }
//     online_url?,                     // remote meeting link
//     attendees: [{ name, email?, response? }]
//                                      // response: 'accepted'|'tentative'|'declined'|null
//     description?,                    // plain text / markdown-lite
//     organizer?: { name, email? },
//     calendar?,                       // "Work" / "Personal"
//     conflict?: boolean               // overlap with another event → pink time chip
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, personChipHTML, timestampHTML, tagHTML, iconHTML,
} from './primitives.js';

function coerceEvent(data) {
  if (!data) return null;
  const title = String(data.title || data.summary || '').trim();
  if (!title) return null;
  const loc = data.location;
  const location = !loc ? null
    : (typeof loc === 'string' ? { name: loc, address: null }
                               : { name: loc.name || loc.title || '', address: loc.address || null });
  return {
    title,
    start: data.start || data.starts_at || null,
    end:   data.end   || data.ends_at   || null,
    location,
    online_url: data.online_url || data.meeting_url || null,
    attendees: Array.isArray(data.attendees)
      ? data.attendees.filter(Boolean).map((a) => (typeof a === 'string'
          ? { name: a, email: null, response: null }
          : { name: a.name || a.email || '—', email: a.email || null, response: a.response || null }))
      : [],
    description: String(data.description || data.notes || '').trim(),
    organizer: data.organizer ? {
      name: data.organizer.name || data.organizer.email || '',
      email: data.organizer.email || null,
    } : null,
    calendar: data.calendar || null,
    conflict: !!data.conflict,
  };
}

// "FRIDAY, APR 24"
function formatDayDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  const day  = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  return `${day}, ${date}`;
}

// "9:30–10:00 AM" — same-day. Cross-day falls back to "APR 24 · 9:30 AM".
function formatTimeRange(startIso, endIso) {
  if (!startIso) return '';
  const s = new Date(startIso);
  if (!Number.isFinite(s.getTime())) return String(startIso);
  const sTime = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (!endIso) return sTime;
  const e = new Date(endIso);
  if (!Number.isFinite(e.getTime())) return sTime;
  const sameDay = s.toDateString() === e.toDateString();
  if (!sameDay) {
    const sDate = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    return `${sDate} · ${sTime}`;
  }
  const eTime = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  // Collapse meridiem on start if both share it: "9:30–10:00 AM"
  const sM = sTime.match(/\s?(AM|PM)$/i);
  const eM = eTime.match(/\s?(AM|PM)$/i);
  if (sM && eM && sM[1].toUpperCase() === eM[1].toUpperCase()) {
    const sNoMer = sTime.replace(/\s?(AM|PM)$/i, '');
    return `${sNoMer}–${eTime}`;
  }
  return `${sTime}–${eTime}`;
}

// "30 min" / "1h 30min" / ""
function durationMins(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const s = new Date(startIso); const e = new Date(endIso);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return '';
  const mins = Math.round((e.getTime() - s.getTime()) / 60000);
  if (mins <= 0) return '';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function responseTone(resp) {
  const r = String(resp || '').toLowerCase();
  if (r === 'accepted') return 'cyan';
  if (r === 'declined') return 'pink';
  return 'muted'; // tentative / null / unknown
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function eventCardTemplate({ dataset, intent }) {
  const ev = coerceEvent(dataset?.data);
  if (!ev) {
    return { body: emptyStateBody(intent, 'Need an event with a title.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'EVENT');

  const kicker = ev.start ? formatDayDate(ev.start) : 'EVENT';
  const timeText = formatTimeRange(ev.start, ev.end);
  const right = timeText
    ? timestampHTML({ text: timeText, tone: ev.conflict ? 'accent' : 'default' })
    : '';

  // Meta row — location/online, duration, attendee count (cap ~4 items).
  const metaItems = [];
  if (ev.location?.name) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'location', inline: true })}${escapeHtml(ev.location.name)}</span>`);
  } else if (ev.online_url) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'globe', inline: true })}Online</span>`);
  }
  const dur = durationMins(ev.start, ev.end);
  if (dur) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'clock', inline: true })}${escapeHtml(dur)}</span>`);
  }
  if (ev.attendees.length) {
    const noun = ev.attendees.length === 1 ? 'guest' : 'guests';
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'user', inline: true })}${ev.attendees.length} ${noun}</span>`);
  }
  const metaRow = metaItems.length
    ? `<div class="holo-meta-row">${metaItems.slice(0, 4).join('')}</div>`
    : '';

  // Attendee chips (up to 4) with +N more tag.
  const shownAttendees = ev.attendees.slice(0, 4);
  const extraAttendees = Math.max(0, ev.attendees.length - 4);
  const attendeeChips = shownAttendees.map((a) => {
    const tone = responseTone(a.response);
    const glow = tone === 'pink' ? ' holo-ev-att--declined' : '';
    return `<span class="holo-ev-att${glow}">${personChipHTML({ name: a.name, role: a.email || '', size: 'sm' })}</span>`;
  }).join('');
  const attendeeRow = ev.attendees.length
    ? `<div class="holo-row holo-row--wrap">
         ${attendeeChips}
         ${extraAttendees ? tagHTML({ label: `+ ${extraAttendees} more`, tone: 'muted' }) : ''}
       </div>`
    : '';

  const descriptionMarkup = ev.description
    ? `<div class="holo-body holo-body--muted">${escapeHtml(truncate(ev.description, 280))}</div>`
    : '';

  // Footer: conflict warning (pink) or calendar tag.
  let footer = '';
  if (ev.conflict) {
    footer = `<div class="holo-ev-conflict">
      ${iconHTML({ name: 'warning', inline: true })}
      <span>Conflicts with another event</span>
    </div>`;
  } else if (ev.calendar) {
    footer = `<div class="holo-tag-row">${tagHTML({ label: ev.calendar, tone: 'muted' })}</div>`;
  }

  const body = `<div id="viz">
  <style>
    .holo-ev-att { display: inline-flex; }
    .holo-ev-att--declined .holo-person-name { color: rgba(255, 102, 179, 0.85); }
    .holo-ev-att--declined .holo-person-avatar {
      box-shadow: 0 0 0 1px rgba(255, 102, 179, 0.45), 0 0 8px rgba(255, 102, 179, 0.25);
    }
    .holo-ev-conflict {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #ff66b3;
      text-shadow: 0 0 6px rgba(255, 102, 179, 0.4);
      padding: 4px 9px;
      border-radius: 999px;
      background: rgba(255, 102, 179, 0.08);
      border: 1px solid rgba(255, 102, 179, 0.32);
      align-self: flex-start;
    }
    .holo-ev-conflict .holo-icon { color: #ff66b3; filter: drop-shadow(0 0 4px rgba(255, 102, 179, 0.45)); }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: ev.title, kicker, right })}
    ${metaRow}
    ${attendeeRow}
    ${descriptionMarkup}
    <div class="holo-spacer"></div>
    ${footer}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('event_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

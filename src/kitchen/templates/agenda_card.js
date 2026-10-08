// agenda_card — the day's schedule at a glance. A stacked list of events
// with start time, title, and duration. Custom row layout (not the generic
// kv-row) because we want time | dot | title | duration aligned columns.
//
// Data shape (all optional except `events`):
//   {
//     date,                            // ISO date — drives the kicker + title day-name
//     events: [{ title, start, end, location?, attendees_count? }],
//     total_hours?                     // pre-computed busy hours (drives pink warn chip)
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, timestampHTML, iconHTML,
} from './primitives.js';

function coerceAgenda(data) {
  if (!data) return null;
  const events = Array.isArray(data.events) ? data.events : [];
  const clean = events.filter(Boolean).map((e) => ({
    title: String(e.title || e.summary || '—').trim(),
    start: e.start || e.starts_at || null,
    end:   e.end   || e.ends_at   || null,
    location: typeof e.location === 'string' ? e.location
               : (e.location?.name || null),
    attendees_count: Number.isInteger(e.attendees_count) ? e.attendees_count : null,
  }));
  return {
    date: data.date || null,
    events: clean,
    total_hours: Number.isFinite(Number(data.total_hours)) ? Number(data.total_hours) : null,
  };
}

// "FRIDAY" — just the weekday, used as the hero title.
function formatDayName(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
}

// "APR 24" — uppercase month + day for the kicker.
function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

// "9:30" or "9:30 AM" — short compact start.
function formatStartTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// "30m" / "1h 30m"
function shortDuration(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const s = new Date(startIso); const e = new Date(endIso);
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return '';
  const mins = Math.round((e.getTime() - s.getTime()) / 60000);
  if (mins <= 0) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function agendaCardTemplate({ dataset, intent }) {
  const a = coerceAgenda(dataset?.data);
  if (!a) {
    return { body: emptyStateBody(intent, 'Need an agenda with events.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'AGENDA');

  const dateLabel = formatShortDate(a.date);
  const kicker = dateLabel ? `AGENDA · ${dateLabel}` : 'AGENDA';
  const dayName = formatDayName(a.date) || 'TODAY';

  // Right slot — event count. Pink if the day is >6 hours of meetings.
  const count = a.events.length;
  const countText = count === 0 ? 'NO EVENTS' : `${count} ${count === 1 ? 'EVENT' : 'EVENTS'}`;
  const busy = a.total_hours != null && a.total_hours > 6;
  const right = count > 0
    ? timestampHTML({ text: countText, tone: busy ? 'accent' : 'default' })
    : '';

  // Empty state inside the card body (keep card shell so kicker+title remain).
  let mainBlock;
  if (count === 0) {
    mainBlock = `<div class="holo-agenda-empty">
      ${iconHTML({ name: 'clock' })}
      <div class="holo-agenda-empty-text">NO EVENTS</div>
    </div>`;
  } else {
    const shown = a.events.slice(0, 6);
    const extra = Math.max(0, count - 6);
    const rows = shown.map((e) => {
      const time = formatStartTime(e.start);
      const dur  = shortDuration(e.start, e.end);
      return `<li class="holo-agenda-row">
        <span class="holo-agenda-time">${escapeHtml(time)}</span>
        <span class="holo-agenda-dot" aria-hidden="true"></span>
        <span class="holo-agenda-title">${escapeHtml(e.title)}</span>
        <span class="holo-agenda-dur">${escapeHtml(dur)}</span>
      </li>`;
    }).join('');
    const moreLine = extra > 0
      ? `<div class="holo-agenda-more">+ ${extra} more</div>`
      : '';
    mainBlock = `<ul class="holo-agenda">${rows}</ul>${moreLine}`;
  }

  const body = `<div id="viz">
  <style>
    .holo-agenda {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex; flex-direction: column;
      gap: 8px;
      font-family: "SF Pro Text", system-ui, sans-serif;
    }
    .holo-agenda-row {
      display: grid;
      grid-template-columns: 64px 10px 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 4px 0;
      border-bottom: 1px dashed rgba(0, 229, 255, 0.08);
    }
    .holo-agenda-row:last-child { border-bottom: none; }
    .holo-agenda-time {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      color: rgba(0, 229, 255, 0.85);
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.3);
      letter-spacing: 0.06em;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .holo-agenda-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #00e5ff;
      box-shadow: 0 0 6px rgba(0, 229, 255, 0.7);
      justify-self: center;
    }
    .holo-agenda-title {
      color: rgba(255, 255, 255, 0.92);
      font-size: 13px;
      line-height: 1.3;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .holo-agenda-dur {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.08em;
      color: rgba(255, 255, 255, 0.48);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .holo-agenda-more {
      margin-top: 6px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.16em;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      padding-left: 74px;
    }
    .holo-agenda-empty {
      flex: 1;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 10px;
      opacity: 0.6;
      padding: 24px 0;
    }
    .holo-agenda-empty .holo-icon { width: 32px; height: 32px; }
    .holo-agenda-empty-text {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.24em;
      color: rgba(255, 255, 255, 0.55);
      text-transform: uppercase;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: dayName, kicker, right })}
    ${mainBlock}
    <div class="holo-spacer"></div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('agenda_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

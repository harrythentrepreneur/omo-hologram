// calendar tools — on-demand calendar access for Momo.
// No Google Calendar connector yet — until one lands the EVENTS array
// stays empty and these tools honestly report "no events" rather than
// inventing a schedule.
//
// Every tool puts the full dataset into the id-keyed store and returns
// { id, ...short_summary } — the model reads the summary, narrates, then
// calls render_viz({ data_refs:[id] }). Dataset kinds are chosen so that
// pickChartType (src/kitchen/templates/index.js) routes them cleanly:
//   - kind includes "calendar_event" → event_card
//   - kind includes "calendar_day"   → agenda_card
//   - kind includes "agenda"         → agenda_card

import * as store from '../../store/datasets.js';

const MINUTE = 60 * 1000;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

const EVENTS = [];

// ─── Formatters ───────────────────────────────────────────────────────

function toIso(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// Normalise a calendar row → the shape event_card / agenda_card expect.
function toEventShape(ev) {
  const start = ev.start_ms;
  const end = ev.start_ms + (ev.duration_min || 30) * MINUTE;
  return {
    title: ev.title,
    start: toIso(start),
    end: toIso(end),
    location: ev.location || null,
    online_url: ev.online_url || null,
    attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
    description: ev.description || '',
    organizer: ev.organizer || null,
    calendar: ev.calendar || null,
    // for agenda rows — convenient for the template's attendees_count slot.
    attendees_count: Array.isArray(ev.attendees) ? ev.attendees.length : 0,
  };
}

function isSameDay(aMs, bMs) {
  const a = new Date(aMs); const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

function startOfDayMs(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Short qualitative time-until string: "14 min", "in 2 hr", "tomorrow".
function humanTimeUntil(startMs) {
  const diff = startMs - Date.now();
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / MINUTE);
  if (mins < 60) return `${mins} min away`;
  const hours = Math.round(diff / HOUR);
  if (hours < 24) return `in ~${hours} hr`;
  const days = Math.round(diff / DAY);
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

// "3:00 PM" short clock for summaries.
function clockHM(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ─── get_next_event ───────────────────────────────────────────────────

export const nextEventDefinition = {
  type: 'function',
  name: 'get_next_event',
  description:
    "Look up the user's next upcoming calendar event (the soonest one that hasn't started yet). Returns a dataset id that routes to an event card showing title, time, attendees, location and a short summary. Call this when the user asks 'what's next', 'what's my next meeting', or any single-next-event question.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runNextEvent() {
  const now = Date.now();
  const upcoming = EVENTS
    .filter((e) => e.start_ms > now)
    .sort((a, b) => a.start_ms - b.start_ms);

  if (upcoming.length === 0) {
    return { id: null, summary: 'No upcoming events on the calendar.', none: true };
  }
  const next = upcoming[0];
  const shaped = toEventShape(next);
  const id = store.put('calendar_event', shaped);

  const when = clockHM(next.start_ms);
  const away = humanTimeUntil(next.start_ms);
  const who  = shaped.attendees.length > 0 ? ` with ${shaped.attendees[0].name}` : '';
  const summary = `Next up: ${shaped.title}${who} at ${when}. ${away.charAt(0).toUpperCase() + away.slice(1)}.`;

  return {
    id,
    summary,
    title: shaped.title,
    time: when,
    time_until: away,
    location: shaped.location?.name || null,
    attendees_count: shaped.attendees.length,
  };
}

// ─── get_agenda_today ─────────────────────────────────────────────────

export const agendaTodayDefinition = {
  type: 'function',
  name: 'get_agenda_today',
  description:
    "Fetch today's calendar agenda — every event scheduled for today, in order. Returns a dataset id that routes to an agenda card (time + title rows). Call this for 'what's on today', 'today's schedule', 'am I busy today'.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runAgendaToday() {
  const now = Date.now();
  const todaysEvents = EVENTS
    .filter((e) => isSameDay(e.start_ms, now))
    .sort((a, b) => a.start_ms - b.start_ms);

  const shaped = todaysEvents.map(toEventShape);
  // Total busy hours (for the template's pink "busy" chip).
  const totalMins = todaysEvents.reduce((s, e) => s + (e.duration_min || 0), 0);
  const totalHours = Math.round((totalMins / 60) * 10) / 10;

  const dataset = {
    date: toIso(startOfDayMs(now)),
    events: shaped,
    total_hours: totalHours,
  };
  const id = store.put('calendar_day', dataset);

  if (shaped.length === 0) {
    return { id, summary: "Today's calendar is clear — nothing scheduled.", count: 0, total_hours: 0 };
  }

  const firstTitle = shaped[0].title;
  const firstTime  = clockHM(todaysEvents[0].start_ms);
  const summary = shaped.length === 1
    ? `One event today: ${firstTitle} at ${firstTime}.`
    : `${shaped.length} events today, starting with ${firstTitle} at ${firstTime}. About ${totalHours} hr in meetings.`;

  return {
    id,
    summary,
    count: shaped.length,
    total_hours: totalHours,
    first_title: firstTitle,
    first_time: firstTime,
  };
}

// ─── get_upcoming_events ──────────────────────────────────────────────

export const upcomingEventsDefinition = {
  type: 'function',
  name: 'get_upcoming_events',
  description:
    "Fetch the next few days of calendar events. Pass `days` (default 7, max 30) to pick the window. Returns a dataset id that routes to an agenda card listing each event in time order. Call this for 'what's coming up', 'this week', 'next few days', anything multi-day.",
  parameters: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        description: 'How many days ahead to include (default 7).',
      },
    },
    additionalProperties: false,
  },
};

export async function runUpcomingEvents(args) {
  const days = Math.max(1, Math.min(30, Number(args?.days) || 7));
  const now = Date.now();
  const horizon = now + days * DAY;

  const upcoming = EVENTS
    .filter((e) => e.start_ms > now && e.start_ms <= horizon)
    .sort((a, b) => a.start_ms - b.start_ms);

  const shaped = upcoming.map(toEventShape);
  const totalMins = upcoming.reduce((s, e) => s + (e.duration_min || 0), 0);
  const totalHours = Math.round((totalMins / 60) * 10) / 10;

  const dataset = {
    date: toIso(startOfDayMs(now)),
    events: shaped,
    total_hours: totalHours,
    timeframe: `next ${days} days`,
  };
  const id = store.put('agenda', dataset);

  if (shaped.length === 0) {
    return {
      id, summary: `No events on the calendar for the next ${days} days.`,
      count: 0, days, total_hours: 0,
    };
  }

  const firstTitle = shaped[0].title;
  const firstAway  = humanTimeUntil(upcoming[0].start_ms);
  const summary = `${shaped.length} events over the next ${days} days. Next up: ${firstTitle} (${firstAway}).`;

  return {
    id,
    summary,
    count: shaped.length,
    days,
    total_hours: totalHours,
    first_title: firstTitle,
    first_time_until: firstAway,
  };
}

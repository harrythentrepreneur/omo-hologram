// meeting_notes — structured meeting minutes. Use for "share the notes
// from Tuesday's standup", "recap from the product review".
//
// Data shape:
//   {
//     title,                             // meeting title (required)
//     date?,                             // ISO or pre-formatted
//     duration?,                         // "45 min" OR raw minutes
//     attendees: [{ name, role? }],
//     agenda?: [string],                 // up to 3 rendered
//     decisions?: [string],              // up to 4 rendered
//     action_items?: [{ owner, text, due? }],   // up to 4 rendered
//     notes?                             // freeform summary prose
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, bulletListHTML, personChipHTML,
  timestampHTML, tagHTML,
} from './primitives.js';

const MAX_ATTENDEES = 4;
const MAX_AGENDA = 3;
const MAX_DECISIONS = 4;
const MAX_ACTIONS = 4;

function formatDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

function fmtDuration(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string') return raw.trim().toUpperCase();
  const mins = Number(raw);
  if (!Number.isFinite(mins) || mins <= 0) return '';
  if (mins < 60) return `${Math.round(mins)} MIN`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  return m ? `${h}H ${m}MIN` : `${h}H`;
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

function coercePeople(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  return raw.map(coercePerson).filter(Boolean);
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

function coerceActionItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    if (!a) return null;
    if (typeof a === 'string') return { owner: '', text: a, due: '' };
    const owner = typeof a.owner === 'string'
      ? a.owner.trim()
      : (a.owner?.name || a.owner?.display_name || '').trim();
    const text = String(a.text || a.task || a.item || '').trim();
    if (!text) return null;
    return { owner, text, due: String(a.due || '').trim() };
  }).filter(Boolean);
}

function coerceMeeting(data) {
  if (!data) return null;
  const title = String(data.title || data.subject || '').trim();
  if (!title) return null;
  return {
    title,
    date: formatDate(data.date || data.when || data.start_at),
    duration: fmtDuration(data.duration || data.duration_min || data.length),
    attendees: coercePeople(data.attendees || data.participants),
    agenda: Array.isArray(data.agenda) ? data.agenda.filter(Boolean).map(String) : [],
    decisions: Array.isArray(data.decisions) ? data.decisions.filter(Boolean).map(String) : [],
    actionItems: coerceActionItems(data.action_items || data.actions || data.todos),
    notes: String(data.notes || data.summary || '').trim(),
  };
}

export function meetingNotesTemplate({ dataset, intent }) {
  const meeting = coerceMeeting(dataset?.data);
  if (!meeting) {
    return { body: emptyStateBody(intent, 'Need a meeting object with a title.'), exposedData: {}, needsEcharts: false };
  }

  const titleDisplay = titleText(meeting.title, 'MEETING');
  const kicker = meeting.date
    ? `MEETING NOTES · ${meeting.date}`
    : 'MEETING NOTES';
  const right = meeting.duration
    ? timestampHTML({ text: meeting.duration, tone: 'default' })
    : '';

  // Attendees row
  const visibleAttendees = meeting.attendees.slice(0, MAX_ATTENDEES);
  const extraAttendees = meeting.attendees.length - visibleAttendees.length;
  const attendeesMarkup = meeting.attendees.length
    ? `<div class="holo-row holo-row--wrap holo-meeting-attendees">
         ${visibleAttendees.map((p) => personChipHTML({ name: p.name, role: p.role || '', size: 'sm' })).join('')}
         ${extraAttendees > 0 ? tagHTML({ label: `+${extraAttendees} MORE`, tone: 'muted' }) : ''}
       </div>`
    : '';

  const notesMarkup = meeting.notes
    ? `<div class="holo-body holo-body--muted holo-meeting-notes">${escapeHtml(truncate(meeting.notes, 200))}</div>`
    : '';

  // Agenda (optional, above two-col)
  let agendaMarkup = '';
  if (meeting.agenda.length) {
    const items = meeting.agenda.slice(0, MAX_AGENDA).map((a) => truncate(a, 80));
    agendaMarkup = `<div class="holo-meeting-agenda">
      ${sectionHeadingHTML({ label: 'AGENDA', tone: 'muted' })}
      ${bulletListHTML({ items, marker: 'arrow' })}
    </div>`;
  }

  // Two-col: decisions (left) | action items (right)
  const visibleDecisions = meeting.decisions.slice(0, MAX_DECISIONS).map((d) => truncate(d, 80));
  const extraDecisions = Math.max(0, meeting.decisions.length - visibleDecisions.length);
  const decisionsMarkup = `<div class="holo-meeting-col">
    ${sectionHeadingHTML({ label: 'DECISIONS', tone: 'cyan' })}
    ${visibleDecisions.length
      ? bulletListHTML({ items: visibleDecisions, marker: 'check' })
      : '<div class="holo-body holo-body--muted" style="font-size:12px;">No decisions logged.</div>'}
    ${extraDecisions > 0 ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${extraDecisions} more</div>` : ''}
  </div>`;

  const visibleActions = meeting.actionItems.slice(0, MAX_ACTIONS);
  const extraActions = Math.max(0, meeting.actionItems.length - visibleActions.length);
  const actionItemsMarkup = `<div class="holo-meeting-col">
    ${sectionHeadingHTML({ label: 'ACTION ITEMS', tone: 'pink' })}
    ${visibleActions.length
      ? `<ul class="holo-action-list">${visibleActions.map((a) => {
          const owner = a.owner ? `<span class="holo-action-owner">${escapeHtml(truncate(a.owner, 18))}</span>` : '';
          const due = a.due ? `<span class="holo-action-due">${escapeHtml(a.due)}</span>` : '';
          return `<li class="holo-action-row">
            <span class="holo-action-arrow">→</span>
            <span class="holo-action-main">
              ${owner}
              <span class="holo-action-text">${escapeHtml(truncate(a.text, 70))}</span>
            </span>
            ${due}
          </li>`;
        }).join('')}</ul>`
      : '<div class="holo-body holo-body--muted" style="font-size:12px;">No action items.</div>'}
    ${extraActions > 0 ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${extraActions} more</div>` : ''}
  </div>`;

  const twoColMarkup = `<div class="holo-two-col holo-meeting-grid">
    ${decisionsMarkup}
    ${actionItemsMarkup}
  </div>`;

  const body = `<div id="viz">
  <style>
    .holo-meeting-attendees { gap: 10px 14px; }
    .holo-meeting-notes { font-size: 12px; }
    .holo-meeting-agenda .holo-list { margin-top: 2px; }
    .holo-meeting-agenda .holo-li { font-size: 12px; margin: 2px 0; }
    .holo-meeting-grid { gap: 18px; align-items: start; }
    .holo-meeting-col { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .holo-meeting-col .holo-list { margin: 2px 0; }
    .holo-meeting-col .holo-li { font-size: 12px; margin: 3px 0; line-height: 1.4; }
    .holo-action-list {
      list-style: none; margin: 4px 0; padding: 0;
      display: flex; flex-direction: column; gap: 5px;
    }
    .holo-action-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 6px;
      align-items: baseline;
      font-family: "SF Pro Text", system-ui, sans-serif;
      font-size: 12px;
      line-height: 1.4;
    }
    .holo-action-arrow {
      color: #00e5ff;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.55);
    }
    .holo-action-main { min-width: 0; }
    .holo-action-owner {
      color: #00e5ff;
      font-weight: 600;
      font-size: 11.5px;
      text-shadow: 0 0 5px rgba(0, 229, 255, 0.35);
      margin-right: 5px;
    }
    .holo-action-owner::after { content: ':'; color: rgba(255,255,255,0.45); margin-left: 1px; }
    .holo-action-text { color: rgba(255, 255, 255, 0.9); }
    .holo-action-due {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      color: rgba(255, 102, 179, 0.9);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      white-space: nowrap;
    }
  </style>
  <div class="holo-stack holo-stack--sm" style="height:100%;">
    ${cardHeaderHTML({ title: titleDisplay, kicker, right })}
    ${attendeesMarkup}
    ${notesMarkup}
    ${agendaMarkup}
    ${twoColMarkup}
    <div class="holo-spacer"></div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('meeting_notes: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

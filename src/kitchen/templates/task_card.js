// task_card — a single to-do: title, priority, due, subtasks, notes, tags.
// Text-card sibling of email_card / event_card; no ECharts.
//
// Data shape (all optional except `title`):
//   {
//     title,
//     done?: boolean,
//     due?,                              // ISO datetime
//     priority: 'p0'|'p1'|'p2'|'p3' | 'low'|'med'|'high',
//     subtasks?: [{ label, done? }],
//     notes?,                            // plain text
//     tags?: [string],
//     assigned?: { name, email? },
//     effort?                            // "30m" / "2h" — pre-formatted
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, tagHTML, iconHTML, progressBarHTML,
} from './primitives.js';

function coerceTask(data) {
  if (!data) return null;
  const title = String(data.title || data.name || '').trim();
  if (!title) return null;
  return {
    title,
    done: !!data.done,
    due: data.due || data.due_at || null,
    priority: data.priority || null,
    subtasks: Array.isArray(data.subtasks)
      ? data.subtasks.filter(Boolean).map((s) => (typeof s === 'string'
          ? { label: s, done: false }
          : { label: String(s.label || s.title || '—'), done: !!s.done }))
      : [],
    notes: String(data.notes || '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.filter(Boolean).map(String) : [],
    assigned: data.assigned ? {
      name: data.assigned.name || data.assigned.email || '',
      email: data.assigned.email || null,
    } : null,
    effort: data.effort ? String(data.effort) : null,
  };
}

// Normalise priority → { label, tone }.
function priorityMeta(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return null;
  switch (s) {
    case 'p0': case 'high':  return { label: s.toUpperCase(), tone: 'pink'  };
    case 'p1': case 'med':
    case 'medium':           return { label: s === 'medium' ? 'MED' : s.toUpperCase(), tone: 'cyan' };
    case 'p2': case 'low':   return { label: s.toUpperCase(), tone: 'muted' };
    case 'p3':               return { label: 'P3',            tone: 'muted' };
    default:                 return { label: s.toUpperCase(), tone: 'muted' };
  }
}

// "APR 24" / "APR 24 · 2:00 PM" / "Today"
function formatDue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // If time portion is midnight-ish, just say "Today"
    if (d.getHours() === 0 && d.getMinutes() === 0) return 'Today';
    return `Today · ${t}`;
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function taskCardTemplate({ dataset, intent }) {
  const t = coerceTask(dataset?.data);
  if (!t) {
    return { body: emptyStateBody(intent, 'Need a task with a title.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'TASK');

  const pri = priorityMeta(t.priority);
  const kicker = pri ? `TASK · ${pri.label}` : 'TASK';

  // Right slot: big cyan check when done, else priority tag.
  let right;
  if (t.done) {
    right = `<span class="holo-task-check">${iconHTML({ name: 'check' })}</span>`;
  } else if (pri) {
    right = tagHTML({ label: pri.label, tone: pri.tone });
  } else {
    right = '';
  }

  // Meta row — due, effort, assigned (only present fields).
  const metaItems = [];
  if (t.due) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'calendar', inline: true })}${escapeHtml(formatDue(t.due))}</span>`);
  }
  if (t.effort) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'clock', inline: true })}${escapeHtml(t.effort)}</span>`);
  }
  if (t.assigned?.name) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'user', inline: true })}${escapeHtml(t.assigned.name)}</span>`);
  }
  const metaRow = metaItems.length
    ? `<div class="holo-meta-row">${metaItems.join('')}</div>`
    : '';

  // Subtasks — custom list (can't pass "done" tone through bulletListHTML).
  let subList = '';
  let progressBar = '';
  if (t.subtasks.length) {
    const doneCount = t.subtasks.filter((s) => s.done).length;
    const pct = Math.round((doneCount / t.subtasks.length) * 100);
    const items = t.subtasks.slice(0, 8).map((s) => {
      const cls = s.done ? 'holo-task-sub holo-task-sub--done' : 'holo-task-sub';
      return `<li class="${cls}">
        <span class="holo-task-sub-box" aria-hidden="true"></span>
        <span class="holo-task-sub-label">${escapeHtml(s.label)}</span>
      </li>`;
    }).join('');
    const more = t.subtasks.length > 8
      ? `<li class="holo-task-sub holo-task-sub--more">+ ${t.subtasks.length - 8} more</li>`
      : '';
    subList = `<ul class="holo-task-subs">${items}${more}</ul>`;
    progressBar = progressBarHTML({ id: 'task-progress', label: 'PROGRESS', pct });
  }

  const notesMarkup = t.notes
    ? `<div class="holo-body holo-body--muted">${escapeHtml(truncate(t.notes, 200))}</div>`
    : '';

  const tagRow = t.tags.length
    ? `<div class="holo-tag-row">${t.tags.slice(0, 5).map((lbl) => tagHTML({ label: lbl, tone: 'muted' })).join('')}</div>`
    : '';

  const headerWrapClass = t.done ? 'holo-task-done' : '';

  const body = `<div id="viz">
  <style>
    .holo-task-done .holo-card-title {
      text-decoration: line-through;
      opacity: 0.55;
    }
    .holo-task-check {
      display: inline-flex;
      align-items: center; justify-content: center;
      width: 34px; height: 34px;
      border-radius: 50%;
      color: #5effc1;
      background: rgba(94, 255, 193, 0.10);
      border: 1px solid rgba(94, 255, 193, 0.45);
      box-shadow: 0 0 12px rgba(94, 255, 193, 0.4);
    }
    .holo-task-check .holo-icon { color: #5effc1; filter: drop-shadow(0 0 4px rgba(94, 255, 193, 0.55)); }

    .holo-task-subs {
      list-style: none;
      margin: 4px 0;
      padding: 0;
      display: flex; flex-direction: column;
      gap: 4px;
      font-family: "SF Pro Text", system-ui, sans-serif;
    }
    .holo-task-sub {
      display: flex; align-items: center; gap: 8px;
      font-size: 12.5px;
      line-height: 1.4;
      color: rgba(255, 255, 255, 0.88);
    }
    .holo-task-sub-box {
      width: 10px; height: 10px;
      border-radius: 2px;
      border: 1px solid rgba(0, 229, 255, 0.55);
      background: transparent;
      flex: 0 0 auto;
      box-shadow: 0 0 4px rgba(0, 229, 255, 0.25);
    }
    .holo-task-sub--done .holo-task-sub-box {
      background: #00e5ff;
      border-color: #00e5ff;
      box-shadow: 0 0 6px rgba(0, 229, 255, 0.7);
      position: relative;
    }
    .holo-task-sub--done .holo-task-sub-box::after {
      content: '';
      position: absolute;
      left: 2px; top: 0px;
      width: 3px; height: 6px;
      border-right: 1.5px solid #021014;
      border-bottom: 1.5px solid #021014;
      transform: rotate(45deg);
    }
    .holo-task-sub--done .holo-task-sub-label {
      text-decoration: line-through;
      color: rgba(255, 255, 255, 0.45);
    }
    .holo-task-sub--more {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.14em;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      padding-left: 18px;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    <div class="${headerWrapClass}">
      ${cardHeaderHTML({ title: t.title, kicker, right })}
    </div>
    ${metaRow}
    ${subList}
    ${progressBar}
    ${notesMarkup}
    <div class="holo-spacer"></div>
    ${tagRow}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('task_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

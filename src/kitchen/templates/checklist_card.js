// checklist_card — a multi-item checklist with progress percentage.
// Text-card sibling of task_card; emphasises completion ratio + items.
//
// Data shape (all optional except `title` and a non-empty `items`):
//   {
//     title,
//     items: [{ label, done? }],
//     note?,                    // small blurb above the list
//     deadline?                 // ISO datetime — shown in footer
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, timestampHTML, iconHTML, progressBarHTML,
} from './primitives.js';

function coerceChecklist(data) {
  if (!data) return null;
  const title = String(data.title || data.name || '').trim();
  const items = Array.isArray(data.items)
    ? data.items.filter(Boolean).map((it) => (typeof it === 'string'
        ? { label: it, done: false }
        : { label: String(it.label || it.title || '—'), done: !!it.done }))
    : [];
  if (!title && items.length === 0) return null;
  return {
    title: title || 'CHECKLIST',
    items,
    note: String(data.note || '').trim(),
    deadline: data.deadline || null,
  };
}

// "By APR 24" / "By APR 24 · 5:00 PM" — raw fallback on parse fail.
function formatDeadline(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  // Only show time if it's not midnight (which typically indicates date-only).
  if (d.getHours() === 0 && d.getMinutes() === 0) return date;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

export function checklistCardTemplate({ dataset, intent }) {
  const c = coerceChecklist(dataset?.data);
  if (!c) {
    return { body: emptyStateBody(intent, 'Need a checklist with items.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'CHECKLIST');

  const total = c.items.length;
  const done  = c.items.filter((i) => i.done).length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const isComplete = total > 0 && done === total;

  const kicker = total > 0
    ? `CHECKLIST · ${done}/${total} DONE`
    : 'CHECKLIST';

  // Right slot: percent chip. Celebrate with a check icon when 100%.
  let right;
  if (total === 0) {
    right = '';
  } else if (isComplete) {
    right = `<span class="holo-ck-complete">
      ${iconHTML({ name: 'check', inline: true })}
      ${timestampHTML({ text: '100%', tone: 'accent' })}
    </span>`;
  } else {
    right = timestampHTML({ text: `${pct}%`, tone: 'default' });
  }

  const noteMarkup = c.note
    ? `<div class="holo-body holo-body--muted">${escapeHtml(c.note)}</div>`
    : '';

  // Items list. Custom UL so we control the checkbox glyph per-item.
  let itemsMarkup = '';
  if (c.items.length) {
    const shown = c.items.slice(0, 10);
    const extra = c.items.length - shown.length;
    const lis = shown.map((it) => {
      const cls = it.done ? 'holo-ck-item holo-ck-item--done' : 'holo-ck-item';
      return `<li class="${cls}">
        <span class="holo-ck-box" aria-hidden="true"></span>
        <span class="holo-ck-label">${escapeHtml(it.label)}</span>
      </li>`;
    }).join('');
    const moreLi = extra > 0
      ? `<li class="holo-ck-more">+ ${extra} more</li>`
      : '';
    itemsMarkup = `<ul class="holo-ck-list">${lis}${moreLi}</ul>`;
  }

  const progress = total > 0
    ? progressBarHTML({ id: 'ck-progress', label: 'COMPLETE', pct, tone: 'cyan' })
    : '';

  const deadlineFooter = c.deadline
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">
         ${iconHTML({ name: 'clock', inline: true })} By ${escapeHtml(formatDeadline(c.deadline))}
       </div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-ck-complete {
      display: inline-flex; align-items: center; gap: 6px;
      color: #ff66b3;
      filter: drop-shadow(0 0 6px rgba(255, 102, 179, 0.5));
    }
    .holo-ck-complete .holo-icon { color: #ff66b3; }

    .holo-ck-list {
      list-style: none;
      margin: 4px 0;
      padding: 0;
      display: flex; flex-direction: column;
      gap: 6px;
      font-family: "SF Pro Text", system-ui, sans-serif;
    }
    .holo-ck-item {
      display: flex; align-items: center; gap: 10px;
      font-size: 13px;
      line-height: 1.4;
      color: rgba(255, 255, 255, 0.9);
    }
    .holo-ck-box {
      width: 14px; height: 14px;
      border-radius: 3px;
      border: 1px solid rgba(0, 229, 255, 0.55);
      background: transparent;
      flex: 0 0 auto;
      box-shadow: 0 0 5px rgba(0, 229, 255, 0.25);
      position: relative;
    }
    .holo-ck-item--done .holo-ck-box {
      background: #00e5ff;
      border-color: #00e5ff;
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.7);
    }
    .holo-ck-item--done .holo-ck-box::after {
      content: '';
      position: absolute;
      left: 4px; top: 1px;
      width: 4px; height: 8px;
      border-right: 2px solid #021014;
      border-bottom: 2px solid #021014;
      transform: rotate(45deg);
    }
    .holo-ck-item--done {
      opacity: 0.5;
    }
    .holo-ck-item--done .holo-ck-label {
      text-decoration: line-through;
    }
    .holo-ck-more {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.16em;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      padding-left: 24px;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: c.title, kicker, right })}
    ${noteMarkup}
    ${itemsMarkup}
    ${progress}
    <div class="holo-spacer"></div>
    ${deadlineFooter}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('checklist_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

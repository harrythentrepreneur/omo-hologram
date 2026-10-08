// notification_card — a stack of recent notifications (the larger sibling
// of `notification_pill`, which is a single ambient toast). Renders up
// to 6 items; each row has a source glyph, title, one-line body, and a
// right-aligned timestamp.
//
// Data shape:
//   { items: [{ source, title, body, time }] }
//
// Pure-HTML card — no ECharts. `source` drives an icon choice from a
// small map (email/slack/stripe/calendar/system → named primitives
// icons). Unknown sources fall back to the bell glyph.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import { cardHeaderHTML, iconHTML } from './primitives.js';

const MAX_ITEMS = 6;

// Source → primitive icon name. Keep this curated — the icon set is tiny.
const SOURCE_ICON = {
  email:    'mail',
  gmail:    'mail',
  mail:     'mail',
  slack:    'hashtag',
  message:  'hashtag',
  chat:     'hashtag',
  stripe:   'money',
  payment:  'money',
  payout:   'money',
  calendar: 'calendar',
  meeting:  'calendar',
  event:    'calendar',
  phone:    'phone',
  call:     'phone',
  system:   'bolt',
  warning:  'warning',
  alert:    'warning',
  file:     'file',
  drive:    'file',
};

function pickIcon(source) {
  if (!source) return 'circle';
  const key = String(source).toLowerCase();
  return SOURCE_ICON[key] || 'circle';
}

function coerceNotifications(data) {
  if (!data) return null;
  const raw = Array.isArray(data.items) ? data.items
            : Array.isArray(data.notifications) ? data.notifications
            : Array.isArray(data) ? data
            : null;
  if (!raw || !raw.length) return null;
  const items = raw.map((n) => ({
    source: n?.source != null ? String(n.source).trim() : '',
    title:  String(n?.title || n?.subject || '').trim(),
    body:   String(n?.body || n?.detail || n?.preview || '').trim(),
    time:   String(n?.time || n?.ts || n?.timestamp || '').trim(),
  })).filter((n) => n.title || n.body);
  return items.length ? items : null;
}

export function notificationCardTemplate({ dataset, intent }) {
  const items = coerceNotifications(dataset?.data);
  if (!items) return { body: emptyStateBody(intent, 'Need a notifications list.'), exposedData: {}, needsEcharts: false };

  const title = titleText(intent, 'NOTIFICATIONS');
  const shown = items.slice(0, MAX_ITEMS);
  const extra = items.length - shown.length;
  const kicker = `${items.length} RECENT`;

  const rows = shown.map((n) => {
    const iconName = pickIcon(n.source);
    const sourceBadge = n.source
      ? `<span class="holo-nc-source">${escapeHtml(n.source.toUpperCase())}</span>`
      : '';
    return `<li class="holo-nc-row">
      <div class="holo-nc-icon">${iconHTML({ name: iconName })}</div>
      <div class="holo-nc-main">
        <div class="holo-nc-top">
          ${sourceBadge}
          ${n.time ? `<span class="holo-nc-time">${escapeHtml(n.time)}</span>` : ''}
        </div>
        ${n.title ? `<div class="holo-nc-title">${escapeHtml(n.title)}</div>` : ''}
        ${n.body ? `<div class="holo-nc-body">${escapeHtml(n.body)}</div>` : ''}
      </div>
    </li>`;
  }).join('');

  const footer = extra > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${extra} older</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-nc {
      list-style: none; padding: 0; margin: 0;
      display: flex; flex-direction: column;
      gap: 8px;
      min-height: 0;
      overflow: hidden;
    }
    .holo-nc-row {
      display: grid;
      grid-template-columns: 34px 1fr;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px dashed rgba(0, 229, 255, 0.1);
      min-width: 0;
    }
    .holo-nc-row:last-child { border-bottom: none; }
    .holo-nc-icon {
      width: 28px; height: 28px;
      display: inline-flex;
      align-items: center; justify-content: center;
      border-radius: 8px;
      background: rgba(0, 229, 255, 0.08);
      border: 1px solid rgba(0, 229, 255, 0.34);
      color: #00e5ff;
      flex: 0 0 auto;
    }
    .holo-nc-icon .holo-icon { width: 14px; height: 14px; }
    .holo-nc-main { min-width: 0; }
    .holo-nc-top {
      display: flex; align-items: baseline; gap: 10px;
      justify-content: space-between;
      min-width: 0;
    }
    .holo-nc-source {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.2em;
      color: rgba(0, 229, 255, 0.75);
      text-transform: uppercase;
      white-space: nowrap;
    }
    .holo-nc-time {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.12em;
      color: rgba(255, 255, 255, 0.5);
      text-transform: uppercase;
      white-space: nowrap;
    }
    .holo-nc-title {
      font-size: 13px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.95);
      line-height: 1.3;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-nc-body {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.35;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker })}
    <ul class="holo-nc">${rows}</ul>
    <div class="holo-spacer"></div>
    ${footer}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('notification_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

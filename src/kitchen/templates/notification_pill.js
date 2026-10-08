// notification_pill — the ambient glance card. Slides in, lives briefly,
// slides out. The visual shape is a compact horizontal pill: left icon
// badge, stacked title + detail, right-side accent glow. Paired with the
// `notification` projectable on the client, which owns the enter/exit
// choreography (offscreen-right → perch → offscreen-right).
//
// Data shape:
//   {
//     icon:   'email'|'bell'|'check'|'warn',   // default 'bell'
//     title,                                   // short uppercase-ish label
//     detail,                                  // one-line context
//     accent: 'cyan'|'pink'|'amber',           // default 'cyan'
//   }
//
// Pure text card — no ECharts, no runtime math.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';

const ACCENTS = new Set(['cyan', 'pink', 'amber']);
const ICONS = new Set(['email', 'bell', 'check', 'warn']);

function iconSvg(name) {
  switch (name) {
    case 'email':
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l8 6 8-6M4 7v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7"/></svg>';
    case 'check':
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    case 'warn':
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';
    case 'bell':
    default:
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>';
  }
}

function coerce(data) {
  if (!data) return null;
  const title  = String(data.title  || '').trim();
  const detail = String(data.detail || '').trim();
  if (!title && !detail) return null;
  const icon   = ICONS.has(data.icon)  ? data.icon  : 'bell';
  const accent = ACCENTS.has(data.accent) ? data.accent : 'cyan';
  return { title, detail, icon, accent };
}

export function notificationPillTemplate({ dataset, intent }) {
  const n = coerce(dataset?.data);
  if (!n) {
    return { body: emptyStateBody(intent, 'Need a notification title or detail.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'NOTIFICATION');

  const body = `<div id="viz" class="holo-note holo-note--${n.accent}">
  <style>
    .holo-note {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      height: 100%;
      padding: 12px 16px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, sans-serif;
    }
    .holo-note-icon {
      flex: 0 0 auto;
      width: 36px; height: 36px;
      display: inline-flex;
      align-items: center; justify-content: center;
      border-radius: 10px;
      background: rgba(0, 229, 255, 0.10);
      border: 1px solid rgba(0, 229, 255, 0.38);
      color: #00e5ff;
      box-shadow: 0 0 0 1px rgba(0, 229, 255, 0.05), 0 0 10px rgba(0, 229, 255, 0.25) inset;
    }
    .holo-note-icon svg { filter: drop-shadow(0 0 4px currentColor); }
    .holo-note-main {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1 1 auto;
      gap: 2px;
    }
    .holo-note-title {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: #00e5ff;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.5);
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-note-detail {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.92);
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-note-rail {
      position: absolute;
      top: 10%; bottom: 10%;
      right: 6px;
      width: 2px;
      border-radius: 1px;
      background: linear-gradient(180deg, rgba(0,229,255,0), #00e5ff 50%, rgba(0,229,255,0));
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.8);
      opacity: 0.85;
    }
    .holo-note--pink .holo-note-icon {
      color: #ff66b3;
      background: rgba(255, 102, 179, 0.10);
      border-color: rgba(255, 102, 179, 0.38);
      box-shadow: 0 0 0 1px rgba(255, 102, 179, 0.05), 0 0 10px rgba(255, 102, 179, 0.25) inset;
    }
    .holo-note--pink .holo-note-title {
      color: #ff66b3;
      text-shadow: 0 0 6px rgba(255, 102, 179, 0.5);
    }
    .holo-note--pink .holo-note-rail {
      background: linear-gradient(180deg, rgba(255,102,179,0), #ff66b3 50%, rgba(255,102,179,0));
      box-shadow: 0 0 8px rgba(255, 102, 179, 0.8);
    }
    .holo-note--amber .holo-note-icon {
      color: #ffcf66;
      background: rgba(255, 207, 102, 0.10);
      border-color: rgba(255, 207, 102, 0.38);
      box-shadow: 0 0 0 1px rgba(255, 207, 102, 0.05), 0 0 10px rgba(255, 207, 102, 0.25) inset;
    }
    .holo-note--amber .holo-note-title {
      color: #ffcf66;
      text-shadow: 0 0 6px rgba(255, 207, 102, 0.55);
    }
    .holo-note--amber .holo-note-rail {
      background: linear-gradient(180deg, rgba(255,207,102,0), #ffcf66 50%, rgba(255,207,102,0));
      box-shadow: 0 0 8px rgba(255, 207, 102, 0.85);
    }
  </style>
  <div class="holo-note-icon">${iconSvg(n.icon)}</div>
  <div class="holo-note-main">
    <div class="holo-note-title">${escapeHtml(n.title || 'NOTIFICATION')}</div>
    <div class="holo-note-detail">${escapeHtml(n.detail)}</div>
  </div>
  <div class="holo-note-rail"></div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('notification_pill: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

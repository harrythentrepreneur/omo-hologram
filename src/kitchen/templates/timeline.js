// timeline — vertical event list. Cyan thread-spine on the left, each
// event a dot at its own time marker with a title and optional source
// tag or icon. Reads top-down (earliest to latest by default).
//
// Data shape:
//   { events: [{ time, label, source?, icon? }] }
// `time` is free-form text (any ISO / "9:42 AM" / "2d ago" — we render it
// verbatim). `icon` is an optional icon name from the primitive ICON_SET;
// default is a cyan dot.
//
// Pure-HTML card — no ECharts. Up to 8 events fit comfortably on the wide
// card; extras show a "+N earlier" footer.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import { cardHeaderHTML, iconHTML, tagHTML, ICON_NAMES } from './primitives.js';

const MAX_EVENTS = 8;

function coerceTimeline(data) {
  if (!data) return null;
  const raw = Array.isArray(data.events) ? data.events
            : Array.isArray(data.items)  ? data.items
            : Array.isArray(data)        ? data
            : null;
  if (!raw || !raw.length) return null;
  const events = raw.map((e) => ({
    time: String(e?.time || e?.ts || e?.timestamp || '').trim(),
    label: String(e?.label || e?.title || e?.text || '').trim(),
    source: e?.source != null ? String(e.source).trim() : null,
    icon: ICON_NAMES.includes(e?.icon) ? e.icon : null,
  })).filter((e) => e.label || e.time);
  return events.length ? events : null;
}

export function timelineTemplate({ dataset, intent }) {
  const events = coerceTimeline(dataset?.data);
  if (!events) return { body: emptyStateBody(intent, 'Need an events list.'), exposedData: {}, needsEcharts: false };

  const title = titleText(intent, 'TIMELINE');
  const kicker = `TIMELINE · ${events.length} EVENT${events.length === 1 ? '' : 'S'}`;

  const shown = events.slice(0, MAX_EVENTS);
  const extra = events.length - shown.length;

  const rows = shown.map((e) => {
    const marker = e.icon
      ? `<span class="holo-tl-icon">${iconHTML({ name: e.icon })}</span>`
      : `<span class="holo-tl-dot"></span>`;
    const sourceMarkup = e.source ? tagHTML({ label: e.source, tone: 'muted' }) : '';
    return `<li class="holo-tl-row">
      <div class="holo-tl-time">${escapeHtml(e.time)}</div>
      <div class="holo-tl-marker">${marker}</div>
      <div class="holo-tl-main">
        <div class="holo-tl-label">${escapeHtml(e.label)}</div>
        ${sourceMarkup ? `<div class="holo-tl-source">${sourceMarkup}</div>` : ''}
      </div>
    </li>`;
  }).join('');

  const footer = extra > 0
    ? `<div class="holo-body holo-body--muted" style="padding-left:96px;font-size:11px;">+ ${extra} earlier</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-tl {
      list-style: none;
      padding: 0; margin: 0;
      display: flex; flex-direction: column;
      gap: 10px;
      position: relative;
    }
    /* The cyan spine rides along the marker column. */
    .holo-tl::before {
      content: "";
      position: absolute;
      left: 88px;
      top: 6px;
      bottom: 6px;
      width: 1px;
      background: linear-gradient(180deg, rgba(0,229,255,0.1), rgba(0,229,255,0.45) 50%, rgba(0,229,255,0.1));
      box-shadow: 0 0 6px rgba(0, 229, 255, 0.35);
    }
    .holo-tl-row {
      display: grid;
      grid-template-columns: 72px 32px 1fr;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }
    .holo-tl-time {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.15em;
      color: rgba(255, 255, 255, 0.55);
      text-transform: uppercase;
      text-align: right;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-tl-marker {
      display: flex; align-items: center; justify-content: center;
      position: relative;
      height: 14px;
    }
    .holo-tl-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #00e5ff;
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.75), 0 0 0 2px rgba(0, 0, 0, 0.6);
      display: inline-block;
    }
    .holo-tl-icon {
      display: inline-flex;
      width: 20px; height: 20px;
      align-items: center; justify-content: center;
      border-radius: 50%;
      background: rgba(0, 229, 255, 0.08);
      border: 1px solid rgba(0, 229, 255, 0.38);
      color: #00e5ff;
    }
    .holo-tl-icon .holo-icon { width: 12px; height: 12px; }
    .holo-tl-main { min-width: 0; }
    .holo-tl-label {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.94);
      line-height: 1.3;
      word-break: break-word;
    }
    .holo-tl-source { margin-top: 4px; }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker })}
    <ol class="holo-tl">${rows}</ol>
    <div class="holo-spacer"></div>
    ${footer}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('timeline: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

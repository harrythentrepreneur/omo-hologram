// report_card — a structured executive report projected as a single
// 720×420 card. Use for "give me a write-up on X", "weekly report",
// "post-mortem". Multi-section long-form content.
//
// Data shape (all fields optional except `title`):
//   {
//     title,                         // report title (hero line)
//     kicker?,                       // "WEEKLY REPORT · WK 17"
//     author?:   { name, role? } | string
//     published?,                    // ISO or pre-formatted
//     tldr,                          // 1–2 sentence hero summary
//     sections: [{                   // 2–4 sections typical
//       heading,                     // uppercase short label
//       body?,                       // one short paragraph
//       bullets?: [string]           // OR 3–6 bullets
//     }],
//     recommendation?,               // optional closing callout (string)
//     tags?: [string]
//   }
//
// This is a TEXT CARD: no ECharts, no data-vis math. Only the first three
// sections render — overflow becomes a muted "+ N more sections" line.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, bulletListHTML, calloutHTML,
  personChipHTML, timestampHTML, tagHTML,
} from './primitives.js';

const MAX_SECTIONS = 3;
const MAX_BULLETS_PER_SECTION = 4;

function formatDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function coercePerson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    return { name: s, role: null };
  }
  const name = raw.name || raw.display_name || raw.author || '';
  if (!name) return null;
  return { name: String(name), role: raw.role || raw.title || null };
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

function coerceReport(data) {
  if (!data) return null;
  const title = String(data.title || '').trim();
  if (!title) return null;

  const sectionsRaw = Array.isArray(data.sections) ? data.sections : [];
  const sections = sectionsRaw.map((s) => {
    if (!s) return null;
    const heading = String(s.heading || s.label || s.title || '').trim();
    if (!heading) return null;
    const bullets = Array.isArray(s.bullets) ? s.bullets.filter(Boolean).map(String) : [];
    const body = String(s.body || s.text || '').trim();
    return { heading, body, bullets };
  }).filter(Boolean);

  return {
    title,
    kicker: String(data.kicker || '').trim(),
    author: coercePerson(data.author || data.by),
    published: formatDate(data.published || data.date || data.published_at),
    tldr: String(data.tldr || data.summary || data.tl_dr || '').trim(),
    sections,
    recommendation: String(data.recommendation || data.next_steps || '').trim(),
    tags: Array.isArray(data.tags) ? data.tags.filter(Boolean).map(String) : [],
  };
}

export function reportCardTemplate({ dataset, intent }) {
  const report = coerceReport(dataset?.data);
  if (!report) {
    return { body: emptyStateBody(intent, 'Need a report object with a title.'), exposedData: {}, needsEcharts: false };
  }

  const titleDisplay = titleText(report.title, 'REPORT');
  const kicker = report.kicker || 'REPORT';
  const right = report.published
    ? timestampHTML({ text: report.published, tone: 'muted' })
    : '';

  const bylineMarkup = report.author
    ? `<div class="holo-report-byline">${personChipHTML({
        name: report.author.name,
        role: report.author.role || '',
        size: 'sm',
      })}</div>`
    : '';

  const tldrMarkup = report.tldr
    ? `<div class="holo-body holo-body--lg holo-report-tldr">${escapeHtml(truncate(report.tldr, 220))}</div>`
    : '';

  const visibleSections = report.sections.slice(0, MAX_SECTIONS);
  const overflowSections = Math.max(0, report.sections.length - visibleSections.length);

  const sectionsMarkup = visibleSections.map((sec, i) => {
    // Alternate cyan/muted tones for rhythm across a long card
    const tone = i === 1 ? 'muted' : 'cyan';
    const heading = sectionHeadingHTML({ label: truncate(sec.heading, 28), tone });
    let bodyMarkup = '';
    if (sec.bullets && sec.bullets.length) {
      const bullets = sec.bullets.slice(0, MAX_BULLETS_PER_SECTION).map((b) => truncate(b, 140));
      bodyMarkup = bulletListHTML({ items: bullets, marker: 'arrow' });
    } else if (sec.body) {
      bodyMarkup = `<div class="holo-body">${escapeHtml(truncate(sec.body, 240))}</div>`;
    }
    return `<div class="holo-report-section">${heading}${bodyMarkup}</div>`;
  }).join('');

  const overflowMarkup = overflowSections > 0
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${overflowSections} more section${overflowSections === 1 ? '' : 's'}</div>`
    : '';

  const recommendationMarkup = report.recommendation
    ? calloutHTML({
        kind: 'good',
        title: 'RECOMMENDATION',
        body: truncate(report.recommendation, 200),
      })
    : '';

  const tagsMarkup = report.tags.length
    ? `<div class="holo-tag-row holo-report-tags">${
        report.tags.slice(0, 5).map((t) => tagHTML({ label: t, tone: 'muted' })).join('')
      }</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-report-byline { margin: 2px 0 2px 0; }
    .holo-report-tldr {
      padding: 8px 10px;
      border-left: 2px solid rgba(0, 229, 255, 0.45);
      background: rgba(0, 229, 255, 0.04);
      border-radius: 0 6px 6px 0;
    }
    .holo-report-section { display: flex; flex-direction: column; gap: 2px; }
    .holo-report-section + .holo-report-section { margin-top: 2px; }
    .holo-report-section .holo-list { margin: 2px 0 0 0; }
    .holo-report-section .holo-li { font-size: 12px; margin: 2px 0; }
    .holo-report-section .holo-body { font-size: 12.5px; }
    .holo-report-tags { margin-top: auto; }
  </style>
  <div class="holo-stack holo-stack--sm" style="height:100%;">
    ${cardHeaderHTML({ title: titleDisplay, kicker, right })}
    ${bylineMarkup}
    ${tldrMarkup}
    ${sectionsMarkup}
    ${overflowMarkup}
    ${recommendationMarkup}
    <div class="holo-spacer"></div>
    ${tagsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('report_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

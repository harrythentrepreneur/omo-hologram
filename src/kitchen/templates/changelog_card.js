// changelog_card — release notes / version history. Use for "what's new
// in v2.4", "show the changelog".
//
// Data shape (all fields optional except `version`):
//   {
//     product?,                        // "Momo"
//     version,                         // "v2.4.0" — hero line
//     released?,                       // ISO or pre-formatted
//     summary?,                        // 1-line TL;DR
//     sections?: [{                    // each a change category
//       label,                         // "ADDED" | "FIXED" | "CHANGED" | "REMOVED" | "SECURITY"
//       items: [string]
//     }],
//     highlights?: [string],           // used if sections aren't provided
//     breaking?: boolean
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, bulletListHTML, calloutHTML, tagHTML,
} from './primitives.js';

const MAX_SECTIONS = 2;
const MAX_BULLETS_PER_SECTION = 4;
const MAX_HIGHLIGHTS = 5;

function formatDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

// Pick the bullet marker for a given section label. Cyan=ADDED, check=FIXED,
// pink=REMOVED/DEPRECATED, arrow for anything else (CHANGED / SECURITY / etc).
function markerForLabel(label) {
  const L = String(label || '').toUpperCase();
  if (L === 'ADDED' || L === 'NEW') return 'cyan';
  if (L === 'FIXED' || L === 'PATCHED') return 'check';
  if (L === 'REMOVED' || L === 'DEPRECATED') return 'pink';
  return 'arrow';
}

function toneForLabel(label) {
  const L = String(label || '').toUpperCase();
  if (L === 'REMOVED' || L === 'DEPRECATED') return 'pink';
  if (L === 'SECURITY') return 'pink';
  return 'cyan';
}

function coerceSections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    if (!s) return null;
    const label = String(s.label || s.heading || s.title || '').trim().toUpperCase();
    if (!label) return null;
    const items = Array.isArray(s.items)
      ? s.items.filter(Boolean).map(String)
      : Array.isArray(s.bullets) ? s.bullets.filter(Boolean).map(String) : [];
    if (!items.length) return null;
    return { label, items };
  }).filter(Boolean);
}

function coerceChangelog(data) {
  if (!data) return null;
  const version = String(data.version || data.title || '').trim();
  if (!version) return null;
  return {
    product: String(data.product || '').trim(),
    version,
    released: formatDate(data.released || data.date || data.published),
    summary: String(data.summary || data.tldr || '').trim(),
    sections: coerceSections(data.sections || data.groups),
    highlights: Array.isArray(data.highlights) ? data.highlights.filter(Boolean).map(String) : [],
    breaking: !!data.breaking,
  };
}

export function changelogCardTemplate({ dataset, intent }) {
  const log = coerceChangelog(dataset?.data);
  if (!log) {
    return { body: emptyStateBody(intent, 'Need a changelog object with a version.'), exposedData: {}, needsEcharts: false };
  }

  const titleDisplay = titleText(log.version, 'RELEASE');
  const kickerParts = [];
  if (log.product) kickerParts.push(log.product.toUpperCase());
  else kickerParts.push('RELEASE');
  if (log.released) kickerParts.push(log.released);
  const kicker = kickerParts.join(' · ');

  const right = log.breaking
    ? tagHTML({ label: 'BREAKING', tone: 'pink' })
    : '';

  const summaryMarkup = log.summary
    ? `<div class="holo-body holo-body--lg holo-changelog-summary">${escapeHtml(truncate(log.summary, 180))}</div>`
    : '';

  const breakingMarkup = log.breaking
    ? calloutHTML({
        kind: 'warn',
        title: 'BREAKING CHANGES',
        body: 'Review before upgrading.',
      })
    : '';

  // Sections path preferred; highlights only if no sections
  let bodyMarkup = '';
  if (log.sections.length) {
    const visibleSections = log.sections.slice(0, MAX_SECTIONS);
    const overflowSections = log.sections.length - visibleSections.length;

    const sectionsMarkup = visibleSections.map((sec) => {
      const items = sec.items.slice(0, MAX_BULLETS_PER_SECTION).map((it) => truncate(it, 110));
      const overflow = Math.max(0, sec.items.length - items.length);
      const overflowLine = overflow > 0
        ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${overflow} more</div>`
        : '';
      return `<div class="holo-changelog-section">
        ${sectionHeadingHTML({ label: sec.label, tone: toneForLabel(sec.label) })}
        ${bulletListHTML({ items, marker: markerForLabel(sec.label) })}
        ${overflowLine}
      </div>`;
    }).join('');

    const moreSectionsLine = overflowSections > 0
      ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${overflowSections} more section${overflowSections === 1 ? '' : 's'}</div>`
      : '';

    bodyMarkup = `<div class="holo-changelog-grid">${sectionsMarkup}</div>${moreSectionsLine}`;
  } else if (log.highlights.length) {
    const items = log.highlights.slice(0, MAX_HIGHLIGHTS).map((h) => truncate(h, 120));
    const overflow = Math.max(0, log.highlights.length - items.length);
    bodyMarkup = `<div class="holo-changelog-section">
      ${sectionHeadingHTML({ label: 'HIGHLIGHTS', tone: 'cyan' })}
      ${bulletListHTML({ items, marker: 'arrow' })}
      ${overflow > 0 ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${overflow} more</div>` : ''}
    </div>`;
  } else {
    bodyMarkup = '<div class="holo-body holo-body--muted">No changes listed.</div>';
  }

  const body = `<div id="viz">
  <style>
    .holo-card-title {
      font-family: "SF Mono", ui-monospace, monospace;
      letter-spacing: 0.02em;
    }
    .holo-changelog-summary {
      padding: 6px 10px;
      border-left: 2px solid rgba(0, 229, 255, 0.45);
      background: rgba(0, 229, 255, 0.04);
      border-radius: 0 6px 6px 0;
    }
    .holo-changelog-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
      align-items: start;
      min-height: 0;
    }
    .holo-changelog-grid:has(> :only-child) { grid-template-columns: 1fr; }
    .holo-changelog-section { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .holo-changelog-section .holo-list { margin: 2px 0; }
    .holo-changelog-section .holo-li { font-size: 12px; margin: 3px 0; line-height: 1.4; }
  </style>
  <div class="holo-stack holo-stack--sm" style="height:100%;">
    ${cardHeaderHTML({ title: titleDisplay, kicker, right })}
    ${summaryMarkup}
    ${breakingMarkup}
    ${bodyMarkup}
    <div class="holo-spacer"></div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('changelog_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

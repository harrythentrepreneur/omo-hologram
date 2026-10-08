// case_study_card — a Problem → Solution → Outcome narrative card. For
// "tell me a case study" or "how we solved X for customer Y". Long-form
// prose with three sectioned paragraphs plus a strip of impact metrics.
//
// Data shape (all fields optional except `title`, `problem`, `solution`,
// `outcome`):
//   {
//     title:     "Acme scaled to 10× in 6 months"   // required — hero line
//     subtitle?: "Customer success story"
//     client?:   { name, industry? }
//     duration?: "6 months"
//     problem:   "paragraph"
//     solution:  "paragraph"
//     outcome:   "paragraph"
//     metrics?:  [{ label, value }]                 // up to 3 impact numbers
//     tags?:     ["fintech", "ops"]
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, timestampHTML,
  iconHTML, tagHTML,
} from './primitives.js';

function coerceCaseStudy(data) {
  if (!data) return null;
  const title = String(data.title || data.name || '').trim();
  const problem  = String(data.problem  || data.challenge || '').trim();
  const solution = String(data.solution || data.approach  || '').trim();
  const outcome  = String(data.outcome  || data.result    || data.impact || '').trim();
  if (!title && !problem && !solution) return null;

  return {
    title,
    subtitle: String(data.subtitle || '').trim(),
    client:   coerceClient(data.client),
    duration: String(data.duration || data.timeframe || '').trim(),
    problem, solution, outcome,
    metrics: coerceMetrics(data.metrics),
    tags:    Array.isArray(data.tags) ? data.tags.filter(Boolean).map(String) : [],
  };
}

function coerceClient(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { name: raw, industry: '' };
  const name = String(raw.name || raw.company || '').trim();
  if (!name) return null;
  return {
    name,
    industry: String(raw.industry || raw.sector || '').trim(),
  };
}

function coerceMetrics(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.label != null || m.value != null))
    .slice(0, 3)
    .map((m) => ({
      label: String(m.label || '').trim(),
      value: String(m.value == null ? '' : m.value).trim(),
    }));
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function caseStudyCardTemplate({ dataset, intent }) {
  const cs = coerceCaseStudy(dataset?.data);
  if (!cs) {
    return { body: emptyStateBody(intent, 'Need a case study with a title + problem/solution/outcome.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(cs.title, 'CASE STUDY');

  const right = cs.duration
    ? timestampHTML({ text: cs.duration, tone: 'default' })
    : '';

  let metaLine = '';
  if (cs.client) {
    const industry = cs.client.industry
      ? `<span class="holo-cs-meta-sub"> · ${escapeHtml(cs.client.industry)}</span>`
      : '';
    metaLine = `<div class="holo-row holo-cs-meta">
      ${iconHTML({ name: 'user', inline: true })}
      <span class="holo-cs-meta-name">${escapeHtml(cs.client.name)}</span>
      ${industry}
    </div>`;
  } else if (cs.subtitle) {
    metaLine = `<div class="holo-body holo-body--muted">${escapeHtml(cs.subtitle)}</div>`;
  }

  const sectionBlock = (label, tone, body) => body
    ? `${sectionHeadingHTML({ label, tone })}
       <div class="holo-body">${escapeHtml(truncate(body, 200))}</div>`
    : '';

  const metricsMarkup = cs.metrics.length
    ? `<div class="holo-cs-metrics">
         ${cs.metrics.map((m) => `<div class="holo-cs-metric">
           <div class="holo-cs-metric-label">${escapeHtml(m.label)}</div>
           <div class="holo-cs-metric-value">${escapeHtml(m.value)}</div>
         </div>`).join('')}
       </div>`
    : '';

  const tagsMarkup = cs.tags.length
    ? `<div class="holo-tag-row">${cs.tags.slice(0, 4).map((t) => tagHTML({ label: t, tone: 'muted' })).join('')}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-cs-meta { gap: 6px; font-size: 12px; }
    .holo-cs-meta-name {
      font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
    }
    .holo-cs-meta-sub {
      color: rgba(255, 255, 255, 0.55);
      font-size: 11px;
    }
    .holo-cs-metrics {
      display: flex;
      gap: 14px;
      padding-top: 6px;
      border-top: 1px solid rgba(0, 229, 255, 0.18);
      margin-top: 4px;
    }
    .holo-cs-metric {
      flex: 1 1 0;
      min-width: 0;
      display: flex; flex-direction: column; gap: 2px;
    }
    .holo-cs-metric + .holo-cs-metric {
      border-left: 1px solid rgba(0, 229, 255, 0.14);
      padding-left: 14px;
    }
    .holo-cs-metric-label {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.85);
      text-transform: uppercase;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
    }
    .holo-cs-metric-value {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 20px;
      color: rgba(255, 255, 255, 0.96);
      font-variant-numeric: tabular-nums;
      text-shadow: 0 0 10px rgba(0, 229, 255, 0.22);
      line-height: 1.1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .holo-cs-body {
      font-size: 12.5px;
      line-height: 1.45;
    }
  </style>
  <div class="holo-stack holo-stack--sm" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'CASE STUDY', right })}
    ${metaLine}
    ${sectionBlock('PROBLEM', 'pink', cs.problem)}
    ${sectionBlock('SOLUTION', 'cyan', cs.solution)}
    ${sectionBlock('OUTCOME', 'cyan', cs.outcome)}
    <div class="holo-spacer"></div>
    ${metricsMarkup}
    ${tagsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('case_study_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

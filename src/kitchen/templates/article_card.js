// article_card — a reading-digest card. TL;DR-style preview of an article
// Momo has skimmed for the user, with key points and source attribution.
//
// Data shape (required: title + summary):
//   {
//     title:         "The quiet rise of inference-time compute"
//     author:        "Ana Patel"
//     published:     "2026-04-20"          // ISO
//     summary:       "…"                   // 1–2 sentences, up to ~220 chars
//     key_points:    ["…", "…", "…"]       // 3–5 bullets
//     tags:          ["AI", "research"]
//     source:        "The Verge"           // domain / publication name
//     reading_time:  "6 min" | 6           // formatted string OR minutes int
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, timestampHTML, tagHTML, iconHTML, bulletListHTML,
} from './primitives.js';

function coerceArticle(data) {
  if (!data) return null;
  const title = String(data.title || data.headline || '').trim();
  const summary = String(data.summary || data.tldr || data.description || '').trim();
  if (!title && !summary) return null;

  const keyPoints = Array.isArray(data.key_points) ? data.key_points
                   : Array.isArray(data.keyPoints) ? data.keyPoints
                   : Array.isArray(data.points) ? data.points
                   : [];

  return {
    title,
    summary,
    author:      String(data.author || data.byline || '').trim(),
    published:   formatPublished(data.published || data.date || data.published_at),
    keyPoints:   keyPoints.filter(Boolean).map(String).slice(0, 5),
    tags:        Array.isArray(data.tags) ? data.tags.filter(Boolean).map(String) : [],
    source:      String(data.source || data.publication || '').trim(),
    readingTime: formatReadingTime(data.reading_time ?? data.readingTime),
  };
}

function formatPublished(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatReadingTime(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) return `${Math.max(1, Math.round(raw))} MIN READ`;
  const s = String(raw).trim();
  if (!s) return '';
  // "6 min" → "6 MIN READ"; leave fully-formed strings intact after uppercasing.
  if (/^\d+\s*min$/i.test(s)) return `${s.replace(/\s*min/i, '')} MIN READ`.toUpperCase();
  return s.toUpperCase();
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function articleCardTemplate({ dataset, intent }) {
  const a = coerceArticle(dataset?.data);
  if (!a) {
    return { body: emptyStateBody(intent, 'Need an article with a title and summary.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(a.title, 'ARTICLE');
  const kicker = a.source ? a.source.toUpperCase() : 'ARTICLE';
  const right = a.readingTime
    ? timestampHTML({ text: a.readingTime, tone: 'default' })
    : '';

  const metaItems = [];
  if (a.author) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'user', inline: true })}<span>${escapeHtml(a.author)}</span></span>`);
  }
  if (a.published) {
    metaItems.push(`<span class="holo-meta-item">${iconHTML({ name: 'calendar', inline: true })}<span>${escapeHtml(a.published)}</span></span>`);
  }
  const metaMarkup = metaItems.length
    ? `<div class="holo-meta-row">${metaItems.join('')}</div>`
    : '';

  const summaryMarkup = a.summary
    ? `<div class="holo-body">${escapeHtml(truncate(a.summary, 220))}</div>`
    : '';

  const pointsMarkup = a.keyPoints.length
    ? bulletListHTML({ items: a.keyPoints, marker: 'arrow' })
    : '';

  const tagsMarkup = a.tags.length
    ? `<div class="holo-tag-row">${a.tags.slice(0, 5).map((t) => tagHTML({ label: t, tone: 'cyan' })).join('')}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-article-body { min-width: 0; }
    .holo-article-body .holo-list { margin-top: 4px; }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker, right })}
    ${metaMarkup}
    <div class="holo-article-body">
      ${summaryMarkup}
      ${pointsMarkup}
    </div>
    <div class="holo-spacer"></div>
    ${tagsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('article_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

// bio_card — a long-form biography card. The verbose cousin of
// profile_card: this is for "give me a bio on Jane" or a prepared intro
// for a new hire, not a compact contact dossier.
//
// Data shape (all fields optional except `name`):
//   {
//     name:       "Jane Okafor"                 // required — hero title
//     tagline?:   "Product lead · ex-Stripe"    // one-line descriptor
//     avatar_url?:"https://…/jane.jpg"
//     summary:    "2–4 sentence body paragraph" // lead prose
//     highlights?:["shipped X to 10M users", …] // 3–5 career bullets
//     experience?:[{ role, company, period? }]  // 2–3 past roles
//     education?: [{ degree, institution, year? }]
//     quote?:     { text, context? }            // optional signature quote
//     tags?:      ["fintech", "ai"]             // interests / topics
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, sectionHeadingHTML, bulletListHTML,
  personChipHTML, quoteBlockHTML, tagHTML, timestampHTML,
} from './primitives.js';

function coerceBio(data) {
  if (!data) return null;
  const name = String(data.name || data.display_name || '').trim();
  if (!name) return null;

  return {
    name,
    tagline:   String(data.tagline || data.headline || '').trim(),
    avatarUrl: data.avatar_url || data.avatarUrl || null,
    summary:   String(data.summary || data.bio || data.about || '').trim(),
    highlights: Array.isArray(data.highlights)
      ? data.highlights.filter(Boolean).map(String)
      : [],
    experience: Array.isArray(data.experience)
      ? data.experience.filter(Boolean).map(coerceExperience)
      : [],
    education: Array.isArray(data.education)
      ? data.education.filter(Boolean).map(coerceEducation)
      : [],
    quote:  coerceQuote(data.quote),
    tags:   Array.isArray(data.tags) ? data.tags.filter(Boolean).map(String) : [],
  };
}

function coerceExperience(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { role: raw, company: '', period: '' };
  return {
    role:    String(raw.role || raw.title || '').trim(),
    company: String(raw.company || raw.organisation || raw.organization || '').trim(),
    period:  String(raw.period || raw.years || raw.dates || '').trim(),
  };
}

function coerceEducation(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { degree: raw, institution: '', year: '' };
  return {
    degree:      String(raw.degree || raw.qualification || '').trim(),
    institution: String(raw.institution || raw.school || raw.university || '').trim(),
    year:        String(raw.year || raw.graduated || '').trim(),
  };
}

function coerceQuote(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { text: raw, context: '' };
  const text = String(raw.text || raw.body || '').trim();
  if (!text) return null;
  return { text, context: String(raw.context || raw.source || '').trim() };
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function bioCardTemplate({ dataset, intent }) {
  const p = coerceBio(dataset?.data);
  if (!p) {
    return { body: emptyStateBody(intent, 'Need a bio with a name.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(p.name, 'BIO');
  const shortTagline = p.tagline && p.tagline.length <= 36;
  const right = shortTagline
    ? timestampHTML({ text: p.tagline, tone: 'muted' })
    : '';

  const taglineLine = (!shortTagline && p.tagline)
    ? `<div class="holo-body holo-body--muted" style="margin-top:-2px;">${escapeHtml(p.tagline)}</div>`
    : '';

  const heroRow = `<div class="holo-bio-hero">
    ${personChipHTML({ name: p.name, size: 'lg', avatarUrl: p.avatarUrl })}
  </div>`;

  const summaryMarkup = p.summary
    ? `<div class="holo-body">${escapeHtml(truncate(p.summary, 260))}</div>`
    : '';

  const highlights = p.highlights.slice(0, 4);
  const leftCol = highlights.length
    ? `<div class="holo-bio-col">
         ${sectionHeadingHTML({ label: 'HIGHLIGHTS', tone: 'cyan' })}
         ${bulletListHTML({ items: highlights, marker: 'arrow' })}
       </div>`
    : '<div class="holo-bio-col"></div>';

  const experience = p.experience.slice(0, 3);
  const expMarkup = experience.length
    ? `${sectionHeadingHTML({ label: 'EXPERIENCE', tone: 'cyan' })}
       <div class="holo-bio-list">
         ${experience.map((e) => {
           const sub = [e.company, e.period].filter(Boolean).join(' · ');
           return `<div class="holo-bio-row">
             <div class="holo-bio-row-title">${escapeHtml(e.role || '—')}</div>
             ${sub ? `<div class="holo-bio-row-sub">${escapeHtml(sub)}</div>` : ''}
           </div>`;
         }).join('')}
       </div>`
    : '';

  const showEducation = experience.length <= 2 && p.education.length;
  const education = showEducation ? p.education.slice(0, 2) : [];
  const eduMarkup = education.length
    ? `${sectionHeadingHTML({ label: 'EDUCATION', tone: 'cyan' })}
       <div class="holo-bio-list">
         ${education.map((e) => {
           const sub = [e.institution, e.year].filter(Boolean).join(' · ');
           return `<div class="holo-bio-row">
             <div class="holo-bio-row-title">${escapeHtml(e.degree || '—')}</div>
             ${sub ? `<div class="holo-bio-row-sub">${escapeHtml(sub)}</div>` : ''}
           </div>`;
         }).join('')}
       </div>`
    : '';

  const rightCol = (expMarkup || eduMarkup)
    ? `<div class="holo-bio-col">${expMarkup}${eduMarkup}</div>`
    : '<div class="holo-bio-col"></div>';

  const quoteMarkup = p.quote
    ? `<div class="holo-bio-quote">
         ${quoteBlockHTML({ text: truncate(p.quote.text, 120), source: p.quote.context })}
       </div>`
    : '';

  const tagsMarkup = p.tags.length
    ? `<div class="holo-tag-row">${p.tags.slice(0, 4).map((t) => tagHTML({ label: t, tone: 'muted' })).join('')}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-bio-hero { display: flex; align-items: center; gap: 14px; margin: 2px 0; }
    .holo-bio-grid {
      display: grid;
      grid-template-columns: 55% 45%;
      gap: 16px;
      min-height: 0;
    }
    .holo-bio-col { min-width: 0; display: flex; flex-direction: column; }
    .holo-bio-list { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 6px 0; }
    .holo-bio-row { line-height: 1.3; min-width: 0; }
    .holo-bio-row-title {
      font-size: 12.5px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .holo-bio-row-sub {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.55);
      margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .holo-bio-quote { max-height: 60px; overflow: hidden; margin-top: 2px; }
    .holo-bio-quote .holo-quote { margin: 0; padding: 2px 4px 2px 16px; }
    .holo-bio-quote .holo-quote-body { font-size: 12.5px; line-height: 1.35; }
    .holo-bio-quote .holo-quote-mark { font-size: 22px; top: -2px; }
    .holo-bio-quote .holo-quote-attr { margin-top: 3px; font-size: 9px; }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker: 'BIO', right })}
    ${taglineLine}
    ${heroRow}
    ${summaryMarkup}
    <div class="holo-bio-grid">
      ${leftCol}
      ${rightCol}
    </div>
    ${quoteMarkup}
    <div class="holo-spacer"></div>
    ${tagsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('bio_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

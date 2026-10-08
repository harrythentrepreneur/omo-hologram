// profile_card — a person dossier card Momo can project when introducing
// a contact or surfacing a relationship touch-point. Text-only: no charts.
//
// Data shape (all fields optional except `name`):
//   {
//     name:        "Sarah Chen"                // required — hero title
//     role:        "Head of Partnerships"      // sub-line under name
//     company:     "Acme Robotics"             // kicker label
//     email:       "sarah@acme.co"
//     phone:       "+1 415 555 0134"
//     location:    "San Francisco, CA"
//     avatar_url:  "https://…/sarah.jpg"       // renders inside personChip
//     bio:         "…"                         // up to ~240 chars
//     tags:        ["investor", "robotics"]    // interest / label chips
//     stats:       [{ label, value }]          // up to 3 summary stats
//     last_interaction: "2026-04-21T10:00:00Z" // ISO — drives "last spoke"
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, personChipHTML, timestampHTML, tagHTML,
  keyValueRowHTML,
} from './primitives.js';

function coerceProfile(data) {
  if (!data) return null;
  const name = String(data.name || data.display_name || '').trim();
  if (!name) return null;

  const statsRaw = Array.isArray(data.stats) ? data.stats : [];
  const stats = statsRaw
    .filter((s) => s && (s.label != null || s.value != null))
    .slice(0, 3)
    .map((s) => ({
      label: String(s.label || '').trim(),
      value: String(s.value == null ? '' : s.value).trim(),
    }));

  return {
    name,
    role:     String(data.role || data.title || '').trim(),
    company:  String(data.company || data.organisation || data.organization || '').trim(),
    email:    String(data.email || '').trim(),
    phone:    String(data.phone || data.tel || '').trim(),
    location: String(data.location || data.city || '').trim(),
    avatarUrl: data.avatar_url || data.avatarUrl || null,
    bio:      String(data.bio || data.about || '').trim(),
    tags:     Array.isArray(data.tags) ? data.tags.filter(Boolean).map(String) : [],
    stats,
    lastInteraction: formatRelative(data.last_interaction || data.lastInteraction),
  };
}

function formatRelative(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const diffMs = Date.now() - d.getTime();
  const day = 86400000;
  const absDays = Math.round(diffMs / day);
  if (absDays <= 0) return 'LAST SPOKE TODAY';
  if (absDays === 1) return 'LAST SPOKE 1 DAY AGO';
  if (absDays < 30) return `LAST SPOKE ${absDays} DAYS AGO`;
  const months = Math.round(absDays / 30);
  if (months < 12) return `LAST SPOKE ${months} MO AGO`;
  const years = Math.round(absDays / 365);
  return `LAST SPOKE ${years} YR AGO`;
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

export function profileCardTemplate({ dataset, intent }) {
  const p = coerceProfile(dataset?.data);
  if (!p) {
    return { body: emptyStateBody(intent, 'Need a profile with a name.'), exposedData: {}, needsEcharts: false };
  }

  const title = titleText(p.name, 'CONTACT');
  const kicker = p.company ? p.company.toUpperCase() : 'CONTACT';

  const right = p.lastInteraction
    ? timestampHTML({ text: p.lastInteraction, tone: 'muted' })
    : '';

  const roleLine = [p.role, p.company].filter(Boolean).join(' · ');
  const heroRow = `<div class="holo-profile-hero">
    ${personChipHTML({ name: p.name, size: 'lg', avatarUrl: p.avatarUrl })}
    ${roleLine
      ? `<div class="holo-profile-hero-meta">
           ${p.role ? `<div class="holo-profile-role">${escapeHtml(p.role)}</div>` : ''}
           ${p.company ? `<div class="holo-profile-company">${escapeHtml(p.company)}</div>` : ''}
         </div>`
      : ''}
  </div>`;

  const metaRows = [];
  if (p.email)    metaRows.push(keyValueRowHTML({ label: 'EMAIL',    value: p.email,    icon: 'mail' }));
  if (p.phone)    metaRows.push(keyValueRowHTML({ label: 'PHONE',    value: p.phone,    icon: 'phone' }));
  if (p.location) metaRows.push(keyValueRowHTML({ label: 'LOCATION', value: p.location, icon: 'location' }));
  const metaMarkup = metaRows.length
    ? `<div class="holo-profile-meta">${metaRows.join('')}</div>`
    : '';

  const bioMarkup = p.bio
    ? `<div class="holo-body holo-body--muted">${escapeHtml(truncate(p.bio, 240))}</div>`
    : '';

  const statsMarkup = p.stats.length
    ? `<div class="holo-profile-stats">
         ${p.stats.map((s) => `<div class="holo-profile-stat">
           <div class="holo-profile-stat-label">${escapeHtml(s.label)}</div>
           <div class="holo-profile-stat-value">${escapeHtml(s.value)}</div>
         </div>`).join('')}
       </div>`
    : '';

  const tagsMarkup = p.tags.length
    ? `<div class="holo-tag-row">${p.tags.slice(0, 6).map((t) => tagHTML({ label: t, tone: 'muted' })).join('')}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-profile-hero {
      display: flex; align-items: center; gap: 14px;
      margin: 2px 0 2px 0;
    }
    .holo-profile-hero-meta { min-width: 0; line-height: 1.3; }
    .holo-profile-role {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.88);
      font-weight: 600;
    }
    .holo-profile-company {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.55);
      margin-top: 2px;
    }
    .holo-profile-meta { display: flex; flex-direction: column; }
    .holo-profile-stats {
      display: grid;
      grid-template-columns: repeat(${Math.max(1, p.stats.length)}, 1fr);
      gap: 12px;
      padding: 6px 0;
    }
    .holo-profile-stat + .holo-profile-stat {
      border-left: 1px solid rgba(0, 229, 255, 0.16);
      padding-left: 12px;
    }
    .holo-profile-stat-label {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.85);
      text-transform: uppercase;
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
      margin-bottom: 3px;
    }
    .holo-profile-stat-value {
      font-size: 20px;
      color: rgba(255, 255, 255, 0.96);
      font-variant-numeric: tabular-nums;
      text-shadow: 0 0 10px rgba(0, 229, 255, 0.2);
      line-height: 1.1;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title, kicker, right })}
    ${heroRow}
    ${metaMarkup}
    ${bioMarkup}
    ${statsMarkup}
    <div class="holo-spacer"></div>
    ${tagsMarkup}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('profile_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

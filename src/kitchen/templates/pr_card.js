// pr_card — a single GitHub pull request rendered as a hologram card.
//
// Kind of like email_card's cousin: same person-chip + tag-row vocabulary,
// but the hero subtitle is a diff badge ("+482 −191 in 14 files"), the
// label row carries reviewer avatars + workflow check status, and the
// state pill calls out merged / draft / open at a glance.
//
// Data shape (lenient — accepts the slim view from connectors/github.js):
//   {
//     repo, number, title,
//     state: 'open' | 'closed',
//     merged, draft,
//     author:   { login, avatar_url },
//     base, head,
//     additions, deletions, changed_files,
//     comments, review_comments,
//     mergeable_state,         // 'clean' | 'dirty' | 'unstable' | ...
//     check_status?:           // optional summary computed by viz prep
//       { state: 'success'|'failure'|'pending'|'neutral', failing, passing, pending },
//     requested_reviewers: [{ login, avatar_url }],
//     labels: [string],
//     html_url,
//     created_at, updated_at, merged_at,
//     body
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, personChipHTML, tagHTML, iconHTML, alertPillHTML,
} from './primitives.js';

function pluralise(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function shortRepo(repo) {
  // "acme/storefront" → "storefront" if the org is the same as
  // the leading word in any other shown card; else keep full slug. Cards
  // are independent so we just trim long org names visually.
  const s = String(repo || '');
  if (s.length <= 30) return s;
  const parts = s.split('/');
  if (parts.length === 2) return `${parts[0].slice(0, 8)}…/${parts[1]}`;
  return s.slice(0, 30) + '…';
}

function statePillHTML(pr) {
  if (pr.merged) return tagHTML({ label: 'MERGED', tone: 'pink' });
  if (pr.state === 'closed') return tagHTML({ label: 'CLOSED', tone: 'muted' });
  if (pr.draft) return tagHTML({ label: 'DRAFT', tone: 'muted' });
  return tagHTML({ label: 'OPEN', tone: 'cyan' });
}

function mergeablePillHTML(pr) {
  // mergeable_state codes: clean, blocked, behind, dirty, unstable,
  // has_hooks, draft, unknown. We collapse to 3 buckets for clarity.
  const m = String(pr.mergeable_state || '').toLowerCase();
  if (!m || m === 'unknown') return '';
  if (m === 'clean') return alertPillHTML({ kind: 'good', text: 'READY TO MERGE' });
  if (m === 'unstable') return alertPillHTML({ kind: 'warn', text: 'CHECKS UNSTABLE' });
  if (m === 'dirty' || m === 'blocked' || m === 'behind') return alertPillHTML({ kind: 'warn', text: m.toUpperCase() });
  return '';
}

function checkPillHTML(pr) {
  // Optional check_status is precomputed by the projection layer for the
  // "CI failed" card path. When absent, fall back to mergeable_state.
  const cs = pr.check_status;
  if (!cs) return '';
  if (cs.state === 'success' || cs.failing === 0) {
    const total = (cs.passing || 0);
    return alertPillHTML({ kind: 'good', text: total ? `${total} CHECK${total === 1 ? '' : 'S'} PASS` : 'CHECKS PASS' });
  }
  if (cs.state === 'failure' || cs.failing > 0) {
    return alertPillHTML({ kind: 'warn', text: `${cs.failing} CHECK${cs.failing === 1 ? '' : 'S'} FAIL` });
  }
  if (cs.pending > 0) {
    return alertPillHTML({ kind: 'info', text: `${cs.pending} CHECK${cs.pending === 1 ? '' : 'S'} RUNNING` });
  }
  return '';
}

function diffBadgeHTML(pr) {
  const adds = Number(pr.additions);
  const dels = Number(pr.deletions);
  const files = Number(pr.changed_files);
  const hasNumbers = Number.isFinite(adds) && Number.isFinite(dels);
  if (!hasNumbers && !Number.isFinite(files)) return '';
  const parts = [];
  if (hasNumbers) {
    parts.push(`<span class="holo-pr-diff"><span class="holo-pr-add">+${adds.toLocaleString()}</span> <span class="holo-pr-del">−${dels.toLocaleString()}</span></span>`);
  }
  if (Number.isFinite(files)) {
    parts.push(`<span class="holo-pr-files">${pluralise(files, 'file', 'files')}</span>`);
  }
  return `<div class="holo-pr-diffrow">${parts.join('<span class="holo-pr-sep">·</span>')}</div>`;
}

function reviewerRowHTML(reviewers) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) return '';
  // First reviewer rendered as a person chip; the rest as +N tag.
  const first = reviewers[0];
  const rest = reviewers.length - 1;
  const firstChip = personChipHTML({ name: first.login, role: 'requested', size: 'sm' });
  const moreTag = rest > 0 ? `<span class="holo-pr-more">+${rest}</span>` : '';
  return `<div class="holo-pr-reviewers">
    <span class="holo-pr-reviewer-label">${iconHTML({ name: 'user', inline: true })}<span>REVIEWERS</span></span>
    ${firstChip}
    ${moreTag}
  </div>`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  if (w < 8) return `${w}w ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function coercePR(data) {
  if (!data) return null;
  const number = data.number != null ? Number(data.number) : null;
  const title = String(data.title || '').trim();
  if (!number || !title) return null;
  return {
    repo: String(data.repo || ''),
    number,
    title,
    state: data.state || 'open',
    merged: !!data.merged,
    draft: !!data.draft,
    author: data.author ? { login: data.author.login || '', avatar_url: data.author.avatar_url || null } : null,
    base: data.base || null,
    head: data.head || null,
    additions: data.additions ?? null,
    deletions: data.deletions ?? null,
    changed_files: data.changed_files ?? null,
    comments: data.comments ?? null,
    review_comments: data.review_comments ?? null,
    mergeable_state: data.mergeable_state || null,
    check_status: data.check_status || null,
    requested_reviewers: Array.isArray(data.requested_reviewers) ? data.requested_reviewers : [],
    labels: Array.isArray(data.labels) ? data.labels.filter(Boolean) : [],
    html_url: data.html_url || null,
    created_at: data.created_at || null,
    updated_at: data.updated_at || null,
    merged_at: data.merged_at || null,
    body: typeof data.body === 'string' ? data.body : '',
  };
}

export function prCardTemplate({ dataset, intent }) {
  const pr = coercePR(dataset?.data);
  if (!pr) {
    return { body: emptyStateBody(intent, 'Need a PR object with a number + title.'), exposedData: {}, needsEcharts: false };
  }

  const titleDisplay = titleText(`${pr.title}`, 'PULL REQUEST');
  const ageStr = timeAgo(pr.merged_at || pr.updated_at || pr.created_at);
  const kicker = `PR #${pr.number} · ${shortRepo(pr.repo)}${ageStr ? ' · ' + ageStr.toUpperCase() : ''}`;

  // Right slot: state pill (open/draft/merged/closed).
  const right = statePillHTML(pr);

  const authorMarkup = pr.author?.login
    ? personChipHTML({ name: pr.author.login, role: pr.head ? `${pr.head} → ${pr.base || 'main'}` : 'author' })
    : '';

  const labelRow = pr.labels.length
    ? `<div class="holo-tag-row">${pr.labels.slice(0, 5).map((l) => tagHTML({ label: String(l).toUpperCase(), tone: 'cyan' })).join('')}</div>`
    : '';

  const checkPill = checkPillHTML(pr);
  const mergeablePill = mergeablePillHTML(pr);
  const statusRow = (checkPill || mergeablePill)
    ? `<div class="holo-pr-statusrow">${checkPill}${mergeablePill}</div>`
    : '';

  const diffBadge = diffBadgeHTML(pr);
  const reviewerRow = reviewerRowHTML(pr.requested_reviewers);

  const bodyText = (pr.body || '').slice(0, 200).replace(/\s+/g, ' ').trim();
  const bodyMarkup = bodyText
    ? `<div class="holo-body holo-body--muted holo-pr-body">${escapeHtml(bodyText)}${pr.body.length > 200 ? '…' : ''}</div>`
    : '';

  const commentBadge = (pr.comments || pr.review_comments)
    ? `<div class="holo-body holo-body--muted holo-pr-comments">${iconHTML({ name: 'mail', inline: true })} ${pluralise(Number(pr.comments || 0) + Number(pr.review_comments || 0), 'comment', 'comments')}</div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-card-title {
      font-family: "SF Pro Display", system-ui, sans-serif;
      letter-spacing: 0.005em;
    }
    .holo-pr-diffrow {
      display: flex; align-items: baseline; gap: 8px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 12.5px;
      letter-spacing: 0.04em;
      color: rgba(255, 255, 255, 0.78);
      margin-top: 4px;
    }
    .holo-pr-diff { display: inline-flex; gap: 8px; }
    .holo-pr-add { color: #5effc1; text-shadow: 0 0 5px rgba(94, 255, 193, 0.45); }
    .holo-pr-del { color: #ff66b3; text-shadow: 0 0 5px rgba(255, 102, 179, 0.45); }
    .holo-pr-sep { color: rgba(0, 229, 255, 0.45); padding: 0 2px; }
    .holo-pr-files { color: rgba(255, 255, 255, 0.62); }
    .holo-pr-statusrow {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin: 2px 0;
    }
    .holo-pr-body {
      max-height: 4.4em; overflow: hidden; position: relative;
    }
    .holo-pr-body::after {
      content: '';
      position: absolute; left: 0; right: 0; bottom: 0; height: 1.6em;
      background: linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,0.45));
      pointer-events: none;
    }
    .holo-pr-reviewers {
      display: flex; align-items: center; gap: 8px;
      flex-wrap: wrap;
      font-family: "SF Mono", ui-monospace, monospace;
    }
    .holo-pr-reviewer-label {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 10px;
      letter-spacing: 0.18em;
      color: rgba(0, 229, 255, 0.75);
      text-transform: uppercase;
    }
    .holo-pr-more {
      font-size: 11px;
      letter-spacing: 0.06em;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(0, 229, 255, 0.08);
      border: 1px solid rgba(0, 229, 255, 0.28);
      color: #00e5ff;
    }
    .holo-pr-comments {
      font-size: 11px;
      letter-spacing: 0.06em;
      color: rgba(0, 229, 255, 0.72);
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: titleDisplay, kicker, right })}
    ${authorMarkup ? `<div class="holo-pr-author">${authorMarkup}</div>` : ''}
    ${diffBadge}
    ${statusRow}
    ${labelRow}
    ${bodyMarkup}
    <div class="holo-spacer"></div>
    ${reviewerRow}
    ${commentBadge}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('pr_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

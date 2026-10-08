// GitHub → hologram projector.
//
// Subscribes to the Data Core event bus, filters source:'github', and
// translates each high-signal kind into a card that pops onto Momo's
// hologram WITHOUT a model round-trip — the same pattern stripe_live and
// gmail_live use.
//
// Handled kinds:
//   pr_opened              → pr_card
//   pr_review_requested    → pr_card with REVIEW REQUESTED kicker
//   pr_merged              → pr_card with MERGED state pill
//   pr_reviewed            → pr_card (only when state is 'changes_requested' or 'approved')
//   workflow_run_failure   → status alert ("CI FAILED")
//   release_published      → changelog_card
//   notification_received  → notification_card (for review_requested only — others are noisy)
//
// Coalescing: if 3+ relevant events for the SAME PR arrive within
// debounceMs, only the most recent gets projected — this matters during
// a flurry of pr_updated events from a force-push or rapid review pings.

import { randomUUID } from 'node:crypto';
import * as datasets from '../store/datasets.js';
import * as projectables from '../store/projectables.js';
import { subscribe, emit } from '../data_core.js';
import { broadcastProjection } from './broadcast.js';

const DEBOUNCE_MS = 4000;
const MAX_BURST = 3;

// PR-event kinds we project as pr_card. Each maps to an intent prefix so
// the card kicker reads right (e.g. "REVIEW REQUESTED · #482").
const PR_KIND_INTENT = {
  pr_opened:           'NEW PR',
  pr_review_requested: 'REVIEW REQUESTED',
  pr_merged:           'PR MERGED',
};

function pickAuthorName(pr) {
  return pr?.author?.login || pr?.user?.login || 'someone';
}

function buildPRDataset(eventData) {
  // Connector's slim shape already matches the pr_card template's input
  // contract — just guard against missing fields.
  if (!eventData || !eventData.number || !eventData.title) return null;
  return {
    repo: eventData.repo,
    number: eventData.number,
    title: eventData.title,
    state: eventData.state,
    merged: !!eventData.merged,
    draft: !!eventData.draft,
    author: eventData.author || null,
    base: eventData.base,
    head: eventData.head,
    additions: eventData.additions ?? null,
    deletions: eventData.deletions ?? null,
    changed_files: eventData.changed_files ?? null,
    comments: eventData.comments ?? null,
    review_comments: eventData.review_comments ?? null,
    mergeable_state: eventData.mergeable_state || null,
    requested_reviewers: eventData.requested_reviewers || [],
    labels: eventData.labels || [],
    html_url: eventData.html_url,
    created_at: eventData.created_at,
    updated_at: eventData.updated_at,
    merged_at: eventData.merged_at,
    body: eventData.body,
  };
}

async function projectPR(event, kind) {
  const data = buildPRDataset(event.data);
  if (!data) return;

  const id = datasets.put('github_pr', data);
  const intentPrefix = PR_KIND_INTENT[kind] || 'PULL REQUEST';
  // Title is repo + number — the pr_card template hangs the actual PR
  // title in the body, so the intent slot stays compact.
  const intent = `${intentPrefix} · ${data.repo} #${data.number}`;
  const reason = `${kind} · ${data.repo}#${data.number} · ${pickAuthorName(data)}`;

  const res = await broadcastProjection({
    intent,
    data_refs: [id],
    chart_type: 'pr_card',
    size: 'wide',
    reason,
    producer: 'projection',
    ttlMs: kind === 'pr_review_requested' ? 0 : 30_000,
  });
  if (!res.ok) {
    console.warn('[projection/github] broadcast failed:', res.error);
    return;
  }
  console.log(`[projection/github] projected ${kind} → pr_card (${res.projectable_id}) · ${reason}`);
}

async function projectReview(event) {
  const review_state = event.data?.review_state;
  // Skip noisy reviews — only project when the state genuinely changes
  // the PR's status. Plain "commented" reviews are too frequent.
  if (review_state !== 'approved' && review_state !== 'changes_requested') return;
  const data = buildPRDataset(event.data);
  if (!data) return;
  const id = datasets.put('github_pr', data);
  const reviewer = event.data?.reviewer || 'a teammate';
  const verb = review_state === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED';
  const intent = `${verb} · ${data.repo} #${data.number}`;
  const reason = `pr_reviewed · ${verb.toLowerCase()} · ${reviewer}`;
  const res = await broadcastProjection({
    intent,
    data_refs: [id],
    chart_type: 'pr_card',
    size: 'wide',
    reason,
    producer: 'projection',
  });
  if (!res.ok) console.warn('[projection/github] broadcast failed:', res.error);
}

// CI failure status alert. We use the same projectable.put('status', ...)
// pattern stripe_live uses for charge_failed / dispute_opened.
function projectCIFailure(event) {
  const d = event.data || {};
  const repo = d.repo || '';
  const branch = d.head_branch || '';
  const conclusion = d.conclusion || 'failed';
  const detail = `${repo}${branch ? ' · ' + branch : ''}${conclusion ? ' · ' + conclusion : ''}`.replace(/^ · /, '');
  const reason = `github ci ${conclusion} · ${repo}${branch ? '/' + branch : ''}`;

  const projectable_id = projectables.put('status', {
    meta: {
      title: 'CI FAILED',
      detail: detail.slice(0, 96),
      variant: 'alert',
      ttl_ms: 30_000,
    },
  });

  emit({
    id: randomUUID(),
    ts: Date.now(),
    source: 'projection',
    kind: 'project',
    title: 'CI FAILED',
    summary: reason,
    data: {
      projectable_kind: 'status',
      projectable_id,
      ttlMs: 30_000,
      reason,
    },
  });
  console.log(`[projection/github] projected workflow_run_failure → status alert (${projectable_id}) · ${reason}`);
}

// Releases → changelog_card. We hand the connector's slim release shape
// straight to the kitchen; the changelog template reads .version from
// .tag_name fallback already.
async function projectRelease(event) {
  const d = event.data || {};
  if (!d.tag_name) return;
  const data = {
    product: d.repo,
    version: d.tag_name,
    released: d.published_at || d.created_at,
    summary: d.name && d.name !== d.tag_name ? d.name : '',
    // changelog_card accepts either `sections` or `highlights`. We have
    // a single body blob — rough-split on common heading markers so the
    // card has structure when GitHub's release body uses ## sections.
    sections: parseReleaseBody(d.body),
    breaking: /\bbreaking\b/i.test(d.body || ''),
  };
  const id = datasets.put('github_release', data);
  const reason = `release ${d.tag_name} · ${d.repo}`;
  const res = await broadcastProjection({
    intent: `RELEASE · ${d.repo} ${d.tag_name}`,
    data_refs: [id],
    chart_type: 'changelog_card',
    size: 'wide',
    reason,
    producer: 'projection',
    ttlMs: 0,
  });
  if (!res.ok) console.warn('[projection/github] broadcast failed:', res.error);
  else console.log(`[projection/github] projected release → changelog_card · ${reason}`);
}

// Quick + dirty release-body parser. GitHub release notes usually have
// ### Added / ### Fixed / ### Changed style headings; we fall back to a
// single "HIGHLIGHTS" section if there's no structure.
function parseReleaseBody(body) {
  if (!body || typeof body !== 'string') return null;
  const lines = body.split('\n');
  const sections = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Heading markers
    const heading = line.match(/^#{2,3}\s+(.+)$/);
    if (heading) {
      if (current) sections.push(current);
      current = { label: heading[1].trim().toUpperCase(), items: [] };
      continue;
    }
    // Bullet
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!current) current = { label: 'HIGHLIGHTS', items: [] };
      current.items.push(bullet[1].trim());
      continue;
    }
    // Plain text — first paragraph becomes summary; we ignore the rest.
  }
  if (current) sections.push(current);
  return sections.length ? sections : null;
}

// Notification cards for review_requested. Other reasons are noisy
// enough that we keep them in the bus but don't pop a card.
async function projectReviewRequest(event) {
  const d = event.data || {};
  if (d.reason !== 'review_requested' && d.reason !== 'mention') return;
  const data = {
    items: [{
      title: d.subject?.title || '(notification)',
      kicker: `${d.reason.toUpperCase()} · ${d.repo || ''}`,
      timestamp: d.updated_at,
    }],
  };
  const id = datasets.put('github_notifications_one', data);
  const intent = d.reason === 'review_requested'
    ? `REVIEW REQUESTED · ${d.repo}`
    : `MENTION · ${d.repo}`;
  const reason = `github notification · ${d.reason} · ${d.repo}`;
  const res = await broadcastProjection({
    intent,
    data_refs: [id],
    chart_type: 'notification_card',
    size: 'wide',
    reason,
    producer: 'projection',
    ttlMs: 0,
  });
  if (!res.ok) console.warn('[projection/github] broadcast failed:', res.error);
}

// ────────────────────────────────────────────────────── install

export function install({ debounceMs = DEBOUNCE_MS } = {}) {
  // Per-PR coalescing buckets so a flurry of pr_updated → pr_review_requested
  // → pr_updated doesn't flash three cards in a row.
  const buckets = new Map(); // key → { event, kind, count, timer }

  function flushBucket(key) {
    const b = buckets.get(key);
    if (!b) return;
    buckets.delete(key);
    if (b.count > 1) {
      console.log(`[projection/github] coalesced ${b.count} events for ${key}; projecting most recent`);
    }
    if (b.kind === 'pr_reviewed') {
      projectReview(b.event).catch((err) => console.warn('[projection/github] review error:', err));
    } else {
      projectPR(b.event, b.kind).catch((err) => console.warn('[projection/github] pr error:', err));
    }
  }

  function bucketPR(event, kind) {
    const d = event.data;
    const key = `${d.repo}#${d.number}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.event = event;
      existing.kind = kind;
      existing.count += 1;
      // If we've seen MAX_BURST events for this PR, flush now even if the
      // debounce window hasn't expired — keeps lively repos feeling alive.
      if (existing.count >= MAX_BURST) {
        clearTimeout(existing.timer);
        flushBucket(key);
        return;
      }
      return;
    }
    const timer = setTimeout(() => flushBucket(key), debounceMs);
    timer.unref?.();
    buckets.set(key, { event, kind, count: 1, timer });
  }

  const unsubscribe = subscribe((event) => {
    try {
      if (!event || event.source !== 'github') return;
      // Skip historical bootstrap events — same convention as stripe_live.
      // The connector tags `pr_seen` / `workflow_run_seen` / `issue_seen`
      // for first-pass scans, plus an explicit `historical:true` for any
      // backfilled event.
      if (event.historical) return;
      const k = event.kind;
      if (k === 'pr_seen' || k === 'workflow_run_seen' || k === 'issue_seen') return;

      switch (k) {
        case 'pr_opened':
        case 'pr_review_requested':
        case 'pr_merged':
          bucketPR(event, k);
          return;
        case 'pr_reviewed':
          bucketPR(event, k);
          return;
        case 'workflow_run_failure':
          // No coalescing — CI failures are infrequent and high-signal.
          projectCIFailure(event);
          return;
        case 'release_published':
          projectRelease(event).catch((err) => console.warn('[projection/github] release error:', err));
          return;
        case 'notification_received':
          projectReviewRequest(event).catch((err) => console.warn('[projection/github] notif error:', err));
          return;
        default:
          // pr_updated, pr_closed, issue_*, commit_pushed, workflow_run_completed
          // (success path) all stay in the bus for hq_query / sprite layer
          // to consume but don't earn a card.
          return;
      }
    } catch (err) {
      console.warn('[projection/github] handler error:', err?.message || err);
    }
  });

  console.log('[projection/github] installed · listening for github events');

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { unsubscribe(); } catch {}
    for (const { timer } of buckets.values()) {
      try { clearTimeout(timer); } catch {}
    }
    buckets.clear();
    console.log('[projection/github] uninstalled');
  };
}

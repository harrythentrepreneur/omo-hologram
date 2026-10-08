// GitHub read-mostly connector for the Omo Data Core.
//
// Mirrors the stripe.js shape so the rest of the system (HQ panel, raw-text
// dump, MOMO snapshot, projection layer) gets a uniform surface:
//   start({ emit })                               — env-based boot
//   connect({ emit, token, repos })               — runtime connect from /hq
//   disconnect()                                  — stop polling
//   getStatus()                                   — current connection info
//   mountRoutes(app, { emit })                    — /omo/api/integrations/github/*
//
// Auth: GitHub Personal Access Token (classic or fine-grained). We accept
// any token shape — the shape varies wildly across the GH ecosystem and
// /user is the source of truth (200 = it works). The token never leaves
// the server; the browser only ever sees /omo/api/integrations/github/*.
//
// Repos are an explicit allowlist (`owner/repo, owner/repo, …`). We never
// touch repos outside that set, so a token with broader scope still only
// gets the work it was asked for.
//
// Polling: every GITHUB_POLL_MS we scan each repo for PR / workflow_run /
// release / issue deltas and emit them onto the bus. New events hit the
// projection layer (src/projection/github_live.js) and pop a card on the
// hologram. A cheap deep-resync every GITHUB_RESYNC_MS pulls everything
// (ignoring deltas) so persisted rows stay coherent.
//
// Webhook: when GITHUB_WEBHOOK_SECRET is set we also accept POSTs to
// /omo/api/integrations/github/webhook. Webhook events are tagged
// {via:'webhook'} and fast-pathed; the poll loop dedupes by external_id
// so the same event never fires twice.

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import * as integrationDb from '../store/integration_db.js';
import * as dataCore from '../data_core.js';

const API = 'https://api.github.com';
const POLL_INTERVAL_MS = parseInt(process.env.GITHUB_POLL_MS, 10) || 60_000;       // 1 min
const DEEP_RESYNC_MS = parseInt(process.env.GITHUB_RESYNC_MS, 10) || 1_800_000;    // 30 min
const PR_PAGE_LIMIT = 50;
const RUNS_PAGE_LIMIT = 30;
const COMMITS_PAGE_LIMIT = 20;
const RELEASES_PAGE_LIMIT = 10;
const ISSUES_PAGE_LIMIT = 30;
const NOTIFICATIONS_PAGE_LIMIT = 30;
const SEEN_CAP = 2000;
const USER_AGENT = 'omo-hologram (+https://github.com/omo)';

// Module-scope runtime so connect / disconnect / status flip at runtime.
let runtime = null;

// /summary cache (per-runtime). The HQ panel polls this every ~30s; the
// build does a few list reads + light aggregation. 20s TTL keeps it
// responsive without re-fetching on every HQ focus.
let _summaryCache = { at: 0, body: null };
const SUMMARY_TTL_MS = 20_000;
function invalidateSummary() { _summaryCache = { at: 0, body: null }; }

// ──────────────────────────────────────────────────────── utilities

function maskToken(t) {
  if (!t) return '';
  if (t.length <= 10) return t.slice(0, 3) + '…';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

function parseRepoList(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s))
    .slice(0, 50);
}

function isAuthError(err) {
  const s = err?.statusCode || err?.status;
  return s === 401 || s === 403;
}

function logErrorThrottled(rt, label, err) {
  const now = Date.now();
  if (!rt) return;
  if (now - rt.lastErrorLogAt < 60_000) return;
  rt.lastErrorLogAt = now;
  console.error(`[github] ${label}:`, err?.message || err);
}

// HTTP GET against the GitHub API with the runtime's PAT. Bubbles a non-2xx
// up as an Error with `.statusCode` so the auth-error guard above works.
// Pass `params` to append a querystring; we never pass tokens via URL.
async function ghFetch(rt, path, { params, method = 'GET', body } = {}) {
  if (!rt?.token) throw new Error('not connected');
  const u = new URL(API + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) u.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(u, {
    method,
    headers: {
      Authorization: `Bearer ${rt.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Track rate-limit headers so we can surface "X requests remaining"
  // in /status and so the poll loop can back off automatically when we're
  // close to the wall.
  const rem = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(rem)) rt.rateLimit = { remaining: rem, resetAt: Number.isFinite(reset) ? reset * 1000 : null, seenAt: Date.now() };

  if (!res.ok) {
    let txt = '';
    try { txt = (await res.text()).slice(0, 400); } catch {}
    const err = new Error(`github ${method} ${path} → ${res.status}${txt ? ': ' + txt : ''}`);
    err.statusCode = res.status;
    throw err;
  }
  // 204 No Content (e.g. successful merges)
  if (res.status === 204) return null;
  return res.json();
}

// ──────────────────────────────────────────────────────── shape adapters
// Translate GitHub API objects into:
//   1. an event for the data-core bus (pr_opened, ci_failed, …) — drives
//      sprites, projections, /hq feed, and Momo's hq_query;
//   2. a slimmed-down row for integration_db so the snapshot + plaintext
//      dump don't blow up on the full GraphQL-shaped JSON.

function slimPR(pr, repo) {
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,                       // open | closed
    merged: !!pr.merged_at,
    draft: !!pr.draft,
    repo: repo || `${pr.base?.repo?.owner?.login || ''}/${pr.base?.repo?.name || ''}`.replace(/^\//, ''),
    author: pr.user ? { login: pr.user.login, avatar_url: pr.user.avatar_url } : null,
    base: pr.base?.ref || null,
    head: pr.head?.ref || null,
    html_url: pr.html_url,
    body: typeof pr.body === 'string' ? pr.body.slice(0, 4000) : null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    requested_reviewers: Array.isArray(pr.requested_reviewers)
      ? pr.requested_reviewers.map((r) => ({ login: r.login, avatar_url: r.avatar_url })) : [],
    requested_teams: Array.isArray(pr.requested_teams)
      ? pr.requested_teams.map((t) => t.slug || t.name) : [],
    labels: Array.isArray(pr.labels) ? pr.labels.map((l) => l.name).filter(Boolean) : [],
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changed_files ?? null,
    comments: pr.comments ?? null,
    review_comments: pr.review_comments ?? null,
    mergeable_state: pr.mergeable_state || null,
  };
}

function slimWorkflowRun(run, repo) {
  if (!run) return null;
  return {
    id: run.id,
    name: run.name,
    workflow_id: run.workflow_id,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    event: run.event,
    status: run.status,           // queued | in_progress | completed
    conclusion: run.conclusion,    // success | failure | cancelled | skipped | neutral | timed_out
    run_number: run.run_number,
    run_attempt: run.run_attempt,
    created_at: run.created_at,
    updated_at: run.updated_at,
    actor: run.actor ? { login: run.actor.login, avatar_url: run.actor.avatar_url } : null,
    html_url: run.html_url,
    repo: repo || run.repository?.full_name || null,
  };
}

function slimRelease(rel, repo) {
  if (!rel) return null;
  return {
    id: rel.id,
    tag_name: rel.tag_name,
    name: rel.name,
    body: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : null,
    draft: !!rel.draft,
    prerelease: !!rel.prerelease,
    created_at: rel.created_at,
    published_at: rel.published_at,
    html_url: rel.html_url,
    author: rel.author ? { login: rel.author.login, avatar_url: rel.author.avatar_url } : null,
    repo: repo || null,
  };
}

function slimCommit(c, repo) {
  if (!c) return null;
  const a = c.commit?.author || {};
  return {
    sha: c.sha,
    message: typeof c.commit?.message === 'string' ? c.commit.message.slice(0, 1000) : '',
    author: { name: a.name || c.author?.login || null, email: a.email || null, login: c.author?.login || null, avatar_url: c.author?.avatar_url || null },
    committed_at: a.date || c.commit?.committer?.date || null,
    html_url: c.html_url,
    repo: repo || null,
  };
}

function slimIssue(issue, repo) {
  if (!issue) return null;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    repo: repo || null,
    author: issue.user ? { login: issue.user.login, avatar_url: issue.user.avatar_url } : null,
    body: typeof issue.body === 'string' ? issue.body.slice(0, 4000) : null,
    labels: Array.isArray(issue.labels) ? issue.labels.map((l) => l?.name || l).filter(Boolean) : [],
    comments: issue.comments ?? 0,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: issue.html_url,
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : [],
  };
}

// External-id stamps. Stable across re-fetches so upserts dedupe.
const idForPR = (repo, number) => `pr:${repo}#${number}`;
const idForRun = (repo, runId) => `run:${repo}#${runId}`;
const idForRelease = (repo, releaseId) => `rel:${repo}#${releaseId}`;
const idForCommit = (repo, sha) => `commit:${repo}#${sha}`;
const idForIssue = (repo, number) => `issue:${repo}#${number}`;
const idForNotification = (notifId) => `notif:${notifId}`;

// Plaintext renderers — one row at a time, used both at upsert time
// (stored on the row) and at dump time (concatenated). Keep them tight;
// the snapshot budget is 6-8KB across all kinds.

function renderPRPlaintext(p) {
  const lines = [
    `[#${p.number}] ${p.title}`,
    `  repo: ${p.repo}  ·  ${p.state}${p.merged ? ' · merged' : ''}${p.draft ? ' · draft' : ''}`,
    `  author: ${p.author?.login || '—'}  ·  ${p.head} → ${p.base}`,
  ];
  if (p.requested_reviewers?.length) lines.push(`  reviewers: ${p.requested_reviewers.map((r) => r.login).join(', ')}`);
  if (p.labels?.length) lines.push(`  labels: ${p.labels.join(', ')}`);
  if (p.additions != null) lines.push(`  diff: +${p.additions} −${p.deletions}  ·  ${p.changed_files} file(s)`);
  if (p.body) lines.push(`  body: ${p.body.slice(0, 240).replace(/\s+/g, ' ').trim()}`);
  if (p.html_url) lines.push(`  url: ${p.html_url}`);
  return lines.join('\n');
}

function renderRunPlaintext(r) {
  const conc = r.conclusion ? ` · ${r.conclusion}` : '';
  return [
    `[run ${r.run_number}] ${r.name}  ·  ${r.repo}`,
    `  status: ${r.status}${conc}  ·  branch: ${r.head_branch}  ·  ${r.event}`,
    `  actor: ${r.actor?.login || '—'}  ·  sha: ${(r.head_sha || '').slice(0, 7)}`,
    `  url: ${r.html_url}`,
  ].join('\n');
}

function renderReleasePlaintext(rel) {
  return [
    `[${rel.tag_name}] ${rel.name || rel.tag_name}  ·  ${rel.repo}`,
    `  ${rel.draft ? 'draft' : rel.prerelease ? 'prerelease' : 'published'}  ·  ${rel.published_at || rel.created_at}`,
    rel.author?.login ? `  by: ${rel.author.login}` : null,
    rel.body ? `  notes: ${rel.body.slice(0, 240).replace(/\s+/g, ' ').trim()}` : null,
  ].filter(Boolean).join('\n');
}

function renderCommitPlaintext(c) {
  const firstLine = (c.message || '').split('\n')[0].slice(0, 120);
  return [
    `[${(c.sha || '').slice(0, 7)}] ${firstLine}  ·  ${c.repo}`,
    `  author: ${c.author?.name || c.author?.login || '—'}  ·  ${c.committed_at || ''}`,
  ].join('\n');
}

function renderIssuePlaintext(i) {
  const lines = [
    `[#${i.number}] ${i.title}`,
    `  repo: ${i.repo}  ·  ${i.state}`,
    `  author: ${i.author?.login || '—'}`,
  ];
  if (i.labels?.length) lines.push(`  labels: ${i.labels.join(', ')}`);
  if (i.assignees?.length) lines.push(`  assignees: ${i.assignees.join(', ')}`);
  if (i.body) lines.push(`  body: ${i.body.slice(0, 200).replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────── persistence

async function persistPR(rt, repo, pr) {
  const slim = slimPR(pr, repo);
  if (!slim) return;
  try {
    await integrationDb.upsertMany([{
      source: 'github', kind: 'pr',
      external_id: idForPR(repo, slim.number),
      ts: new Date(slim.updated_at || slim.created_at || Date.now()),
      title: `#${slim.number} ${slim.title}`,
      summary: `${slim.repo} · ${slim.state}${slim.merged ? ' · merged' : ''} · ${slim.author?.login || '—'}`,
      plaintext: renderPRPlaintext(slim),
      data: slim,
    }]);
  } catch (err) { logErrorThrottled(rt, 'persist pr failed', err); }
}

async function persistRun(rt, repo, run) {
  const slim = slimWorkflowRun(run, repo);
  if (!slim) return;
  try {
    await integrationDb.upsertMany([{
      source: 'github', kind: 'workflow_run',
      external_id: idForRun(repo, slim.id),
      ts: new Date(slim.updated_at || slim.created_at || Date.now()),
      title: `${slim.name} #${slim.run_number}`,
      summary: `${slim.repo} · ${slim.status}${slim.conclusion ? ' · ' + slim.conclusion : ''} · ${slim.head_branch || ''}`,
      plaintext: renderRunPlaintext(slim),
      data: slim,
    }]);
  } catch (err) { logErrorThrottled(rt, 'persist run failed', err); }
}

async function persistRelease(rt, repo, rel) {
  const slim = slimRelease(rel, repo);
  if (!slim) return;
  try {
    await integrationDb.upsertMany([{
      source: 'github', kind: 'release',
      external_id: idForRelease(repo, slim.id),
      ts: new Date(slim.published_at || slim.created_at || Date.now()),
      title: `${slim.tag_name} ${slim.name ? '· ' + slim.name : ''}`.trim(),
      summary: `${slim.repo} · ${slim.draft ? 'draft' : slim.prerelease ? 'prerelease' : 'published'}`,
      plaintext: renderReleasePlaintext(slim),
      data: slim,
    }]);
  } catch (err) { logErrorThrottled(rt, 'persist release failed', err); }
}

async function persistCommit(rt, repo, c) {
  const slim = slimCommit(c, repo);
  if (!slim) return;
  try {
    await integrationDb.upsertMany([{
      source: 'github', kind: 'commit',
      external_id: idForCommit(repo, slim.sha),
      ts: new Date(slim.committed_at || Date.now()),
      title: (slim.message || '').split('\n')[0].slice(0, 140) || slim.sha,
      summary: `${slim.repo} · ${slim.author?.name || slim.author?.login || '—'}`,
      plaintext: renderCommitPlaintext(slim),
      data: slim,
    }]);
  } catch (err) { logErrorThrottled(rt, 'persist commit failed', err); }
}

async function persistIssue(rt, repo, issue) {
  const slim = slimIssue(issue, repo);
  if (!slim) return;
  try {
    await integrationDb.upsertMany([{
      source: 'github', kind: 'issue',
      external_id: idForIssue(repo, slim.number),
      ts: new Date(slim.updated_at || slim.created_at || Date.now()),
      title: `#${slim.number} ${slim.title}`,
      summary: `${slim.repo} · ${slim.state} · ${slim.author?.login || '—'}`,
      plaintext: renderIssuePlaintext(slim),
      data: slim,
    }]);
  } catch (err) { logErrorThrottled(rt, 'persist issue failed', err); }
}

// ──────────────────────────────────────────────────────── event emission

// Each function emits a fully-formed Data Core event and persists the
// underlying object. Callers have already deduped by external_id via the
// `seen` set so the same delta never fires twice.

async function emitPRDelta(rt, repo, pr, kind, extra = {}) {
  const slim = slimPR(pr, repo);
  if (!slim) return;
  await persistPR(rt, repo, pr);
  rt.emit({
    id: randomUUID(),
    source: 'github',
    kind,
    ts: Date.now(),
    title: `#${slim.number} ${slim.title}`,
    summary: `${repo} · ${slim.author?.login || '—'} · ${slim.head} → ${slim.base}`,
    data: { ...slim, ...extra },
  });
  rt.eventCount++;
  invalidateSummary();
}

async function emitRunDelta(rt, repo, run, kind) {
  const slim = slimWorkflowRun(run, repo);
  if (!slim) return;
  await persistRun(rt, repo, run);
  rt.emit({
    id: randomUUID(),
    source: 'github',
    kind,
    ts: Date.now(),
    title: `${slim.name} ${slim.conclusion || slim.status}`,
    summary: `${repo} · ${slim.head_branch || ''} · ${slim.actor?.login || ''}`.trim(),
    data: slim,
  });
  rt.eventCount++;
  invalidateSummary();
}

async function emitReleaseDelta(rt, repo, rel) {
  const slim = slimRelease(rel, repo);
  if (!slim) return;
  await persistRelease(rt, repo, rel);
  rt.emit({
    id: randomUUID(),
    source: 'github',
    kind: 'release_published',
    ts: Date.now(),
    title: `${repo} ${slim.tag_name}`,
    summary: slim.name || slim.tag_name,
    data: slim,
  });
  rt.eventCount++;
  invalidateSummary();
}

async function emitIssueDelta(rt, repo, issue, kind) {
  const slim = slimIssue(issue, repo);
  if (!slim) return;
  await persistIssue(rt, repo, issue);
  rt.emit({
    id: randomUUID(),
    source: 'github',
    kind,
    ts: Date.now(),
    title: `#${slim.number} ${slim.title}`,
    summary: `${repo} · ${slim.state} · ${slim.author?.login || ''}`.trim(),
    data: slim,
  });
  rt.eventCount++;
  invalidateSummary();
}

// ──────────────────────────────────────────────────────── repo polling
// One cheap pass per repo per tick. We list the most recent N items and
// dedupe against the per-runtime `seen` Map (external_id → updated_at).
// First-seen items emit `*_opened`, subsequent updates with a newer
// updated_at emit `*_updated`. Closed/merged transitions emit terminal
// kinds so the projection layer can pop the right card.

function rememberSeen(rt, key, updatedAt) {
  const prev = rt.seen.get(key) || 0;
  if (updatedAt && updatedAt <= prev) return false; // no change
  rt.seen.set(key, updatedAt || Date.now());
  rt.seenOrder.push(key);
  while (rt.seenOrder.length > SEEN_CAP) {
    const evicted = rt.seenOrder.shift();
    if (evicted) rt.seen.delete(evicted);
  }
  return true;
}

async function pollRepoPRs(rt, repo) {
  const list = await ghFetch(rt, `/repos/${repo}/pulls`, {
    params: { state: 'all', sort: 'updated', direction: 'desc', per_page: PR_PAGE_LIMIT },
  });
  if (!Array.isArray(list)) return;

  for (const pr of list) {
    const key = idForPR(repo, pr.number);
    const updatedAt = new Date(pr.updated_at || pr.created_at || Date.now()).getTime();
    if (!rememberSeen(rt, key, updatedAt)) continue;

    // First-pass classification: was this brand-new to us, or an update
    // to a known PR? If updated_at === created_at and the previous seen
    // value was 0, treat as open.
    const wasFresh = !rt.seenInitialized.has(key);
    rt.seenInitialized.add(key);
    if (!rt.bootstrapped) {
      // During the very first poll we tag everything historical so the
      // projection layer doesn't dump 30 PR cards onto the hologram.
      await emitPRDelta(rt, repo, pr, 'pr_seen', { historical: true });
      continue;
    }

    // Steady-state classification.
    if (pr.merged_at && pr.state === 'closed') {
      await emitPRDelta(rt, repo, pr, 'pr_merged');
    } else if (pr.state === 'closed') {
      await emitPRDelta(rt, repo, pr, 'pr_closed');
    } else if (wasFresh) {
      await emitPRDelta(rt, repo, pr, 'pr_opened');
    } else {
      await emitPRDelta(rt, repo, pr, 'pr_updated');
    }
  }
}

async function pollRepoRuns(rt, repo) {
  const data = await ghFetch(rt, `/repos/${repo}/actions/runs`, {
    params: { per_page: RUNS_PAGE_LIMIT },
  });
  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  for (const run of runs) {
    const key = idForRun(repo, run.id);
    const updatedAt = new Date(run.updated_at || run.created_at || Date.now()).getTime();
    if (!rememberSeen(rt, key, updatedAt)) continue;

    if (!rt.bootstrapped) {
      await emitRunDelta(rt, repo, { ...run, _historical: true }, 'workflow_run_seen');
      continue;
    }

    if (run.status === 'completed') {
      const failure = run.conclusion && run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'neutral';
      await emitRunDelta(rt, repo, run, failure ? 'workflow_run_failure' : 'workflow_run_completed');
    } else {
      await emitRunDelta(rt, repo, run, 'workflow_run_updated');
    }
  }
}

async function pollRepoReleases(rt, repo) {
  const list = await ghFetch(rt, `/repos/${repo}/releases`, { params: { per_page: RELEASES_PAGE_LIMIT } });
  if (!Array.isArray(list)) return;
  for (const rel of list) {
    const key = idForRelease(repo, rel.id);
    const updatedAt = new Date(rel.published_at || rel.created_at || Date.now()).getTime();
    if (!rememberSeen(rt, key, updatedAt)) continue;
    if (!rt.bootstrapped) { await persistRelease(rt, repo, rel); continue; }
    if (!rel.draft) await emitReleaseDelta(rt, repo, rel);
  }
}

async function pollRepoCommits(rt, repo) {
  const list = await ghFetch(rt, `/repos/${repo}/commits`, { params: { per_page: COMMITS_PAGE_LIMIT } });
  if (!Array.isArray(list)) return;
  for (const c of list) {
    // Commit "updated_at" doesn't really exist; use committed date as the
    // dedupe stamp. Only log on first sight, never re-emit.
    const key = idForCommit(repo, c.sha);
    if (rt.seen.has(key)) continue;
    rt.seen.set(key, Date.now());
    rt.seenOrder.push(key);
    while (rt.seenOrder.length > SEEN_CAP) rt.seen.delete(rt.seenOrder.shift());
    await persistCommit(rt, repo, c);
    if (rt.bootstrapped) {
      // Only emit a high-signal `commit_pushed` event for commits to the
      // default branch. Branch commits are too noisy for the bus — they
      // still get persisted (above) so commits-by-author analytics work.
      try {
        const branch = c?.commit?.tree?.sha ? c?.parents?.[0]?.sha : null; // weak signal — skip
      } catch {}
    }
  }
}

async function pollRepoIssues(rt, repo) {
  // Note: GitHub's /issues endpoint includes PRs by default; filter them out.
  const list = await ghFetch(rt, `/repos/${repo}/issues`, {
    params: { state: 'all', sort: 'updated', direction: 'desc', per_page: ISSUES_PAGE_LIMIT },
  });
  if (!Array.isArray(list)) return;
  for (const issue of list) {
    if (issue.pull_request) continue; // PR, not a true issue
    const key = idForIssue(repo, issue.number);
    const updatedAt = new Date(issue.updated_at || issue.created_at || Date.now()).getTime();
    if (!rememberSeen(rt, key, updatedAt)) continue;

    if (!rt.bootstrapped) {
      await emitIssueDelta(rt, repo, issue, 'issue_seen');
      continue;
    }
    if (issue.state === 'closed') {
      await emitIssueDelta(rt, repo, issue, 'issue_closed');
    } else if (!rt.seenInitialized.has(key)) {
      rt.seenInitialized.add(key);
      await emitIssueDelta(rt, repo, issue, 'issue_opened');
    } else {
      await emitIssueDelta(rt, repo, issue, 'issue_updated');
    }
  }
}

async function pollNotifications(rt) {
  // This pulls notifications across ALL repos on the user's account, not
  // just the allowlisted set. We accept that — the user usually wants to
  // hear about review-requested / mentioned across everything they care
  // about, not just the repos they explicitly enrolled.
  let list;
  try { list = await ghFetch(rt, `/notifications`, { params: { per_page: NOTIFICATIONS_PAGE_LIMIT, all: 'false' } }); }
  catch (err) { logErrorThrottled(rt, 'notifications pull failed', err); return; }
  if (!Array.isArray(list)) return;
  for (const n of list) {
    const key = idForNotification(n.id);
    const updatedAt = new Date(n.updated_at || Date.now()).getTime();
    if (!rememberSeen(rt, key, updatedAt)) continue;
    try {
      await integrationDb.upsertMany([{
        source: 'github', kind: 'notification',
        external_id: key,
        ts: new Date(n.updated_at || Date.now()),
        title: n.subject?.title || '(notification)',
        summary: `${n.repository?.full_name || ''} · ${n.reason} · ${n.subject?.type || ''}`.trim(),
        plaintext: `[${n.reason}] ${n.subject?.title || ''}\n  repo: ${n.repository?.full_name || '—'}\n  type: ${n.subject?.type || ''}\n  url: ${n.subject?.url || ''}`,
        data: {
          id: n.id,
          repo: n.repository?.full_name || null,
          reason: n.reason,
          subject: n.subject || null,
          unread: !!n.unread,
          updated_at: n.updated_at,
          url: n.subject?.url || null,
          html_url: n.subject?.html_url || null,
        },
      }]);
    } catch (err) { logErrorThrottled(rt, 'persist notification failed', err); }
    if (rt.bootstrapped) {
      rt.emit({
        id: randomUUID(),
        source: 'github',
        kind: 'notification_received',
        ts: Date.now(),
        title: n.subject?.title || '(notification)',
        summary: `${n.reason} · ${n.repository?.full_name || ''}`.trim(),
        data: {
          notification_id: n.id,
          repo: n.repository?.full_name || null,
          reason: n.reason,
          subject_type: n.subject?.type || null,
          url: n.subject?.url || null,
        },
      });
      rt.eventCount++;
    }
  }
}

// ──────────────────────────────────────────────────────── poll loop

async function tick(rt) {
  if (!runtime || runtime !== rt || rt.stopped) return;
  try {
    // Check rate-limit budget before issuing the next batch. If we have
    // <50 calls left, skip non-essential pulls until reset.
    const lowBudget = rt.rateLimit && rt.rateLimit.remaining != null && rt.rateLimit.remaining < 50;

    for (const repo of rt.repos) {
      if (rt.stopped) return;
      try { await pollRepoPRs(rt, repo); } catch (err) { if (isAuthError(err)) { disconnect(); return; } logErrorThrottled(rt, `pr poll ${repo}`, err); }
      try { await pollRepoRuns(rt, repo); } catch (err) { if (isAuthError(err)) { disconnect(); return; } logErrorThrottled(rt, `run poll ${repo}`, err); }
      if (!lowBudget) {
        try { await pollRepoIssues(rt, repo); } catch (err) { if (isAuthError(err)) { disconnect(); return; } logErrorThrottled(rt, `issue poll ${repo}`, err); }
        try { await pollRepoReleases(rt, repo); } catch (err) { if (isAuthError(err)) { disconnect(); return; } logErrorThrottled(rt, `release poll ${repo}`, err); }
        try { await pollRepoCommits(rt, repo); } catch (err) { if (isAuthError(err)) { disconnect(); return; } logErrorThrottled(rt, `commit poll ${repo}`, err); }
      }
    }
    if (!lowBudget) {
      try { await pollNotifications(rt); } catch (err) { if (isAuthError(err)) { disconnect(); return; } logErrorThrottled(rt, 'notifications poll', err); }
    }

    rt.lastPollAt = Date.now();
    if (!rt.bootstrapped) {
      rt.bootstrapped = true;
      console.log(`[github] bootstrap complete · ${rt.repos.length} repo(s) · ${rt.seen.size} item(s) seeded`);
    }
  } catch (err) {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(rt, 'tick failed', err);
  } finally {
    if (runtime === rt && !rt.stopped) {
      const interval = rt.rateLimit?.remaining != null && rt.rateLimit.remaining < 100
        ? POLL_INTERVAL_MS * 3
        : POLL_INTERVAL_MS;
      rt.pollTimer = setTimeout(() => tick(rt), interval);
      rt.pollTimer?.unref?.();
    }
  }
}

// ──────────────────────────────────────────────────────── connect

export async function connect({ emit, token, repos } = {}) {
  if (!token) throw new Error('connect: token required');
  const repoList = Array.isArray(repos) ? repos.filter(Boolean) : parseRepoList(repos);
  if (repoList.length === 0) throw new Error('connect: at least one repo required (e.g. "owner/repo")');

  // Probe /user with the token to validate auth + collect login.
  const probe = await fetch(`${API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    },
  });
  if (!probe.ok) {
    let txt = '';
    try { txt = (await probe.text()).slice(0, 200); } catch {}
    const err = new Error(`token validation failed (${probe.status})${txt ? ': ' + txt : ''}`);
    err.statusCode = probe.status;
    throw err;
  }
  const userJson = await probe.json();

  // Probe each repo to fail fast if a repo isn't accessible.
  const probedRepos = [];
  for (const repo of repoList) {
    try {
      const r = await fetch(`${API}/repos/${repo}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': USER_AGENT,
        },
      });
      if (r.ok) {
        const data = await r.json();
        probedRepos.push({ full_name: repo, default_branch: data?.default_branch || 'main', private: !!data?.private });
        try {
          await integrationDb.upsertMany([{
            source: 'github', kind: 'repo', external_id: `repo:${repo}`,
            ts: new Date(), title: data?.full_name || repo,
            summary: `${data?.private ? 'private' : 'public'} · default ${data?.default_branch || 'main'} · ${data?.description || ''}`.trim(),
            plaintext: `[${data?.full_name || repo}] ${data?.description || ''}\n  default branch: ${data?.default_branch || 'main'}\n  private: ${!!data?.private}\n  stars: ${data?.stargazers_count ?? 0}  ·  forks: ${data?.forks_count ?? 0}`,
            data: data || { full_name: repo },
          }]);
        } catch {}
      } else {
        console.warn(`[github] cannot access ${repo} (status ${r.status}) — skipping`);
      }
    } catch (err) {
      console.warn(`[github] probe ${repo} failed:`, err?.message || err);
    }
  }

  if (probedRepos.length === 0) {
    throw new Error('no accessible repos in allowlist');
  }

  // Tear down any prior runtime cleanly.
  if (runtime) disconnect();

  runtime = {
    token,
    tokenMask: maskToken(token),
    user: { login: userJson?.login, name: userJson?.name, avatar_url: userJson?.avatar_url },
    repos: probedRepos.map((r) => r.full_name),
    repoMeta: probedRepos,
    emit,
    connectedAt: Date.now(),
    stopped: false,
    pollTimer: null,
    resyncTimer: null,
    seen: new Map(),
    seenOrder: [],
    seenInitialized: new Set(),
    bootstrapped: false,
    rateLimit: null,
    eventCount: 0,
    lastPollAt: null,
    lastErrorLogAt: 0,
    pollIntervalMs: POLL_INTERVAL_MS,
    resyncIntervalMs: DEEP_RESYNC_MS,
  };

  console.log(`[github] connected · @${runtime.user.login} · ${runtime.repos.length} repo(s) · poll=${Math.round(POLL_INTERVAL_MS/1000)}s`);

  if (typeof dataCore.markSourceLive === 'function') dataCore.markSourceLive('github');

  // Kick the first tick immediately so the panel goes live without a wait.
  tick(runtime).catch((err) => {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(runtime, 'first tick failed', err);
  });

  // Periodic deep-resync that wipes the `seen` Map so every item is
  // re-evaluated. Catches events the poll missed during a network blip.
  runtime.resyncTimer = setInterval(() => {
    const rt = runtime;
    if (!rt || rt.stopped) return;
    rt.seen.clear();
    rt.seenOrder.length = 0;
    rt.bootstrapped = false;
    console.log('[github] scheduled deep resync starting');
    tick(rt).catch((err) => logErrorThrottled(rt, 'resync failed', err));
  }, DEEP_RESYNC_MS);
  runtime.resyncTimer?.unref?.();

  return getStatus();
}

export function disconnect() {
  if (!runtime) return;
  runtime.stopped = true;
  if (runtime.pollTimer) clearTimeout(runtime.pollTimer);
  if (runtime.resyncTimer) clearInterval(runtime.resyncTimer);
  console.log('[github] disconnected');
  runtime = null;
  invalidateSummary();
}

export function getStatus() {
  if (!runtime) {
    return {
      connected: false,
      has_token: !!process.env.GITHUB_TOKEN,
      env_repos: parseRepoList(process.env.GITHUB_REPOS),
      poll_interval_ms: POLL_INTERVAL_MS,
      resync_interval_ms: DEEP_RESYNC_MS,
    };
  }
  return {
    connected: true,
    user: runtime.user,
    token_mask: runtime.tokenMask,
    repos: runtime.repos,
    repo_meta: runtime.repoMeta,
    connected_at: runtime.connectedAt,
    last_poll_at: runtime.lastPollAt,
    event_count: runtime.eventCount,
    rate_limit: runtime.rateLimit,
    poll_interval_ms: runtime.pollIntervalMs,
    resync_interval_ms: runtime.resyncIntervalMs,
    webhook_configured: !!process.env.GITHUB_WEBHOOK_SECRET,
  };
}

// ──────────────────────────────────────────────────────── env-based boot

export async function start({ emit }) {
  const token = process.env.GITHUB_TOKEN;
  const repos = parseRepoList(process.env.GITHUB_REPOS);
  if (!token) {
    console.log('[github] skipped (no GITHUB_TOKEN)');
    return;
  }
  if (repos.length === 0) {
    console.log('[github] skipped (no GITHUB_REPOS — set comma-separated "owner/repo" allowlist)');
    return;
  }
  try {
    await connect({ emit, token, repos });
  } catch (err) {
    console.error('[github] start failed:', err?.message || err);
  }
}

// ──────────────────────────────────────────────────────── action helpers
// These are awaited by the action tools (pr_comment / pr_merge / pr_close).
// All routed through the runtime so they share auth + rate-limit accounting.

export async function postPRComment(repo, number, bodyText) {
  if (!runtime) throw new Error('github not connected');
  if (!repo || !number || !bodyText) throw new Error('repo + number + body required');
  // GitHub treats issue comments and PR comments uniformly through the
  // /issues/:n/comments endpoint (PR review comments are a different path).
  const json = await ghFetch(runtime, `/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: { body: String(bodyText) },
  });
  // Trigger an immediate re-poll of this PR so the comment count updates.
  pollRepoPRs(runtime, repo).catch(() => {});
  return { id: json?.id, html_url: json?.html_url, body: json?.body };
}

export async function mergePR(repo, number, { method = 'merge', commit_title, commit_message } = {}) {
  if (!runtime) throw new Error('github not connected');
  if (!repo || !number) throw new Error('repo + number required');
  const allowed = new Set(['merge', 'squash', 'rebase']);
  const m = allowed.has(method) ? method : 'merge';
  const json = await ghFetch(runtime, `/repos/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    body: { merge_method: m, commit_title, commit_message },
  });
  pollRepoPRs(runtime, repo).catch(() => {});
  return { merged: !!json?.merged, sha: json?.sha, message: json?.message };
}

export async function closeIssue(repo, number, { reopen = false } = {}) {
  if (!runtime) throw new Error('github not connected');
  if (!repo || !number) throw new Error('repo + number required');
  const json = await ghFetch(runtime, `/repos/${repo}/issues/${number}`, {
    method: 'PATCH',
    body: { state: reopen ? 'open' : 'closed' },
  });
  pollRepoIssues(runtime, repo).catch(() => {});
  return { number: json?.number, state: json?.state, html_url: json?.html_url };
}

// On-demand fetches (used by data tools — they don't pre-poll, the tools
// dispatch hits the API directly so the model gets fresh data).

export async function fetchPR(repo, number) {
  if (!runtime) throw new Error('github not connected');
  return ghFetch(runtime, `/repos/${repo}/pulls/${number}`);
}

export async function fetchPRDiff(repo, number) {
  if (!runtime) throw new Error('github not connected');
  // GitHub returns the unified diff when the Accept header is set.
  const u = `${API}/repos/${repo}/pulls/${number}`;
  const res = await fetch(u, {
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      Accept: 'application/vnd.github.v3.diff',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const err = new Error(`fetchPRDiff ${res.status}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.text();
}

export async function fetchPRFiles(repo, number) {
  if (!runtime) throw new Error('github not connected');
  return ghFetch(runtime, `/repos/${repo}/pulls/${number}/files`, { params: { per_page: 100 } });
}

export function listConfiguredRepos() {
  return runtime?.repos?.slice() || [];
}

export function isLive() { return !!runtime; }

// ──────────────────────────────────────────────────────── webhook receiver

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // timing-safe compare; both sides must be the same length.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// Translate a GitHub webhook event into our internal event shape AND
// trigger persistence. Webhook payloads are richer than the polling
// shapes (they include sender, action, etc.) so we keep useful fields
// alongside the slim view.
async function handleWebhookEvent(rt, eventName, payload) {
  if (!rt) return;
  const repo = payload?.repository?.full_name;
  switch (eventName) {
    case 'pull_request': {
      const action = payload.action;                  // opened|closed|reopened|edited|synchronize|review_requested|...
      const pr = payload.pull_request;
      if (!pr || !repo) return;
      let kind = `pr_${action}`;
      if (action === 'closed') kind = pr.merged ? 'pr_merged' : 'pr_closed';
      if (action === 'review_requested') kind = 'pr_review_requested';
      await emitPRDelta(rt, repo, pr, kind, { via: 'webhook' });
      // Important: invalidate seen so the next poll doesn't re-emit the
      // same delta as `pr_updated`.
      rt.seen.set(idForPR(repo, pr.number), new Date(pr.updated_at).getTime());
      return;
    }
    case 'pull_request_review': {
      const pr = payload.pull_request;
      if (!pr || !repo) return;
      await emitPRDelta(rt, repo, pr, 'pr_reviewed', {
        via: 'webhook',
        review_state: payload.review?.state,
        reviewer: payload.review?.user?.login,
        review_body: payload.review?.body || null,
      });
      return;
    }
    case 'workflow_run': {
      const run = payload.workflow_run;
      if (!run || !repo) return;
      let kind = 'workflow_run_updated';
      if (run.status === 'completed') {
        const failure = run.conclusion && run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'neutral';
        kind = failure ? 'workflow_run_failure' : 'workflow_run_completed';
      }
      await emitRunDelta(rt, repo, run, kind);
      rt.seen.set(idForRun(repo, run.id), new Date(run.updated_at || run.created_at).getTime());
      return;
    }
    case 'release': {
      const rel = payload.release;
      if (!rel || !repo || rel.draft) return;
      if (payload.action === 'published') await emitReleaseDelta(rt, repo, rel);
      return;
    }
    case 'issues': {
      const issue = payload.issue;
      if (!issue || !repo) return;
      let kind = `issue_${payload.action}`;
      if (payload.action === 'opened') kind = 'issue_opened';
      else if (payload.action === 'closed') kind = 'issue_closed';
      await emitIssueDelta(rt, repo, issue, kind);
      return;
    }
    case 'push': {
      // Treat push-to-default-branch as `commit_pushed`. GitHub sends
      // commits in `payload.commits`; persist each via slimCommit.
      const ref = payload.ref || '';
      const defaultBranch = payload.repository?.default_branch;
      const isDefault = ref === `refs/heads/${defaultBranch}`;
      if (!isDefault) return;
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      for (const c of commits) {
        const adapted = {
          sha: c.id,
          commit: { message: c.message, author: { date: c.timestamp, name: c.author?.name, email: c.author?.email } },
          author: { login: c.author?.username || null },
          html_url: c.url,
        };
        await persistCommit(rt, repo, adapted);
      }
      if (commits.length) {
        rt.emit({
          id: randomUUID(),
          source: 'github',
          kind: 'commit_pushed',
          ts: Date.now(),
          title: `${commits.length} commit${commits.length === 1 ? '' : 's'} → ${defaultBranch}`,
          summary: `${repo} · ${payload.pusher?.name || ''}`.trim(),
          data: {
            repo,
            ref,
            branch: defaultBranch,
            commit_count: commits.length,
            head: payload.head_commit ? { sha: payload.head_commit.id, message: payload.head_commit.message } : null,
            pusher: payload.pusher?.name || null,
          },
        });
        rt.eventCount++;
      }
      return;
    }
    case 'ping':
      return;
    default:
      // Unhandled event type — that's fine. Webhook configs often include
      // events we don't model yet (deployment, label, etc.). Persist a
      // raw row so they're at least queryable via /raw/github.
      try {
        await integrationDb.upsertMany([{
          source: 'github', kind: 'webhook_other',
          external_id: `wh:${eventName}:${payload?.delivery || randomUUID()}`,
          ts: new Date(),
          title: `${eventName} · ${payload?.action || ''}`.trim(),
          summary: repo || '',
          plaintext: `[${eventName}] action=${payload?.action || ''} repo=${repo || '—'}`,
          data: { event: eventName, action: payload?.action, repo },
        }]);
      } catch {}
      return;
  }
}

// ──────────────────────────────────────────────────────── routes

export function mountRoutes(app, { emit }) {
  // Webhook MUST come before any global json() so we can compute the
  // HMAC over the raw body bytes. Mounted with our own raw parser scoped
  // to this route only.
  app.post(
    '/omo/api/integrations/github/webhook',
    express.raw({ type: 'application/json', limit: '2mb' }),
    async (req, res) => {
      try {
        const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
        const sigOk = secret
          ? verifyWebhookSignature(req.body, req.headers['x-hub-signature-256'], secret)
          : false;
        if (!secret) return res.status(503).json({ ok: false, error: 'GITHUB_WEBHOOK_SECRET not configured' });
        if (!sigOk) return res.status(401).json({ ok: false, error: 'invalid signature' });

        const eventName = String(req.headers['x-github-event'] || '').toLowerCase();
        let payload;
        try { payload = JSON.parse(req.body.toString('utf8')); }
        catch { return res.status(400).json({ ok: false, error: 'invalid json' }); }

        if (!runtime) return res.status(202).json({ ok: true, note: 'connector not connected; ignoring' });

        // Fire-and-forget so we ack the delivery quickly. GitHub retries
        // on >10s response times.
        handleWebhookEvent(runtime, eventName, payload)
          .catch((err) => logErrorThrottled(runtime, `webhook ${eventName}`, err));

        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: err?.message || String(err) });
      }
    },
  );

  app.get('/omo/api/integrations/github/status', (_req, res) => {
    res.json(getStatus());
  });

  app.post('/omo/api/integrations/github/connect', express.json(), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const repos = req.body?.repos;
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
    try {
      const status = await connect({ emit, token, repos });
      res.json({ ok: true, status });
    } catch (err) {
      const code = err?.statusCode || 500;
      res.status(code >= 400 && code < 500 ? 400 : 500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/integrations/github/disconnect', (_req, res) => {
    disconnect();
    res.json({ ok: true });
  });

  // Manually kick a poll. ?prune=1 pre-deletes all github rows so the
  // result is a fresh pull.
  app.post('/omo/api/integrations/github/refresh', async (req, res) => {
    if (!runtime) return res.status(409).json({ ok: false, error: 'Not connected — connect first.' });
    const prune = req.query.prune === '1' || req.query.prune === 'true';
    try {
      if (prune) await integrationDb.pruneSource('github');
      runtime.seen.clear();
      runtime.seenOrder.length = 0;
      runtime.bootstrapped = false;
      tick(runtime).catch(() => {});
      res.json({ ok: true, status: getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Plaintext dump for /raw/github.
  app.get('/omo/api/integrations/github/plaintext', async (_req, res) => {
    try {
      const status = getStatus();
      const counts = await integrationDb.countsBySource('github');
      const total = Object.values(counts).reduce((s, n) => s + n, 0);
      const ageMin = (t) => (t ? Math.round((Date.now() - t) / 60000) + 'm ago' : '—');
      const header = [
        '='.repeat(72),
        'GITHUB DATA DUMP',
        `generated: ${new Date().toISOString()}`,
        status.connected
          ? `account: @${status.user?.login}  ·  ${status.repos.length} repo(s)`
          : `account: (connector not currently connected — showing last persisted data)`,
        status.connected ? `repos: ${status.repos.join(', ')}` : '',
        `last_poll: ${ageMin(status.last_poll_at)}  ·  rate-limit-remaining: ${status.rate_limit?.remaining ?? '—'}`,
        `rows: ${total} across ${Object.keys(counts).length} kind(s)`,
        '='.repeat(72),
        '',
      ].filter(Boolean).join('\n');
      const body = await integrationDb.plaintextBySource('github', {
        kindOrder: ['repo', 'pr', 'workflow_run', 'release', 'issue', 'commit', 'notification'],
        limitPerKind: 100,
        header,
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    } catch (err) {
      res.status(500).type('text/plain').send(`ERROR: ${err?.message || err}`);
    }
  });

  // Compact summary the HQ panel polls. KPIs + recent items + repo list.
  app.get('/omo/api/integrations/github/summary', async (_req, res) => {
    try {
      if (_summaryCache.body && Date.now() - _summaryCache.at < SUMMARY_TTL_MS) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(_summaryCache.body);
      }
      const status = getStatus();
      const repos = status.connected ? status.repos : [];
      const prRows = await integrationDb.listBySource('github', { kind: 'pr', limit: 200 });
      const runRows = await integrationDb.listBySource('github', { kind: 'workflow_run', limit: 100 });
      const issueRows = await integrationDb.listBySource('github', { kind: 'issue', limit: 100 });
      const releaseRows = await integrationDb.listBySource('github', { kind: 'release', limit: 30 });
      const commitRows = await integrationDb.listBySource('github', { kind: 'commit', limit: 60 });
      const notifRows = await integrationDb.listBySource('github', { kind: 'notification', limit: 30 });

      const prs = prRows.map((r) => r.data).filter(Boolean);
      const openPRs = prs.filter((p) => p.state === 'open');
      const drafts = openPRs.filter((p) => p.draft);
      const reviewable = openPRs.filter((p) => !p.draft);
      const myPRs = openPRs.filter((p) => p.author?.login === status.user?.login);
      const reviewerLogin = status.user?.login;
      const awaitingMyReview = openPRs.filter((p) => Array.isArray(p.requested_reviewers) && p.requested_reviewers.some((r) => r.login === reviewerLogin));

      // CI snapshot — bucket recent runs into pass/fail counts per repo.
      const runs = runRows.map((r) => r.data).filter(Boolean);
      const ciByRepo = {};
      for (const repo of repos) ciByRepo[repo] = { last: null, failing: 0, passing: 0 };
      for (const r of runs) {
        const repoBucket = ciByRepo[r.repo];
        if (!repoBucket) continue;
        if (!repoBucket.last) repoBucket.last = r;
        if (r.conclusion === 'success') repoBucket.passing += 1;
        else if (r.conclusion && r.conclusion !== 'skipped' && r.conclusion !== 'neutral') repoBucket.failing += 1;
      }

      const body = {
        connected: status.connected,
        user: status.user || null,
        repos,
        repo_meta: status.repo_meta || [],
        last_poll_at: status.last_poll_at || null,
        rate_limit: status.rate_limit || null,
        webhook_configured: !!status.webhook_configured,
        kpi: {
          open_prs: openPRs.length,
          drafts: drafts.length,
          ready_for_review: reviewable.length,
          my_open_prs: myPRs.length,
          awaiting_my_review: awaitingMyReview.length,
          ci_failing_repos: Object.values(ciByRepo).filter((b) => b.failing > 0 && (!b.last || b.last.conclusion !== 'success')).length,
          open_issues: issueRows.filter((r) => r.data?.state === 'open').length,
          unread_notifications: notifRows.filter((r) => r.data?.unread).length,
        },
        ci_by_repo: ciByRepo,
        recent_prs: prs.slice(0, 20),
        recent_runs: runs.slice(0, 20),
        recent_releases: releaseRows.map((r) => r.data).filter(Boolean).slice(0, 8),
        recent_commits: commitRows.map((r) => r.data).filter(Boolean).slice(0, 12),
        recent_notifications: notifRows.map((r) => r.data).filter(Boolean).slice(0, 12),
        counts: await integrationDb.countsBySource('github'),
      };
      _summaryCache = { at: Date.now(), body };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Fetch a single PR's diff + files for the review-agent flow.
  app.get('/omo/api/integrations/github/pr/:repo1/:repo2/:number', async (req, res) => {
    try {
      const repo = `${req.params.repo1}/${req.params.repo2}`;
      const number = Number(req.params.number);
      if (!Number.isFinite(number)) return res.status(400).json({ ok: false, error: 'invalid number' });
      const pr = await fetchPR(repo, number);
      const files = await fetchPRFiles(repo, number).catch(() => []);
      res.json({ ok: true, pr: slimPR(pr, repo), files });
    } catch (err) {
      const code = err?.statusCode || 500;
      res.status(code).json({ ok: false, error: err?.message || String(err) });
    }
  });
}

export const _internal = { runtime: () => runtime };

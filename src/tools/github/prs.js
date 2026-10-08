// list_prs — Momo's "show me the pull requests" tool.
//
// Reads from integration_db.gh.pr (populated by the connector + webhooks).
// Filters in-process so the model can ask for "open + waiting for my
// review" without a custom SQL endpoint per case. Returns a single
// dataset id (matches the universal data-tool contract) + a slim
// summary the model can quote without re-asking.

import * as integrationDb from '../../store/integration_db.js';
import * as store from '../../store/datasets.js';
import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'list_prs',
  description:
    "List pull requests across your connected GitHub repos. Pulls from the cached connector data — no live API call. Use for 'what PRs are open', 'show me Sarah's PRs', 'PRs waiting on my review', 'what merged this week'. Returns a dataset id you can hand to render_viz (use chart_type='pr_card' for a single PR or 'notification_card' for a list).",
  parameters: {
    type: 'object',
    properties: {
      state:    { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: "Default 'open'. 'merged' = closed AND merged." },
      repo:     { type: 'string', description: "Filter to one repo, e.g. 'owner/name'. Default: all configured repos." },
      author:   { type: 'string', description: 'Filter by author login (case-insensitive substring).' },
      reviewer: { type: 'string', description: "Filter to PRs requesting review from this login. Pass 'me' to use the connected account." },
      label:    { type: 'string', description: 'Filter by label (case-insensitive exact match).' },
      query:    { type: 'string', description: 'Substring matched against title and body.' },
      draft:    { type: 'boolean', description: 'true = drafts only, false = exclude drafts.' },
      limit:    { type: 'integer', minimum: 1, maximum: 50, description: 'Max rows (default 20).' },
    },
    additionalProperties: false,
  },
};

function matchString(haystack, needle) {
  if (!needle) return true;
  return String(haystack || '').toLowerCase().includes(String(needle).toLowerCase());
}

export async function run(args = {}) {
  const state = args.state || 'open';
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));

  const status = github.getStatus();
  const me = status?.user?.login || null;

  // Pull a generous slice from the DB then filter — github_db keeps PRs
  // small enough that this is cheap.
  const rows = await integrationDb.listBySource('github', { kind: 'pr', limit: 500 });
  const prs = rows.map((r) => r.data).filter(Boolean);

  let filtered = prs;
  if (state === 'open') filtered = filtered.filter((p) => p.state === 'open');
  else if (state === 'closed') filtered = filtered.filter((p) => p.state === 'closed' && !p.merged);
  else if (state === 'merged') filtered = filtered.filter((p) => !!p.merged);
  // 'all' → no state filter

  if (args.repo) filtered = filtered.filter((p) => String(p.repo || '').toLowerCase() === String(args.repo).toLowerCase());
  if (args.author) filtered = filtered.filter((p) => matchString(p.author?.login, args.author));
  if (args.reviewer) {
    const want = args.reviewer === 'me' ? me : args.reviewer;
    if (want) filtered = filtered.filter((p) => Array.isArray(p.requested_reviewers) && p.requested_reviewers.some((r) => r.login === want));
  }
  if (args.label) {
    const lbl = String(args.label).toLowerCase();
    filtered = filtered.filter((p) => Array.isArray(p.labels) && p.labels.some((l) => String(l).toLowerCase() === lbl));
  }
  if (args.draft === true) filtered = filtered.filter((p) => p.draft);
  else if (args.draft === false) filtered = filtered.filter((p) => !p.draft);
  if (args.query) {
    const q = String(args.query).toLowerCase();
    filtered = filtered.filter((p) =>
      String(p.title || '').toLowerCase().includes(q) ||
      String(p.body || '').toLowerCase().includes(q)
    );
  }

  // Newest update first.
  filtered.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  const trimmed = filtered.slice(0, limit);

  const id = store.put('github_prs', {
    prs: trimmed,
    filter: {
      state, repo: args.repo || null, author: args.author || null,
      reviewer: args.reviewer || null, label: args.label || null,
      query: args.query || null, draft: args.draft ?? null,
    },
    me,
    total_matched: filtered.length,
  });

  // Compact summary for the model: top 3 titles + counts.
  const sample = trimmed.slice(0, 3).map((p) => ({
    repo: p.repo,
    number: p.number,
    title: p.title,
    state: p.merged ? 'merged' : p.state,
    author: p.author?.login || null,
    draft: !!p.draft,
    awaiting_review: Array.isArray(p.requested_reviewers) ? p.requested_reviewers.map((r) => r.login) : [],
  }));

  return {
    id,
    count: trimmed.length,
    total_matched: filtered.length,
    state,
    repos: status?.repos || [],
    sample,
    summary:
      trimmed.length === 0
        ? `No ${state} PRs match those filters.`
        : `${trimmed.length} ${state} PR${trimmed.length === 1 ? '' : 's'} across ${(status?.repos || []).length} repo${(status?.repos || []).length === 1 ? '' : 's'}.`,
  };
}

// ─────────────────────────────────────────────────────────
// get_pr — single PR detail with files + diff stats. Used when Momo wants
// to render a pr_card or feed a review agent.

export const detailDefinition = {
  type: 'function',
  name: 'get_pr',
  description:
    "Fetch one pull request in detail (title, body, file stats, requested reviewers, latest CI status). Live API call so you always get fresh data. Pair with render_viz(chart_type='pr_card') to project it as a card.",
  parameters: {
    type: 'object',
    properties: {
      repo:   { type: 'string', description: "Owner/repo, e.g. 'acme/storefront'." },
      number: { type: 'integer', minimum: 1, description: 'PR number.' },
    },
    required: ['repo', 'number'],
    additionalProperties: false,
  },
};

export async function runDetail(args = {}) {
  if (!args.repo || !args.number) return { error: 'repo + number required' };
  if (!github.isLive()) return { error: 'github not connected — connect via /hq or set GITHUB_TOKEN' };

  let pr, files;
  try { pr = await github.fetchPR(args.repo, args.number); }
  catch (err) { return { error: err?.message || String(err) }; }
  try { files = await github.fetchPRFiles(args.repo, args.number); }
  catch { files = []; }

  const slim = {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged_at,
    draft: !!pr.draft,
    repo: args.repo,
    author: pr.user ? { login: pr.user.login, avatar_url: pr.user.avatar_url } : null,
    base: pr.base?.ref || null,
    head: pr.head?.ref || null,
    body: typeof pr.body === 'string' ? pr.body.slice(0, 4000) : null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    requested_reviewers: Array.isArray(pr.requested_reviewers)
      ? pr.requested_reviewers.map((r) => ({ login: r.login, avatar_url: r.avatar_url })) : [],
    labels: Array.isArray(pr.labels) ? pr.labels.map((l) => l.name).filter(Boolean) : [],
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changed_files ?? null,
    comments: pr.comments ?? null,
    review_comments: pr.review_comments ?? null,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable_state,
    html_url: pr.html_url,
    files: Array.isArray(files) ? files.slice(0, 30).map((f) => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions, changes: f.changes,
    })) : [],
  };

  const id = store.put('github_pr', slim);
  return {
    id,
    repo: slim.repo,
    number: slim.number,
    title: slim.title,
    state: slim.merged ? 'merged' : slim.state,
    author: slim.author?.login || null,
    additions: slim.additions,
    deletions: slim.deletions,
    files_changed: slim.changed_files,
    awaiting_review: slim.requested_reviewers.map((r) => r.login),
    summary: `#${slim.number} ${slim.title} · ${slim.state}${slim.merged ? ' · merged' : ''} · +${slim.additions ?? 0} −${slim.deletions ?? 0}`,
  };
}

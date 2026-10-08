// list_issues — GitHub issues (true issues, not PRs).
// Reads from integration_db.gh.issue. Filters in-process. Returns a
// dataset id; pair with render_viz(chart_type='notification_card') for
// the list or 'task_card' for a single issue.

import * as integrationDb from '../../store/integration_db.js';
import * as store from '../../store/datasets.js';
import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'list_issues',
  description:
    "List GitHub issues (excludes PRs) across connected repos. Use for 'what bugs are open', 'show me Sarah's issues', 'open issues with the security label'. Returns a dataset id you can hand to render_viz.",
  parameters: {
    type: 'object',
    properties: {
      state:    { type: 'string', enum: ['open', 'closed', 'all'], description: "Default 'open'." },
      repo:     { type: 'string', description: 'Filter to one repo (owner/name).' },
      author:   { type: 'string', description: 'Filter by author login (substring).' },
      assignee: { type: 'string', description: "Filter by assignee login. Pass 'me' to use the connected account." },
      label:    { type: 'string', description: 'Filter by label name (case-insensitive exact match).' },
      query:    { type: 'string', description: 'Substring matched against title and body.' },
      limit:    { type: 'integer', minimum: 1, maximum: 50, description: 'Max rows (default 20).' },
    },
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const state = args.state || 'open';
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const status = github.getStatus();
  const me = status?.user?.login || null;

  const rows = await integrationDb.listBySource('github', { kind: 'issue', limit: 500 });
  const issues = rows.map((r) => r.data).filter(Boolean);

  let filtered = issues;
  if (state === 'open') filtered = filtered.filter((i) => i.state === 'open');
  else if (state === 'closed') filtered = filtered.filter((i) => i.state === 'closed');
  if (args.repo) filtered = filtered.filter((i) => String(i.repo || '').toLowerCase() === String(args.repo).toLowerCase());
  if (args.author) filtered = filtered.filter((i) => String(i.author?.login || '').toLowerCase().includes(String(args.author).toLowerCase()));
  if (args.assignee) {
    const want = args.assignee === 'me' ? me : args.assignee;
    if (want) filtered = filtered.filter((i) => Array.isArray(i.assignees) && i.assignees.some((a) => String(a).toLowerCase() === String(want).toLowerCase()));
  }
  if (args.label) {
    const lbl = String(args.label).toLowerCase();
    filtered = filtered.filter((i) => Array.isArray(i.labels) && i.labels.some((l) => String(l).toLowerCase() === lbl));
  }
  if (args.query) {
    const q = String(args.query).toLowerCase();
    filtered = filtered.filter((i) =>
      String(i.title || '').toLowerCase().includes(q) ||
      String(i.body || '').toLowerCase().includes(q)
    );
  }

  filtered.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  const trimmed = filtered.slice(0, limit);

  const id = store.put('github_issues', {
    issues: trimmed,
    filter: {
      state, repo: args.repo || null, author: args.author || null,
      assignee: args.assignee || null, label: args.label || null, query: args.query || null,
    },
    me,
    total_matched: filtered.length,
  });

  const sample = trimmed.slice(0, 3).map((i) => ({
    repo: i.repo, number: i.number, title: i.title, state: i.state,
    author: i.author?.login || null, labels: i.labels || [],
  }));

  return {
    id,
    count: trimmed.length,
    total_matched: filtered.length,
    state,
    sample,
    summary: trimmed.length === 0
      ? `No ${state} issues match those filters.`
      : `${trimmed.length} ${state} issue${trimmed.length === 1 ? '' : 's'}.`,
  };
}

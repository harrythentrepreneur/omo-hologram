// list_repo_activity — recent commits + releases across configured repos.
// Used for "what shipped this week", "recent activity in <repo>",
// "any releases lately". Returns a dataset id suitable for
// render_viz(chart_type='timeline') or 'changelog_card' for a single
// release.

import * as integrationDb from '../../store/integration_db.js';
import * as store from '../../store/datasets.js';
import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'list_repo_activity',
  description:
    "Recent commits and releases across your connected GitHub repos. Use for 'what shipped this week', 'any new releases', 'who pushed last'. Returns a dataset id; pair with render_viz(chart_type='timeline') for a feed or 'changelog_card' for a single release.",
  parameters: {
    type: 'object',
    properties: {
      repo:    { type: 'string', description: 'Filter to one repo (owner/name).' },
      kind:    { type: 'string', enum: ['commits', 'releases', 'both'], description: "Default 'both'." },
      author:  { type: 'string', description: 'Filter by author login or display name (substring).' },
      since_minutes: { type: 'integer', minimum: 1, description: "Only items updated in the last N minutes. Default no limit." },
      limit:   { type: 'integer', minimum: 1, maximum: 60, description: 'Max items (default 30).' },
    },
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const limit = Math.max(1, Math.min(60, Number(args.limit) || 30));
  const kind = args.kind || 'both';
  const sinceMs = args.since_minutes ? Date.now() - Number(args.since_minutes) * 60_000 : 0;

  let commits = [], releases = [];
  if (kind === 'commits' || kind === 'both') {
    const rows = await integrationDb.listBySource('github', { kind: 'commit', limit: 500 });
    commits = rows.map((r) => ({ ...r.data, _kind: 'commit', _ts: r.data?.committed_at || r.ts })).filter((x) => x.sha);
  }
  if (kind === 'releases' || kind === 'both') {
    const rows = await integrationDb.listBySource('github', { kind: 'release', limit: 100 });
    releases = rows.map((r) => ({ ...r.data, _kind: 'release', _ts: r.data?.published_at || r.data?.created_at || r.ts })).filter((x) => x.id);
  }

  let merged = [...commits, ...releases];

  if (args.repo) merged = merged.filter((x) => String(x.repo || '').toLowerCase() === String(args.repo).toLowerCase());
  if (args.author) {
    const a = String(args.author).toLowerCase();
    merged = merged.filter((x) => {
      if (x._kind === 'commit') {
        return String(x.author?.name || '').toLowerCase().includes(a) || String(x.author?.login || '').toLowerCase().includes(a);
      }
      return String(x.author?.login || '').toLowerCase().includes(a);
    });
  }
  if (sinceMs) merged = merged.filter((x) => new Date(x._ts || 0).getTime() >= sinceMs);

  merged.sort((a, b) => new Date(b._ts || 0) - new Date(a._ts || 0));
  const trimmed = merged.slice(0, limit);

  const id = store.put('github_activity', {
    items: trimmed,
    commit_count: trimmed.filter((x) => x._kind === 'commit').length,
    release_count: trimmed.filter((x) => x._kind === 'release').length,
    filter: { repo: args.repo || null, kind, author: args.author || null, since_minutes: args.since_minutes || null },
  });

  const sample = trimmed.slice(0, 3).map((x) => x._kind === 'commit'
    ? { kind: 'commit', repo: x.repo, sha: (x.sha || '').slice(0, 7), message: (x.message || '').split('\n')[0].slice(0, 100), author: x.author?.name || x.author?.login || null }
    : { kind: 'release', repo: x.repo, tag: x.tag_name, name: x.name }
  );

  return {
    id,
    count: trimmed.length,
    commit_count: trimmed.filter((x) => x._kind === 'commit').length,
    release_count: trimmed.filter((x) => x._kind === 'release').length,
    repos: github.listConfiguredRepos(),
    sample,
    summary: trimmed.length === 0
      ? 'No recent activity in that window.'
      : `${trimmed.length} item${trimmed.length === 1 ? '' : 's'} · ${trimmed.filter((x) => x._kind === 'commit').length} commits, ${trimmed.filter((x) => x._kind === 'release').length} releases.`,
  };
}

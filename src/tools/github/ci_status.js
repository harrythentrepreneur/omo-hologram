// list_ci_runs — CI / GitHub Actions snapshot.
// Reads workflow_run rows from integration_db. Buckets by repo and
// classifies the most-recent state. The model uses this for "is anything
// red", "what failed last night", "is main green right now".

import * as integrationDb from '../../store/integration_db.js';
import * as store from '../../store/datasets.js';
import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'list_ci_runs',
  description:
    "List recent GitHub Actions workflow runs across connected repos. Use for 'is CI green', 'what failed', 'show me the deploy run'. Returns a dataset id; pair with render_viz(chart_type='status_ring') for a single repo or 'timeline'/'notification_card' for the run feed.",
  parameters: {
    type: 'object',
    properties: {
      repo:       { type: 'string', description: 'Filter to one repo (owner/name).' },
      branch:     { type: 'string', description: 'Filter to one branch.' },
      status:     { type: 'string', enum: ['failing', 'passing', 'in_progress', 'all'], description: "'failing' = most recent run failed, 'passing' = succeeded. Default 'all'." },
      limit:      { type: 'integer', minimum: 1, maximum: 50, description: 'Max runs (default 20).' },
    },
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const status = github.getStatus();

  const rows = await integrationDb.listBySource('github', { kind: 'workflow_run', limit: 500 });
  const runs = rows.map((r) => r.data).filter(Boolean);

  let filtered = runs;
  if (args.repo) filtered = filtered.filter((r) => String(r.repo || '').toLowerCase() === String(args.repo).toLowerCase());
  if (args.branch) filtered = filtered.filter((r) => String(r.head_branch || '') === String(args.branch));
  if (args.status === 'in_progress') filtered = filtered.filter((r) => r.status !== 'completed');
  else if (args.status === 'passing') filtered = filtered.filter((r) => r.status === 'completed' && r.conclusion === 'success');
  else if (args.status === 'failing') filtered = filtered.filter((r) => r.status === 'completed' && r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped' && r.conclusion !== 'neutral');

  filtered.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  const trimmed = filtered.slice(0, limit);

  // Per-repo health: most-recent run conclusion.
  const repoHealth = {};
  for (const repo of (status?.repos || [])) repoHealth[repo] = { last_conclusion: null, last_status: null, last_at: null, last_branch: null, name: null };
  for (const r of runs) {
    const bucket = repoHealth[r.repo];
    if (!bucket) continue;
    if (!bucket.last_at || new Date(r.updated_at || r.created_at) > new Date(bucket.last_at)) {
      bucket.last_at = r.updated_at || r.created_at;
      bucket.last_status = r.status;
      bucket.last_conclusion = r.conclusion;
      bucket.last_branch = r.head_branch;
      bucket.name = r.name;
    }
  }
  const failingRepos = Object.entries(repoHealth)
    .filter(([, b]) => b.last_conclusion && b.last_conclusion !== 'success' && b.last_conclusion !== 'skipped' && b.last_conclusion !== 'neutral')
    .map(([repo]) => repo);

  const id = store.put('github_ci_runs', {
    runs: trimmed,
    repo_health: repoHealth,
    failing_repos: failingRepos,
    filter: { repo: args.repo || null, branch: args.branch || null, status: args.status || 'all' },
  });

  const sample = trimmed.slice(0, 3).map((r) => ({
    repo: r.repo, name: r.name, run_number: r.run_number,
    branch: r.head_branch, status: r.status, conclusion: r.conclusion,
  }));

  return {
    id,
    count: trimmed.length,
    failing_repos: failingRepos,
    repo_health: repoHealth,
    sample,
    summary: failingRepos.length
      ? `${failingRepos.length} repo${failingRepos.length === 1 ? '' : 's'} failing CI: ${failingRepos.join(', ')}.`
      : trimmed.length
        ? `${trimmed.length} recent run${trimmed.length === 1 ? '' : 's'} · all green.`
        : 'No recent workflow runs.',
  };
}

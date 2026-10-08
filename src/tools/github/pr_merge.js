// merge_pr — merge a pull request. Hard-gated: Momo's persona says she
// must request approval (request_approval dial) before calling, and the
// connector itself only acts if the runtime is live + repo is in the
// allowlist. There's no "force" flag.

import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'merge_pr',
  description:
    "Merge a pull request. This is a destructive, public action — ALWAYS go through request_approval before calling. Returns the merge SHA on success. Will fail if checks haven't passed or the PR has unresolved conflicts.",
  parameters: {
    type: 'object',
    properties: {
      repo:           { type: 'string', description: 'Owner/repo.' },
      number:         { type: 'integer', minimum: 1, description: 'PR number.' },
      method:         { type: 'string', enum: ['merge', 'squash', 'rebase'], description: "Merge strategy. Default 'merge'." },
      commit_title:   { type: 'string', description: 'Merge commit title (squash/merge only).' },
      commit_message: { type: 'string', description: 'Merge commit body (squash/merge only).' },
    },
    required: ['repo', 'number'],
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  if (!args.repo || !args.number) return { error: 'repo + number required' };
  if (!github.isLive()) return { error: 'github not connected' };
  const allowed = github.listConfiguredRepos();
  if (allowed.length && !allowed.includes(args.repo)) {
    return { error: `repo '${args.repo}' not in connected allowlist (${allowed.join(', ')})` };
  }
  try {
    const result = await github.mergePR(args.repo, args.number, {
      method: args.method,
      commit_title: args.commit_title,
      commit_message: args.commit_message,
    });
    if (!result.merged) {
      return { error: result.message || 'merge failed', repo: args.repo, number: args.number };
    }
    return {
      ok: true,
      repo: args.repo,
      number: args.number,
      sha: result.sha,
      method: args.method || 'merge',
      summary: `${args.repo}#${args.number} merged (${(result.sha || '').slice(0, 7)}).`,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// close_issue — close (or reopen) a GitHub issue or pull request. Behind
// the same confirmation pattern as pr_merge / post_pr_comment.

import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'close_issue',
  description:
    "Close (or reopen) a GitHub issue or PR. Public action — confirm with the user before calling. Set reopen=true to flip a closed item back to open.",
  parameters: {
    type: 'object',
    properties: {
      repo:   { type: 'string', description: 'Owner/repo.' },
      number: { type: 'integer', minimum: 1, description: 'Issue or PR number.' },
      reopen: { type: 'boolean', description: 'Set true to reopen instead of close.' },
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
    const result = await github.closeIssue(args.repo, args.number, { reopen: !!args.reopen });
    return {
      ok: true,
      repo: args.repo,
      number: result.number,
      state: result.state,
      html_url: result.html_url,
      summary: `${args.repo}#${result.number} → ${result.state}.`,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

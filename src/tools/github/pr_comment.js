// post_pr_comment — drop a comment on a PR (or any issue) on the user's
// behalf. Behind a confirmation gate per the persona contract: Momo MUST
// read the body back to the user and wait for "yes" before calling.

import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'post_pr_comment',
  description:
    "Post a comment on a pull request (or any issue) in one of your connected repos. Always read the body back to the user and wait for confirmation before calling — this is visible to anyone watching the PR.",
  parameters: {
    type: 'object',
    properties: {
      repo:   { type: 'string', description: "Owner/repo, e.g. 'acme/storefront'." },
      number: { type: 'integer', minimum: 1, description: 'PR or issue number.' },
      body:   { type: 'string', description: 'Comment markdown. Keep it short and human.' },
    },
    required: ['repo', 'number', 'body'],
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  if (!args.repo || !args.number || !args.body) return { error: 'repo + number + body required' };
  if (!github.isLive()) return { error: 'github not connected — connect via /hq or set GITHUB_TOKEN' };

  // Soft repo-allowlist check. The connector's runtime owns the canonical
  // allowlist; we cross-check here so a hallucinated repo doesn't get a
  // 404 from the API after we've already announced "posting!".
  const allowed = github.listConfiguredRepos();
  if (allowed.length && !allowed.includes(args.repo)) {
    return { error: `repo '${args.repo}' not in connected allowlist (${allowed.join(', ')})` };
  }

  try {
    const result = await github.postPRComment(args.repo, args.number, args.body);
    return {
      ok: true,
      repo: args.repo,
      number: args.number,
      comment_id: result.id,
      html_url: result.html_url,
      summary: `Comment posted on ${args.repo}#${args.number}.`,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

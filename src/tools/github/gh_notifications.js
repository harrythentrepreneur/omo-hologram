// list_gh_notifications — GitHub's own notification feed across all repos
// the user has access to (review-requested, mentioned, assigned, etc.).
// Use for "anything pinging me", "review requests", "@mentions today".

import * as integrationDb from '../../store/integration_db.js';
import * as store from '../../store/datasets.js';
import * as github from '../../connectors/github.js';

export const definition = {
  type: 'function',
  name: 'list_gh_notifications',
  description:
    "List your GitHub notifications (review requests, @mentions, assignments) across all repos you can see — not just the configured allowlist. Use for 'is anyone pinging me on GitHub', 'what review requests do I have'. Returns a dataset id; pair with render_viz(chart_type='notification_card').",
  parameters: {
    type: 'object',
    properties: {
      reason:        { type: 'string', description: "Filter by notification reason: 'review_requested', 'mention', 'assign', 'team_mention', 'subscribed', 'state_change', 'comment'." },
      unread_only:   { type: 'boolean', description: 'Default true.' },
      since_minutes: { type: 'integer', minimum: 1, description: "Only events in the last N minutes." },
      limit:         { type: 'integer', minimum: 1, maximum: 50, description: 'Max rows (default 20).' },
    },
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const unreadOnly = args.unread_only !== false;
  const sinceMs = args.since_minutes ? Date.now() - Number(args.since_minutes) * 60_000 : 0;

  const rows = await integrationDb.listBySource('github', { kind: 'notification', limit: 200 });
  const notifications = rows.map((r) => r.data).filter(Boolean);

  let filtered = notifications;
  if (args.reason) filtered = filtered.filter((n) => n.reason === args.reason);
  if (unreadOnly) filtered = filtered.filter((n) => !!n.unread);
  if (sinceMs) filtered = filtered.filter((n) => new Date(n.updated_at || 0).getTime() >= sinceMs);

  filtered.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  const trimmed = filtered.slice(0, limit);

  const id = store.put('github_notifications', {
    notifications: trimmed,
    filter: { reason: args.reason || null, unread_only: unreadOnly, since_minutes: args.since_minutes || null },
    total_matched: filtered.length,
  });

  const sample = trimmed.slice(0, 3).map((n) => ({
    reason: n.reason, repo: n.repo, type: n.subject?.type, title: n.subject?.title,
  }));

  return {
    id,
    count: trimmed.length,
    total_matched: filtered.length,
    sample,
    user: github.getStatus()?.user || null,
    summary: trimmed.length === 0
      ? 'No matching GitHub notifications.'
      : `${trimmed.length} notification${trimmed.length === 1 ? '' : 's'} · ${[...new Set(trimmed.map((n) => n.reason))].join(', ')}.`,
  };
}

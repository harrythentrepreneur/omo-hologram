// render_notification — a small ambient notification pill that slides in
// from offscreen, lives for a bounded TTL, then slides out. Unlike
// render_viz, this isn't an iframe: the client projectable renders the
// pill from meta so the transition is smooth and there's no document
// boot. A dataset is still stored in parallel so the same payload can be
// projected through render_viz (via the `notification_pill` kitchen
// template) if Momo ever wants the iframe form factor.

import * as datasets from '../../store/datasets.js';
import * as projectables from '../../store/projectables.js';

const ICONS   = new Set(['email', 'bell', 'check', 'warn']);
const ACCENTS = new Set(['cyan', 'pink', 'amber']);

const MAX_TITLE_LEN  = 40;
const MAX_DETAIL_LEN = 120;
const DEFAULT_TTL_MS = 4500;
const MAX_TTL_MS     = 15_000;  // longer than this belongs in a status or chart
const MIN_TTL_MS     = 800;

export const definition = {
  type: 'function',
  name: 'render_notification',
  description:
    'Slide a small notification pill into the upper-right of the hologram — ephemeral, auto-dismisses. Use for ambient glance info: a new email just arrived, a task just finished, a reminder fired. Title is the short label, detail is one line of context. Icon picks the glyph (email/bell/check/warn), accent picks the colour (cyan/pink/amber). Do not narrate after — the pill speaks for itself.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `Short uppercase-ish label, ≤${MAX_TITLE_LEN} chars. e.g. "NEW EMAIL", "TASK DONE", "REMINDER". Chinese OK.`,
      },
      detail: {
        type: 'string',
        description: `One-line context under the title, ≤${MAX_DETAIL_LEN} chars. e.g. "From Stripe · $2,410 payout", "Pomodoro finished".`,
      },
      icon: {
        type: 'string',
        enum: ['email', 'bell', 'check', 'warn'],
        description: "Glyph in the left badge. Defaults to 'bell'.",
      },
      accent: {
        type: 'string',
        enum: ['cyan', 'pink', 'amber'],
        description: "Accent colour. cyan=neutral/info (default), pink=attention, amber=caution.",
      },
      ttl_ms: {
        type: 'integer',
        description: `How long the pill lives before sliding out. Default ${DEFAULT_TTL_MS}ms, min ${MIN_TTL_MS}ms, max ${MAX_TTL_MS}ms.`,
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const title = String(args?.title || '').trim().slice(0, MAX_TITLE_LEN);
  if (!title) return { error: 'title is required' };
  const detail = String(args?.detail || '').trim().slice(0, MAX_DETAIL_LEN);

  const icon   = ICONS.has(args?.icon)    ? args.icon    : 'bell';
  const accent = ACCENTS.has(args?.accent) ? args.accent : 'cyan';

  let ttl_ms = Number.isInteger(args?.ttl_ms) ? args.ttl_ms : DEFAULT_TTL_MS;
  if (ttl_ms < MIN_TTL_MS) ttl_ms = MIN_TTL_MS;
  if (ttl_ms > MAX_TTL_MS) ttl_ms = MAX_TTL_MS;

  const payload = { title, detail, icon, accent, ttl_ms };
  const dataset_id = datasets.put('notification_pill', payload);

  const projectable_id = projectables.put('notification', {
    meta: { title, detail, icon, accent, ttl_ms, dataset_id },
  });

  return {
    projectable_id,
    kind: 'notification',
    dataset_id,
    title,
    detail,
    icon,
    accent,
    ttl_ms,
    note: 'Notification is sliding in and will auto-dismiss. Do not narrate unless the user asks.',
  };
}

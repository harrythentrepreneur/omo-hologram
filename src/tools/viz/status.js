// render_status — Momo projects a small status card inside her hologram.
// Not for thinking-during-a-tool-call (that's client-side, doesn't need a
// round-trip). This tool is for moments where Momo herself wants to
// surface a status artifact: task complete flourish, incoming email
// preview, calendar next-up, alert. Returns a projectable_id against the
// unified store; client mounts via kind-based dispatch.

import * as projectables from '../../store/projectables.js';

const VALID_VARIANTS = new Set(['thinking', 'complete', 'incoming', 'alert']);

// Keep the allowed text bounded. Status cards are glanceable; long prose
// belongs in a media projectable, not a status chip.
const MAX_TITLE_LEN = 32;
const MAX_DETAIL_LEN = 96;

export const definition = {
  type: 'function',
  name: 'render_status',
  description:
    'Project a small status card inside the hologram — use for "done!" flourishes after you finish a task, short notification previews (new email, next calendar event), or attention flags. Not for indicating you are thinking mid-tool-call (the UI handles that automatically). Title is a short uppercase label; detail is one line of context.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `Uppercase label, ≤${MAX_TITLE_LEN} chars. e.g. "DONE", "NEW EMAIL", "NEXT UP", "HEADS UP". Chinese OK.`,
      },
      detail: {
        type: 'string',
        description: `One-line context under the title, ≤${MAX_DETAIL_LEN} chars. e.g. "3 orders synced", "From Stripe · $2,410 payout", "Call with Sam at 4pm".`,
      },
      variant: {
        type: 'string',
        enum: ['thinking', 'complete', 'incoming', 'alert'],
        description: "Visual accent. complete=cyan-green check, incoming=cyan envelope, alert=pink warn. Default 'complete'.",
      },
      ttl_ms: {
        type: 'integer',
        description: 'Optional auto-dismiss timeout in ms. Omit for manual dismiss.',
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
  const variantRaw = String(args?.variant || 'complete').trim();
  const variant = VALID_VARIANTS.has(variantRaw) ? variantRaw : 'complete';
  const ttl_ms = Number.isInteger(args?.ttl_ms) && args.ttl_ms > 0
    ? Math.min(args.ttl_ms, 30_000)   // cap at 30s; longer would linger
    : undefined;

  const projectable_id = projectables.put('status', {
    meta: { title, detail, variant, ttl_ms },
  });

  return {
    projectable_id,
    kind: 'status',
    title,
    detail,
    variant,
    ttl_ms,
    note: 'Status card is flashing on stage. Narrate briefly if it warrants it, or say nothing — the card already speaks.',
  };
}

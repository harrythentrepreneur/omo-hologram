// request_approval — put an approval dial on the hologram before Momo
// runs a destructive or irreversible action. The UI is voice-driven; the
// dial is purely a visual cue that "I'm waiting for your confirm." Call
// this, narrate the ask, and then wait for the user to say "confirm"
// (or "cancel") before running the actual destructive tool.

import { renderViz } from '../../kitchen/index.js';
import * as datasets from '../../store/datasets.js';
import * as projectables from '../../store/projectables.js';
import { SIZES } from '../../sizes.js';

const MAX_ACTION_LEN = 64;
const MAX_DETAIL_LEN = 160;
const VALID_RISKS = new Set(['low', 'med', 'high']);

export const definition = {
  type: 'function',
  name: 'request_approval',
  description:
    'Show an approval dial on the hologram before you run a destructive or irreversible action (sending money, deleting bulk data, sending an email on the user\'s behalf). Pass the action line ("Send $500 to Sam", "Delete 12 emails"), a one-line detail, and a risk level. Then narrate the ask and WAIT for the user to say "confirm" or "cancel" before running the underlying tool. Returns a viz_id that mounts automatically.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: `Headline verb-phrase of the action, ≤${MAX_ACTION_LEN} chars. e.g. "Send $500 to Sam", "Delete 12 emails".`,
      },
      detail: {
        type: 'string',
        description: `One line of clarifying context, ≤${MAX_DETAIL_LEN} chars. e.g. "Transfer will clear today", "This is permanent".`,
      },
      risk: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: "low=cyan (routine), med=amber (meaningful, default), high=pink (destructive/irreversible).",
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const action = String(args?.action || '').trim().slice(0, MAX_ACTION_LEN);
  if (!action) return { error: 'action is required' };
  const detail = args?.detail ? String(args.detail).trim().slice(0, MAX_DETAIL_LEN) : '';
  const risk = VALID_RISKS.has(String(args?.risk || '').toLowerCase())
    ? String(args.risk).toLowerCase()
    : 'med';

  const payload = { action, detail, risk };
  const dataset_id = datasets.put('approval_dial', payload);
  const intent = action;
  const size = SIZES.square;

  let result;
  try {
    result = await renderViz({
      intent,
      data_refs: [dataset_id],
      size,
      chart_type: 'approval_dial',
    });
  } catch (err) {
    return { error: `approval render failed: ${err?.message || err}` };
  }
  if (!result.ok) return { error: result.error };

  const projectable_id = projectables.put('chart', {
    payload: result.html,
    meta: { intent, fingerprint: result.fingerprint, chart_type: result.chart_type, size: 'square' },
  });

  return {
    projectable_id,
    kind: 'chart',
    viz_id: projectable_id,
    dataset_id,
    size: 'square',
    width: size.width,
    height: size.height,
    chart_type: result.chart_type,
    cached: result.cached,
    action,
    risk,
    note: 'Approval dial is up. State the action once and WAIT — do not run the destructive tool until the user says "confirm" (or equivalent). If they say cancel, dismiss and drop it.',
  };
}

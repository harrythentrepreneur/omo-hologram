// show_qr — render a QR-style code on the hologram stage. One call:
// stores the dataset, renders through the kitchen against the
// `qr_code` template, and publishes a chart projectable. Momo doesn't
// have to chain render_viz afterwards — the viz_id comes back ready to
// mount.

import { renderViz } from '../../kitchen/index.js';
import * as datasets from '../../store/datasets.js';
import * as projectables from '../../store/projectables.js';
import { SIZES } from '../../sizes.js';

const MAX_DATA_LEN    = 512;   // keep it reasonable; demo QR, not a whitepaper
const MAX_CAPTION_LEN = 48;
const MAX_SUBTITLE_LEN = 48;

export const definition = {
  type: 'function',
  name: 'show_qr',
  description:
    'Render a QR-style code on the hologram stage for a URL, payment string, or handoff token. Pass the string to encode plus an optional caption (headline under the code). Returns a viz_id — the card mounts automatically, narrate what the code is for in one short line.',
  parameters: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: `The string to encode (URL, payment URI, handoff token). ≤${MAX_DATA_LEN} chars.`,
      },
      caption: {
        type: 'string',
        description: `Optional short headline under the code, ≤${MAX_CAPTION_LEN} chars. e.g. "Pay $12.40", "Join room".`,
      },
      subtitle: {
        type: 'string',
        description: `Optional second line under the caption, ≤${MAX_SUBTITLE_LEN} chars. e.g. "Valid 10 min".`,
      },
    },
    required: ['data'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const data = String(args?.data || '').trim().slice(0, MAX_DATA_LEN);
  if (!data) return { error: 'data is required' };
  const caption  = args?.caption  ? String(args.caption).trim().slice(0, MAX_CAPTION_LEN)   : '';
  const subtitle = args?.subtitle ? String(args.subtitle).trim().slice(0, MAX_SUBTITLE_LEN) : '';

  const dataset_id = datasets.put('qr_code', { data, caption, subtitle });
  const intent = caption || 'SCAN';
  const size = SIZES.square;

  let result;
  try {
    result = await renderViz({
      intent,
      data_refs: [dataset_id],
      size,
      chart_type: 'qr_code',
    });
  } catch (err) {
    return { error: `qr render failed: ${err?.message || err}` };
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
    caption,
    note: 'QR card is being mounted on stage. Tell the user what the code is for in one short line.',
  };
}

// show_map — render a stylised location card on the hologram stage.
// Not a real tile map: a cyan grid + pulse-dotted pin + label + address
// that reads as "place here" without any network fetch or off-palette
// imagery. One call: stores dataset, renders through the kitchen,
// publishes a chart projectable.

import { renderViz } from '../../kitchen/index.js';
import * as datasets from '../../store/datasets.js';
import * as projectables from '../../store/projectables.js';
import { SIZES } from '../../sizes.js';

const MAX_LABEL_LEN   = 48;
const MAX_ADDRESS_LEN = 120;

export const definition = {
  type: 'function',
  name: 'show_map',
  description:
    'Render a stylised location card on the hologram stage — a pin + label + address. Not a real-time map; this is a holographic prop for "the place is here" moments. Pass the place label and optionally the address + coordinates. Returns a viz_id — the card mounts automatically.',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: `Place title, ≤${MAX_LABEL_LEN} chars. e.g. "Monmouth Coffee", "My office".`,
      },
      address: {
        type: 'string',
        description: `Optional street address under the label, ≤${MAX_ADDRESS_LEN} chars.`,
      },
      lat: {
        type: 'number',
        description: 'Optional latitude (decimal degrees). Shown as a mono tag on the card.',
      },
      lng: {
        type: 'number',
        description: 'Optional longitude (decimal degrees). Shown as a mono tag on the card.',
      },
    },
    required: ['label'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const label = String(args?.label || '').trim().slice(0, MAX_LABEL_LEN);
  if (!label) return { error: 'label is required' };

  const address = args?.address ? String(args.address).trim().slice(0, MAX_ADDRESS_LEN) : '';
  const lat = Number.isFinite(Number(args?.lat)) ? Number(args.lat) : null;
  const lng = Number.isFinite(Number(args?.lng ?? args?.lon)) ? Number(args.lng ?? args.lon) : null;

  const dataset_id = datasets.put('map_snippet', { label, address, lat, lng });
  const intent = label;
  const size = SIZES.wide;

  let result;
  try {
    result = await renderViz({
      intent,
      data_refs: [dataset_id],
      size,
      chart_type: 'map_snippet',
    });
  } catch (err) {
    return { error: `map render failed: ${err?.message || err}` };
  }
  if (!result.ok) return { error: result.error };

  const projectable_id = projectables.put('chart', {
    payload: result.html,
    meta: { intent, fingerprint: result.fingerprint, chart_type: result.chart_type, size: 'wide' },
  });

  return {
    projectable_id,
    kind: 'chart',
    viz_id: projectable_id,
    dataset_id,
    size: 'wide',
    width: size.width,
    height: size.height,
    chart_type: result.chart_type,
    cached: result.cached,
    label,
    note: 'Map card is mounting on stage. Mention the place in one short sentence if it warrants it.',
  };
}

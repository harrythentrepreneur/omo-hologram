// render_timer — snapshot a countdown ring on the hologram. The ring is
// static at call time: if the user wants the digits to tick live, we'd
// wire a client JS loop, which is out of scope. Callers refresh by
// invoking the tool again; every call stores a fresh dataset so the
// cache key rotates and a new snapshot mounts cleanly.

import { renderViz } from '../../kitchen/index.js';
import * as datasets from '../../store/datasets.js';
import * as projectables from '../../store/projectables.js';
import { SIZES } from '../../sizes.js';

const MAX_LABEL_LEN = 40;
const MAX_DURATION_SEC = 24 * 60 * 60;   // 24h cap; longer timers feel abusive
const MIN_DURATION_SEC = 1;

export const definition = {
  type: 'function',
  name: 'render_timer',
  description:
    'Render a countdown timer ring on the hologram stage. Pass a short label ("Pomodoro", "Bake", "Focus") and duration in seconds. The ring is a static snapshot: call again to refresh if the user wants to see elapsed time update. Returns a viz_id — the card mounts automatically.',
  parameters: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: `Short uppercase label, ≤${MAX_LABEL_LEN} chars. e.g. "Pomodoro", "Focus", "Bake".`,
      },
      duration_sec: {
        type: 'integer',
        description: `Total duration in seconds. Min ${MIN_DURATION_SEC}, max ${MAX_DURATION_SEC} (24h).`,
      },
      remaining_sec: {
        type: 'integer',
        description: 'Optional seconds remaining at snapshot time. Defaults to duration_sec (i.e. just-started).',
      },
    },
    required: ['label', 'duration_sec'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const label = String(args?.label || '').trim().slice(0, MAX_LABEL_LEN);
  if (!label) return { error: 'label is required' };

  let totalSec = Number.isInteger(args?.duration_sec) ? args.duration_sec : Number(args?.duration_sec);
  totalSec = Math.floor(totalSec);
  if (!Number.isFinite(totalSec) || totalSec < MIN_DURATION_SEC) return { error: `duration_sec must be ≥ ${MIN_DURATION_SEC}` };
  if (totalSec > MAX_DURATION_SEC) totalSec = MAX_DURATION_SEC;

  let remainingSec = Number.isInteger(args?.remaining_sec)
    ? args.remaining_sec
    : totalSec;
  if (!Number.isFinite(remainingSec) || remainingSec < 0) remainingSec = 0;
  if (remainingSec > totalSec) remainingSec = totalSec;

  const startedAt = new Date(Date.now() - (totalSec - remainingSec) * 1000).toISOString();
  const elapsedPct = totalSec > 0 ? (1 - (remainingSec / totalSec)) * 100 : 0;

  const payload = {
    label,
    totalSec,
    remainingSec,
    startedAt,
    elapsedPct,
  };

  const dataset_id = datasets.put('timer_ring', payload);
  const intent = label;
  const size = SIZES.square;

  let result;
  try {
    result = await renderViz({
      intent,
      data_refs: [dataset_id],
      size,
      chart_type: 'timer_ring',
    });
  } catch (err) {
    return { error: `timer render failed: ${err?.message || err}` };
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
    label,
    total_sec: totalSec,
    remaining_sec: remainingSec,
    elapsed_pct: Math.round(elapsedPct),
    note: 'Timer is on stage. Say something short like "time is running" — keep it light.',
  };
}

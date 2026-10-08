// render_now_playing — the "music is on" card. Cover art, track, artist,
// album, progress bar snapshot. One call renders through the kitchen
// and mounts on stage.

import { renderViz } from '../../kitchen/index.js';
import * as datasets from '../../store/datasets.js';
import * as projectables from '../../store/projectables.js';
import { SIZES } from '../../sizes.js';

const MAX_TRACK_LEN  = 80;
const MAX_ARTIST_LEN = 80;
const MAX_ALBUM_LEN  = 80;
const MAX_COVER_LEN  = 512;

function sanitiseCover(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (s.length > MAX_COVER_LEN) return null;
  // CSP img-src only allows data:/https:; the template also filters, but
  // stripping early lets us return a clean summary.
  if (!/^https:\/\/[^\s<>"']+$/i.test(s)) return null;
  return s;
}

export const definition = {
  type: 'function',
  name: 'render_now_playing',
  description:
    'Render a "now playing" music card on the hologram stage — cover art, track title, artist, album, progress. Static snapshot at call time; call again to update progress. Returns a viz_id that mounts automatically.',
  parameters: {
    type: 'object',
    properties: {
      track: {
        type: 'string',
        description: `Song title, ≤${MAX_TRACK_LEN} chars.`,
      },
      artist: {
        type: 'string',
        description: `Artist name, ≤${MAX_ARTIST_LEN} chars.`,
      },
      album: {
        type: 'string',
        description: `Optional album name, ≤${MAX_ALBUM_LEN} chars.`,
      },
      cover_url: {
        type: 'string',
        description: 'Optional https album-art URL. Anything else is ignored; a fallback gradient renders in its place.',
      },
      progress_sec: {
        type: 'integer',
        description: 'Seconds elapsed into the track (≥ 0). Omit to render with a zeroed progress bar.',
      },
      duration_sec: {
        type: 'integer',
        description: 'Track length in seconds (> 0). Needed to draw the progress bar.',
      },
    },
    required: ['track', 'artist'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const track  = String(args?.track  || '').trim().slice(0, MAX_TRACK_LEN);
  const artist = String(args?.artist || '').trim().slice(0, MAX_ARTIST_LEN);
  if (!track) return { error: 'track is required' };
  if (!artist) return { error: 'artist is required' };

  const album = args?.album ? String(args.album).trim().slice(0, MAX_ALBUM_LEN) : '';
  const coverUrl = sanitiseCover(args?.cover_url);

  const duration = Number(args?.duration_sec);
  const progress = Number(args?.progress_sec);

  const durationSec = Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null;
  let progressSec = Number.isFinite(progress) && progress >= 0 ? Math.floor(progress) : null;
  if (progressSec != null && durationSec != null && progressSec > durationSec) {
    progressSec = durationSec;
  }

  const payload = {
    track, artist, album,
    coverUrl,
    progressSec,
    durationSec,
  };

  const dataset_id = datasets.put('now_playing', payload);
  const intent = `${track} — ${artist}`.slice(0, 64);
  const size = SIZES.wide;

  let result;
  try {
    result = await renderViz({
      intent,
      data_refs: [dataset_id],
      size,
      chart_type: 'now_playing',
    });
  } catch (err) {
    return { error: `now_playing render failed: ${err?.message || err}` };
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
    track, artist, album,
    note: 'Now-playing card is on stage. Do not recite the track title — the card already shows it.',
  };
}

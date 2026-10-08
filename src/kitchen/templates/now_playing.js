// now_playing — the "music playing" card. Square album art on the left,
// stacked track + artist + album on the right, progress bar across the
// bottom. Pure static snapshot; like timer_ring, we don't animate the
// progress in the iframe — the caller re-renders to update.
//
// Data shape:
//   {
//     track,                  // song title (required)
//     artist,                 // artist name
//     album?,                 // optional album name
//     coverUrl?,              // https URL (img-src allows https)
//     progressSec?,           // 0..durationSec
//     durationSec?,           // full length in seconds
//   }

import { escapeHtml, titleText, emptyStateBody } from './shared.js';

function coerce(data) {
  if (!data) return null;
  const track = String(data.track || data.title || '').trim();
  const artist = String(data.artist || data.artists || '').trim();
  if (!track) return null;
  const duration = Number(data.durationSec ?? data.duration_sec);
  const progress = Number(data.progressSec ?? data.progress_sec);
  return {
    track,
    artist,
    album: String(data.album || '').trim(),
    coverUrl: data.coverUrl || data.cover_url || null,
    progressSec: Number.isFinite(progress) && progress >= 0 ? Math.floor(progress) : null,
    durationSec: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
  };
}

function fmtClock(s) {
  if (s == null || !Number.isFinite(s)) return '';
  const n = Math.max(0, Math.floor(s));
  const m = Math.floor(n / 60);
  const sec = n % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Safe URL filter — must be https (CSP img-src allows https only). Bail to
// null on anything suspicious so the fallback art renders instead.
function safeImg(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!/^https:\/\/[^\s<>"']+$/i.test(s)) return null;
  return s;
}

// Deterministic initial pair for the fallback cover art.
function coverInitials(track, artist) {
  const a = String(artist || '').trim()[0] || '';
  const t = String(track || '').trim()[0] || '';
  return (a + t).toUpperCase() || '•';
}

export function nowPlayingTemplate({ dataset, intent }) {
  const np = coerce(dataset?.data);
  if (!np) {
    return { body: emptyStateBody(intent, 'Need a track and artist.'), exposedData: {}, needsEcharts: false };
  }
  titleText(intent, 'NOW PLAYING');

  const safeCover = safeImg(np.coverUrl);
  const progressPct = (np.progressSec != null && np.durationSec)
    ? Math.max(0, Math.min(100, (np.progressSec / np.durationSec) * 100))
    : 0;
  const showClock = np.progressSec != null && np.durationSec != null;

  const coverMarkup = safeCover
    ? `<img class="holo-np-cover-img" src="${escapeHtml(safeCover)}" alt="">`
    : `<span class="holo-np-cover-fallback">${escapeHtml(coverInitials(np.track, np.artist))}</span>`;

  const body = `<div id="viz" class="holo-np">
  <style>
    .holo-np {
      width: 100%; height: 100%;
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto 1fr auto;
      gap: 14px 16px;
      padding: 16px 18px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, sans-serif;
      align-items: center;
    }
    .holo-np-kicker {
      grid-column: 1 / -1;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.82);
      text-shadow: 0 0 6px rgba(0, 229, 255, 0.4);
      text-transform: uppercase;
      display: inline-flex;
      align-items: center; gap: 8px;
    }
    .holo-np-live-dot {
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #00e5ff;
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.9);
      animation: holo-np-pulse 1.6s ease-in-out infinite;
    }
    @keyframes holo-np-pulse {
      0%, 100% { opacity: 0.55; transform: scale(0.9); }
      50%      { opacity: 1;    transform: scale(1.15); }
    }
    .holo-np-cover {
      grid-row: 2;
      grid-column: 1;
      width: 110px; height: 110px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(0,229,255,0.25), rgba(255,102,179,0.20));
      display: flex;
      align-items: center; justify-content: center;
      color: rgba(255, 255, 255, 0.9);
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 0.05em;
      overflow: hidden;
      box-shadow:
        0 0 0 1px rgba(0, 229, 255, 0.35) inset,
        0 0 18px rgba(0, 229, 255, 0.25);
    }
    .holo-np-cover-img {
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
    .holo-np-meta {
      grid-row: 2;
      grid-column: 2;
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 4px;
    }
    .holo-np-track {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: rgba(255, 255, 255, 0.98);
      text-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-np-artist {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.78);
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-np-album {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.14em;
      color: rgba(0, 229, 255, 0.72);
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .holo-np-progress {
      grid-row: 3;
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .holo-np-track-bar {
      height: 4px;
      border-radius: 2px;
      background: rgba(0, 229, 255, 0.1);
      overflow: hidden;
      position: relative;
    }
    .holo-np-track-fill {
      height: 100%;
      background: linear-gradient(90deg, #00e5ff 0%, #ff66b3 100%);
      box-shadow: 0 0 8px rgba(0, 229, 255, 0.55);
      border-radius: 2px;
      transition: width 600ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .holo-np-clock {
      display: flex; justify-content: space-between;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      color: rgba(0, 229, 255, 0.75);
      font-variant-numeric: tabular-nums;
    }
  </style>
  <div class="holo-np-kicker">
    <span class="holo-np-live-dot"></span>
    <span>NOW PLAYING</span>
  </div>
  <div class="holo-np-cover">${coverMarkup}</div>
  <div class="holo-np-meta">
    <div class="holo-np-track">${escapeHtml(np.track)}</div>
    ${np.artist ? `<div class="holo-np-artist">${escapeHtml(np.artist)}</div>` : ''}
    ${np.album ? `<div class="holo-np-album">${escapeHtml(np.album)}</div>` : ''}
  </div>
  <div class="holo-np-progress">
    <div class="holo-np-track-bar"><div class="holo-np-track-fill" style="width:${progressPct.toFixed(1)}%"></div></div>
    ${showClock ? `<div class="holo-np-clock"><span>${escapeHtml(fmtClock(np.progressSec))}</span><span>${escapeHtml(fmtClock(np.durationSec))}</span></div>` : ''}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('now_playing: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

// Pane layer — full-stage iframe surface for Momo's internal pages
// (/hq, /agents-grid). Unlike chart-layer (card inside the hologram
// column), pane-layer takes over the viewport and shrinks the avatar
// into a corner thumbnail.
//
// Perf: no iframe exists until mount() fires; dismount fully removes it.
// Shrink is a CSS transform on the passed stageEl, so the WebGL renderer
// keeps its full resolution and no relayout happens.

const STYLE_ID = 'holo-pane-styles';
// Cycle order when the user taps `M` to hunt for the right flip. Starts
// from "no flip" so a fresh user sees normal text first.
const MIRROR_CYCLE = [
  { x: false, y: false, label: 'OFF' },
  { x: true,  y: false, label: 'X'   },
  { x: false, y: true,  label: 'Y'   },
  { x: true,  y: true,  label: 'XY'  },
];

let installed = false;
let stageRef = null;
let currentPane = null;
let mirror = { x: false, y: false };

export function installPaneLayer({ stageEl, mirror: mirror0 } = {}) {
  if (installed) return;
  installed = true;
  stageRef = stageEl || null;
  // Call-site default is the single source of truth — the reflector
  // orientation is a physical property of the rig, codified in the boot
  // config. M-key cycling is a live in-session debug tool; reloads always
  // snap back to this default.
  setMirror(mirror0 || { x: false, y: false });
  ensureCSS();
  // Legend chip intentionally not mounted — HUD is kept minimal; the H/G/M
  // shortcuts still work, they're just not displayed on screen.

  window.__holoPane = {
    mount:     (opts) => mount(opts),
    dismount:  () => dismount(),
    setMirror: (m) => setMirror(m),
    // Generic postMessage forwarder — for tools like
    // meta_dashboard_command that need to send arbitrary structured
    // messages into whichever HQ iframe is mounted. Returns true if a
    // pane was open and the message was forwarded; false otherwise.
    forwardMessage: (payload) => {
      if (!currentPane || !payload) return false;
      const iframe = currentPane.root.querySelector('.holo-pane-iframe');
      if (!iframe) return false;
      try { iframe.contentWindow?.postMessage(payload, location.origin); return true; }
      catch (err) { console.warn('[pane] forwardMessage err', err); return false; }
    },
  };

  // Iframes can swallow keyboard events — when focus is inside the
  // nested /preview iframe, Esc never reaches us. The /preview page
  // forwards an `omo.dismissPane` message instead. Same-origin only;
  // any other origin or shape is dropped on the floor.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'omo.dismissPane' && currentPane) dismount();
  });

  window.addEventListener('keydown', (e) => {
    if (currentPane && e.key === 'Escape') { dismount(); return; }
    // User-triggered pane toggles (independent of Momo). Skip when a form
    // field has focus so typing in /hq search boxes doesn't hijack keys.
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'h' || e.key === 'H') {
      if (currentPane?.meta?.page === 'hq') dismount();
      else mount({ url: '/hq', page: 'hq', title: 'HQ // CONTROL CENTER' });
    } else if (e.key === 's' || e.key === 'S' || e.key === 'g' || e.key === 'G') {
      // 's' opens /squad. 'g' is the legacy shortcut for the retired
      // /agents-grid and now also opens /squad — same destination.
      if (currentPane?.meta?.page === 'squad') dismount();
      else mount({ url: '/squad', page: 'squad', title: 'SQUAD // PIXEL OFFICE' });
    } else if (e.key === 'm' || e.key === 'M') {
      cycleMirror();
    }
  });
}

function cycleMirror() {
  const i = MIRROR_CYCLE.findIndex((m) => m.x === mirror.x && m.y === mirror.y);
  const next = MIRROR_CYCLE[(i + 1) % MIRROR_CYCLE.length];
  setMirror(next);
  updateLegendMirror();
}

function mount({ url, title, page, projectable_id, slot, view, filter } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
    console.warn('[pane] refused non-internal url', url);
    return null;
  }
  // Fast path: if the same page is already mounted, don't tear the iframe
  // down — just postMessage to refocus. Keeps Browserbase live sessions,
  // narration, HQ live-stream WS subscriptions, and poll state all
  // untouched while the user zooms between panels.
  if (currentPane && currentPane.meta?.page === page && (page === 'hq' || page === 'squad')) {
    const iframe = currentPane.root.querySelector('.holo-pane-iframe');
    const target = slot === undefined ? null : slot;
    // Forward refocus postMessage when ANY of slot/view/filter changes.
    // The model can spam show_pane (slot=meta) several times in a row;
    // without the gate the HQ iframe would re-run the heavy panel render
    // for each one. With it, we still need to forward view/filter changes
    // (e.g. "switch to scaling tab") since those don't change the slot.
    const prevSlot = currentPane.meta?.slot ?? null;
    const prevView = currentPane.meta?.view ?? null;
    const prevFilter = currentPane.meta?.filter ?? null;
    const slotChanged = (target ?? null) !== (prevSlot ?? null);
    const viewChanged = (view ?? null) !== (prevView ?? null);
    const filterChanged = (filter ?? null) !== (prevFilter ?? null);
    if (slotChanged || viewChanged || filterChanged) {
      try { iframe?.contentWindow?.postMessage({ type: 'omo.focusSlot', slot: target, view: view ?? null, filter: filter ?? null }, location.origin); }
      catch (err) { console.warn('[pane] focus postMessage err', err); }
    }
    currentPane.meta = { ...currentPane.meta, title: title || currentPane.meta.title, slot: target, view: view ?? null, filter: filter ?? null, projectable_id: projectable_id || currentPane.meta.projectable_id };
    console.log(`[pane] refocus page=${page} slot=${target ?? '-'}${view ? ' view=' + view : ''}${filter ? ' filter=' + filter : ''} (no remount${slotChanged || viewChanged || filterChanged ? '' : ' · no change'})`);
    return currentPane.meta;
  }
  // Same fast path for /preview: a second show_preview against the same
  // pane just swaps the inner URL via postMessage so scroll/form state
  // inside the user's app survives. The outer pane stays mounted.
  if (currentPane && currentPane.meta?.page === 'preview' && page === 'preview') {
    const iframe = currentPane.root.querySelector('.holo-pane-iframe');
    // Pull the target URL back out of the internal /preview?url=…
    let nextTarget = null;
    try { nextTarget = new URL(url, location.href).searchParams.get('url'); }
    catch { /* fall through to a full remount */ }
    const prevTarget = currentPane.meta?.targetUrl || null;
    if (nextTarget && nextTarget !== prevTarget) {
      try { iframe?.contentWindow?.postMessage({ type: 'omo.focusPreview', url: nextTarget, title: title || null }, location.origin); }
      catch (err) { console.warn('[pane] preview focus postMessage err', err); }
    }
    currentPane.meta = { ...currentPane.meta, title: title || currentPane.meta.title, targetUrl: nextTarget || prevTarget, projectable_id: projectable_id || currentPane.meta.projectable_id };
    console.log(`[pane] refocus page=preview target=${nextTarget || '-'} (no remount${nextTarget && nextTarget !== prevTarget ? '' : ' · no change'})`);
    return currentPane.meta;
  }
  if (currentPane) {
    console.log(`[pane] swap from page=${currentPane.meta?.page} → page=${page}`);
    dismount({ immediate: true });
  } else {
    console.log(`[pane] mount page=${page} slot=${slot ?? '-'} url=${url}`);
  }

  const root = document.createElement('div');
  root.className = 'holo-pane';
  root.dataset.paneId = projectable_id || '';
  root.innerHTML = `
    <div class="holo-pane-backdrop"></div>
    <div class="holo-pane-frame">
      <div class="holo-pane-body">
        <iframe class="holo-pane-iframe"
                referrerpolicy="same-origin"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe>
      </div>
    </div>
  `;
  const iframe = root.querySelector('.holo-pane-iframe');
  applyIframeMirror(iframe);
  iframe.src = url;
  root.querySelector('.holo-pane-backdrop').addEventListener('click', () => dismount());

  document.body.appendChild(root);
  document.body.classList.add('pane-open');
  stageRef?.classList.add('pane-shrunk');

  // Time iframe load — Browserbase / HQ panes can take a moment to settle,
  // and that wait often *looks* like a freeze. Log when load fires so the
  // user can correlate the visual delay with the iframe finishing.
  // 8s watchdog: if /hq is starved by a backfill on the same Node process
  // and never fires `load`, surface it as a warning so we can correlate
  // with the visible "stuck on black pane" symptom rather than silently
  // wait forever. The iframe stays mounted — it'll paint when it does.
  const iframeT0 = performance.now();
  let loaded = false;
  iframe.addEventListener('load', () => {
    loaded = true;
    console.log(`[pane] iframe loaded page=${page} · ${Math.round(performance.now() - iframeT0)}ms`);
  }, { once: true });
  setTimeout(() => {
    if (!loaded) console.warn(`[pane] iframe load slow page=${page} · still waiting after 8000ms`);
  }, 8000);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.add('is-entering'));
  });

  // For preview panes, decode the inner ?url= so a later refocus can
  // detect "same URL → no-op" vs "swap the inner iframe".
  let targetUrl = null;
  if (page === 'preview') {
    try { targetUrl = new URL(url, location.href).searchParams.get('url'); }
    catch {}
  }
  currentPane = { root, meta: { url, title, page, projectable_id, slot: slot ?? null, view: view ?? null, filter: filter ?? null, targetUrl } };
  return currentPane.meta;
}

function dismount({ immediate = false } = {}) {
  if (!currentPane) return;
  const page = currentPane.meta?.page;
  const t0 = performance.now();
  console.log(`[pane] dismount page=${page}${immediate ? ' (immediate)' : ''}`);
  const { root } = currentPane;
  currentPane = null;
  document.body.classList.remove('pane-open');
  stageRef?.classList.remove('pane-shrunk');
  // Tell the server "nothing is on screen" so get_screen_context returns
  // null. Fire-and-forget.
  try { fetch('/omo/ingest/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"clear":true}' }); } catch {}

  // Eagerly blank the iframe src so any live streams it owns (HQ holds
  // 4–5 WebSockets across stripe/meta/gmail/drive/transcript panels;
  // /agents-grid holds the Browserbase debug socket) tear down NOW rather
  // than 420ms later when the DOM is physically removed. Without this,
  // teardown work happens during the leave animation and visibly glues
  // the avatar to its shrunk position. Try/catch because some browsers
  // dispatch a synchronous unload that can throw on cross-origin frames.
  try {
    const iframe = root.querySelector('.holo-pane-iframe');
    if (iframe && iframe.src && iframe.src !== 'about:blank') iframe.src = 'about:blank';
  } catch (err) { console.warn('[pane] iframe blank err', err); }

  if (immediate) {
    root.remove();
    console.log(`[pane] removed page=${page} · ${Math.round(performance.now() - t0)}ms`);
    return;
  }
  root.classList.add('is-leaving');
  root.classList.remove('is-entering');
  // Matches the CSS leave-fade (.holo-pane.is-leaving = 360ms opacity) +
  // a small buffer so we never rip the iframe out mid-fade.
  setTimeout(() => {
    root.remove();
    console.log(`[pane] removed page=${page} · ${Math.round(performance.now() - t0)}ms`);
  }, 380);
}

// Forward "open this specific card by voice" payloads into whatever pane
// iframe is currently mounted. Safe to call even if no pane is open.
export function forwardOpenDetail({ panel, kind, id } = {}) {
  if (!currentPane || !panel || !id) return false;
  const iframe = currentPane.root.querySelector('.holo-pane-iframe');
  if (!iframe?.contentWindow) return false;
  try {
    iframe.contentWindow.postMessage({ type: 'omo.openDetail', panel, kind, id }, location.origin);
    return true;
  } catch { return false; }
}

function mountLegend() {
  if (document.querySelector('.holo-pane-legend')) return;
  const el = document.createElement('div');
  el.className = 'holo-pane-legend';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="holo-pane-legend-row"><kbd>H</kbd><span>HQ</span></div>
    <div class="holo-pane-legend-row"><kbd>G</kbd><span>AGENTS</span></div>
    <div class="holo-pane-legend-row"><kbd>M</kbd><span class="holo-pane-legend-mirror">FLIP OFF</span></div>
    <div class="holo-pane-legend-row"><kbd>⎋</kbd><span>CLOSE</span></div>
  `;
  document.body.appendChild(el);
  updateLegendMirror();
}

function updateLegendMirror() {
  const el = document.querySelector('.holo-pane-legend-mirror');
  if (el) el.textContent = `X:${mirror.x ? 'ON ' : 'OFF'} Y:${mirror.y ? 'ON' : 'OFF'}`;
}

function setMirror(m) {
  // Accept { x, y }, or shorthand strings 'y' | 'x' | 'xy' | '' | false.
  if (typeof m === 'string') m = { x: m.includes('x'), y: m.includes('y') };
  else if (!m) m = { x: false, y: false };
  mirror = { x: !!m.x, y: !!m.y };
  document.body.classList.toggle('pane-mirror-x', mirror.x);
  document.body.classList.toggle('pane-mirror-y', mirror.y);
  if (currentPane) {
    applyIframeMirror(currentPane.root.querySelector('.holo-pane-iframe'));
  }
}

// Rotate the iframe element itself via inline style with `!important`
// priority. This beats any cascading parent transform (body.mirror, etc.)
// so the popup reliably shows rotated on screen, regardless of what the
// host holo page is doing with body.
function applyIframeMirror(iframe) {
  if (!iframe) return;
  const parts = [];
  if (mirror.x) parts.push('scaleX(-1)');
  if (mirror.y) parts.push('scaleY(-1)');
  const t = parts.join(' ') || 'none';
  iframe.style.setProperty('transform', t, 'important');
  iframe.style.setProperty('transform-origin', '50% 50%', 'important');
}

function ensureCSS() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
  :root {
    --pane-ease-in:  cubic-bezier(0.22, 1, 0.36, 1);
    --pane-ease-out: cubic-bezier(0.4, 0, 1, 1);
    --pane-corner-size: 220px;
    --pane-corner-inset: 18px;
  }

  .pane-shrunk {
    transform-origin: 0% 0%;
    transform:
      translate(var(--pane-corner-inset), var(--pane-corner-inset))
      scale(calc(var(--pane-corner-size) / min(100vw, 100vh)));
    transition: transform 640ms var(--pane-ease-in);
    pointer-events: none;
    z-index: 40;
  }
  #stage, #scene { transition: transform 640ms var(--pane-ease-out); }

  .holo-pane {
    position: fixed; inset: 0; z-index: 50;
    opacity: 0; pointer-events: none;
    transition: opacity 420ms var(--pane-ease-in);
  }
  .holo-pane.is-entering { opacity: 1; pointer-events: auto; }
  .holo-pane.is-leaving  { opacity: 0; transition: opacity 360ms var(--pane-ease-out); }

  .holo-pane-backdrop {
    position: absolute; inset: 0;
    background: radial-gradient(120% 120% at 50% 42%,
      rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.78) 55%, rgba(0,0,0,0.92) 100%);
    backdrop-filter: blur(6px) saturate(0.85);
    -webkit-backdrop-filter: blur(6px) saturate(0.85);
  }

  .holo-pane-frame {
    position: absolute; left: 50%; top: 50%;
    width: 100vw; height: 100vh;
    transform: translate(-50%, -50%) scale(0.99);
    border-radius: 0; overflow: hidden;
    background: rgba(0, 10, 16, 0.92);
    box-shadow:
      0 0 0 1px rgba(0, 229, 255, 0.28) inset,
      0 40px 120px rgba(0, 0, 0, 0.75),
      0 0 60px rgba(0, 229, 255, 0.08);
    display: flex; flex-direction: column;
    transition: transform 420ms var(--pane-ease-in);
  }
  .holo-pane.is-entering .holo-pane-frame { transform: translate(-50%, -50%) scale(1); }
  /* The pane iframe gets inline-style !important transforms from JS (see
     applyIframeMirror). Viz cards and any other projected iframes flip
     via the rules below so everything the user sees through the reflector
     is oriented the same way. */
  body.pane-mirror-x .chart-iframe,
  body.pane-mirror-x iframe[data-holo-content="true"] {
    transform: scaleX(-1); transform-origin: 50% 50%;
  }
  body.pane-mirror-y .chart-iframe,
  body.pane-mirror-y iframe[data-holo-content="true"] {
    transform: scaleY(-1); transform-origin: 50% 50%;
  }
  body.pane-mirror-x.pane-mirror-y .chart-iframe,
  body.pane-mirror-x.pane-mirror-y iframe[data-holo-content="true"] {
    transform: scale(-1, -1); transform-origin: 50% 50%;
  }

  .holo-pane-body { flex: 1; position: relative; background: #000; }
  .holo-pane-iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; display: block; background: #000; color-scheme: dark;
  }

  /* Shortcut legend — subtle top-right chip listing the pane hotkeys.
     Fades further while a pane is open so it doesn't compete with the
     iframe UI. Dimmed by default, brightens on hover. Inherits the page
     mirror (via .pane-mirror-* body classes) so the letters read the
     right way round on a physical reflector. */
  .holo-pane-legend {
    position: fixed;
    top: 12px; right: 12px;
    z-index: 45;
    display: flex; flex-direction: column; gap: 6px;
    padding: 10px 12px;
    background: rgba(0, 10, 16, 0.65);
    border: 1px solid rgba(0, 229, 255, 0.3);
    border-radius: 8px;
    font-family: "SF Mono", ui-monospace, monospace;
    letter-spacing: 2px;
    color: rgba(0, 229, 255, 0.85);
    font-size: 12px;
    pointer-events: auto;
    user-select: none;
    opacity: 0.75;
    transition: opacity 240ms ease;
  }
  .holo-pane-legend:hover { opacity: 1; }
  body.pane-open .holo-pane-legend { opacity: 0.5; }
  body.pane-open .holo-pane-legend:hover { opacity: 1; }
  .holo-pane-legend-row { display: flex; align-items: center; gap: 10px; }
  .holo-pane-legend kbd {
    display: inline-block;
    min-width: 24px; height: 24px; line-height: 22px;
    padding: 0 6px; text-align: center;
    border: 1px solid rgba(0, 229, 255, 0.5);
    border-radius: 4px;
    color: #00e5ff; font: inherit; font-size: 13px; font-weight: 600;
    background: rgba(0, 229, 255, 0.08);
    box-shadow: 0 0 8px rgba(0, 229, 255, 0.18) inset;
  }
  .holo-pane-legend-mirror {
    color: #00e5ff;
    text-shadow: 0 0 6px rgba(0, 229, 255, 0.55);
    font-weight: 600;
  }

  body.pane-mirror-y .holo-pane-legend { transform: scaleY(-1); }
  body.pane-mirror-x .holo-pane-legend { transform: scaleX(-1); }
  body.pane-mirror-x.pane-mirror-y .holo-pane-legend { transform: scale(-1, -1); }

  @media (max-width: 720px) {
    :root { --pane-corner-size: 140px; --pane-corner-inset: 12px; }
    .holo-pane-legend { font-size: 10px; padding: 7px 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pane-shrunk, .holo-pane, .holo-pane-frame { transition: none !important; }
  }
`;

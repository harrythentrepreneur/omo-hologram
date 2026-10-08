// public/preview.js — the /preview pane.
//
// Job: load an arbitrary http(s) URL into a sandboxed iframe, give the
// user a typeable address bar (with autocomplete for omo's own routes
// and recent visits), and relay voice commands from the holo parent
// down to the page (via /preview-bridge.js) or, for cross-origin nav,
// handle them outer-side.
//
// Hard rules:
//   • never trust input — only http(s) URLs are accepted (server probes too).
//   • never bake numbers/secrets into postMessages relayed to the inner page.
//   • the bridge inside the iframe is optional — when missing, voice still
//     gets navigate/reload (we handle those here, outer-side).
//
// What this file DOESN'T do:
//   • track agent file_changes for a diff view (use /squad)
//   • render a pending-reviews dock (worktrees are off by default)
//   • show a per-task timeline (same)
// If those come back, they go elsewhere — /preview stays a focused tab.

const KNOWN_ROUTES = [
  { path: '/squad',            hint: 'agent squad + monitor' },
  { path: '/hq',               hint: 'connected accounts dashboard' },
  { path: '/agents-grid',      hint: 'four-slot terminal grid' },
  { path: '/landing',          hint: 'marketing page' },
  { path: '/pitch',            hint: 'pitch deck' },
  { path: '/automation',       hint: 'Holo3 vision agent' },
  { path: '/reflector',        hint: 'reflector layout' },
  { path: '/avatar',           hint: 'avatar layout' },
  { path: '/pyramid',          hint: 'pyramid layout' },
  { path: '/hermes-dashboard', hint: 'Hermes agent dashboard' },
  { path: '/',                 hint: 'cylinder hologram' },
];
const HISTORY_KEY = 'omo.preview.history';
const HISTORY_MAX = 24;
const LIVE_KEY    = 'omo.preview.live';
const BRIDGE_WAIT_MS = 1500;

const $ = (id) => document.getElementById(id);

const els = {
  frame:    $('frame'),
  addr:     $('addr'),
  url:      $('addr-url'),
  meta:     $('addr-meta'),
  refresh:  $('refresh'),
  openTab:  $('open-tab'),
  overlay:  $('overlay'),
  ovTitle:  $('ov-title'),
  ovDetail: $('ov-detail'),
  navBack:  $('nav-back'),
  navFwd:   $('nav-forward'),
  live:     $('live-toggle'),
  suggest:  $('addr-suggest'),
  tier:     $('tier'),
};

// ── URL helpers ─────────────────────────────────────────────────────
function normalise(u) {
  if (!u) return '';
  const withScheme = /^https?:\/\//i.test(u) ? u : 'http://' + u;
  try { return new URL(withScheme).toString(); } catch { return ''; }
}
function isSafeUrl(u) {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}
function hostOf(u) { try { return new URL(u).host; } catch { return u; } }
function originOf(u) { try { return new URL(u).origin; } catch { return null; } }
function looksLikeNavInput(s) {
  if (!s) return false;
  if (s.startsWith('/')) return true;
  if (/^https?:\/\//i.test(s)) return true;
  return /^[a-z0-9.\-]+(:\d+)?(\/|$)/i.test(s);
}
function appendBust(u) {
  try {
    const p = new URL(u);
    p.searchParams.set('_omo_reload', Date.now().toString(36));
    return p.toString();
  } catch { return u; }
}

// ── state ───────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
let currentUrl = normalise(params.get('url') || params.get('target') || '');
let titleArg   = params.get('title') || '';

let probeSeq    = 0;        // increments per loadUrl; stale probes ignored
let loadedAt    = 0;
let loadTimer   = 0;
let bridgeTimer = 0;
let bridgeReady = false;

// Parent-side history. Independent of the iframe's own history (which
// resets on cross-origin nav and is opaque for cross-origin frames).
const navStack = [];
let   navCursor = -1;

// Persisted recents (for autocomplete only — not the nav stack).
const persistedRecents = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((u) => typeof u === 'string').slice(-HISTORY_MAX) : [];
  } catch { return []; }
})();

let liveOn = false;
try { liveOn = localStorage.getItem(LIVE_KEY) === '1'; } catch {}

// ── address bar paint ───────────────────────────────────────────────
function setAddrValue(v) {
  // Don't clobber whatever the user is typing.
  if (els.addr.classList.contains('editing')) return;
  els.url.value = v;
}
function setState(s) { els.addr.dataset.state = s; }

function showOverlay(title, detail) {
  els.ovTitle.textContent  = title;
  els.ovDetail.textContent = detail;
  els.overlay.classList.add('show');
  els.frame.classList.add('loading');
}
function hideOverlay() { els.overlay.classList.remove('show'); }

function setTier(tier) {
  // tier: 'unknown' | 'live' | 'nav'
  els.tier.dataset.tier = tier;
  const lbl = els.tier.querySelector('.tier-label');
  if (tier === 'live') {
    lbl.textContent = 'bridge live';
    els.tier.title  = 'Voice can click / type / scroll / describe this page — bridge loaded.';
  } else if (tier === 'nav') {
    lbl.textContent = 'navigate only';
    els.tier.title  = "Cross-origin without /preview-bridge.js — voice can navigate / reload / go back, but click & type need the bridge.";
  } else {
    lbl.textContent = '—';
    els.tier.title  = '';
  }
}
function resetTier() {
  setTier('unknown');
  bridgeReady = false;
  clearTimeout(bridgeTimer);
  bridgeTimer = setTimeout(() => {
    if (els.tier.dataset.tier === 'unknown') setTier('nav');
  }, BRIDGE_WAIT_MS);
}

// ── reachability probe ─────────────────────────────────────────────
async function probe(u) {
  try {
    const r = await fetch('/omo/preview/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: u }),
    });
    return await r.json();
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
}
function friendlyProbeError(p) {
  const code = String(p?.code || p?.error || '').toUpperCase();
  if (code.includes('ECONNREFUSED')) return 'Nothing is listening on that port. Start your dev server and try again.';
  if (code.includes('ENOTFOUND'))    return "Can't resolve that hostname. Check the URL.";
  if (code.includes('ETIMEDOUT') || code === 'TIMEOUT') return 'The server is taking too long to respond.';
  if (code.includes('ECONNRESET'))   return 'The connection was reset. Restart your dev server.';
  if (code.includes('CERT'))         return 'TLS certificate problem. Use http:// for localhost, or fix the cert.';
  if (code.includes('UND_ERR_SOCKET')) return "Couldn't reach that server. Make sure it's running.";
  if (p?.status && p.status >= 500)  return `Server returned ${p.status} ${p.statusText || ''}`.trim();
  return p?.error || 'Unknown error reaching that URL.';
}

// ── loadUrl: the one entry point ───────────────────────────────────
async function loadUrl(u, { bustCache = false, skipHistory = false } = {}) {
  const seq = ++probeSeq;
  const target = normalise(u);
  if (!isSafeUrl(target)) {
    showOverlay('invalid url', u
      ? 'only http(s) URLs are accepted: ' + u
      : "tell me where to go — e.g. 'open /squad' or '/landing'.");
    setState('error');
    return;
  }
  currentUrl = target;
  setAddrValue(target);
  document.title = `omo · ${titleArg || hostOf(target)}`;
  els.openTab.href = target;
  setState('loading');
  els.meta.textContent = 'reaching ' + hostOf(target) + '…';
  loadedAt = performance.now();
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    if (seq === probeSeq && els.addr.dataset.state === 'loading') {
      els.meta.textContent = '… still loading';
    }
  }, 6000);

  const p = await probe(target);
  if (seq !== probeSeq) return;     // user switched URLs mid-probe
  if (!p.ok) {
    clearTimeout(loadTimer);
    setState('error');
    els.meta.textContent = '';
    showOverlay("can't reach " + hostOf(target), friendlyProbeError(p));
    return;
  }

  hideOverlay();
  els.frame.classList.add('loading');
  resetTier();
  els.frame.src = bustCache ? appendBust(target) : target;
  if (!skipHistory && !bustCache) pushHistory(target);
}

// Bridge announces every same-origin SPA nav (pushState / popstate /
// hash). Mirror that change in the outer chrome without re-probing or
// reloading the iframe — the inner page already navigated itself.
function syncOuterToInnerUrl(rawUrl, rawTitle) {
  const next = normalise(rawUrl);
  if (!isSafeUrl(next)) return;
  if (next === currentUrl) return; // ready re-announce on the same URL — no-op
  currentUrl = next;
  setAddrValue(next);
  els.openTab.href = next;
  if (rawTitle && typeof rawTitle === 'string') {
    titleArg = rawTitle.slice(0, 80);
  }
  document.title = `omo · ${titleArg || hostOf(next)}`;
  pushHistory(next);
  // Update the time-to-first-byte meta to a short host hint so the user
  // can see where they are at a glance (mimics how a real browser bar
  // shows the host on cross-page nav).
  els.meta.textContent = '';
  setState('live');
  // Tell the server the visible preview URL changed, so
  // get_screen_context's "this page" deixis resolves correctly.
  try {
    fetch('/omo/ingest/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ view: 'preview', url: currentUrl, title: titleArg || null }),
    });
  } catch {}
}

els.frame.addEventListener('load', () => {
  clearTimeout(loadTimer);
  setState('live');
  els.meta.textContent = `${Math.max(0, Math.round(performance.now() - loadedAt))}ms`;
  els.frame.classList.remove('loading');
  // Tell the server which preview is on screen so omo's
  // get_screen_context tool can resolve "this" / "that" deixis.
  fetch('/omo/ingest/view', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ view: 'preview', url: currentUrl, title: titleArg || null }),
  }).catch(() => {});
});

// ── history ────────────────────────────────────────────────────────
function pushHistory(url) {
  if (navCursor >= 0 && navStack[navCursor] === url) return;
  navStack.splice(navCursor + 1);
  navStack.push(url);
  if (navStack.length > HISTORY_MAX) navStack.shift();
  navCursor = navStack.length - 1;
  saveRecents();
  paintNavButtons();
}
function saveRecents() {
  // Dedupe newest-first, cap, persist.
  const seen = new Set();
  const out  = [];
  for (let i = navStack.length - 1; i >= 0; i--) {
    if (seen.has(navStack[i])) continue;
    seen.add(navStack[i]);
    out.unshift(navStack[i]);
    if (out.length >= HISTORY_MAX) break;
  }
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(out)); } catch {}
}
function paintNavButtons() {
  els.navBack.disabled = navCursor <= 0;
  els.navFwd .disabled = navCursor < 0 || navCursor >= navStack.length - 1;
}
function navGo(delta) {
  const idx = navCursor + delta;
  if (idx < 0 || idx >= navStack.length) return;
  navCursor = idx;
  paintNavButtons();
  loadUrl(navStack[idx], { skipHistory: true });
}

// ── autocomplete ───────────────────────────────────────────────────
let suggestActive = 0;

function recents() {
  const seen = new Set();
  const out  = [];
  for (let i = navStack.length - 1; i >= 0; i--) {
    if (seen.has(navStack[i])) continue;
    seen.add(navStack[i]);
    out.push(navStack[i]);
  }
  for (let i = persistedRecents.length - 1; i >= 0; i--) {
    if (seen.has(persistedRecents[i])) continue;
    seen.add(persistedRecents[i]);
    out.push(persistedRecents[i]);
  }
  return out.slice(0, 12);
}
function suggestionsFor(q) {
  const ql = String(q || '').toLowerCase().trim();
  const base = originOf(currentUrl) || 'http://localhost:8080';
  const items = [];

  for (const r of KNOWN_ROUTES) {
    if (!ql || r.path.toLowerCase().includes(ql) || r.hint.toLowerCase().includes(ql)) {
      items.push({ kind: 'route', glyph: '·', label: r.path, hint: r.hint, value: base + r.path, score: scoreSuggest(r.path, ql) });
    }
  }
  const known = new Set(items.map((i) => i.value));
  for (const u of recents()) {
    if (known.has(u)) continue;
    if (!ql || u.toLowerCase().includes(ql)) {
      items.push({ kind: 'recent', glyph: '↻', label: u.replace(/^https?:\/\//, ''), hint: 'recent', value: u, score: scoreSuggest(u, ql) });
    }
  }
  // Always offer the literal input first when it looks navigable, so the
  // user can Enter past autocomplete to type a raw URL.
  if (ql && looksLikeNavInput(ql)) {
    const full = ql.startsWith('/')   ? base + ql
              : /^https?:/i.test(ql) ? ql
              :                        'http://' + ql;
    items.unshift({ kind: 'free', glyph: '→', label: ql, hint: 'navigate', value: full, score: 1e6 });
  }
  return items.sort((a, b) => b.score - a.score).slice(0, 10);
}
function scoreSuggest(text, q) {
  if (!q) return 50;
  const t = text.toLowerCase();
  if (t === q)             return 200;
  if (t.startsWith(q))     return 150;
  if (t.includes(q))       return 80;
  return 10;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}
function renderSuggest() {
  const items = suggestionsFor(els.url.value);
  if (!items.length) {
    els.suggest.innerHTML = '<div class="s-empty">no matches — press Enter to navigate</div>';
    suggestActive = -1;
    return;
  }
  suggestActive = Math.min(Math.max(0, suggestActive), items.length - 1);
  els.suggest.innerHTML = '<div class="s-group">jump to</div>' + items.map((it, i) => `
    <div class="s-row"
         data-active="${i === suggestActive ? 1 : 0}"
         data-value="${escapeHtml(it.value)}"
         data-index="${i}">
      <span class="s-glyph">${it.glyph}</span>
      <span class="s-path">${escapeHtml(it.label)}</span>
      <span class="s-hint">${escapeHtml(it.hint)}</span>
    </div>`).join('');
}
function activeSuggestValue() {
  return els.suggest.querySelector(`.s-row[data-index="${suggestActive}"]`)?.dataset.value || null;
}

// ── input wiring ───────────────────────────────────────────────────
els.url.addEventListener('focus', () => {
  els.addr.classList.add('editing');
  els.url.dataset.prev = currentUrl || els.url.value || '';
  try { els.url.select(); } catch {}
  suggestActive = 0;
  renderSuggest();
});
els.url.addEventListener('blur', () => {
  setTimeout(() => {
    els.addr.classList.remove('editing');
    if (currentUrl) els.url.value = currentUrl;
    else if (els.url.dataset.prev) els.url.value = els.url.dataset.prev;
  }, 120);
});
els.url.addEventListener('input', () => { suggestActive = 0; renderSuggest(); });
els.url.addEventListener('keydown', (e) => {
  const rows = els.suggest.querySelectorAll('.s-row');
  if (e.key === 'ArrowDown' && rows.length) {
    e.preventDefault();
    suggestActive = (suggestActive + 1) % rows.length;
    renderSuggest();
  } else if (e.key === 'ArrowUp' && rows.length) {
    e.preventDefault();
    suggestActive = (suggestActive - 1 + rows.length) % rows.length;
    renderSuggest();
  } else if (e.key === 'Tab') {
    const v = activeSuggestValue();
    if (v) { e.preventDefault(); els.url.value = v; renderSuggest(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const v = activeSuggestValue() || els.url.value;
    if (v && v.trim()) {
      els.addr.classList.remove('editing');
      els.url.blur();
      loadUrl(v.trim());
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    els.url.value = currentUrl || els.url.dataset.prev || '';
    els.addr.classList.remove('editing');
    els.url.blur();
  }
});
els.suggest.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.s-row');
  if (!row) return;
  e.preventDefault();
  const v = row.dataset.value;
  if (v) {
    els.addr.classList.remove('editing');
    els.url.value = v;
    els.url.blur();
    loadUrl(v);
  }
});

// ── buttons + global keys ──────────────────────────────────────────
els.refresh.addEventListener('click', () => {
  if (!isSafeUrl(currentUrl)) return;
  els.refresh.classList.add('spinning');
  setTimeout(() => els.refresh.classList.remove('spinning'), 800);
  loadUrl(currentUrl, { bustCache: true, skipHistory: true });
});
els.navBack.addEventListener('click', () => navGo(-1));
els.navFwd .addEventListener('click', () => navGo(+1));

function setLive(state) { els.live.dataset.state = state; }
function paintLive() { setLive(liveOn ? 'on' : 'off'); }
paintLive();
els.live.addEventListener('click', () => {
  liveOn = !liveOn;
  try { localStorage.setItem(LIVE_KEY, liveOn ? '1' : '0'); } catch {}
  paintLive();
});

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target?.tagName || '').toUpperCase();
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
  if (typing) return;

  if (e.key === '/')      { e.preventDefault(); els.url.focus(); }
  else if (e.key === 'r' || e.key === 'R') els.refresh.click();
  else if (e.key === 'l' || e.key === 'L') els.live.click();
  else if (e.key === 'ArrowLeft'  && !els.navBack.disabled) { e.preventDefault(); navGo(-1); }
  else if (e.key === 'ArrowRight' && !els.navFwd.disabled)  { e.preventDefault(); navGo(+1); }
  else if (e.key === 'Escape') {
    try { window.parent?.postMessage({ type: 'omo.dismissPane' }, location.origin); } catch {}
  }
});

// ── parent ↔ preview ↔ inner-iframe relay ─────────────────────────
// Voice commands flow down; bridge acks (and outer-handled acks) flow up.
function sendToParent(msg) {
  try { window.parent?.postMessage(msg, location.origin); } catch {}
}

// Decide whether to handle a voice nav command at the OUTER (/preview)
// level rather than forwarding to the bridge inside the iframe:
//   • no iframe loaded yet → outer (bridge can't be there)
//   • action: back / forward → use OUR parent-side history stack
//   • action: reload with no current url → outer
//   • full URL crossing origin → outer (parent URL bar won't update otherwise)
// Same-origin path nav stays in the bridge — preserves SPA route hooks.
function isOuterNavigate(m) {
  const { url, path, action } = m || {};
  if (action === 'back' || action === 'forward') return true;
  if (action === 'reload' && !currentUrl)        return true;
  if (!currentUrl)                                return true;
  if (url) {
    const t = originOf(url);
    const c = originOf(currentUrl);
    if (t && c && t !== c) return true;
  }
  // path-only same-origin → bridge handles it
  return false;
}
async function handleOuterNavigate(m) {
  if (m.action === 'back') {
    if (els.navBack.disabled) return { ok: false, error: 'no_history' };
    navGo(-1);
    return { ok: true, result: { via: 'outer_back', url: currentUrl } };
  }
  if (m.action === 'forward') {
    if (els.navFwd.disabled) return { ok: false, error: 'no_history' };
    navGo(+1);
    return { ok: true, result: { via: 'outer_forward', url: currentUrl } };
  }
  if (m.action === 'reload') {
    if (!currentUrl) return { ok: false, error: 'no_url' };
    await loadUrl(currentUrl, { bustCache: true, skipHistory: true });
    return { ok: true, result: { via: 'outer_reload', url: currentUrl } };
  }
  let target = m.url;
  if (!target && m.path) {
    const base = originOf(currentUrl) || 'http://localhost:8080';
    target = base + (m.path.startsWith('/') ? m.path : '/' + m.path);
  }
  if (!target) return { ok: false, error: 'no_target' };
  await loadUrl(target);
  return { ok: true, result: { via: 'outer_load', url: target } };
}

window.addEventListener('message', (e) => {
  const sameOrigin = e.origin === location.origin;
  const fromInner  = e.source === els.frame.contentWindow;
  const m = e.data;
  if (!m || typeof m !== 'object') return;

  // Parent (holo) → preview
  if (sameOrigin && m.type === 'omo.focusPreview' && m.url) {
    if (m.title) titleArg = String(m.title).slice(0, 80);
    loadUrl(m.url);
    return;
  }
  if (sameOrigin && m.type === 'omo.preview.cmd') {
    if (m.command === 'navigate' && isOuterNavigate(m)) {
      handleOuterNavigate(m).then((res) => {
        sendToParent({
          type: 'omo.preview.ack',
          id: m.id,
          ok: !!res?.ok,
          ...(res?.ok ? { result: res.result || {} } : { error: res?.error || 'navigate failed' }),
        });
      });
      return;
    }
    // Relay to inner iframe; the bridge (if loaded) acks. No bridge →
    // dispatcher times out, model gets a clean message.
    try { els.frame.contentWindow?.postMessage(m, '*'); }
    catch { sendToParent({ type: 'omo.preview.ack', id: m.id, ok: false, error: 'inner unreachable' }); }
    return;
  }

  // Inner iframe → parent. Accept any origin (data is DOM info, not secrets).
  if (fromInner && (m.type === 'omo.preview.ack'
                 || m.type === 'omo.preview.ready'
                 || m.type === 'omo.preview.nav')) {
    if (m.type === 'omo.preview.ready') {
      bridgeReady = true;
      clearTimeout(bridgeTimer);
      setTier('live');
      // SPA routers fire the same ready event after a soft route change
      // when the bridge re-loads — treat it as a nav too so the bar
      // stays in sync from the first load.
      syncOuterToInnerUrl(m.url, m.title);
    } else if (m.type === 'omo.preview.nav') {
      setTier('live');
      // Inner same-origin SPA route just changed (pushState / popstate /
      // hashchange). Reflect the new URL in the outer chrome so the user
      // sees what they're actually looking at; otherwise voice "back" or
      // "reload" would target a stale URL.
      syncOuterToInnerUrl(m.url, m.title);
    }
    sendToParent(m);
  }
});

// ── live-reload: minimal /hermes/ws file_change listener ───────────
// One purpose: when an agent writes a file AND the user has Live on,
// debounce-reload the current iframe. Only fires for localhost hosts —
// remote sites won't pick up local edits anyway.
function liveTargetMatches() {
  if (!currentUrl) return false;
  try {
    const h = new URL(currentUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || /\.local$/.test(h);
  } catch { return false; }
}
function startLiveListener() {
  let socket = null;
  let backoff = 500;
  let reloadTimer = 0;
  let armTimer    = 0;

  const connect = () => {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${location.host}/hermes/ws`);
    } catch { return scheduleReconnect(); }
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m?.type !== 'file_change') return;
      if (!liveOn || !liveTargetMatches() || !currentUrl) return;
      // Coalesce file_change bursts (a single task often emits many).
      setLive('armed');
      clearTimeout(armTimer);
      armTimer = setTimeout(() => paintLive(), 1500);
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        if (liveOn && liveTargetMatches() && currentUrl) {
          loadUrl(currentUrl, { bustCache: true, skipHistory: true });
        }
      }, 1200);
    });
    socket.addEventListener('open',  () => { backoff = 500; });
    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', scheduleReconnect);
  };
  const scheduleReconnect = () => {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
  connect();
}
startLiveListener();

// ── boot ───────────────────────────────────────────────────────────
paintNavButtons();
// Opening /preview without a ?url= param? Default to "our app" — the
// omo server itself. Matches the show_preview tool's server-side
// default and lets voice/text "show me the preview" land on a real
// page instead of an empty idle screen. The user can still retarget
// the bar to any http(s) URL ("open localhost:3000", "go to vercel.com",
// "github.com") — the input above accepts arbitrary URLs, and the
// navigate_preview voice tool will route them through loadUrl too.
if (!currentUrl) {
  currentUrl = `${location.protocol}//${location.host}`;
}
loadUrl(currentUrl);

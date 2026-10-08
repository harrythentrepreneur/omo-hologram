// voice-mode.js — shared 3-mode voice toggle for every Gemini Live page.
//
// Modes (cycled via M, persisted in localStorage as `omo.voiceMode`):
//   'off' (default): fully muted. Session closed, mic off, no auto-reconnect.
//                    Typed-chat overlay auto-opens so the user can still
//                    interact (cheapest path — no Gemini Live billing).
//   'ptt':           hold SPACE to talk. Session closes between presses,
//                    so the user pays only while they're actively talking.
//   'on':            legacy always-on. Session stays open continuously.
//
// This file owns the HUD chip, the M / SPACE key bindings, the mode state,
// and localStorage persistence. It does NOT know how to open or close
// Gemini Live — each host page wires that by listening for two events:
//
//   'omo:voice-want-on'   the user wants the live session open NOW.
//                         Open it (or no-op if already open). Clear any
//                         user-paused flag and reset reconnect backoff.
//
//   'omo:voice-want-off'  the user wants the live session closed NOW.
//                         Tear it down, set a "suppress auto-reconnect"
//                         flag, and clear any pending reconnect timer.
//
// At boot, the host page should consult `window.omoVoiceMode.shouldAutoConnect()`
// before calling its auto-connect path. PTT and OFF return false; ON returns
// true (matches legacy behaviour).
//
// Two cosmetic events also fire so the avatar etc. can react:
//   'omo:voice-mode'      (detail: { mode, prev }) on any mode change.
//   'omo:voice-frozen'    (detail: { frozen: bool }) — true only in 'off',
//                         lets the host pause avatar idle motion / dim audio
//                         gain. Matches the legacy `frozen` flag semantics.

(() => {
  if (window.omoVoiceMode) return; // single-install guard
  // Skip iframes — the parent owns the HUD + key bindings. Without this,
  // an iframe (e.g. /preview-diff embedded in /squad) would render a
  // duplicate HUD and double-handle M.
  try { if (window.self !== window.top) return; } catch { /* cross-origin → treat as iframe */ return; }

  const STORAGE_KEY = 'omo.voiceMode';
  const VOICE_MODES = ['ptt', 'off', 'on'];

  // Default mode is 'off' (muted, no Gemini Live billing). The text
  // overlay auto-opens so the user can still type to omo. M cycles
  // off → on → ptt → off; press once from default to go always-on.
  let mode = 'off';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (VOICE_MODES.includes(saved)) mode = saved;
  } catch {}

  let pttHeld = false;
  let hud = null;
  // Voice pages opt in to the spacebar PTT handler via enablePtt(true).
  // Non-voice pages (HQ, squad, etc.) load this script just for the HUD +
  // M-key cycle — they should NOT swallow SPACE (would break page scroll).
  let pttEnabled = false;

  function fire(type, detail) {
    try { window.dispatchEvent(new CustomEvent(type, { detail })); } catch {}
  }

  function ensureHud() {
    if (hud) return hud;
    if (!document.body) return null;
    const el = document.createElement('div');
    el.id = 'voice-mode-hud';
    el.setAttribute('aria-live', 'polite');
    // Top-RIGHT — out of the way of the floating text bar (bottom) and
    // the avatar (center). Small, low-contrast pill that sits flush in
    // the corner. Per-mode colours are applied in updateHud().
    el.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:9999',
      'font:9.5px/1 "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      'letter-spacing:1.4px', 'text-transform:uppercase',
      'padding:5px 8px', 'border-radius:999px',
      'border:1px solid rgba(120,120,140,0.22)',
      'background:rgba(20,18,22,0.42)',
      'backdrop-filter:blur(10px)', '-webkit-backdrop-filter:blur(10px)',
      'color:rgba(220,220,230,0.85)', 'cursor:pointer', 'user-select:none',
      'transition:all .18s ease', 'opacity:0.78',
    ].join(';');
    el.addEventListener('mouseenter', () => { el.style.opacity = '1'; });
    el.addEventListener('mouseleave', () => { el.style.opacity = '0.78'; });
    el.title = 'press M (or click) to cycle voice mode · PTT / OFF / ON';
    el.addEventListener('click', cycle);
    document.body.appendChild(el);
    hud = el;
    return el;
  }

  function updateHud() {
    const el = ensureHud(); if (!el) return;
    el.style.display = '';
    if (mode === 'off') {
      el.textContent = '○ muted · no billing';
      el.title = 'voice OFF · no Gemini Live billing · click or press M to cycle';
      el.style.borderColor = 'rgba(180,180,195,0.22)';
      el.style.color = 'rgba(200,200,210,0.78)';
    } else if (mode === 'ptt') {
      el.textContent = pttHeld ? '◉ PTT · live' : '◌ PTT · hold space';
      el.title = 'voice PTT · hold SPACE to talk · click or press M to cycle';
      el.style.borderColor = pttHeld ? 'rgba(127,255,191,0.55)' : 'rgba(0,229,255,0.38)';
      el.style.color = pttHeld ? 'rgba(127,255,191,0.95)' : 'rgba(0,229,255,0.92)';
    } else {
      el.textContent = '● live';
      el.title = 'voice ON · always-on Gemini Live · click or press M to cycle';
      el.style.borderColor = 'rgba(127,255,191,0.42)';
      el.style.color = 'rgba(127,255,191,0.95)';
    }
  }

  // Whenever voice is muted or PTT-only, pop the typed-chat overlay open
  // so the user can fall back to typing. Polls briefly because /voice-mode.js
  // can load before /text-overlay.js has finished installing window.omoText.
  function ensureTextOverlayOpen() {
    let tries = 0;
    const tryOpen = () => {
      try { if (window.omoText?.open) { window.omoText.open(); return true; } } catch {}
      return false;
    };
    if (tryOpen()) return;
    const iv = setInterval(() => {
      if (tryOpen() || ++tries > 40) clearInterval(iv);
    }, 50);
  }

  function setMode(next, opts) {
    if (!VOICE_MODES.includes(next)) return;
    if (next === mode && !opts?.force) return;
    const prev = mode;
    mode = next;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}

    // Tell host pages whether to dim the avatar / mute output gain.
    fire('omo:voice-frozen', { frozen: mode === 'off' });

    if (mode === 'off') {
      pttHeld = false;
      fire('omo:voice-want-off', { reason: 'mode_off' });
      ensureTextOverlayOpen();
    } else if (mode === 'ptt') {
      pttHeld = false;
      // PTT default state: closed. Tear down if leaving 'on'.
      if (prev === 'on') fire('omo:voice-want-off', { reason: 'mode_ptt' });
      else fire('omo:voice-want-off', { reason: 'mode_ptt_init' });
      ensureTextOverlayOpen();
    } else if (mode === 'on') {
      pttHeld = false;
      fire('omo:voice-want-on', { reason: 'mode_on' });
      // Leave the text overlay alone in 'on' mode — if the user opened it
      // manually they probably want it to stay. Esc closes it.
    }

    updateHud();
    fire('omo:voice-mode', { mode, prev });
  }

  function cycle() {
    const i = VOICE_MODES.indexOf(mode);
    setMode(VOICE_MODES[(i + 1) % VOICE_MODES.length]);
  }

  function isTypingTarget(t) {
    return t instanceof HTMLInputElement
        || t instanceof HTMLTextAreaElement
        || (t && t.isContentEditable);
  }

  // M-key cycle. Shift+M is reserved by the cylinder for its mirror toggle,
  // so plain M only. Ignore when typing in a real input.
  window.addEventListener('keydown', (e) => {
    if (e.repeat || isTypingTarget(e.target)) return;
    if (e.shiftKey) return;
    if (e.key !== 'm' && e.key !== 'M') return;
    e.preventDefault();
    cycle();
  });

  // SPACE: push-to-talk.
  //  · PTT mode (Gemini Live): hold to talk, release to send. Standard.
  //  · OFF mode: instead of swallowing the key, hand the press off to
  //    text-overlay's browser-STT PTT. That path uses the free
  //    SpeechRecognition API and pipes the transcript through the cheap
  //    /text/chat rail — no Gemini Live billing. Falls back to the old
  //    swallow if text overlay isn't installed or doesn't support PTT.
  //  · ON mode: falls through so the host page's existing handler runs.
  // Only active when the host has called enablePtt(true) — non-voice
  // pages opt out so SPACE keeps scrolling the page.
  window.addEventListener('keydown', (e) => {
    if (!pttEnabled) return;
    if (e.code !== 'Space' || e.repeat || isTypingTarget(e.target)) return;
    if (mode === 'off') {
      // Hand the space off to text-overlay's hold-detect handler if the
      // overlay can accept it. text-overlay's own handler will run after
      // this one (both capture-phase) and do tap-vs-hold detection so
      // brief taps still type a literal space.
      const tx = window.omoText;
      if (tx?.pttSupported?.() && tx?.isOpen?.()) return;
      // No text-PTT available — fall back to old behaviour: swallow.
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (mode === 'ptt') {
      e.preventDefault();
      pttHeld = true;
      updateHud();
      fire('omo:voice-want-on', { reason: 'ptt_down' });
      e.stopImmediatePropagation();
    }
    // mode === 'on': do nothing here. Host's own SPACE handler will run.
  }, { capture: true });

  window.addEventListener('keyup', (e) => {
    if (!pttEnabled) return;
    if (e.code !== 'Space') return;
    // OFF mode: text-overlay's keyup handler does its own cleanup.
    if (mode === 'off') return;
    if (mode !== 'ptt') return;
    if (!pttHeld) return;
    pttHeld = false;
    updateHud();
    fire('omo:voice-want-off', { reason: 'ptt_up' });
  }, { capture: true });

  // Mount the HUD as soon as the body is ready, and auto-open the typed-
  // chat overlay if we boot into PTT or OFF (the "always-on text box" the
  // user asked for when the mic isn't continuously live).
  function bootInit() {
    updateHud();
    if (mode !== 'on') ensureTextOverlayOpen();
  }
  if (document.body) bootInit();
  else document.addEventListener('DOMContentLoaded', bootInit, { once: true });

  window.omoVoiceMode = {
    get current() { return mode; },
    get pttHeld() { return pttHeld; },
    set: setMode,
    cycle,
    updateHud,
    /**
     * Voice pages call this at boot so spacebar drives PTT. Non-voice
     * pages leave it disabled — the HUD + M-key still work, but SPACE
     * keeps its default behaviour (page scroll, etc.).
     */
    enablePtt(enabled = true) { pttEnabled = !!enabled; },
    /**
     * Host should call this in its auto-connect-on-load path. Returns true
     * only when mode === 'on'. PTT and OFF skip the connect to save cost.
     */
    shouldAutoConnect() { return mode === 'on'; },
  };
})();

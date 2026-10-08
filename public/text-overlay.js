// text-overlay.js — floating glass command bar for talking to omo.
//
// Just the textbox. omo's reply is spoken aloud via the browser's Web
// Speech API; tool side-effects (viz, pane) still mount onto the parent
// page's hologram surfaces. No visible reply stack — voice in, voice out.
//
// Triggered by `/` or ⌘K/CtrlK. Drag the bar from any non-input area;
// position persists. Esc closes and interrupts any in-flight speech.

(() => {
  if (window.__omoTextOverlayInstalled) return;
  window.__omoTextOverlayInstalled = true;

  const STYLE = `
    .omo-bar-root {
      position: fixed; inset: 0; z-index: 99999;
      display: none;
      pointer-events: none;
    }
    .omo-bar-root.open { display: block; }

    /* ── The bar ─────────────────────────────────────────────────── */
    .omo-bar {
      pointer-events: auto;
      position: absolute;
      display: flex; align-items: center; gap: 10px;
      width: min(560px, 92vw);
      height: 56px;
      padding: 0 8px 0 20px;
      border-radius: 999px;
      cursor: grab;
      will-change: transform;
      background:
        linear-gradient(180deg,
          rgba(255, 255, 255, 0.45) 0%,
          rgba(250, 249, 246, 0.30) 100%);
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      border: 1px solid rgba(255, 255, 255, 0.55);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.70),
        inset 0 0 0 1px rgba(45, 42, 38, 0.04),
        0 1px 0 rgba(45, 42, 38, 0.04),
        0 24px 60px rgba(45, 42, 38, 0.20),
        0 6px 18px rgba(45, 42, 38, 0.10);
      animation: omo-bar-pop .22s cubic-bezier(.2, .9, .25, 1.05);
    }
    .omo-bar::before {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      border-radius: inherit;
      background:
        radial-gradient(140% 100% at 0% 0%,  rgba(227, 117, 83, 0.10), transparent 60%),
        radial-gradient(140% 100% at 100% 100%, rgba(111, 168, 176, 0.10), transparent 60%);
      mix-blend-mode: screen;
    }
    .omo-bar.dragging { cursor: grabbing; animation: none; transition: none; }
    @keyframes omo-bar-pop {
      from { opacity: 0; transform: translateY(6px) scale(.98); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Status dot — idle/thinking/speaking. */
    .omo-bar .dot {
      flex: 0 0 auto;
      width: 8px; height: 8px; border-radius: 50%;
      background: #E37553;
      box-shadow: 0 0 0 3px rgba(227, 117, 83, 0.20);
      animation: omo-pulse 2.2s ease-in-out infinite;
      pointer-events: none;
    }
    .omo-bar.thinking .dot {
      animation: omo-pulse-fast .9s ease-in-out infinite;
      background: #6FA8B0;
      box-shadow: 0 0 0 3px rgba(111, 168, 176, 0.24);
    }
    .omo-bar.speaking .dot {
      animation: omo-speak 1.4s ease-in-out infinite;
      background: #6FA8B0;
      box-shadow: 0 0 0 4px rgba(111, 168, 176, 0.30);
    }
    /* PTT (hold-Space) listening — warm dot pulse + warm halo breath.
       Transcription appears live in the input (see rec.onresult). We keep
       the dictated text crisp (no fading) and italicised so it reads as
       "live, being recognised". */
    .omo-bar.listening .dot {
      animation: omo-speak .8s ease-in-out infinite;
      background: #E37553;
      box-shadow: 0 0 0 6px rgba(227, 117, 83, 0.32);
    }
    .omo-bar.listening input { color: #2D2A26; font-style: italic; font-weight: 500; }
    .omo-bar.listening input::placeholder { color: rgba(227, 117, 83, 0.60); font-style: italic; }
    .omo-bar.listening { animation: omo-bar-listen 1.6s ease-in-out infinite; }
    @keyframes omo-bar-listen {
      0%, 100% {
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.70),
          inset 0 0 0 1px rgba(45, 42, 38, 0.04),
          0 1px 0 rgba(45, 42, 38, 0.04),
          0 24px 60px rgba(45, 42, 38, 0.20),
          0 6px 18px rgba(45, 42, 38, 0.10),
          0 0 0 0 rgba(227, 117, 83, 0);
      }
      50% {
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.70),
          inset 0 0 0 1px rgba(227, 117, 83, 0.22),
          0 1px 0 rgba(45, 42, 38, 0.04),
          0 24px 60px rgba(45, 42, 38, 0.20),
          0 6px 18px rgba(45, 42, 38, 0.10),
          0 0 28px 6px rgba(227, 117, 83, 0.26);
      }
    }

    /* Thinking — a light sweep glides across the glass while a soft teal
       halo breathes around the bar. Designed to feel like the assistant
       is "noticing" your request, not just sitting on a spinner. */
    .omo-bar.thinking { animation: omo-bar-breath 2.4s ease-in-out infinite; }
    .omo-bar.thinking::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background: linear-gradient(105deg,
        transparent 32%,
        rgba(255, 250, 240, 0.70) 46%,
        rgba(111, 168, 176, 0.30) 51%,
        rgba(227, 117, 83, 0.16) 56%,
        transparent 70%);
      background-size: 260% 100%;
      background-repeat: no-repeat;
      mix-blend-mode: overlay;
      animation: omo-shimmer 1.6s cubic-bezier(.55, .05, .5, 1) infinite;
    }
    @keyframes omo-shimmer {
      0%   { background-position: -60% 0; opacity: .85; }
      55%  { opacity: 1; }
      100% { background-position: 160% 0; opacity: .85; }
    }
    @keyframes omo-bar-breath {
      0%, 100% {
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.70),
          inset 0 0 0 1px rgba(45, 42, 38, 0.04),
          0 1px 0 rgba(45, 42, 38, 0.04),
          0 24px 60px rgba(45, 42, 38, 0.20),
          0 6px 18px rgba(45, 42, 38, 0.10),
          0 0 0 0 rgba(111, 168, 176, 0);
      }
      50% {
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.70),
          inset 0 0 0 1px rgba(111, 168, 176, 0.18),
          0 1px 0 rgba(45, 42, 38, 0.04),
          0 26px 64px rgba(45, 42, 38, 0.20),
          0 6px 18px rgba(45, 42, 38, 0.10),
          0 0 30px 5px rgba(111, 168, 176, 0.22);
      }
    }

    @keyframes omo-pulse      { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .55; transform: scale(.92); } }
    @keyframes omo-pulse-fast { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .40; transform: scale(.72); } }
    @keyframes omo-speak {
      0%, 100% { transform: scale(1);    box-shadow: 0 0 0 4px  rgba(111, 168, 176, 0.30); }
      50%      { transform: scale(1.25); box-shadow: 0 0 0 8px  rgba(111, 168, 176, 0.18); }
    }

    .omo-bar input {
      flex: 1; min-width: 0;
      background: transparent; border: 0; outline: 0;
      color: #2D2A26;
      cursor: text;
      font: 400 14.5px/1.4 "Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    }
    .omo-bar input::placeholder { color: rgba(45, 42, 38, 0.40); }
    .omo-bar input::selection { background: rgba(227, 117, 83, 0.22); }

    .omo-bar button.send {
      flex: 0 0 auto;
      width: 40px; height: 40px;
      display: flex; align-items: center; justify-content: center;
      border: 0; border-radius: 999px;
      background: #E37553;
      color: #FFFFFF;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(227, 117, 83, 0.36);
      transition: background .15s ease, transform .12s ease, box-shadow .15s ease, opacity .15s ease;
    }
    .omo-bar button.send:hover { background: #C95E3C; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(227, 117, 83, 0.46); }
    .omo-bar button.send:active { transform: translateY(0); }
    .omo-bar button.send:disabled { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: 0 2px 6px rgba(227, 117, 83, 0.20); }
    .omo-bar button.send svg { width: 16px; height: 16px; }

    /* Hint just below the bar */
    .omo-bar-hint {
      position: absolute; bottom: -22px; right: 12px;
      font: 500 10px/1 "JetBrains Mono", ui-monospace, Menlo, monospace;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: rgba(45, 42, 38, 0.42);
      white-space: nowrap; pointer-events: none;
      transition: color .15s ease;
      display: none;
    }
    .omo-bar-hint[data-state="listening"],
    .omo-bar-hint[data-state="thinking"] { display: block; }
    .omo-bar-hint kbd {
      background: rgba(227, 117, 83, 0.12);
      border: 1px solid rgba(227, 117, 83, 0.28);
      border-radius: 4px;
      padding: 1px 6px;
      color: rgba(201, 94, 60, 0.95);
      font-family: inherit;
    }
    .omo-bar-hint[data-state="listening"] { color: rgba(201, 94, 60, 0.85); }
    .omo-bar-hint[data-state="thinking"] { color: rgba(96, 145, 152, 0.85); }

    /* Reply preview — fills in as the model streams. Stays subtle so it
       doesn't compete with the hologram / spoken audio, but guarantees
       the user sees a response even if TTS is blocked or fails. Hides
       itself when empty. */
    .omo-bar-reply {
      position: absolute;
      left: 20px; right: 20px;
      top: calc(100% + 8px);
      max-height: 30vh;
      overflow: auto;
      padding: 10px 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.55);
      backdrop-filter: blur(20px) saturate(160%);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      border: 1px solid rgba(255, 255, 255, 0.5);
      box-shadow: 0 12px 32px rgba(45, 42, 38, 0.14);
      color: #2D2A26;
      font: 400 14px/1.45 "Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      white-space: pre-wrap;
      opacity: 0;
      transition: opacity .18s ease;
      pointer-events: auto;
    }
    .omo-bar-reply.show { opacity: 1; }
    .omo-bar-reply.err { color: #B45A35; background: rgba(255, 232, 222, 0.78); }
    .omo-bar-reply:empty { display: none; }
  `;

  const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l7-7m0 0l7 7m-7-7v18"/></svg>';

  // ─── TTS helpers ─────────────────────────────────────────────────
  // Audio is synthesized server-side by Gemini's preview-tts model and
  // returned as a single WAV blob — much warmer than the browser's
  // built-in voices. One outstanding HTMLAudioElement at a time; new
  // replies stomp the previous one.
  function stripForSpeech(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^_\((.+)\)_$/g, '$1')
      .trim();
  }

  function install() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'omo-bar-root';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="omo-bar" role="dialog" aria-label="omo command bar">
        <span class="dot"></span>
        <input type="text" placeholder="message omo…" autocomplete="off" spellcheck="false" />
        <button class="send" aria-label="send">${SEND_SVG}</button>
        <div class="omo-bar-hint"><kbd>hold space</kbd> talk · <kbd>esc</kbd> close · <kbd>/</kbd> or <kbd>⌘K</kbd> toggle</div>
        <div class="omo-bar-reply" aria-live="polite"></div>
      </div>
    `;
    document.body.appendChild(root);

    const bar = root.querySelector('.omo-bar');
    const input = root.querySelector('input');
    const sendBtn = root.querySelector('button.send');
    const replyEl = root.querySelector('.omo-bar-reply');
    const hintEl = root.querySelector('.omo-bar-hint');
    const HINT_DEFAULT = '<kbd>hold space</kbd> talk · <kbd>esc</kbd> close · <kbd>/</kbd> or <kbd>⌘K</kbd> toggle';
    const HINT_LISTEN  = '<kbd>release</kbd> to send · keep holding to keep talking';
    const HINT_THINK   = 'omo is thinking…';
    function setHint(state) {
      // state: '' | 'listening' | 'thinking'
      hintEl.dataset.state = state || '';
      hintEl.innerHTML =
        state === 'listening' ? HINT_LISTEN :
        state === 'thinking'  ? HINT_THINK :
                                HINT_DEFAULT;
    }
    let replyHideTimer = null;
    function setReplyText(text, { error = false } = {}) {
      replyEl.textContent = text || '';
      replyEl.classList.toggle('err', !!error);
      replyEl.classList.toggle('show', !!text);
      if (replyHideTimer) { clearTimeout(replyHideTimer); replyHideTimer = null; }
    }
    function appendReplyText(delta) {
      if (!delta) return;
      replyEl.textContent += delta;
      replyEl.classList.remove('err');
      replyEl.classList.add('show');
    }
    function scheduleReplyFade(ms = 8000) {
      if (replyHideTimer) clearTimeout(replyHideTimer);
      replyHideTimer = setTimeout(() => {
        replyEl.classList.remove('show');
        replyHideTimer = setTimeout(() => { replyEl.textContent = ''; }, 220);
      }, ms);
    }

    // ─── Position persistence + drag ────────────────────────────────
    const POS_KEY = 'omo.textBar.pos';

    function applyPos(pos) {
      const w = bar.offsetWidth || 480;
      const h = bar.offsetHeight || 56;
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - w - margin);
      const maxTop  = Math.max(margin, window.innerHeight - h - margin);
      const left = Math.min(Math.max(margin, pos.left), maxLeft);
      const top  = Math.min(Math.max(margin, pos.top),  maxTop);
      bar.style.left = left + 'px';
      bar.style.top  = top + 'px';
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
    }
    function loadPos() {
      try {
        const raw = localStorage.getItem(POS_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p?.left === 'number' && typeof p?.top === 'number') return p;
      } catch {}
      return null;
    }
    function savePos(pos) { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {} }

    function placeDefault() {
      const w = bar.offsetWidth || 480;
      const h = bar.offsetHeight || 56;
      applyPos({
        left: Math.max(8, (window.innerWidth - w) / 2),
        top:  Math.max(8, window.innerHeight - h - 32),
      });
    }

    // ─── Focus-defense window ───────────────────────────────────────
    // Other pages (notably /squad's monitor compose, which `.focus()`es
    // its own input on a 320 ms setTimeout when the monitor opens) can
    // race and yank focus right after we grab it. While the guard is
    // active, any focus leaving the bar gets reclaimed. The window is
    // brief enough that genuine outside clicks still work after.
    let focusGuardUntil = 0;
    function defendFocus(ms) {
      focusGuardUntil = Math.max(focusGuardUntil, Date.now() + ms);
    }
    document.addEventListener('focusin', (e) => {
      if (!root.classList.contains('open')) return;
      if (Date.now() > focusGuardUntil) return;
      if (root.contains(e.target)) return;
      try { input.focus(); } catch {}
    }, true);

    let dragState = null;
    bar.addEventListener('pointerdown', (e) => {
      // Any pointerdown inside the bar — input, button, or background — is
      // the user explicitly aiming at us. Defend focus briefly so racing
      // focus() calls from other components don't steal it right after.
      defendFocus(300);
      if (e.button !== 0) return;
      if (e.target.closest('input, button')) return;
      const rect = bar.getBoundingClientRect();
      dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, pointerId: e.pointerId, moved: false };
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      dragState.moved = true;
      applyPos({ left: e.clientX - dragState.dx, top: e.clientY - dragState.dy });
    });
    function endDrag() {
      if (!dragState) return;
      try { bar.releasePointerCapture(dragState.pointerId); } catch {}
      bar.classList.remove('dragging');
      const moved = dragState.moved;
      dragState = null;
      if (moved) {
        const rect = bar.getBoundingClientRect();
        savePos({ left: rect.left, top: rect.top });
      } else {
        input.focus();
      }
    }
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', () => {
      if (!root.classList.contains('open')) return;
      const rect = bar.getBoundingClientRect();
      applyPos({ left: rect.left, top: rect.top });
    });

    // ─── Speaking state ─────────────────────────────────────────────
    // Audio is synthesized by Fish Audio (server-side at /text/speak) and
    // streamed back as audio/mpeg. We hand the GET URL straight to an
    // <audio> element so the browser progressive-downloads the MP3 and
    // starts playing as soon as the first frame arrives — no blob, no
    // arrayBuffer, no waiting on the tail.
    //
    // queue[] holds one playlist of sentences for the current reply.
    // While the model streams text, send() feeds whole sentences in here
    // one at a time, so playback can start before the model has finished
    // generating. speakSeq stomps any in-flight playback when a new reply
    // begins or the user hits Esc.
    const speakQueue = [];
    let currentAudio = null;
    let speakSeq = 0;

    function ttsUrl(text) {
      return '/text/speak?text=' + encodeURIComponent(text) + '&_t=' + speakSeq;
    }

    function enqueueSpeak(text) {
      const clean = stripForSpeech(text);
      if (!clean) return;
      speakQueue.push({ text: clean, seq: speakSeq });
      if (!currentAudio) playNextInQueue();
    }

    function playNextInQueue() {
      const next = speakQueue.shift();
      if (!next) {
        currentAudio = null;
        bar.classList.remove('speaking');
        return;
      }
      if (next.seq !== speakSeq) return playNextInQueue();
      const audio = new Audio(ttsUrl(next.text));
      audio.preload = 'auto';
      currentAudio = audio;
      bar.classList.add('speaking');
      const onDone = () => {
        if (currentAudio !== audio) return;
        playNextInQueue();
      };
      audio.addEventListener('ended', onDone);
      audio.addEventListener('error', (e) => {
        console.warn('[text-bar] audio err', e);
        onDone();
      });
      audio.play().catch((err) => {
        console.warn('[text-bar] play err', err);
        onDone();
      });
    }

    // Legacy single-shot speak(): used by external callers via
    // window.omoText.speak(). Keeps the same behaviour — clear, then
    // queue one item.
    function speak(text) {
      stopSpeaking();
      enqueueSpeak(text);
    }
    function stopSpeaking() {
      speakSeq++;
      speakQueue.length = 0;
      if (currentAudio) {
        try { currentAudio.pause(); currentAudio.src = ''; currentAudio.load(); } catch {}
        currentAudio = null;
      }
      bar.classList.remove('speaking');
    }

    // ─── PTT (push-to-talk) ─────────────────────────────────────────
    // Hold SPACE to dictate, release to send. Uses the browser's native
    // SpeechRecognition (free, browser-side STT — Chrome routes it to
    // Google's speech endpoint at no API-key cost) and pipes the final
    // transcript through the same /text/chat path as a typed message.
    // No Gemini Live, no per-minute mic billing.
    //
    // The recognizer picks a language from (in order): localStorage
    // `omo.ui.lang`, <html lang>, or 'en-US'. Chrome treats this as a
    // hint; mixed-language utterances still mostly work.
    const SR_CTOR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let pttRec = null;
    let pttHeld = false;
    let pttFinal = '';
    // Any text the user had already typed when PTT engages — kept as a
    // prefix so dictation appends to it instead of replacing it.
    let pttPrefix = '';

    function pttSupported() { return !!SR_CTOR; }

    function pttLanguage() {
      try {
        const stored = localStorage.getItem('omo.ui.lang');
        if (stored === 'zh') return 'zh-CN';
        if (stored === 'en') return 'en-US';
      } catch {}
      const html = (document.documentElement.lang || '').toLowerCase();
      if (html.startsWith('zh')) return 'zh-CN';
      return 'en-US';
    }

    function startPtt() {
      if (!pttSupported() || pttHeld || pending) return;
      // If reply audio is still talking from a previous turn, cut it
      // so the user doesn't talk over omo while it's mid-sentence.
      stopSpeaking();
      pttHeld = true;
      pttFinal = '';
      bar.classList.add('listening');
      setHint('listening');
      // Preserve any typed prefix and strip the tap-space that leaked in
      // during the hold-detect window. Dictation appends to the prefix
      // instead of overwriting it, so users can start typing then finish
      // by voice.
      pttPrefix = input.value.replace(/\s+$/, '');
      if (pttPrefix) pttPrefix += ' ';
      input.value = pttPrefix;
      input.placeholder = 'listening…';
      try { input.focus(); } catch {}

      try { pttRec?.abort?.(); } catch {}
      const rec = new SR_CTOR();
      pttRec = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = pttLanguage();

      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) pttFinal += r[0].transcript;
          else interim += r[0].transcript;
        }
        input.value = (pttPrefix + (pttFinal + interim)).replace(/[ \t]+/g, ' ').trim();
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        console.warn('[text-bar][ptt]', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setReplyText('mic permission denied — allow it in browser settings', { error: true });
          scheduleReplyFade(8000);
        } else if (e.error === 'network') {
          setReplyText('PTT network error — Chrome STT needs internet', { error: true });
          scheduleReplyFade(6000);
        }
        cancelPtt();
      };
      rec.onend = () => {
        // Chrome auto-stops on silence; if user is still holding, restart.
        if (pttHeld) {
          try { rec.start(); } catch {}
        }
      };
      try { rec.start(); }
      catch (err) {
        console.warn('[text-bar][ptt] start', err);
        cancelPtt();
      }
    }

    function cancelPtt() {
      pttHeld = false;
      pttFinal = '';
      bar.classList.remove('listening');
      setHint('');
      input.placeholder = 'message omo…';
      try { pttRec?.abort?.(); } catch {}
      pttRec = null;
    }

    async function endPtt() {
      if (!pttHeld) return;
      pttHeld = false;
      bar.classList.remove('listening');
      setHint('');
      input.placeholder = 'message omo…';
      try { pttRec?.stop?.(); } catch {}
      // Wait a beat for the recognizer to emit a final result.
      await new Promise((r) => setTimeout(r, 220));
      const text = (pttFinal || input.value || '').trim();
      pttFinal = '';
      pttRec = null;
      if (!text) return;
      input.value = text;
      send();
    }

    // Streaming text → sentence chunks → TTS. Called on every SSE delta.
    // Splits on CJK and Latin sentence-enders; trailing fragments wait
    // for either more text or the `done` event (flushSpeakBuffer).
    let speakBuffer = '';
    const SENTENCE_RE = /^([\s\S]*?[。！？!?\.](?:["'”’)）\]]+)?\s*)/;
    const MIN_SENTENCE_LEN = 8;  // avoid TTS'ing "ok." on its own
    function feedSpeakBuffer(delta) {
      speakBuffer += delta;
      while (true) {
        const m = SENTENCE_RE.exec(speakBuffer);
        if (!m) break;
        const sentence = m[1];
        if (sentence.trim().length < MIN_SENTENCE_LEN && speakBuffer.length === sentence.length) break;
        speakBuffer = speakBuffer.slice(sentence.length);
        enqueueSpeak(sentence);
      }
    }
    function flushSpeakBuffer() {
      const tail = speakBuffer.trim();
      speakBuffer = '';
      if (tail) enqueueSpeak(tail);
    }

    // ─── Conversation state ────────────────────────────────────────
    const SID_KEY = 'omo.text.sid';
    let sid = sessionStorage.getItem(SID_KEY) || null;
    let pending = false;

    function routeEvent(ev) {
      if (!ev || typeof ev !== 'object') return;
      try {
        if (ev.kind === 'viz' && ev.viz_id && window.__holoChart) {
          window.__holoChart.mount(ev.viz_id, ev.size || 'wide', {
            width: ev.width, height: ev.height, chart_type: ev.chart_type,
          });
        } else if (ev.kind === 'viz_dismiss' && window.__holoChart) {
          window.__holoChart.dismount(ev.viz_id || undefined);
        } else if (ev.kind === 'pane' && ev.url) {
          if (window.__holoPane) {
            window.__holoPane.mount({
              url: ev.url, title: ev.title, page: ev.page,
              slot: ev.slot, view: ev.view, filter: ev.filter,
            });
          } else if (!sameUrl(ev.url)) {
            // Let any ack speech start playing, then navigate. 350ms is
            // enough for the first phoneme; 900ms (the old value) was
            // long enough to feel like a stall.
            setTimeout(() => { try { window.location.href = ev.url; } catch {} }, 350);
          }
        } else if (ev.kind === 'pane_dismiss') {
          // Hologram pages: dismount the projected pane. /squad: cascade-
          // exit the grid overlay (zoom → mosaic → closed) — what
          // "go back / close it / 出去" means when the overlay is the
          // only thing on screen. /preview standalone: navigate back to
          // /squad, the surface the user normally launched it from.
          if (window.__holoPane) window.__holoPane.dismount();
          else if (window.squadGrid?.goBack) window.squadGrid.goBack();
          else if (location.pathname.replace(/\/+$/, '') === '/preview') {
            setTimeout(() => { try { window.location.href = '/squad'; } catch {} }, 250);
          }
        }
      } catch (err) {
        console.warn('[text-bar] route err', err);
      }
    }
    function sameUrl(url) {
      try {
        const here = new URL(window.location.href);
        const there = new URL(url, window.location.origin);
        if (here.pathname.replace(/\/$/, '') !== there.pathname.replace(/\/$/, '')) return false;
        const aq = [...here.searchParams.entries()].sort().join('&');
        const bq = [...there.searchParams.entries()].sort().join('&');
        return aq === bq;
      } catch { return false; }
    }

    // Active fetch's AbortController, so a new send() / Esc / stop kills
    // the still-streaming previous reply.
    let activeCtrl = null;

    // ─── Voice-nav fast-path ──────────────────────────────────────────
    // Short, unambiguous navigation phrases get intercepted client-side
    // BEFORE /text/chat so they fire instantly (0ms vs ~300-1500ms). Same
    // pattern as the HQ "look at the screen and debug" idea: when the
    // right action is unambiguous given the current view state, there's
    // no reason to round-trip the model. Each rule has a guard so it
    // only fires when its destination is reachable from the current page.
    // Rules are tried in order; first match wins. Misses fall through to
    // /text/chat as normal.
    const hasHan = (s) => /[一-鿿]/.test(s);
    const ackFor = (text, en = 'got it ✨', zh = '好嘞~') => hasHan(text) ? zh : en;
    const onPage = (path) => location.pathname.replace(/\/+$/, '') === path.replace(/\/+$/, '');
    function navTo(href) {
      try { stopSpeaking(); } catch {}
      try { window.location.href = href; } catch {}
    }

    // 1. Exit the terminal overlay (one-shot — reveals the page behind).
    const GRID_EXIT_RE = /^(exit|close|close it|close them|close terminals?|close the terminals?|back|go back|out|get out|dismiss|hide(?: it)?|go to squad|back to squad|back to the (?:squad|room)|show (?:me )?(?:the )?(?:squad|room|page behind)|出去|出来|退出(?:网格)?|关掉(?:终端)?|回去|回到(?:房间|squad)?|关掉那个|收起来)[!.。！]*$/i;
    // 2. Open the grid overlay (from /squad's hologram view).
    const GRID_OPEN_RE = /^(?:show\s+(?:me\s+)?(?:the\s+)?(?:grid|terminals?|all terminals?|the agents?'?s? terminals?)|open(?:\s+(?:the|up))?\s+(?:grid|terminals?)|let me see (?:the\s+)?terminals?|grid|terminals?|打开网格|网格|看终端|打开终端|看所有终端)[!.。！]*$/i;
    // 3. Zoom out (mosaic) WITHIN the grid (stay in the overlay).
    const GRID_MOSAIC_RE = /^(?:zoom\s*out|mosaic|show\s+all(?:\s+terminals?)?|back\s+to\s+(?:the\s+)?(?:grid|mosaic)|overview|缩回去|缩小|回到网格|全部终端|全部)[!.。！]*$/i;
    // 4. Cross-page nav — only fire if not already on the target page.
    const NAV_HQ_RE = /^(?:go\s+to|open|show\s+me|take\s+me\s+to)?\s*(?:the\s+)?(?:hq|headquarters|control(?:\s+center)?|command\s+center|总部|控制中心|指挥台)[!.。！]*$/i;
    const NAV_SQUAD_RE = /^(?:go\s+to|open|show\s+me|take\s+me\s+to)\s+(?:the\s+)?(?:squad|agents|pixel\s+office|小队|像素办公室|squad\s+page)[!.。！]*$/i;
    const NAV_HOME_RE = /^(?:go\s+(?:home|back\s+to\s+(?:home|holo|hologram|omo))|home|back\s+to\s+omo|主页|回到主页|首页|回到\s?omo)[!.。！]*$/i;
    // 4b. /preview — open the live-site preview pane. "preview" alone is
    // too ambiguous (could mean "preview the diff"), so require either a
    // qualifier ("the preview / the app / the live site / the site") or a
    // verb phrase ("show me / open / let me see / look at"). Same range
    // of zh phrasing.
    const PREVIEW_OPEN_RE = /^(?:show\s+(?:me\s+)?(?:the\s+)?(?:preview|app|live\s+site|site)|open\s+(?:the\s+)?(?:preview|app|site|live\s+site)|let\s+me\s+see\s+(?:the\s+)?(?:app|preview|site|live\s+site)|see\s+(?:the\s+)?(?:preview|app|live\s+site)|what\s+does\s+(?:it|the\s+(?:app|site|page))\s+look\s+like|look\s+at\s+(?:the\s+)?(?:app|site|preview|live\s+site)|打开预览|看(?:一下|看)?预览|打开网站|看(?:一下|看)?网站|看页面|让我看(?:看|一下)?(?:网站|页面|预览|app|site))[!.。！]*$/i;
    // 5. Voice mode toggles — local state, zero server cost.
    const MUTE_RE = /^(?:mute|silence|shh|静音|关闭语音|关闭麦克风|mic\s+off)[!.。！]*$/i;
    const UNMUTE_RE = /^(?:unmute|listen|open\s+mic|mic\s+on|开麦|开启语音|开启麦克风|talk\s+to\s+me)[!.。！]*$/i;

    // 6. /hq panel & view switches. When window.__omoHq is present (the
    //    /hq page exposes it, see public/hq.html), short phrases jump
    //    straight to a panel / sub-view / filter / drilldown reset with
    //    zero server roundtrip. When /hq is mounted as a pane on the
    //    hologram, we postMessage `omo.focusSlot` to the iframe instead.
    //
    //    Each entry: [regex, panel-key, optional sub-view, optional filter]
    const HQ_PANEL_INTENTS = [
      // Stripe / revenue
      [/^(?:show\s+(?:me\s+)?)?(?:stripe|revenue|sales|money|payments|mrr|charges|收入|营收|付款|支付)$/i, 'stripe'],
      // Stripe sub-views — collocated so "show churn" → stripe + subscriptions
      [/^(?:show\s+(?:me\s+)?)?(?:subscriptions|churn|active\s+subs|active\s+subscribers|churned|trial(?:s|\s+ending)?|订阅|流失|续订|退订)$/i, 'stripe', 'subscriptions'],
      [/^(?:show\s+(?:me\s+)?)?(?:top\s+)?customers?(?:\s+list)?(?:\s+overview)?|customer\s+(?:overview|breakdown)|客户|top\s+customers?$/i, 'stripe', 'customers'],
      [/^(?:show\s+(?:me\s+)?)?(?:payments?|all\s+payments?|charge\s+(?:feed|list)|失败码|card\s+brands?|cards?)$/i, 'stripe', 'payments'],
      [/^(?:show\s+(?:me\s+)?)?(?:payouts?|balance|account\s+balance|gross|fees?|net|余额|未付|已付|invoices?)$/i, 'stripe', 'payouts'],
      [/^(?:show\s+(?:me\s+)?)?(?:catalog|products?(?:\s+(?:list|catalog))?|prices?|价格|产品目录)$/i, 'stripe', 'catalog'],
      [/^(?:show\s+(?:me\s+)?)?(?:disputes?|chargebacks?|refunds?|risk|risk\s+kpis?|fail(?:ed|ure)\s+(?:rate|list|charges?)|风险|争议)$/i, 'stripe', 'risk'],
      // Meta / FB ads
      [/^(?:show\s+(?:me\s+)?)?(?:meta|fb|facebook|ads|advertising|meta\s+ads|fb\s+ads|广告|脸书)$/i, 'meta'],
      [/^(?:show\s+(?:me\s+)?)?(?:scaling|adsets?\s+to\s+action|scale\s+list|leaderboard|trend|放大|扩量)$/i, 'meta', 'scaling'],
      [/^(?:show\s+(?:me\s+)?)?(?:creatives?|creative\s+gallery|top\s+ads?|fatigue|ad\s+fatigue|疲劳|素材)$/i, 'meta', 'creative'],
      [/^(?:show\s+(?:me\s+)?)?(?:audience|demographics?|geo|country|age|gender|platform|受众|国家|年龄|性别)$/i, 'meta', 'audience'],
      [/^(?:show\s+(?:me\s+)?)?(?:diagnostics?|pacing|account\s+health|rate\s+limit|objectives?|status|诊断|账户健康)$/i, 'meta', 'diagnostics'],
      // Meta filter buckets (only valid when in Meta panel)
      [/^(?:what\s+should\s+i\s+kill|kill\s+list|kill|losers|underperformers?|该砍|该停|该关)$/i, 'meta', 'overview', 'KILL'],
      [/^(?:what\s+should\s+i\s+scale|scale\s+list|scale|winners?|top\s+performers?|该放大|该扩量)$/i, 'meta', 'overview', 'SCALE'],
      [/^(?:what\s+(?:to|should\s+i)\s+watch|watch\s+list|watch|fatigued|saturated|saturation|该盯|该看)$/i, 'meta', 'overview', 'WATCH'],
      // Gmail
      [/^(?:show\s+(?:me\s+)?)?(?:gmail|inbox|email|emails?|mail|邮件|邮箱|收件箱)$/i, 'gmail'],
      [/^(?:show\s+(?:me\s+)?)?(?:all\s+(?:my\s+)?(?:emails?|mail)|full\s+inbox|inbox\s+list|所有邮件)$/i, 'gmail', 'inbox'],
      [/^(?:show\s+(?:me\s+)?)?(?:threads?|conversations?|active\s+threads?|会话|对话)$/i, 'gmail', 'threads'],
      [/^(?:show\s+(?:me\s+)?)?(?:senders?|top\s+senders?|who\s+emails?\s+me|发件人|谁给我发邮件)$/i, 'gmail', 'senders'],
      [/^(?:show\s+(?:me\s+)?)?(?:labels?|gmail\s+labels?|标签)$/i, 'gmail', 'labels'],
      [/^(?:show\s+(?:me\s+)?)?(?:attachments?|files?\s+attached|附件)$/i, 'gmail', 'attachments'],
      // Drive
      [/^(?:show\s+(?:me\s+)?)?(?:drive|docs?|google\s+drive|google\s+docs?|documents?|files?|文档|网盘)$/i, 'drive'],
      // Transcript
      [/^(?:show\s+(?:me\s+)?)?(?:transcript|overheard|listening|conversations?|audio|转录|偷听|环境录音)$/i, 'transcript'],
      // GitHub / code
      [/^(?:show\s+(?:me\s+)?)?(?:github|gh|git|code|prs?|pull\s+requests?|repo(?:s|sitor(?:y|ies))?|ci|actions?|代码|代码库|仓库|拉取请求)$/i, 'github'],
    ];
    // /hq "back to all panels / overview / 6-panel grid" — clear single-panel focus.
    const HQ_CLEAR_FOCUS_RE = /^(?:show\s+all|all\s+panels?|panels?|overview|back\s+to\s+overview|全部面板|回到全部|全景|缩回去)[!.。！]*$/i;
    // /hq drilldown close — back from email/charge/file reader to panel.
    const HQ_CLOSE_READER_RE = /^(?:close\s+(?:the\s+)?(?:email|message|charge|invoice|file|reader|that)|close\s+(?:it|this)|back\s+to\s+(?:the\s+)?panel|关掉(?:邮件|这个)?|收起来)[!.。！]*$/i;

    function tryVoiceNavShortcut(rawText) {
      const text = String(rawText || '').trim();
      if (!text || text.length > 64) return false;

      const grid = window.squadGrid;
      const gridOpen = !!grid?.isOpen?.();
      // /squad's floating agent monitor — open when #monitor has the
      // .open class. We close it client-side too so "exit/back/out"
      // peels whichever surface is on top.
      const monitorEl = onPage('/squad') ? document.getElementById('monitor') : null;
      const monitorOpen = !!(monitorEl && monitorEl.classList.contains('open'));
      // Holo pages mount /hq, /squad, /preview, etc. as a pane via
      // pane-layer.js. body.pane-open is set whenever currentPane exists,
      // so it's a cheap, library-stable check. dismount() is idempotent
      // either way, but we read the class so we know whether we just
      // acted on this surface (and can ack instantly without falling
      // through to other branches).
      const paneOpen = !!window.__holoPane && document.body?.classList?.contains('pane-open');
      const onPreviewPage = onPage('/preview');

      if (GRID_EXIT_RE.test(text)) {
        let acted = false;
        try {
          if (paneOpen) { window.__holoPane.dismount(); acted = true; }
          if (gridOpen) { grid.goBack(); acted = true; }
          if (monitorOpen) {
            const back = document.getElementById('monitor-backdrop');
            (back || monitorEl)?.click?.();
            acted = true;
          }
        } catch {}
        if (acted) { enqueueSpeak(ackFor(text)); return true; }
        // /preview standalone — no pane / no overlay to peel, but we
        // know the user wants to leave it. Send them back to /squad,
        // which is where they normally launched the preview from.
        if (onPreviewPage) {
          enqueueSpeak(ackFor(text, 'back to squad', '回小队~'));
          setTimeout(() => navTo('/squad'), 250);
          return true;
        }
      }
      if (PREVIEW_OPEN_RE.test(text) && !onPreviewPage) {
        // On a holo page, mount /preview as a pane so the avatar
        // shrinks and the preview takes over the stage. Anywhere else
        // (e.g. /squad, /hq), navigate to /preview as a full page.
        try {
          if (window.__holoPane) {
            window.__holoPane.mount({ url: '/preview', page: 'preview', title: 'PREVIEW' });
            enqueueSpeak(ackFor(text, 'opening preview', '打开预览~'));
            return true;
          }
        } catch {}
        enqueueSpeak(ackFor(text, 'opening preview', '打开预览~'));
        setTimeout(() => navTo('/preview'), 250);
        return true;
      }
      if (GRID_OPEN_RE.test(text) && grid && !gridOpen && onPage('/squad')) {
        try { grid.open(); enqueueSpeak(ackFor(text)); return true; } catch {}
      }
      if (GRID_MOSAIC_RE.test(text) && gridOpen) {
        try {
          // Cascade like Escape: zoom1/2/4 → mosaic → close. Saying
          // "zoom out" a second time while already in mosaic leaves the
          // overlay entirely. Matches what users mean by "zoom out / go
          // back" — peel one layer each time.
          if (grid.mode?.() === 'mosaic') {
            grid.goBack();
            enqueueSpeak(ackFor(text));
          } else {
            grid.setLayout('mosaic');
            enqueueSpeak(ackFor(text, 'mosaic ✨', '缩回去啦~'));
          }
          return true;
        } catch {}
      }
      if (NAV_HQ_RE.test(text) && !onPage('/hq')) {
        enqueueSpeak(ackFor(text, 'going to HQ', '去总部~'));
        // Tiny delay so the ack starts speaking before page tear-down.
        setTimeout(() => navTo('/hq'), 250);
        return true;
      }
      if (NAV_SQUAD_RE.test(text) && !onPage('/squad')) {
        enqueueSpeak(ackFor(text, 'going to squad', '去小队~'));
        setTimeout(() => navTo('/squad'), 250);
        return true;
      }
      if (NAV_HOME_RE.test(text) && !onPage('/') && !onPage('/holo')) {
        enqueueSpeak(ackFor(text, 'going home', '回主页~'));
        setTimeout(() => navTo('/'), 250);
        return true;
      }
      if (MUTE_RE.test(text) && window.omoVoiceMode?.set) {
        try { window.omoVoiceMode.set('off'); enqueueSpeak(ackFor(text, 'muted', '静音啦')); return true; } catch {}
      }
      if (UNMUTE_RE.test(text) && window.omoVoiceMode?.set) {
        try { window.omoVoiceMode.set('on'); enqueueSpeak(ackFor(text, 'listening', '开麦啦')); return true; } catch {}
      }

      // ─── HQ panel / view / filter / reader fast-paths ────────────────
      // These work both when /hq is the top page (window.__omoHq present)
      // AND when /hq is mounted as a pane on the hologram (use the iframe
      // omo.focusSlot postMessage). Either way, zero server roundtrip.
      if (tryHqShortcut(text)) return true;

      // ─── Visible-button shortcuts ────────────────────────────────────
      // Universal "click the visible button" pattern: when a UI element is
      // already on screen for the action the user just said, click it
      // instead of round-tripping through the model. Covers the awaiting-
      // prompt banner, agent review card, and email send/discard.
      if (tryVisibleButtonShortcut(text)) return true;

      // ─── Preview-bridge nav fast-paths ───────────────────────────────
      // When a preview pane is mounted, "back / forward / reload / scroll
      // down / submit" go straight to the bridge via postMessage. The
      // bridge already accepts {type:'omo.preview.cmd', command, ...} so
      // we skip the WS hop and ack roundtrip.
      if (tryPreviewShortcut(text)) return true;

      return false;
    }

    // ─── visible-button intercept ──────────────────────────────────────
    // Approval-prompt banner (squad-grid awaiting). Yes / always / no /
    // show-me — fire the same click handler the user would tap. Risk-free:
    // the button is visible, the user sees the result, and the click is
    // idempotent. Saves ~300-800ms (Gemini round-trip).
    const BANNER_YES_RE = /^(?:yes|yeah|yep|ok|okay|sure|proceed|go ahead|do it|allow|approve|accept|continue|carry on|可以|好|好的|行|同意|批准|继续|你可以继续)[!.。！]*$/i;
    const BANNER_ALWAYS_RE = /^(?:always|always yes|yes always|don't ask again|dont ask again|remember(?: this| it)?|总是|一直允许|以后都允许|别再问|不要再问|记住)[!.。！]*$/i;
    const BANNER_NO_RE = /^(?:no|nope|n|decline|reject|deny|dont|don't|do not|不要|不行|不可以|拒绝|别|否)[!.。！]*$/i;
    const BANNER_SHOWME_RE = /^(?:show me|zoom|let me see|look|看看|看一下|先看|放大|放大看)[!.。！]*$/i;
    const BANNER_NUM_RE = /^([1-3])[!.。！]*$/;
    // Agent review card (mounted after task_complete). SHIP / SCRAP / PREVIEW.
    const REVIEW_SHIP_RE = /^(?:ship\s*it|ship|send\s+it|merge|merge\s+it|accept|apply|apply\s+it|通过|合(?:进?去|进来)?|接受|发出)[!.。！]*$/i;
    const REVIEW_SCRAP_RE = /^(?:scrap(?:\s+(?:it|that))?|throw\s+(?:it\s+)?away|discard|nah|nope\s+scrap|丢掉|扔掉|舍弃|不要了?|撤回)[!.。！]*$/i;
    const REVIEW_PREVIEW_RE = /^(?:preview(?:\s+it)?|show\s+(?:me\s+)?(?:the\s+)?diff|see\s+(?:the\s+)?diff|let\s+me\s+see|先看一下|看(?:看)?(?:改动|diff)?|看一下改动|预览|打开预览)[!.。！]*$/i;
    // Gmail draft compose. SEND / DISCARD when a draft is staged.
    const EMAIL_SEND_RE = /^(?:send(?:\s+it)?|fire(?:\s+it)?|fire\s+away|发吧|发出|发送|送出|发出去|可以发|发送邮件)[!.。！]*$/i;
    const EMAIL_DISCARD_RE = /^(?:scrap(?:\s+(?:it|that))?|discard(?:\s+(?:it|draft))?|throw\s+(?:it\s+)?away|never\s+mind|nah|不要(?:了|发)?|算了|放弃|丢掉|删掉)[!.。！]*$/i;

    function tryVisibleButtonShortcut(text) {
      if (text.length > 48) return false;

      // 1) Approval-prompt banner (squad-grid). Topmost priority — when
      //    the banner is visible the user is parked on an explicit yes/no.
      const banner = document.querySelector('.sg-banner.sg-show');
      if (banner) {
        const fire = (choice) => {
          const btn = banner.querySelector('[data-choice="' + choice + '"]');
          if (!btn) return false;
          btn.click();
          enqueueSpeak(ackFor(text));
          return true;
        };
        if (BANNER_YES_RE.test(text)) { if (fire('yes')) return true; }
        if (BANNER_ALWAYS_RE.test(text)) { if (fire('always')) return true; }
        if (BANNER_NO_RE.test(text)) { if (fire('no')) return true; }
        if (BANNER_SHOWME_RE.test(text)) { if (fire('zoom')) return true; }
        const m = text.match(BANNER_NUM_RE);
        if (m) {
          const n = parseInt(m[1], 10);
          if (fire(n === 1 ? 'yes' : n === 2 ? 'always' : 'no')) return true;
        }
      }

      // 2) Agent review card — flying on stage after task_complete with
      //    PREVIEW / SHIP IT / SCRAP buttons.
      const reviewCard = document.querySelector(
        '.ag-review-card, .agent-review-card, [data-review-card]'
      );
      if (reviewCard) {
        const click = (action) => {
          const btn = reviewCard.querySelector('[data-action="' + action + '"], [data-ag-action="' + action + '"]');
          if (!btn) return false;
          btn.click();
          enqueueSpeak(ackFor(text));
          return true;
        };
        if (REVIEW_SHIP_RE.test(text))    { if (click('ship') || click('accept')) return true; }
        if (REVIEW_SCRAP_RE.test(text))   { if (click('scrap') || click('discard')) return true; }
        if (REVIEW_PREVIEW_RE.test(text)) { if (click('preview') || click('show-preview')) return true; }
      }

      // 3) Gmail draft staged in the /hq reader. Send / discard buttons.
      const stagedReader = document.querySelector('[data-draft-staged="1"]');
      if (stagedReader) {
        const click = (slot) => {
          const btn = stagedReader.querySelector('[data-slot="' + slot + '"]');
          if (!btn || btn.disabled) return false;
          btn.click();
          enqueueSpeak(ackFor(text));
          return true;
        };
        if (EMAIL_SEND_RE.test(text))    { if (click('send')) return true; }
        if (EMAIL_DISCARD_RE.test(text)) { if (click('discard')) return true; }
      }

      return false;
    }

    // ─── preview-bridge intercept ──────────────────────────────────
    // Only fires when a preview pane is mounted. Pre-bridge dispatch keeps
    // a 2s ack timeout but the model doesn't wait on us — we postMessage
    // fire-and-forget and ack the user instantly. The bridge itself does
    // fuzzy DOM matching for click/type/focus targets, so we just pass the
    // raw user phrase through and let the bridge's resolver handle it.
    const PREVIEW_BACK_RE = /^(?:back|go\s+back|previous|prev|后退|上一页|回去)[!.。！]*$/i;
    const PREVIEW_FORWARD_RE = /^(?:forward|next|前进|下一页)[!.。！]*$/i;
    const PREVIEW_RELOAD_RE = /^(?:reload|refresh|刷新|重新加载)[!.。！]*$/i;
    const PREVIEW_SCROLL_RE = /^(?:scroll\s+(?:down|up|to\s+(?:top|bottom)|顶|底)|往下(?:滑|滚)?|往上(?:滑|滚)?|滚到顶|滚到底|上滚|下滚)[!.。！]*$/i;
    const PREVIEW_SUBMIT_RE = /^(?:submit|press\s+enter|hit\s+enter|确认|提交|发送)[!.。！]*$/i;
    // click / press / tap / 点 / 按 — fuzzy target match in the bridge.
    const PREVIEW_CLICK_RE = /^(?:click(?:\s+on)?|press|tap|hit|点(?:击|一下)?|按(?:一下)?)\s+(.+?)[!.。！]*$/i;
    // type X in Y / 在 Y 输入 X — two-arg form (text + target field).
    const PREVIEW_TYPE_IN_RE = /^(?:type|输入|填(?:写)?)\s+(.+?)\s+(?:in(?:to)?|在|进(?:入)?)\s+(?:the\s+)?(.+?)[!.。！]*$/i;
    // type X / 输入 X — single-arg form (text only; targets focused field).
    const PREVIEW_TYPE_RE = /^(?:type|输入|填(?:写)?)\s+(.+?)[!.。！]*$/i;
    // focus X / select the X / 聚焦 X.
    const PREVIEW_FOCUS_RE = /^(?:focus(?:\s+on)?|select(?:\s+the)?|聚焦|定位到|跳到)\s+(.+?)[!.。！]*$/i;
    // describe — the bridge returns headings/links/buttons; we let the
    // model handle this one so the summary stays a Momo line, NOT a regex
    // intercept. Kept here as a comment so future me doesn't add it.
    // Close / dismiss the preview pane. Routes via __holoPane.dismount —
    // exact same path the dismiss_pane tool result triggers.
    const PREVIEW_CLOSE_RE = /^(?:close|dismiss|hide|exit|out)(?:\s+(?:the\s+)?(?:preview|page|app|site|website))?|关掉(?:预览|网页|网站)?|收(?:起|掉)(?:预览)?|退出预览[!.。！]*$/i;

    function findPreviewIframe() {
      // On /preview as the TOP page, the inner #frame iframe IS the bridge
      // host (the user's previewed URL with preview-bridge.js injected).
      // Posting directly to it skips the /preview.js relay layer.
      if (location.pathname === '/preview' || location.pathname.startsWith('/preview/')) {
        const inner = document.getElementById('frame');
        if (inner) return inner;
      }
      // On /holo with a preview pane mounted, find the /preview iframe and
      // post into it — /preview.js then relays the command to #frame.
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        const src = f.getAttribute('src') || '';
        if (src.startsWith('/preview') || /[?&]omo[-_]?preview/.test(src)) return f;
      }
      return null;
    }

    function tryPreviewShortcut(text) {
      const iframe = findPreviewIframe();
      if (!iframe || !iframe.contentWindow) return false;

      // Hard cap is generous since click/type targets can be long.
      if (text.length > 120) return false;

      const post = (msg, ackLabel) => {
        try {
          iframe.contentWindow.postMessage(
            { type: 'omo.preview.cmd', id: 'fastpath_' + Date.now().toString(36), ...msg },
            '*'
          );
          enqueueSpeak(ackLabel || ackFor(text));
          return true;
        } catch { return false; }
      };

      // ── Navigation (highest priority — short/unambiguous) ──────────
      if (PREVIEW_BACK_RE.test(text))    return post({ command: 'navigate', action: 'back' }, ackFor(text, 'back', '回上一页'));
      if (PREVIEW_FORWARD_RE.test(text)) return post({ command: 'navigate', action: 'forward' }, ackFor(text, 'forward', '前进'));
      if (PREVIEW_RELOAD_RE.test(text))  return post({ command: 'navigate', action: 'reload' }, ackFor(text, 'reloading', '刷新'));
      if (PREVIEW_SUBMIT_RE.test(text))  return post({ command: 'submit' }, ackFor(text, 'submitted', '提交了'));
      if (PREVIEW_SCROLL_RE.test(text)) {
        const t = text.toLowerCase();
        let dir = 'down';
        if (/up|往上|上滚/.test(t)) dir = 'up';
        else if (/top|顶/.test(t)) dir = 'top';
        else if (/bottom|底/.test(t)) dir = 'bottom';
        return post({ command: 'scroll', direction: dir }, ackFor(text));
      }

      // ── Close / dismiss the preview pane ──────────────────────────
      if (PREVIEW_CLOSE_RE.test(text)) {
        try {
          if (window.__holoPane?.dismount) {
            window.__holoPane.dismount();
            enqueueSpeak(ackFor(text, 'closed ✨', '关掉啦~'));
            return true;
          }
        } catch {}
        // No __holoPane (we're on /preview as top page) — fall through.
      }

      // ── click X / press X / 点 X ────────────────────────────────────
      const cm = PREVIEW_CLICK_RE.exec(text);
      if (cm) {
        const target = cm[1].trim();
        return post({ command: 'click', target }, ackFor(text, 'clicked ' + target, '点了 ' + target));
      }

      // ── type X in Y (two-arg) ─────────────────────────────────────
      const tim = PREVIEW_TYPE_IN_RE.exec(text);
      if (tim) {
        const inputText = tim[1].trim();
        const target = tim[2].trim();
        return post({ command: 'type', text: inputText, target }, ackFor(text, 'typed in ' + target, '输入到 ' + target));
      }
      // ── type X (single-arg — needs focused field) ──────────────────
      // Only fire when the text is short-ish AND doesn't look like a
      // sentence ("type 'hello world'" passes; "type this letter and..." fails).
      const tm = PREVIEW_TYPE_RE.exec(text);
      if (tm && tm[1].trim().split(/\s+/).length <= 8) {
        const inputText = tm[1].trim();
        return post({ command: 'type', text: inputText }, ackFor(text, 'typed', '输入了'));
      }

      // ── focus X ────────────────────────────────────────────────────
      const fm = PREVIEW_FOCUS_RE.exec(text);
      if (fm) {
        const target = fm[1].trim();
        return post({ command: 'focus', target }, ackFor(text, 'focused ' + target, '聚焦 ' + target));
      }

      return false;
    }

    // Returns true if the utterance matched an HQ panel/view/filter/reader
    // shortcut AND we could apply it (i.e. /hq is reachable from this page).
    function tryHqShortcut(text) {
      if (text.length > 64) return false;
      const hqApi = window.__omoHq;
      const hqIframe = findHqIframe();
      if (!hqApi && !hqIframe) return false;

      // Close-reader: only valid when a drilldown is open. Always try first
      // so "close" beats panel-name matches if a reader is up.
      if (HQ_CLOSE_READER_RE.test(text)) {
        if (hqApi?.closeReader?.()) {
          enqueueSpeak(ackFor(text, 'closed ✨', '关掉啦~'));
          return true;
        }
        // /hq-in-iframe path: there's no postMessage opcode for "close
        // reader". Fall through so the model handles it via dismiss_pane.
      }

      // Clear panel focus → back to 6-panel grid.
      if (HQ_CLEAR_FOCUS_RE.test(text)) {
        if (hqApi?.clearFocus?.()) {
          enqueueSpeak(ackFor(text, 'overview ✨', '回到全部啦~'));
          return true;
        }
        if (hqIframe) {
          hqIframe.contentWindow?.postMessage({ type: 'omo.focusSlot', slot: null }, '*');
          enqueueSpeak(ackFor(text, 'overview ✨', '回到全部啦~'));
          return true;
        }
      }

      // Match a panel intent. First wins (the table is ordered so
      // sub-view-specific phrases are tested before bare panel names).
      for (const intent of HQ_PANEL_INTENTS) {
        const [re, panel, view, filter] = intent;
        if (!re.test(text)) continue;
        // Same-page top-level call.
        if (hqApi) {
          try {
            hqApi.setFocus(panel);
            if (view) hqApi.setView(panel, view);
            if (filter) hqApi.setFilter(filter);
          } catch (err) { console.warn('[text-bar][hq]', err); }
          const label = filter ? `${panel}/${(view || 'overview').toLowerCase()} · ${filter.toLowerCase()}`
                       : view   ? `${panel}/${view}`
                       :          panel;
          enqueueSpeak(ackFor(text, label, '好嘞~'));
          return true;
        }
        // Pane-mounted: postMessage into the iframe (sync, ~5ms).
        if (hqIframe) {
          const msg = { type: 'omo.focusSlot', slot: panel };
          if (view) msg.view = view;
          if (filter) msg.filter = filter;
          try { hqIframe.contentWindow?.postMessage(msg, '*'); } catch {}
          enqueueSpeak(ackFor(text, panel, '好嘞~'));
          return true;
        }
      }
      return false;
    }

    // Locate a mounted /hq iframe — pane-layer assigns the page name on
    // window.__holoPane and renders an iframe whose src starts with /hq.
    function findHqIframe() {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        try {
          const src = f.getAttribute('src') || '';
          if (src.startsWith('/hq') || src.includes('localhost') && src.includes('/hq')) return f;
        } catch {}
      }
      return null;
    }

    async function send() {
      if (pending) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      stopSpeaking();
      // Voice-nav fast-path: short, unambiguous navigation phrases skip
      // /text/chat entirely and fire instantly. Anything that doesn't
      // match falls through to /text/chat as normal.
      if (tryVoiceNavShortcut(text)) return;
      if (activeCtrl) { try { activeCtrl.abort(); } catch {} }
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      pending = true;
      sendBtn.disabled = true;
      bar.classList.add('thinking');
      setHint('thinking');
      setReplyText('');
      // Bound the "thinking" indicator to the first model output —
      // once text starts flowing or a side-effect arrives, the user
      // perceives the reply as in-progress.
      let firstChunkSeen = false;
      const markFirst = () => {
        if (firstChunkSeen) return;
        firstChunkSeen = true;
        bar.classList.remove('thinking');
        setHint('');
      };

      let r;
      try {
        r = await fetch('/text/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: JSON.stringify({ sid, message: text, stream: 1 }),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        pending = false; sendBtn.disabled = false; bar.classList.remove('thinking'); setHint('');
        console.warn('[text-bar] fetch err', err);
        setReplyText('network error: ' + (err?.message || err), { error: true });
        scheduleReplyFade(6000);
        return;
      }
      if (!r.ok) {
        bar.classList.remove('thinking');
        setHint('');
        pending = false; sendBtn.disabled = false;
        let detail = '';
        try { detail = (await r.json())?.error || ''; } catch {}
        const msg = detail || ('server error ' + r.status);
        console.warn('[text-bar] http', r.status, detail);
        setReplyText(msg, { error: true });
        scheduleReplyFade(6000);
        return;
      }

      try {
        await consumeSseStream(r, ctrl.signal, {
          onSid: (s) => { if (s) { sid = s; sessionStorage.setItem(SID_KEY, sid); } },
          onText: (delta) => { markFirst(); appendReplyText(delta); feedSpeakBuffer(delta); },
          onEvent: (ev) => { markFirst(); routeEvent(ev); },
          onDone: () => { flushSpeakBuffer(); scheduleReplyFade(); },
          onError: (msg) => {
            console.warn('[text-bar] server error', msg);
            setReplyText(msg || 'server error', { error: true });
            scheduleReplyFade(6000);
          },
        });
      } catch (err) {
        if (!ctrl.signal.aborted) {
          console.warn('[text-bar] sse err', err);
          setReplyText('stream error: ' + (err?.message || err), { error: true });
          scheduleReplyFade(6000);
        }
      } finally {
        if (activeCtrl === ctrl) activeCtrl = null;
        bar.classList.remove('thinking');
        setHint('');
        pending = false; sendBtn.disabled = false;
        try { input.focus(); } catch {}
      }
    }

    // Minimal SSE parser. Reads `event:` and `data:` lines; emits whole
    // events on the blank-line boundary. Cancellable via AbortSignal.
    async function consumeSseStream(response, signal, handlers) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          if (signal?.aborted) { try { reader.cancel(); } catch {} return; }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message', dataStr = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trimStart();
            }
            let data = {};
            try { data = dataStr ? JSON.parse(dataStr) : {}; } catch {}
            if (event === 'sid')       handlers.onSid?.(data.sid);
            else if (event === 'text') handlers.onText?.(String(data.delta || ''));
            else if (event === 'event')handlers.onEvent?.(data);
            else if (event === 'tool') { /* transcript hint, no-op in overlay */ }
            else if (event === 'done') { handlers.onDone?.(data); return; }
            else if (event === 'error'){ handlers.onError?.(data.error); return; }
          }
        }
      } finally {
        try { reader.releaseLock?.(); } catch {}
      }
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    // ─── Open / close / toggle ─────────────────────────────────────
    function open() {
      if (root.classList.contains('open')) return;
      root.classList.add('open');
      root.setAttribute('aria-hidden', 'false');
      defendFocus(700);
      requestAnimationFrame(() => {
        const saved = loadPos();
        if (saved) applyPos(saved); else placeDefault();
        try { input.focus(); } catch {}
      });
    }
    function close() {
      if (!root.classList.contains('open')) return;
      stopSpeaking();
      if (activeCtrl) { try { activeCtrl.abort(); } catch {} activeCtrl = null; }
      pending = false; sendBtn.disabled = false;
      speakBuffer = '';
      setReplyText('');
      root.classList.remove('open');
      root.setAttribute('aria-hidden', 'true');
    }
    function toggle() { if (root.classList.contains('open')) close(); else open(); }

    window.addEventListener('keydown', (e) => {
      const t = e.target;
      const typingInParent = (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t && t.isContentEditable))
        && !root.contains(t);

      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); toggle(); return;
      }
      if (e.key === 'Escape' && root.classList.contains('open')) {
        e.preventDefault(); close(); return;
      }
      if (e.key === '/' && !typingInParent && !root.contains(document.activeElement)) {
        e.preventDefault(); open(); return;
      }
    });

    // PTT — hold SPACE to dictate, release to send. Registered in capture
    // so it can decide before host-page handlers; voice-mode.js running
    // in 'off' mode also calls window.omoText.startPtt/endPtt directly,
    // so the two paths converge here.
    //
    // We only handle SPACE if:
    //   - overlay is open
    //   - SpeechRecognition is available
    //   - input is empty (so users can still type spaces in messages)
    //   - voice mode (if present) is OFF or absent
    // Tap-vs-hold detection: a quick space tap stays a literal space
    // character; a hold past 220 ms engages PTT. Auto-repeats are
    // unconditionally swallowed while the overlay is open and our input
    // (or no other input) owns the space key — without this, the OS
    // pumps " " into the focused field every ~30 ms while the user is
    // talking, which is the "spaces forever" bug.
    const PTT_HOLD_MS = 220;
    let pttPendingTimer = null;

    function spaceIsOurs(target) {
      if (!target) return true;
      if (target === input) return true;
      if (root.contains(target)) return true;
      // Some other text-entry surface on the host page — let space pass.
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return false;
      return true;
    }
    function pttPreconditionsMet() {
      if (!root.classList.contains('open')) return false;
      if (!pttSupported()) return false;
      if (pending) return false;
      const vm = window.omoVoiceMode;
      if (vm && vm.current && vm.current !== 'off') return false;
      return true;
    }

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      if (!root.classList.contains('open')) return;
      if (!spaceIsOurs(e.target)) return;

      // Already mid-PTT or mid-hold-decision — swallow every keydown
      // (including the auto-repeats the OS fires while held).
      if (pttHeld || pttPendingTimer) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Repeats that arrive before we've armed the timer: still swallow.
      // (Shouldn't happen — the first event is always non-repeat — but
      // defends against odd focus / blur edge cases.)
      if (e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!pttPreconditionsMet()) return;

      // First press: arm a hold timer. We DON'T preventDefault here, so
      // a brief tap still types a literal space into whatever's focused;
      // if the user keeps holding past PTT_HOLD_MS, startPtt() engages
      // and strips any trailing whitespace from the tap that leaked in.
      pttPendingTimer = setTimeout(() => {
        pttPendingTimer = null;
        startPtt();
      }, PTT_HOLD_MS);
    }, { capture: true });

    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      if (pttPendingTimer) {
        // Released before the threshold — it was a tap, not a hold.
        // The literal space already went into the input on keydown.
        clearTimeout(pttPendingTimer);
        pttPendingTimer = null;
        return;
      }
      if (pttHeld) {
        e.preventDefault();
        e.stopImmediatePropagation();
        endPtt();
      }
    }, { capture: true });

    window.omoText = {
      open, close, toggle, speak, stopSpeaking,
      isOpen: () => root.classList.contains('open'),
      startPtt, endPtt, cancelPtt,
      pttSupported,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();

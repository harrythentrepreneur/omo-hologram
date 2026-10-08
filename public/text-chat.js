// Floating text-chat input for talking to Momo without a mic.
//
// The host page wires up four callbacks:
//   - getSession() → the active Live API session, or null/undefined
//   - isConnected() → boolean, true if we can send right now
//   - connect() → Promise that opens a session (no-op if already open)
//   - diag(msg, isErr?) → optional, mirrors the page's own readout
//
// Design: pill-shaped input bottom-center, mirrors the cyan theme. Hidden
// by default; press `/` to focus, Esc to blur. Enter submits. If the
// session isn't connected, Enter auto-connects first and queues the text.
//
// Reflector-safe: pure-black fill, cyan outline only. Lives inside #stage
// when one is present so any mirror-flip transform applies — keeping the
// text right-way-round in the reflection. Pass { mountEl } to override.

const CSS = `
  #chatbox {
    position: absolute;
    left: 50%;
    bottom: 4%;
    transform: translateX(-50%);
    z-index: 40;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px 6px 14px;
    background:
      linear-gradient(180deg, rgba(0,229,255,0.06) 0%, rgba(0,0,0,0) 60%),
      rgba(0, 0, 0, 0.55);
    border: 1px solid rgba(0,229,255,0.38);
    border-radius: 999px;
    box-shadow:
      0 0 0 1px rgba(0,229,255,0.08),
      0 12px 40px rgba(0,0,0,0.7),
      0 0 24px rgba(0,229,255,0.18);
    opacity: 0;
    transition: opacity 0.35s ease, transform 0.35s cubic-bezier(0.22,1,0.36,1);
    pointer-events: none;
    font-family: 'Inter', 'SF Pro Text', system-ui, sans-serif;
  }
  #chatbox.show { opacity: 0.96; pointer-events: auto; transform: translateX(-50%) translateY(0); }
  #chatbox.hidden-by-user { opacity: 0 !important; pointer-events: none !important; }

  #chatbox::before {
    content: '';
    display: block;
    width: 7px; height: 7px; border-radius: 50%;
    background: #ff66b3;
    box-shadow: 0 0 8px #ff66b3;
    flex-shrink: 0;
    opacity: 0.55;
    transition: background 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
  }
  #chatbox.connected::before {
    background: #00e5ff;
    box-shadow: 0 0 8px #00e5ff;
    opacity: 0.95;
  }
  #chatbox.busy::before {
    animation: chat-dot-pulse 1.2s ease-in-out infinite;
  }
  @keyframes chat-dot-pulse {
    0%, 100% { opacity: 0.4; transform: scale(0.85); }
    50%      { opacity: 1;   transform: scale(1.05); }
  }

  #chatinput {
    background: transparent;
    border: 0; outline: 0;
    color: rgba(255,255,255,0.96);
    font: 500 13px/1.1 'Inter', 'SF Pro Text', system-ui, sans-serif;
    letter-spacing: 0.01em;
    width: min(60vw, 520px);
    padding: 8px 6px;
    caret-color: #00e5ff;
  }
  #chatinput::placeholder {
    color: rgba(0,229,255,0.55);
    letter-spacing: 0.12em;
    font-size: 11px;
    text-transform: uppercase;
  }

  #chatsend {
    appearance: none;
    background: rgba(0,229,255,0.12);
    border: 1px solid rgba(0,229,255,0.5);
    color: #00e5ff;
    font: 600 10px/1 'SF Mono', ui-monospace, monospace;
    letter-spacing: 0.18em;
    padding: 7px 12px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
    flex-shrink: 0;
  }
  #chatsend:hover { background: rgba(0,229,255,0.22); }
  #chatsend:disabled { opacity: 0.4; cursor: not-allowed; }

  #chathint {
    position: absolute;
    left: 50%;
    bottom: calc(4% + 44px);
    transform: translateX(-50%);
    z-index: 40;
    font: 500 9px/1 'SF Mono', ui-monospace, monospace;
    letter-spacing: 0.22em;
    color: rgba(0,229,255,0.55);
    text-transform: uppercase;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.4s ease;
  }
  #chatbox.show + #chathint { opacity: 0.6; }

  @media (max-width: 520px) {
    #chatinput { width: 58vw; }
  }
`;

export function installTextChat({
  getSession, isConnected, connect, diag, mountEl,
  // Optional 3D mount — if a scene+camera+CSS3DObject are provided, the
  // chat pill is mounted as a CSS3DObject parented to the scene at a
  // fixed world-space position in front of Momo's feet. Billboards to
  // the camera each frame via the returned update() hook.
  scene, camera, CSS3DObject,
} = {}) {
  if (document.getElementById('chatbox')) return;
  if (typeof getSession !== 'function') throw new Error('installTextChat: getSession required');
  if (typeof connect !== 'function') throw new Error('installTextChat: connect required');
  isConnected = isConnected || (() => !!getSession());
  diag = diag || (() => {});

  const style = document.createElement('style');
  style.id = 'chatbox-styles';
  style.textContent = CSS;
  document.head.appendChild(style);

  const use3D = !!(scene && camera && CSS3DObject);
  const host = mountEl || document.getElementById('stage') || document.body;

  const box = document.createElement('div');
  box.id = 'chatbox';
  box.className = 'show';

  const input = document.createElement('input');
  input.id = 'chatinput';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '和 omo 打字聊天… (/)';
  box.appendChild(input);

  const send = document.createElement('button');
  send.id = 'chatsend';
  send.type = 'button';
  send.textContent = 'SEND';
  box.appendChild(send);

  const hint = document.createElement('div');
  hint.id = 'chathint';
  hint.textContent = 'press / to focus · enter to send · esc to hide';

  // ── 3D mount: wrap the pill in a CSS3DObject anchored in front of
  //    Momo's feet. The CSS3DRenderer the host uses for chart-layer is
  //    shared (same scene), so no new renderer is needed — we just add
  //    an object to the same scene. The hint caption rides along inside
  //    the same CSS3DObject so it's flipped/swayed consistently. ─────
  let css3dObj = null;
  if (use3D) {
    // Container div: holds both pill + hint. CSS3DObject uses the element's
    // centre as the local origin, so we size the wrap explicitly and
    // centre its children within it. The stage flip(sx,sy) on #stage
    // also applies to the CSS3DRenderer's DOM container (which lives
    // inside #stage), so this stays readable in reflector mode.
    const pillWrap = document.createElement('div');
    pillWrap.style.position = 'relative';
    pillWrap.style.width = '560px';
    pillWrap.style.height = '80px';
    pillWrap.style.display = 'flex';
    pillWrap.style.flexDirection = 'column';
    pillWrap.style.alignItems = 'center';
    pillWrap.style.justifyContent = 'flex-end';
    pillWrap.style.gap = '8px';
    // Override the CSS's bottom-center anchoring — the CSS3DObject takes
    // care of world-space positioning, so the element inside it should
    // be statically centred.
    box.style.position = 'static';
    box.style.left = 'auto';
    box.style.bottom = 'auto';
    box.style.transform = 'none';
    hint.style.position = 'static';
    hint.style.left = 'auto';
    hint.style.bottom = 'auto';
    hint.style.transform = 'none';
    pillWrap.appendChild(hint);
    pillWrap.appendChild(box);

    css3dObj = new CSS3DObject(pillWrap);
    // World-space anchor: in front of Momo's feet, lifted slightly off
    // the ground so it doesn't clip the pedestal ring.
    css3dObj.position.set(0, -2.1, 1.2);
    css3dObj.scale.setScalar(0.003);
    scene.add(css3dObj);
  } else {
    host.appendChild(box);
    host.appendChild(hint);
  }

  let busy = false;

  function reflectState() {
    box.classList.toggle('connected', !!isConnected());
    box.classList.toggle('busy', busy);
  }
  reflectState();
  setInterval(reflectState, 600);

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    reflectState();
    try {
      if (!isConnected()) {
        diag('connecting for chat…');
        try { await connect(); }
        catch (err) { diag('connect failed: ' + (err?.message || err), true); return; }
      }
      const session = getSession();
      if (!session) { diag('no session after connect', true); return; }
      try {
        // Live API: sendClientContent turns the text into a model turn.
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        });
        input.value = '';
        diag('sent: ' + (text.length > 48 ? text.slice(0, 45) + '…' : text));
      } catch (err) {
        diag('send failed: ' + (err?.message || err), true);
      }
    } finally {
      busy = false;
      send.disabled = false;
      reflectState();
      input.focus();
    }
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.blur(); box.classList.add('hidden-by-user'); }
  });

  // Global focus shortcut: `/` focuses the input unless already typing
  // somewhere. Capture-phase so the page's SPACE handler can't steal it.
  window.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      box.classList.remove('hidden-by-user');
      input.focus();
    }
  }, true);

  // Swallow space inside the input so the page's SPACE=connect doesn't fire.
  input.addEventListener('keydown', (e) => {
    if (e.key === ' ') e.stopPropagation();
  });
  input.addEventListener('keyup', (e) => {
    if (e.key === ' ') e.stopPropagation();
  });

  // Per-frame billboard: only needed in 3D mode. Host calls this from
  // the render loop. No-op otherwise. Use the camera's WORLD position so
  // the lookAt is correct regardless of parent transforms on the pill.
  let __camWorld = null;
  function update(t, dt) {
    if (!css3dObj || !camera) return;
    if (!__camWorld) __camWorld = camera.position.clone();
    camera.getWorldPosition(__camWorld);
    css3dObj.lookAt(__camWorld);
  }

  return {
    focus: () => input.focus(),
    setText: (t) => { input.value = t; },
    submit,
    hide: () => box.classList.add('hidden-by-user'),
    show: () => box.classList.remove('hidden-by-user'),
    update,
  };
}

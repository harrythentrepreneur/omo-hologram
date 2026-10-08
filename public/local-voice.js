// public/local-voice.js — browser client for the local-voice path.
//
// Owns three things:
//   1. STT — Web Speech API (SpeechRecognition / webkitSpeechRecognition).
//      Note: Chrome's recognizer is cloud-routed even though it's a
//      browser API. Safari on macOS uses Apple's on-device dictation.
//      For a fully-local STT swap to whisper.cpp later (server-side).
//   2. Chat — POST /local/chat with the running messages array.
//   3. TTS — speechSynthesis with the platform's best local voice.
//
// State is kept in module scope (one transcript per page load). On reload
// the conversation resets — no persistence. Add a backing store later if
// the user wants resumable sessions.

(() => {
  const $ = (id) => document.getElementById(id);
  const transcriptEl = $("transcript");
  const toolListEl = $("tool-list");
  const statusLineEl = $("status-line");
  const ollamaPill = $("ollama-pill");
  const modelPill = $("model-pill");
  const iterPill = $("iter-pill");
  const micBtn = $("mic");
  const textInput = $("text-input");
  const sendBtn = $("send");

  /** Running conversation. We send the whole thing each turn so the
   * server stays stateless. Capped at 24 turns to keep prompts modest. */
  const messages = [];
  /** Live count of tool calls this session (for the iter pill). */
  let totalToolCalls = 0;
  /** True while a /local/chat request is in flight. */
  let busy = false;

  // ─── Status helpers ─────────────────────────────────────────────────

  function setStatus(s) { statusLineEl.textContent = s; }
  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b;
    textInput.disabled = b;
    micBtn.disabled = b && !micBtn.classList.contains("listening");
  }

  // ─── Health check on boot ───────────────────────────────────────────

  async function checkHealth() {
    try {
      const r = await fetch("/local/health");
      const j = await r.json();
      if (j.ok) {
        ollamaPill.textContent = "ollama: ok";
        ollamaPill.classList.add("ok");
        modelPill.textContent = "model: " + (j.model || "—");
        if (j.modelInstalled === false) {
          modelPill.classList.add("warn");
          appendErrorTurn(`Model "${j.model}" isn't installed yet. Hint: ${j.hint}`);
        } else {
          modelPill.classList.add("ok");
        }
      } else {
        ollamaPill.textContent = "ollama: offline";
        ollamaPill.classList.add("err");
        appendErrorTurn(j.reason || "Ollama is unreachable. " + (j.hint || ""));
      }
    } catch (err) {
      ollamaPill.textContent = "ollama: offline";
      ollamaPill.classList.add("err");
      appendErrorTurn("Couldn't reach /local/health: " + err.message);
    }
  }

  // ─── Transcript rendering ───────────────────────────────────────────

  function clearEmpty() {
    const empty = transcriptEl.querySelector(".empty");
    if (empty) empty.remove();
  }

  function appendTurn(role, text) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "turn " + role;
    el.innerHTML = `
      <div class="who">${role}</div>
      <div class="body"></div>
    `;
    el.querySelector(".body").textContent = text;
    transcriptEl.appendChild(el);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return el;
  }

  function appendErrorTurn(text) {
    appendTurn("error", text);
  }

  function appendToolCall(call) {
    const empty = toolListEl.querySelector(".empty");
    if (empty) empty.remove();
    totalToolCalls += 1;
    iterPill.textContent = `tools: ${totalToolCalls}`;
    const div = document.createElement("div");
    div.className = "tool-call";
    const argSummary = compactArgs(call.args);
    div.innerHTML = `<b>${escapeHtml(call.name)}</b>` +
      (argSummary ? `<span class="args"> · ${escapeHtml(argSummary)}</span>` : "");
    toolListEl.appendChild(div);
    toolListEl.scrollTop = toolListEl.scrollHeight;
  }

  function compactArgs(args) {
    if (!args || typeof args !== "object") return "";
    try {
      const s = JSON.stringify(args);
      return s.length > 80 ? s.slice(0, 77) + "…" : s;
    } catch { return ""; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ─── TTS via speechSynthesis ────────────────────────────────────────
  // Voices load asynchronously on first call. We pick a high-quality
  // local voice if one is installed (Apple's "Samantha", "Daniel", or
  // Google's branded ones), else fall back to the default.

  let voicesReady = false;
  let preferredVoice = null;

  function ensureVoices() {
    if (voicesReady) return;
    const voices = speechSynthesis.getVoices();
    if (!voices.length) return; // Chrome lazily loads — try again next tick
    voicesReady = true;
    // Prefer en-US enhanced/local voices. Apple's are highest quality on
    // macOS; on Chrome you may see "Google US English" too.
    const ranked = voices
      .filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"))
      .sort((a, b) => {
        const aScore = scoreVoice(a);
        const bScore = scoreVoice(b);
        return bScore - aScore;
      });
    preferredVoice = ranked[0] || voices[0] || null;
  }

  function scoreVoice(v) {
    let s = 0;
    if (v.localService) s += 5; // local > cloud
    const n = v.name.toLowerCase();
    if (n.includes("samantha") || n.includes("daniel") || n.includes("karen")) s += 3;
    if (n.includes("enhanced") || n.includes("premium") || n.includes("siri")) s += 2;
    if (v.default) s += 1;
    return s;
  }

  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.addEventListener("voiceschanged", ensureVoices);
    setTimeout(ensureVoices, 100);
  }

  function speak(text) {
    if (typeof speechSynthesis === "undefined" || !text) return;
    ensureVoices();
    speechSynthesis.cancel(); // stop any prior utterance
    const u = new SpeechSynthesisUtterance(text);
    if (preferredVoice) u.voice = preferredVoice;
    u.rate = 1.05;
    u.pitch = 1.0;
    speechSynthesis.speak(u);
  }

  // ─── STT via SpeechRecognition ──────────────────────────────────────

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let listening = false;

  function buildRecognizer() {
    if (!SR) return null;
    const r = new SR();
    r.continuous = false;        // single utterance per tap
    r.interimResults = true;     // show partial as user speaks
    r.lang = "en-US";
    r.onstart = () => {
      listening = true;
      micBtn.classList.add("listening");
      setStatus("listening…");
    };
    r.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
      if (!busy) setStatus("idle");
    };
    r.onerror = (ev) => {
      listening = false;
      micBtn.classList.remove("listening");
      setStatus("mic error: " + ev.error);
    };
    let interim = "";
    let final = "";
    r.onresult = (ev) => {
      interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      const display = (final + " " + interim).trim();
      if (display) textInput.value = display;
      if (final) {
        // auto-submit on final result
        textInput.value = final.trim();
        final = "";
        send();
      }
    };
    return r;
  }

  function startListening() {
    if (!SR) {
      appendErrorTurn("Your browser doesn't expose SpeechRecognition. Use Chrome or Safari, or type instead.");
      return;
    }
    if (listening) { recog.stop(); return; }
    recog = recog || buildRecognizer();
    if (!recog) return;
    try { recog.start(); } catch (err) { setStatus("mic err: " + err.message); }
  }

  // ─── Send + chat loop ───────────────────────────────────────────────

  async function send() {
    const text = textInput.value.trim();
    if (!text || busy) return;
    textInput.value = "";
    appendTurn("user", text);
    setBusy(true);
    setStatus("thinking…");

    // Stop any ongoing TTS — the user is speaking again.
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();

    try {
      const r = await fetch("/local/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, userText: text }),
      });
      const j = await r.json();
      if (!j.ok) {
        appendErrorTurn(j.error || "chat failed");
        setStatus("error");
        return;
      }
      // Replace local conversation with server's authoritative version.
      // It includes the system prompt + every assistant/tool turn.
      messages.length = 0;
      for (const m of (j.messages || []).slice(-24)) messages.push(m);

      for (const c of (j.toolCalls || [])) appendToolCall(c);

      const reply = (j.reply || "").trim();
      if (reply) {
        appendTurn("assistant", reply);
        speak(reply);
      } else {
        appendTurn("assistant", "(no reply)");
      }
      setStatus(j.truncated ? "truncated · iter cap hit" : `idle · ${j.iterations || 0} iter`);
    } catch (err) {
      appendErrorTurn("network: " + err.message);
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  // ─── Wire UI ────────────────────────────────────────────────────────

  micBtn.addEventListener("click", () => {
    if (listening) { recog?.stop(); return; }
    startListening();
  });
  sendBtn.addEventListener("click", send);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // Boot
  checkHealth();
  setStatus("idle");
})();

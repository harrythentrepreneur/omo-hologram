// public/momo-ingest.js — tiny client used by every hologram page to
// push Momo's voice transcripts onto the Data Core event ring.
//
// One exported helper: `attachMomoIngest({ page, getSession })`.
// Call it once per page; it installs a Gemini-Live message tap that
// batches finalized user / assistant transcription turns and posts
// them to /omo/ingest/momo. The server fans them out over /omo/ws
// so /hq and /agents-grid see Momo's voice in realtime.
//
// Why a shared module? The 4 hologram pages all carry the same
// `handleLiveMessage` shape for Gemini Live serverContent; putting
// the transcript plumbing here keeps per-page JS thin and guarantees
// all four behave identically. Page-specific code just wires the
// per-message callback:
//
//   import { attachMomoIngest } from '/momo-ingest.js';
//   const ingest = attachMomoIngest({ page: 'cylinder' });
//   // inside handleLiveMessage(msg):
//   ingest.onLiveMessage(msg);
//
// Tool calls are NOT posted from here — server.js wraps /tool so
// tool_call / tool_result events emit automatically, authoritatively,
// regardless of which page initiated the dispatch.

const INGEST_URL = "/omo/ingest/momo";
const BATCH_MS = 220;      // flush at ~turn boundary; keeps log order crisp
const BATCH_MAX = 8;

function mintSid() {
  // Not security-sensitive — a short random tag so multi-tab setups can
  // be told apart in the log.
  return "sid_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function attachMomoIngest({ page = "holo", getSession } = {}) {
  const sid = mintSid();
  const queue = [];
  let flushTimer = null;

  // Per-turn transcript buffers. Gemini Live delivers transcriptions in
  // chunks; we concatenate until turnComplete / generationComplete fires
  // on the same message, then emit a single finalized event.
  let userBuf = "";
  let momoBuf = "";

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushNow, BATCH_MS);
  }

  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0) return;
    const payload = queue.splice(0, queue.length);
    const body = JSON.stringify(payload);
    // Prefer sendBeacon so page-unload still delivers; fall back to fetch.
    let sent = false;
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        sent = navigator.sendBeacon(INGEST_URL, blob);
      }
    } catch {}
    if (!sent) {
      fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => { /* non-fatal — transcripts are best-effort */ });
    }
  }

  function enqueue(kind, extra = {}) {
    queue.push({ kind, page, sid, ts: Date.now(), ...extra });
    if (queue.length >= BATCH_MAX) flushNow();
    else schedule();
  }

  // Finalize and emit whatever is in the turn buffers. Called on
  // turnComplete / generationComplete / interrupted.
  function flushTurns({ interrupted = false } = {}) {
    const u = userBuf.trim();
    const m = momoBuf.trim();
    userBuf = "";
    momoBuf = "";
    if (u) enqueue("user_said", { text: u });
    if (m) enqueue("momo_said", { text: m, interrupted: interrupted || undefined });
  }

  // The public hook pages call inside their handleLiveMessage. We match
  // the field names Gemini Live uses on serverContent.
  function onLiveMessage(msg) {
    if (!msg) return;
    const sc = msg.serverContent;
    if (!sc) return;
    // Incremental transcription chunks — append to turn buffers.
    const inT = sc.inputTranscription?.text;
    if (typeof inT === "string" && inT) userBuf += (userBuf ? " " : "") + inT;
    const outT = sc.outputTranscription?.text;
    if (typeof outT === "string" && outT) momoBuf += (momoBuf ? " " : "") + outT;
    // Turn boundary — finalize.
    if (sc.turnComplete || sc.generationComplete) flushTurns();
    else if (sc.interrupted) flushTurns({ interrupted: true });
  }

  // Page lifecycle — announce start/end so /hq shows when the hologram
  // actually went live. Always fires on attach; tries to fire on unload.
  (function sessionStart() {
    const s = (typeof getSession === "function" ? getSession() : null) || {};
    enqueue("session_start", { model: s.model, voice: s.voice });
  })();
  window.addEventListener("pagehide", () => {
    enqueue("session_end", { reason: "pagehide" });
    flushNow();
  });
  window.addEventListener("beforeunload", () => {
    enqueue("session_end", { reason: "unload" });
    flushNow();
  });

  return {
    sid,
    onLiveMessage,
    flush: flushNow,
    // Escape hatch for pages that want to announce something custom.
    emit(kind, extra) { enqueue(kind, extra); },
  };
}

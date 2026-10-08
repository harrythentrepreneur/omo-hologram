// src/runtimes/claude_pty_adapter.js — claude task runner via PTY.
//
// Sibling of src/runtimes/claude.js but uses the long-lived interactive
// PTY (src/runtimes/claude_pty.js) instead of a one-shot `claude -p`.
// The voice-dispatched prompt is written into the PTY's stdin so the
// user SEES it land in the live terminal — same session, same TUI, same
// conversation history. No more "task runs headlessly while the popup
// shows a different fresh claude".
//
// Shape: exposes detect / status / spawn matching the headless adapter
// so the hermes coordinator can swap us in without touching its dispatch
// pipeline. Events are still canonical (./events.js) — chunk events come
// straight from the PTY stream, and a synthetic `result` fires once the
// PTY has been idle for IDLE_COMPLETE_MS.
//
// Hard rules (CLAUDE.md):
//   • never throw at module load
//   • idempotent: dispatching twice for the same agent reuses the PTY
//   • no event emission AFTER `result` (downstream code dedupes on that)

import * as claudePty from "./claude_pty.js";
import * as events from "./events.js";

export function detect() { return claudePty.detect(); }

export function status() {
  const d = claudePty.detect();
  return { installed: d.installed, bin: d.bin, version: d.version };
}

// How long the PTY must be silent (no meaningful new content, only
// background cursor blinks) before we declare the task complete. Claude
// Code's TUI doesn't emit a structured "done" marker — we approximate
// by detecting an output lull. 60s is long enough to survive intra-tool
// pauses (a long Bash, a slow WebFetch) without leaving the squad UI
// stuck on "running" forever.
const IDLE_COMPLETE_MS = Number(process.env.OMO_CLAUDE_PTY_IDLE_MS || 60000);

// Prompt-write timing. We do NOT just wait a fixed delay — that was the
// original bug: on a fresh worktree claude's banner / TUI reconciler
// takes 1-2s to settle, and writing too early lands the prompt in the
// wrong buffer (or the trust dialog, when one was still showing). We
// also can't wait forever — claude's TUI emits cursor-blink chunks
// every few hundred ms, which never truly go silent.
//
// Strategy: wait for the OUTPUT TO SETTLE — a quiet window of
// PROMPT_IDLE_GAP_MS with no meaningful (non-ANSI) chunks. Floor it at
// PROMPT_MIN_DELAY_MS so we never write during the initial banner
// burst, cap it at PROMPT_MAX_WAIT_MS so a chatty TUI can't keep us
// stalled forever. Defaults chosen so the typical "fresh worktree,
// trust-dialog-skipped" path lands the prompt at ~1.2s in.
const PROMPT_MIN_DELAY_MS = Number(process.env.OMO_CLAUDE_PTY_PROMPT_MIN_MS || 800);
const PROMPT_IDLE_GAP_MS  = Number(process.env.OMO_CLAUDE_PTY_PROMPT_GAP_MS || 350);
const PROMPT_MAX_WAIT_MS  = Number(process.env.OMO_CLAUDE_PTY_PROMPT_MAX_MS || 5000);

// Gap between writing the prompt text and the standalone Enter keystroke
// that submits it. Has to be long enough that ink's input reducer has
// landed the text in its state, short enough that the user doesn't see
// the prompt sitting un-submitted. 150ms covers both.
const PROMPT_SUBMIT_GAP_MS = Number(process.env.OMO_CLAUDE_PTY_SUBMIT_GAP_MS || 150);

export function spawn_({
  prompt,
  agentId,
  sessionId = null,
  cwd = null,
  model = null,
  effort = null,
  permissionMode = null,
  addDirs = null,
  mcpConfig = null,
  settingsPath = null,
  continueLast = false,
  onEvent, onError, onClose,
  // accepted for shape compatibility with headless adapter; ignored
  allowedTools = null,
} = {}) {
  void allowedTools;
  if (!agentId) {
    const err = new Error("agent_id required for claude PTY adapter");
    err.code = "MISSING_AGENT_ID";
    throw err;
  }
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    const err = new Error("missing prompt");
    err.code = "MISSING_PROMPT";
    throw err;
  }

  const startedAt = Date.now();
  let finished = false;
  let idleTimer = null;
  let unsubData = null;
  let unsubExit = null;
  let sessionPollTimer = null;
  let sessionRef = null;
  let emittedSessionId = null;

  function safeEmit(evt) {
    if (finished && evt?.kind !== "result") return;
    try { onEvent?.(evt); } catch (e) { try { onError?.(e); } catch {} }
  }
  function maybeEmitSessionId() {
    if (emittedSessionId) return;
    let sid = null;
    try { sid = sessionRef?.readActiveSessionId?.() || null; } catch {}
    if (!sid) return;
    emittedSessionId = sid;
    safeEmit(events.sessionInit({ sessionId: sid, cwd }));
  }
  function finalize(status, { exitCode = null, error = null } = {}) {
    if (finished) return;
    maybeEmitSessionId();
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (sessionPollTimer) clearInterval(sessionPollTimer);
    try { unsubData?.(); } catch {}
    try { unsubExit?.(); } catch {}
    safeEmit(events.result({
      status,
      exitCode: exitCode ?? (status === "done" ? 0 : 1),
      durationMs: Date.now() - startedAt,
      error,
    }));
    try { onClose?.(exitCode ?? (status === "done" ? 0 : 1)); } catch {}
  }
  function bumpIdle() {
    if (finished) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finalize("done"), IDLE_COMPLETE_MS);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  }

  (async () => {
    let session;
    try {
      session = await claudePty.sessionFor(agentId, {
        cwd,
        model,
        permissionMode,
        mcpConfig,
        settingsPath,
        addDirs,
        effort,
        // Resume the prior session when we have one so the agent
        // continues the same conversation rather than starting fresh.
        resumeSessionId: sessionId,
        continueLast,
      });
    } catch (err) {
      try { onError?.(err); } catch {}
      finalize("error", { error: err?.message || String(err) });
      return;
    }
    sessionRef = session;
    maybeEmitSessionId();

    // Surface raw PTY output as chunk events so the squad activity
    // ticker shows *something*. The popup's xterm gets the same bytes
    // via /claude-tty/ws — this is just a hint stream. Idle detection
    // only counts MEANINGFUL output (no pure cursor-blink chunks); the
    // TUI emits decoration constantly and would otherwise keep the
    // timer reset forever.
    let promptWritten = false;
    let lastMeaningfulAt = Date.now();
    unsubData = session.onData((buf) => {
      maybeEmitSessionId();
      // Strip CSI / OSC sequences so we judge idleness on actual text.
      const stripped = String(buf)
        .replace(/\x1B\][^\x07]*\x07/g, "")          // OSC ... BEL
        .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")   // CSI
        .replace(/\x1B[()][0-9A-B]/g, "")            // charset select
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""); // misc ctrls
      if (stripped.trim().length === 0) return;
      lastMeaningfulAt = Date.now();
      bumpIdle();
      safeEmit(events.chunk({ text: stripped, role: "assistant" }));
    });

    unsubExit = session.onExit(({ exitCode, signal }) => {
      if (finished) return;
      finalize(exitCode === 0 ? "done" : "error", {
        exitCode,
        error: exitCode === 0 ? null : `claude pty exited code=${exitCode}${signal ? " signal=" + signal : ""}`,
      });
    });

    // Claude writes the session jsonl shortly after the TUI boots. Poll
    // briefly so the coordinator can bind the real session id for future
    // idle-agent opens and follow-up dispatches.
    sessionPollTimer = setInterval(maybeEmitSessionId, 250);
    sessionPollTimer.unref?.();
    setTimeout(() => {
      if (sessionPollTimer) {
        clearInterval(sessionPollTimer);
        sessionPollTimer = null;
      }
      maybeEmitSessionId();
    }, 15000).unref?.();

    // Wait for the TUI to settle before writing the prompt. Poll until
    // we've seen PROMPT_IDLE_GAP_MS of silence after the minimum floor,
    // or until the hard cap fires.
    //
    // Submission is a TWO-step write: first the text, then a brief
    // pause, then a standalone \r. The TUI's input handler (ink/React)
    // distinguishes between
    //   (a) a chunk containing text + \r → treats \r as newline-in-input
    //       (the prompt visibly lands, multi-line, but is NOT submitted)
    //   (b) a discrete \r keystroke arriving alone → treats as Enter
    //       (submits the input)
    // We saw (a) in production: prompt typed into the box, "running" but
    // 0 tools, cursor parked at end of text. Splitting the writes gives
    // the TUI a tick to settle the text into its input model before the
    // Enter keystroke arrives as a separate event.
    const dispatchedAt = Date.now();
    function tryWritePrompt() {
      if (finished || promptWritten) return;
      const now = Date.now();
      const sinceStart = now - dispatchedAt;
      const sinceQuiet = now - lastMeaningfulAt;
      const minPassed = sinceStart >= PROMPT_MIN_DELAY_MS;
      const settled   = sinceQuiet >= PROMPT_IDLE_GAP_MS;
      const capped    = sinceStart >= PROMPT_MAX_WAIT_MS;
      if (capped || (minPassed && settled)) {
        promptWritten = true;
        try {
          // Step 1: the prompt text only — no trailing CR.
          session.write(trimmed.replace(/\r?\n/g, " "));
        } catch (err) {
          finalize("error", { error: `failed to write prompt to pty: ${err?.message || err}` });
          return;
        }
        // Step 2: a discrete Enter keystroke after a brief settle.
        setTimeout(() => {
          if (finished) return;
          try { session.write("\r"); } catch {}
          bumpIdle();
        }, PROMPT_SUBMIT_GAP_MS);
        return;
      }
      // Re-check in PROMPT_IDLE_GAP_MS — that's the cadence at which a
      // freshly-settled stream would tip us into "write now". Bumped to
      // 100ms minimum so we don't spin.
      setTimeout(tryWritePrompt, Math.max(100, PROMPT_IDLE_GAP_MS));
    }
    setTimeout(tryWritePrompt, PROMPT_MIN_DELAY_MS);

    bumpIdle();
  })();

  return {
    child: null,
    kill(signal = "SIGTERM") {
      try {
        const s = sessionRef || claudePty.getSession(agentId);
        if (s && s.alive) s.signal(signal);
      } catch {}
      if (!finished) {
        finalize("error", { exitCode: 130, error: "interrupted" });
      }
    },
  };
}

export { spawn_ as spawn };

// src/runtimes/hermes_pty_adapter.js — Hermes task runner via live PTY.
//
// This mirrors claude_pty_adapter.js structurally, but intentionally does
// NOT write prompt text followed by a synthetic "\r". Hermes' TUI already
// exposes a programmatic startup hook: HERMES_TUI_QUERY. The PTY runtime
// seeds that env var before spawning `hermes chat --tui`, and Hermes submits
// the prompt internally after its gateway and session are ready. That keeps
// dispatch visible in /feather without hitting the composer paste/Enter race.

import * as hermesPty from "./hermes_pty.js";
import * as events from "./events.js";

export function detect() { return hermesPty.detect(); }

export function status() {
  const d = hermesPty.detect();
  return { installed: d.installed, bin: d.bin, version: d.version };
}

// Hermes' TUI has no structured "turn complete" signal on the raw VT stream,
// so task completion follows the Claude PTY adapter's idle heuristic.
const IDLE_COMPLETE_MS = Number(process.env.OMO_HERMES_PTY_IDLE_MS || 60000);

export function spawn_({
  prompt,
  agentId,
  sessionId = null,
  cwd = null,
  model = null,
  provider = null,
  toolsets = null,
  skills = null,
  maxTurns = null,
  checkpoints = null,
  permissionMode = null,
  addDirs = null,
  mcpConfig = null,
  settingsPath = null,
  effort = null,
  continueLast = false,
  allowedTools = null,
  onEvent, onError, onClose,
} = {}) {
  void addDirs;
  void mcpConfig;
  void settingsPath;
  void effort;
  void allowedTools;
  if (!agentId) {
    const err = new Error("agent_id required for hermes PTY adapter");
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
  let sessionPollTimer = null;
  let unsubData = null;
  let unsubExit = null;
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
    idleTimer.unref?.();
  }

  (async () => {
    let session;
    try {
      session = await hermesPty.sessionFor(agentId, {
        cwd,
        model,
        provider,
        toolsets: Array.isArray(toolsets) ? toolsets : [],
        skills: Array.isArray(skills) ? skills : [],
        maxTurns: Number.isFinite(maxTurns) ? Number(maxTurns) : null,
        permissionMode: permissionMode || "yolo",
        checkpoints: !!checkpoints,
        resumeSessionId: sessionId,
        continueLast,
        startupQuery: trimmed,
      });
    } catch (err) {
      try { onError?.(err); } catch {}
      finalize("error", { error: err?.message || String(err) });
      return;
    }
    sessionRef = session;

    unsubData = session.onData((buf) => {
      maybeEmitSessionId();
      const stripped = String(buf)
        .replace(/\x1B\][^\x07]*\x07/g, "")
        .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\x1B[()][0-9A-B]/g, "")
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
      if (stripped.trim().length === 0) return;
      bumpIdle();
      safeEmit(events.chunk({ text: stripped, role: "assistant" }));
    });

    unsubExit = session.onExit(({ exitCode, signal }) => {
      if (finished) return;
      finalize(exitCode === 0 ? "done" : "error", {
        exitCode,
        error: exitCode === 0 ? null : `hermes pty exited code=${exitCode}${signal ? " signal=" + signal : ""}`,
      });
    });

    // The active-session sidecar may be written before or after our first
    // meaningful VT chunk; poll briefly so follow-up dispatches can resume.
    sessionPollTimer = setInterval(maybeEmitSessionId, 100);
    sessionPollTimer.unref?.();
    setTimeout(() => {
      if (sessionPollTimer) {
        clearInterval(sessionPollTimer);
        sessionPollTimer = null;
      }
      maybeEmitSessionId();
    }, 15000).unref?.();

    bumpIdle();
  })();

  return {
    child: null,
    kill(signal = "SIGTERM") {
      try {
        const s = sessionRef || hermesPty.getSession(agentId);
        if (s && s.alive) s.signal(signal);
      } catch {}
      if (!finished) {
        finalize("error", { exitCode: 130, error: "interrupted" });
      }
    },
  };
}

export { spawn_ as spawn };

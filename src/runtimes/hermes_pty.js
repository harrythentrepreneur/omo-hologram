// src/runtimes/hermes_pty.js — interactive Hermes Agent PTY runtime.
//
// Mirror of src/runtimes/claude_pty.js for the Hermes CLI. Spawns a
// long-lived interactive `hermes chat --tui` inside a PTY and pipes the
// raw VT stream to/from the browser via WebSocket. The user sees the
// real Hermes TUI — tool calls, slash menu, /skill display, the works.
//
// One PTY per agent_id, persistent until reapAgent. Keys come in via
// pty.write(); raw bytes go out via pty.onData() to every WebSocket
// subscribed to /hermes-tty/ws/<agent_id>. Browser disconnect/reconnect
// is supported — the PTY survives, and a small ring buffer of recent
// bytes is replayed so the screen comes back populated.
//
// Differences from claude_pty.js:
//   • binary discovery — uses HERMES_BIN env + ~/.local/bin/hermes
//   • base command — `hermes chat --tui --yolo --accept-hooks`
//   • flag translation — claude's --permission-mode has no direct
//     hermes equivalent (translated loosely to --yolo); --add-dir,
//     --mcp-config, --settings, --effort are not supported by hermes
//     and are silently dropped
//
// Hard rules (CLAUDE.md):
//   • never throw at module load (node-pty import is dynamic + cached)
//   • cwd is the agent's worktree (caller's responsibility to set up)
//   • cleanup is idempotent; safe to call multiple times

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// Hermes stores session jsonl under ~/.hermes/sessions/. Probe disk
// before launching and drop --resume cleanly when missing so a stale
// session id from a different cwd doesn't crash the child.
const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), ".hermes");
const HERMES_SESSIONS_ROOT = join(HERMES_HOME, "sessions");
const ACTIVE_SESSION_DIR = join(HERMES_HOME, "omo-active-sessions");
function locateSession(sessionId) {
  if (!sessionId) return "missing";
  // Hermes' on-disk session layout varies by version. Cast a wide net:
  // try the flat layout first, then walk subdirs once if needed.
  try {
    const flat = join(HERMES_SESSIONS_ROOT, `${sessionId}.jsonl`);
    if (existsSync(flat)) return "here";
    const flatJson = join(HERMES_SESSIONS_ROOT, `${sessionId}.json`);
    if (existsSync(flatJson)) return "here";
  } catch {}
  try {
    const entries = readdirSync(HERMES_SESSIONS_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const here = join(HERMES_SESSIONS_ROOT, e.name, `${sessionId}.jsonl`);
      if (existsSync(here)) return "here";
    }
  } catch {}
  // Couldn't prove it exists — Hermes will error verbosely on launch if
  // the id is bogus. Return "missing" so the caller falls back to a
  // safer flag combination.
  return "missing";
}

// node-pty is a native module — load lazily so a missing build doesn't
// break server boot. The first sessionFor() call eats the import cost.
let ptyModulePromise = null;
function loadPty() {
  if (!ptyModulePromise) {
    ptyModulePromise = import("node-pty").then((m) => m.default || m);
  }
  return ptyModulePromise;
}

// Bin discovery — same shape as hermes.js so the two adapters agree on
// which `hermes` they're driving.
const BIN_CANDIDATES = [
  process.env.HERMES_BIN,
  join(homedir(), ".local", "bin", "hermes"),
  join(homedir(), ".npm-global", "bin", "hermes"),
  "/usr/local/bin/hermes",
  "/opt/homebrew/bin/hermes",
].filter(Boolean);

let cachedBin = null;
let cachedVersion = null;

export function detect() {
  if (cachedBin && existsSync(cachedBin)) {
    return { installed: true, bin: cachedBin, version: cachedVersion };
  }
  const bin = BIN_CANDIDATES.find((p) => p && existsSync(p) && isExecutable(p));
  if (!bin) return { installed: false, bin: null, version: null };
  cachedBin = bin;
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (r.status === 0) {
      // e.g. "Hermes Agent v0.13.0 (2026.5.7)"
      const m = String(r.stdout || "").match(/v?([\d][\w.\-]*)/);
      if (m) cachedVersion = m[1];
    }
  } catch {}
  return { installed: true, bin, version: cachedVersion };
}

function isExecutable(p) {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// agent_id → Session
const sessions = new Map();

// How many bytes of recent output to keep so a reconnecting browser can
// repaint the chat, not just the last screen. Capped by env for local
// tuning; 2 MB × 4 seats is still small and preserves normal agent turns.
const REPLAY_BUFFER_BYTES = Number(process.env.OMO_PTY_REPLAY_BYTES || (2 * 1024 * 1024));

// Default geometry. Browser can resize once it knows its own viewport.
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

class Session {
  constructor({
    agent_id,
    cwd,
    model,
    provider,
    toolsets,
    skills,
    maxTurns,
    permissionMode,
    checkpoints,
    startupQuery,
    activeSessionFile,
    resumeSessionId,
    continueLast,
    continueName,
    // Accepted-but-ignored options (claude_pty parity surface). Hermes
    // doesn't have direct equivalents; documented in the module header.
    // eslint-disable-next-line no-unused-vars
    addDirs,
    // eslint-disable-next-line no-unused-vars
    mcpConfig,
    // eslint-disable-next-line no-unused-vars
    settingsPath,
    // eslint-disable-next-line no-unused-vars
    effort,
  }) {
    this.agent_id = agent_id;
    this.cwd = cwd;
    this.model = model || null;
    this.provider = provider || null;
    this.toolsets = Array.isArray(toolsets) ? toolsets.slice() : [];
    this.skills = Array.isArray(skills) ? skills.slice() : [];
    this.maxTurns = Number.isFinite(maxTurns) ? Number(maxTurns) : null;
    // When omo dispatches a task into a live Hermes TUI, do not synthesize
    // Enter. Hermes' own startup hook submits this after the gateway/session
    // is ready, avoiding the composer paste/return race.
    this.startupQuery = typeof startupQuery === "string" && startupQuery.trim()
      ? startupQuery
      : null;
    this.activeSessionFile = activeSessionFile || defaultActiveSessionFile(agent_id);
    this.currentSessionId = resumeSessionId || null;
    // Hermes has no --permission-mode. The nearest behavioural lever is
    // --yolo (bypass dangerous-command prompts), which we always pass.
    // Stored only for status() echoing.
    this.permissionMode = permissionMode || "yolo";
    this.checkpoints = !!checkpoints;
    // Conversation continuity. Priority: explicit --resume <id> > named
    // --continue <name> > bare --continue (most-recent in cwd).
    this.resumeSessionId = resumeSessionId || null;
    this.continueName = continueName || null;
    this.continueLast = !!continueLast;
    this.cols = DEFAULT_COLS;
    this.rows = DEFAULT_ROWS;
    this.pty = null;
    this.alive = false;
    this.startedAt = 0;
    this.exitedAt = 0;
    this.exitCode = null;
    this.exitSignal = null;
    this.generation = 0;
    this.replay = Buffer.alloc(0);
    this.subscribers = new Set();    // WebSocket-like { send, isAlive }
    this.dataListeners = new Set();  // optional in-process listeners
    this.exitListeners = new Set();
  }

  buildArgs() {
    // Always start with `chat --tui --yolo --accept-hooks`. yolo bypasses
    // the dangerous-command prompt in the TUI (needed for hands-free
    // voice operation); accept-hooks skips hook approval prompts.
    const args = ["chat", "--tui", "--yolo", "--accept-hooks"];
    if (this.resumeSessionId) {
      args.push("--resume", this.resumeSessionId);
    } else if (this.continueName) {
      args.push("--continue", this.continueName);
    } else if (this.continueLast) {
      args.push("--continue");
    }
    if (this.model) args.push("-m", this.model);
    if (this.provider) args.push("--provider", this.provider);
    if (this.toolsets.length) args.push("-t", this.toolsets.join(","));
    if (this.skills.length)   args.push("-s", this.skills.join(","));
    if (this.maxTurns)        args.push("--max-turns", String(this.maxTurns));
    if (this.checkpoints)     args.push("--checkpoints");
    return args;
  }

  async start() {
    if (this.alive) return;
    const detected = detect();
    if (!detected.installed) {
      const err = new Error("hermes is not installed");
      err.code = "NOT_INSTALLED";
      throw err;
    }
    // Pre-flight: drop --resume if we can't locate the session file. The
    // probe is best-effort (layout varies by hermes version), so we only
    // demote when we positively know it's missing.
    if (this.resumeSessionId) {
      const loc = locateSession(this.resumeSessionId);
      if (loc === "missing") {
        // Fall back to --continue (resume the most recent session)
        // so the user still picks up any prior conversation hermes
        // itself recorded here.
        this.resumeSessionId = null;
        this.continueLast = true;
      }
    }
    const pty = await loadPty();
    const args = this.buildArgs();
    const env = {
      ...process.env,
      // xterm.js advertises xterm-256color; pass it through so Hermes
      // paints with the right palette.
      TERM: process.env.TERM_PROGRAM === "iTerm.app" ? "xterm-256color" : (process.env.TERM || "xterm-256color"),
      // Force colour even if Hermes is sniffing for "is this a real TTY".
      // It IS a real PTY now, but explicit is friendlier.
      FORCE_COLOR: "1",
      // Disable any TTY shenanigans the parent process might inherit.
      NO_COLOR: undefined,
      CI: undefined,
    };
    if (this.startupQuery) {
      env.HERMES_TUI_QUERY = this.startupQuery;
    }
    if (this.resumeSessionId) {
      env.HERMES_TUI_RESUME = this.resumeSessionId;
    }
    if (this.activeSessionFile) {
      try { mkdirSync(dirname(this.activeSessionFile), { recursive: true }); } catch {}
      env.HERMES_TUI_ACTIVE_SESSION_FILE = this.activeSessionFile;
    }
    // Strip null/undefined so we don't accidentally clear inherited vars.
    for (const k of Object.keys(env)) {
      if (env[k] == null) delete env[k];
    }
    this.pty = pty.spawn(detected.bin, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    const generation = ++this.generation;
    this.alive = true;
    this.startedAt = Date.now();
    this.exitedAt = 0;
    this.exitCode = null;
    this.exitSignal = null;

    this.pty.onData((data) => {
      if (generation !== this.generation) return;
      // node-pty hands us a string by default; convert to a buffer so
      // websocket binary frames stay binary-clean.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      this.appendReplay(buf);
      // Fan out to every connected subscriber.
      for (const sub of this.subscribers) {
        try { sub.send(buf); } catch {}
      }
      for (const cb of this.dataListeners) {
        try { cb(buf); } catch {}
      }
    });

    this.pty.onExit(({ exitCode, signal }) => {
      if (generation !== this.generation) return;
      this.alive = false;
      this.exitedAt = Date.now();
      this.exitCode = exitCode ?? null;
      this.exitSignal = signal ?? null;
      // Keep the same envelope name as claude_pty — the client's message
      // dispatcher in xterm.js code is runtime-agnostic. Don't rename.
      const payload = JSON.stringify({
        type: "claude_pty_exit",
        agent_id: this.agent_id,
        exit_code: this.exitCode,
        signal: this.exitSignal,
        ts: this.exitedAt,
      });
      for (const sub of this.subscribers) {
        try { sub.send(payload); } catch {}
      }
      for (const cb of this.exitListeners) {
        try { cb({ exitCode: this.exitCode, signal: this.exitSignal }); } catch {}
      }
    });
  }

  async restart(opts = {}) {
    const oldPty = this.pty;
    // Invalidate callbacks from the old process before killing it. The
    // Session object is preserved so existing WS handlers keep writing to
    // the replacement PTY once start() completes.
    this.generation++;
    this.alive = false;
    if (oldPty) {
      try { oldPty.kill("SIGTERM"); } catch {}
    }
    this.applyOptions(opts);
    this.pty = null;
    this.startedAt = 0;
    this.exitedAt = 0;
    this.exitCode = null;
    this.exitSignal = null;
    this.replay = Buffer.alloc(0);
    this.currentSessionId = null;
    await this.start();
  }

  applyOptions(opts = {}) {
    if (opts.cwd) this.cwd = opts.cwd;
    this.model = opts.model || null;
    this.provider = opts.provider || null;
    this.toolsets = Array.isArray(opts.toolsets) ? opts.toolsets.slice() : [];
    this.skills = Array.isArray(opts.skills) ? opts.skills.slice() : [];
    this.maxTurns = Number.isFinite(opts.maxTurns) ? Number(opts.maxTurns) : null;
    this.permissionMode = opts.permissionMode || "yolo";
    this.checkpoints = !!opts.checkpoints;
    this.startupQuery = typeof opts.startupQuery === "string" && opts.startupQuery.trim()
      ? opts.startupQuery
      : null;
    this.activeSessionFile = opts.activeSessionFile || this.activeSessionFile || defaultActiveSessionFile(this.agent_id);
    this.resumeSessionId = opts.resumeSessionId || null;
    this.currentSessionId = this.resumeSessionId || null;
    this.continueName = opts.continueName || null;
    this.continueLast = !!opts.continueLast;
  }

  appendReplay(buf) {
    if (!buf || !buf.length) return;
    if (buf.length >= REPLAY_BUFFER_BYTES) {
      this.replay = buf.slice(buf.length - REPLAY_BUFFER_BYTES);
      return;
    }
    const combined = Buffer.concat([this.replay, buf]);
    if (combined.length > REPLAY_BUFFER_BYTES) {
      this.replay = combined.slice(combined.length - REPLAY_BUFFER_BYTES);
    } else {
      this.replay = combined;
    }
  }

  write(data) {
    if (!this.alive || !this.pty) return false;
    if (data == null) return false;
    try {
      this.pty.write(typeof data === "string" ? data : Buffer.from(data));
      return true;
    } catch {
      return false;
    }
  }

  resize(cols, rows) {
    const c = Math.max(20, Math.min(500, Number(cols) | 0));
    const r = Math.max(5, Math.min(200, Number(rows) | 0));
    if (!this.alive || !this.pty) {
      this.cols = c; this.rows = r;
      return false;
    }
    try {
      this.pty.resize(c, r);
      this.cols = c; this.rows = r;
      return true;
    } catch {
      return false;
    }
  }

  signal(signame) {
    if (!this.alive || !this.pty) return false;
    const sig = String(signame || "SIGINT").toUpperCase();
    try {
      this.pty.kill(sig);
      return true;
    } catch {
      return false;
    }
  }

  kill(signal = "SIGTERM") {
    if (!this.alive || !this.pty) return;
    try { this.pty.kill(signal); } catch {}
  }

  attach(sub) {
    this.subscribers.add(sub);
    // Send a small JSON header so the client knows the geometry +
    // alive state, then replay recent bytes so the screen is populated.
    // Use the same envelope name as claude_pty — the protocol stays
    // runtime-agnostic so xterm.js code on the client doesn't fork.
    try {
      sub.send(JSON.stringify({
        type: "claude_pty_attach",
        agent_id: this.agent_id,
        cols: this.cols,
        rows: this.rows,
        alive: this.alive,
        started_at: this.startedAt,
        exit_code: this.exitCode,
        exit_signal: this.exitSignal,
      }));
    } catch {}
    if (this.replay.length > 0) {
      try { sub.send(this.replay); } catch {}
    }
  }

  detach(sub) {
    this.subscribers.delete(sub);
  }

  onData(cb) {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb) {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  status() {
    const sessionId = this.readActiveSessionId();
    return {
      agent_id: this.agent_id,
      alive: this.alive,
      cwd: this.cwd,
      model: this.model,
      provider: this.provider,
      permission_mode: this.permissionMode,
      toolsets: this.toolsets.slice(),
      skills: this.skills.slice(),
      max_turns: this.maxTurns,
      checkpoints: this.checkpoints,
      cols: this.cols,
      rows: this.rows,
      started_at: this.startedAt,
      exited_at: this.exitedAt || null,
      exit_code: this.exitCode,
      exit_signal: this.exitSignal,
      session_id: sessionId,
      subscribers: this.subscribers.size,
    };
  }

  readActiveSessionId() {
    if (this.currentSessionId) return this.currentSessionId;
    if (!this.activeSessionFile) return null;
    try {
      const raw = readFileSync(this.activeSessionFile, "utf8");
      const parsed = JSON.parse(raw);
      const sid = parsed?.session_id ? String(parsed.session_id) : null;
      if (sid) this.currentSessionId = sid;
      return sid;
    } catch {
      return null;
    }
  }
}

function defaultActiveSessionFile(agent_id) {
  const safe = String(agent_id || "agent").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(ACTIVE_SESSION_DIR, `${safe}.json`);
}

// Get-or-create the session for this agent. Caller (hermes coordinator)
// is responsible for passing a stable cwd (the agent's worktree path).
// If the session exists but its pty has died, a fresh one is spawned in
// place — same agent_id, same cwd, fresh process.
export async function sessionFor(agent_id, opts = {}) {
  if (!agent_id) throw new Error("agent_id required");
  let s = sessions.get(agent_id);
  // Startup queries are consumed only at TUI boot. If dispatch wants to
  // inject a prompt into an already-idle Hermes PTY, restart the TUI and let
  // Hermes resume the same session via HERMES_TUI_RESUME before submitting.
  if (s && s.alive && typeof opts?.startupQuery === "string" && opts.startupQuery.trim()) {
    const liveSessionId = s.readActiveSessionId?.();
    if (!opts.resumeSessionId && liveSessionId) {
      opts = { ...opts, resumeSessionId: liveSessionId };
    }
    await s.restart(opts);
    return s;
  }
  if (s && s.alive) return s;
  if (s && !s.alive) {
    // Replace dead session with a fresh one that inherits config.
    sessions.delete(agent_id);
    s = null;
  }
  if (!s) {
    s = new Session({ agent_id, ...opts });
    sessions.set(agent_id, s);
  }
  await s.start();
  return s;
}

export function getSession(agent_id) {
  return sessions.get(agent_id) || null;
}

export function listSessions() {
  return [...sessions.values()].map((s) => s.status());
}

export function killSession(agent_id, signal = "SIGTERM") {
  const s = sessions.get(agent_id);
  if (!s) return false;
  s.kill(signal);
  return true;
}

export function removeSession(agent_id) {
  const s = sessions.get(agent_id);
  if (!s) return false;
  if (s.alive) s.kill("SIGTERM");
  sessions.delete(agent_id);
  return true;
}

// Best-effort cleanup at process exit. Coordinator calls this from the
// hermes shutdown path.
export function shutdown() {
  let killed = 0;
  for (const s of sessions.values()) {
    if (s.alive) {
      try { s.kill("SIGTERM"); killed++; } catch {}
    }
  }
  sessions.clear();
  return { killed };
}

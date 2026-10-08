// src/runtimes/claude_pty.js — interactive Claude Code PTY runtime.
//
// Sibling of src/runtimes/claude.js but with a fundamentally different
// shape: instead of `claude -p "<prompt>"` one-shots, this spawns a
// long-lived interactive `claude` inside a PTY and pipes the raw VT
// stream to/from the browser. The browser renders it with xterm.js so
// the user sees the actual Claude Code TUI — slash menu, plan mode,
// permission dialogs, TodoWrite display, scrollback, the works.
//
// One PTY per agent_id, persistent until reapAgent. Keys come in via
// pty.write(); raw bytes go out via pty.onData() to every WebSocket
// subscribed to /claude-tty/ws/<agent_id>. Browser disconnect/reconnect
// is supported — the PTY survives, and a small ring buffer of recent
// bytes is replayed so the screen comes back populated.
//
// Hard rules (CLAUDE.md):
//   • never throw at module load (node-pty import is dynamic + cached)
//   • cwd is the agent's worktree (caller's responsibility to set up)
//   • cleanup is idempotent; safe to call multiple times

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// Claude Code stores per-cwd session jsonl at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. If we try to
// `--resume` a session id that was recorded under a different cwd, the
// PTY child hard-fails with "No conversation found with session ID".
// Probe disk before launching and drop --resume cleanly when missing.
const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");
function encodeCwdForClaudeProjects(cwd) { return String(cwd || "").replace(/[/_.]/g, "-"); }
function locateSession(sessionId, cwd) {
  if (!sessionId || !cwd) return "missing";
  const here = join(CLAUDE_PROJECTS_ROOT, encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
  if (existsSync(here)) return "here";
  let entries;
  try { entries = readdirSync(CLAUDE_PROJECTS_ROOT); } catch { return "missing"; }
  const fname = `${sessionId}.jsonl`;
  for (const name of entries) {
    try {
      if (existsSync(join(CLAUDE_PROJECTS_ROOT, name, fname))) return "elsewhere";
    } catch {}
  }
  return "missing";
}

function latestSessionIdForCwd(cwd) {
  if (!cwd) return null;
  const dir = join(CLAUDE_PROJECTS_ROOT, encodeCwdForClaudeProjects(cwd));
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    try {
      const p = join(dir, e.name);
      const st = statSync(p);
      const sid = e.name.slice(0, -".jsonl".length);
      if (!sid) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { sessionId: sid, mtimeMs: st.mtimeMs };
    } catch {}
  }
  return best?.sessionId || null;
}

// Pre-accept claude's "Do you trust the files in this folder?" dialog
// for the worktree path BEFORE spawning. Without this, a fresh worktree
// (which claude has never seen) shows the trust dialog, and our prompt —
// written 600ms after spawn — gets typed into that dialog instead of
// into the input box. The dialog only accepts y/n/Enter, so the prompt
// text is silently dropped and the trailing \r accepts "Yes, proceed"
// by default — claude finishes loading and sits at an empty input box,
// looking idle. The voice user sees "nothing happened".
//
// Mechanism mirrors what claude itself writes when the user clicks
// "Yes, proceed": an entry under projects[<cwd>] with
// hasTrustDialogAccepted: true. We also pre-flag onboarding so the
// "first time in this project" welcome screen doesn't eat the prompt
// the same way. Best-effort — never throws, never blocks the spawn.
const CLAUDE_GLOBAL_CONFIG = join(homedir(), ".claude.json");
function preTrustProject(cwd) {
  if (!cwd) return;
  let config;
  try {
    const raw = readFileSync(CLAUDE_GLOBAL_CONFIG, "utf8");
    config = JSON.parse(raw);
  } catch {
    // ~/.claude.json doesn't exist yet — claude will create it on first
    // run; the trust dialog still shows that first time. Better to seed
    // the file ourselves so the dispatch lands cleanly.
    config = {};
  }
  if (!config || typeof config !== "object") config = {};
  if (!config.projects || typeof config.projects !== "object") config.projects = {};
  const existing = config.projects[cwd] || {};
  if (existing.hasTrustDialogAccepted === true && existing.hasCompletedProjectOnboarding === true) {
    return; // already good — nothing to do
  }
  config.projects[cwd] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: Math.max(1, Number(existing.projectOnboardingSeenCount) || 0),
  };
  try {
    const tmp = `${CLAUDE_GLOBAL_CONFIG}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, CLAUDE_GLOBAL_CONFIG);
  } catch (err) {
    if (process.env.OMO_CLAUDE_PTY_DEBUG) {
      console.warn("[claude_pty] pre-trust write failed:", err?.message || err);
    }
  }
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

// Bin discovery — same candidates as claude.js so the two adapters
// agree on which `claude` they're driving.
const BIN_CANDIDATES = [
  process.env.CLAUDE_BIN,
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".npm-global", "bin", "claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
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
      const m = String(r.stdout || "").match(/^([\d.]+)/);
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
  constructor({ agent_id, cwd, model, permissionMode, mcpConfig, settingsPath, addDirs, effort, resumeSessionId, continueLast }) {
    this.agent_id = agent_id;
    this.cwd = cwd;
    this.model = model || null;
    this.permissionMode = permissionMode || process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions";
    this.mcpConfig = mcpConfig || null;
    this.settingsPath = settingsPath || null;
    this.addDirs = Array.isArray(addDirs) ? addDirs.slice() : [];
    this.effort = effort || null;
    // Conversation continuity. If a prior `-p` turn already created a
    // session in this worktree, pass --resume <id> so the interactive
    // PTY picks up the same conversation (the user sees their task's
    // transcript replayed, not a fresh banner). Without an id, fall
    // back to --continue (resume the most recent session in this cwd).
    this.resumeSessionId = resumeSessionId || null;
    this.currentSessionId = resumeSessionId || null;
    this.continueLast = !!continueLast;
    this.cols = DEFAULT_COLS;
    this.rows = DEFAULT_ROWS;
    this.pty = null;
    this.alive = false;
    this.startedAt = 0;
    this.exitedAt = 0;
    this.exitCode = null;
    this.exitSignal = null;
    this.replay = Buffer.alloc(0);
    this.subscribers = new Set();    // WebSocket-like { send, isAlive }
    this.dataListeners = new Set();  // optional in-process listeners
    this.exitListeners = new Set();
  }

  buildArgs() {
    // Interactive flags only — no -p, no --output-format. We want the
    // real TUI. Permission mode defaults to bypassPermissions (Claude
    // Code's "auto" mode) so the agent runs unattended without any
    // prompts; when callers want native permission dialogs they pass
    // mode='default', 'acceptEdits', or 'plan'.
    const args = [];
    if (this.resumeSessionId) {
      args.push("--resume", this.resumeSessionId);
    } else if (this.continueLast) {
      args.push("--continue");
    }
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--effort", this.effort);
    if (this.permissionMode) args.push("--permission-mode", this.permissionMode);
    if (this.mcpConfig) args.push("--mcp-config", this.mcpConfig);
    if (this.settingsPath) args.push("--settings", this.settingsPath);
    for (const dir of this.addDirs) {
      if (dir) args.push("--add-dir", dir);
    }
    return args;
  }

  async start() {
    if (this.alive) return;
    const detected = detect();
    if (!detected.installed) {
      const err = new Error("claude code is not installed");
      err.code = "NOT_INSTALLED";
      throw err;
    }
    // Pre-flight: drop --resume if the session id doesn't actually live
    // under this cwd's project dir. Better to start fresh than to crash
    // the child mid-launch with "No conversation found with session ID".
    if (this.resumeSessionId) {
      const loc = locateSession(this.resumeSessionId, this.cwd);
      if (loc !== "here") {
        // Fall back to --continue (resume the most recent session under
        // this cwd) so the user still picks up any prior conversation
        // claude itself recorded here from a different code path.
        this.resumeSessionId = null;
        this.currentSessionId = null;
        this.continueLast = true;
      }
    }
    if (!this.resumeSessionId && this.continueLast && !latestSessionIdForCwd(this.cwd)) {
      this.continueLast = false;
    }
    // Pre-accept the trust dialog + onboarding for this worktree path so
    // claude lands on the input box rather than a y/n dialog when we
    // write the voice prompt 600ms after spawn. Best-effort.
    if (this.cwd) preTrustProject(this.cwd);
    const pty = await loadPty();
    const args = this.buildArgs();
    const env = {
      ...process.env,
      // xterm.js advertises xterm-256color; pass it through so Claude
      // Code paints with the right palette.
      TERM: process.env.TERM_PROGRAM === "iTerm.app" ? "xterm-256color" : (process.env.TERM || "xterm-256color"),
      // Force colour even if Claude is sniffing for "is this a real TTY".
      // It IS a real PTY now, but explicit is friendlier.
      FORCE_COLOR: "1",
      // Avoid the auto-update prompt eating the screen on first boot.
      CLAUDE_DISABLE_UPDATE_CHECK: process.env.CLAUDE_DISABLE_UPDATE_CHECK || "1",
      // Disable any TTY shenanigans the parent process might inherit.
      NO_COLOR: undefined,
      CI: undefined,
    };
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
    this.alive = true;
    this.startedAt = Date.now();

    this.pty.onData((data) => {
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
      this.alive = false;
      this.exitedAt = Date.now();
      this.exitCode = exitCode ?? null;
      this.exitSignal = signal ?? null;
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
      // node-pty exposes .kill(signal) which sends to the foreground
      // process group of the PTY — same as ctrl-c in the terminal.
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
    return {
      agent_id: this.agent_id,
      alive: this.alive,
      cwd: this.cwd,
      model: this.model,
      permission_mode: this.permissionMode,
      cols: this.cols,
      rows: this.rows,
      started_at: this.startedAt,
      exited_at: this.exitedAt || null,
      exit_code: this.exitCode,
      exit_signal: this.exitSignal,
      session_id: this.readActiveSessionId(),
      subscribers: this.subscribers.size,
    };
  }

  readActiveSessionId() {
    if (this.currentSessionId) return this.currentSessionId;
    const sid = latestSessionIdForCwd(this.cwd);
    if (sid) this.currentSessionId = sid;
    return sid;
  }
}

// Get-or-create the session for this agent. Caller (hermes coordinator)
// is responsible for passing a stable cwd (the agent's worktree path).
// If the session exists but its pty has died, a fresh one is spawned in
// place — same agent_id, same cwd, fresh process.
export async function sessionFor(agent_id, opts = {}) {
  if (!agent_id) throw new Error("agent_id required");
  let s = sessions.get(agent_id);
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

// src/runtimes/claude.js — Claude Code runtime adapter.
//
// Spawns `claude -p "<prompt>" --output-format stream-json --verbose
// --permission-mode acceptEdits [--resume <session_id>]` and translates
// its NDJSON event stream into the canonical events documented in
// ./events.js. The coordinator in src/hermes/index.js consumes those.
//
// Why stream-json? Claude Code's native output is decorated for humans;
// stream-json gives us structured tool_use / tool_result / text / result
// events with the actual arguments the agent passed — no regex parsing,
// no guessing what file is being edited.
//
// Hard rules (CLAUDE.md):
//   • never throw at module load
//   • detect() is sync + cheap; safe to call repeatedly
//   • spawn() returns immediately with a handle; callers consume events
//     via the onEvent callback

import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as events from "./events.js";

// Bin discovery. CLAUDE_BIN env var wins; otherwise we search common
// install paths. The user's openclaw is intentionally NOT a candidate —
// it's a different agent platform, not a Claude Code wrapper.
const BIN_CANDIDATES = [
  process.env.CLAUDE_BIN,
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".npm-global", "bin", "claude"),
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
].filter(Boolean);

// Default permission mode. bypassPermissions is Claude Code's "auto"
// mode (the most permissive cycle in Shift+Tab) — matches hermes' --yolo
// and means agents can Edit/Write/Bash with no interactive prompts at
// all. Override with CLAUDE_PERMISSION_MODE.
const DEFAULT_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions";

// Optional model override. Aliases ("sonnet", "opus") and full ids both
// work. Unset → server default (whatever the user has configured).
const MODEL_OVERRIDE = process.env.CLAUDE_MODEL || null;

let cache = { installed: false, bin: null, version: null, warmedAt: 0 };

export function detect() {
  const bin = BIN_CANDIDATES.find((p) => p && existsSync(p) && isExecutable(p));
  if (!bin) {
    cache = { installed: false, bin: null, version: null, warmedAt: Date.now() };
    return cache;
  }
  let version = null;
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (r.status === 0) {
      // Output like "2.1.141 (Claude Code)" — keep the leading version.
      const m = String(r.stdout || "").match(/^([\d.]+)/);
      if (m) version = m[1];
    }
  } catch {}
  cache = { installed: true, bin, version, warmedAt: Date.now() };
  return cache;
}

export function status() {
  if (!cache.warmedAt) detect();
  return { ...cache };
}

function isExecutable(p) {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

// Map a Claude Code tool name (camelCase / PascalCase) to the lowercase
// key the squad UI's TOOL_KIND table expects. Anything we don't know
// passes through lowercased — the UI falls back to the 'misc' bucket.
const TOOL_NAME_MAP = {
  Read: "read",
  Edit: "edit",
  Write: "write",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  WebSearch: "web_search",
  WebFetch: "web_extract",
  Task: "task",
  TaskCreate: "task",
  TaskUpdate: "task",
  TaskList: "task",
  TodoWrite: "task",
};

function normaliseToolName(raw) {
  if (!raw) return "tool";
  return TOOL_NAME_MAP[raw] || String(raw).toLowerCase();
}

// Pick the single most useful display string from a tool's input args.
// What goes in the squad sidebar's address bar / sprite caption.
function formatToolArgs(name, input) {
  if (!input || typeof input !== "object") return "";
  const lower = String(name || "").toLowerCase();
  // File-shaped tools — show the path.
  if (input.file_path) return String(input.file_path);
  if (input.path && lower !== "glob") return String(input.path);
  // Shell — show the command (truncated).
  if (input.command) return String(input.command).slice(0, 400);
  // Search — show the query / pattern.
  if (input.query) return String(input.query).slice(0, 200);
  if (input.pattern) return String(input.pattern).slice(0, 200);
  // Url fetch — show the url.
  if (input.url) return String(input.url);
  // Task family — short prompt / subject.
  if (input.prompt) return String(input.prompt).slice(0, 200);
  if (input.subject) return String(input.subject).slice(0, 200);
  if (input.description) return String(input.description).slice(0, 200);
  // Fallback — first scalar value.
  for (const v of Object.values(input)) {
    if (v == null) continue;
    if (typeof v === "string") return v.slice(0, 200);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") out.push(part.text);
  }
  return out.join("\n");
}

function extractToolResult(content) {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part?.type !== "tool_result") continue;
    const body = Array.isArray(part.content)
      ? part.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("")
      : (typeof part.content === "string" ? part.content : JSON.stringify(part.content || ""));
    return { toolUseId: part.tool_use_id || null, isError: !!part.is_error, body };
  }
  return null;
}

// Spawn a Claude Code child. Returns { child, kill } and pumps canonical
// events into onEvent. onError is called on JSON parse + lifecycle
// errors. onClose fires with the exit code once the child exits AND we
// have flushed the final result event.
//
// opts:
//   prompt          — string, required
//   sessionId       — optional, passed to --resume
//   cwd             — working directory (defaults to process.cwd())
//   allowedTools    — optional array of allow-list tool names
//   model           — optional per-call model (overrides CLAUDE_MODEL env)
//   effort          — optional effort level (low/medium/high/xhigh/max)
//   permissionMode  — optional permission mode override
//   addDirs         — optional array of extra dirs passed as --add-dir
//   mcpConfig       — optional path/json passed as --mcp-config
//   settingsPath    — optional path passed as --settings
//   onEvent         — (evt) => void; canonical events from ./events.js
//   onError         — (err) => void
//   onClose         — (exitCode) => void
export function spawn_({
  prompt,
  sessionId = null,
  cwd = null,
  allowedTools = null,
  model = null,
  effort = null,
  permissionMode = null,
  addDirs = null,
  mcpConfig = null,
  settingsPath = null,
  onEvent, onError, onClose,
} = {}) {
  if (!cache.warmedAt) detect();
  if (!cache.installed) {
    const err = new Error("claude code is not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    const err = new Error("missing prompt");
    err.code = "MISSING_PROMPT";
    throw err;
  }

  const args = [
    "-p", trimmed,
    "--output-format", "stream-json",
    "--verbose", // required for stream-json to emit per-turn events
    "--permission-mode", permissionMode || DEFAULT_PERMISSION_MODE,
  ];
  if (sessionId) args.push("--resume", sessionId);
  const effectiveModel = model || MODEL_OVERRIDE;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (effort) args.push("--effort", effort);
  if (Array.isArray(addDirs)) {
    for (const d of addDirs) {
      if (d) args.push("--add-dir", String(d));
    }
  }
  if (mcpConfig)    args.push("--mcp-config", String(mcpConfig));
  if (settingsPath) args.push("--settings",   String(settingsPath));
  if (Array.isArray(allowedTools) && allowedTools.length) {
    args.push("--allowedTools", allowedTools.join(" "));
  }

  const childEnv = {
    ...process.env,
    NO_COLOR: process.env.NO_COLOR || "1",
    // Belt + suspenders: surface CI-style behaviour to discourage
    // anything in Claude Code that wants a TTY.
    CI: process.env.CI || "1",
  };

  let child;
  try {
    child = spawn(cache.bin, args, {
      cwd: cwd || process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = new Error(`failed to spawn claude: ${err?.message || err}`);
    e.code = "SPAWN_FAILED";
    throw e;
  }

  // ── stdout: NDJSON event stream ────────────────────────────────────
  // Claude Code emits one JSON object per line. We buffer partial
  // lines and parse on newline; any malformed line is forwarded as a
  // chunk event (so the UI sees it as raw output rather than silently
  // dropping). pendingTools maps tool_use_id → tool name + start ts,
  // letting us emit a matching tool_end when the tool_result arrives.
  let stdoutBuf = "";
  let resultEmitted = false;
  let exitCode = null;
  // Map tool_use_id → { tool, ts, filePath? }. filePath set only for
  // Edit/Write/MultiEdit/NotebookEdit so we know which file to emit a
  // file_change event for once the matching tool_result arrives.
  const pendingTools = new Map();
  const startedAt = Date.now();

  // Tool names that, on success, count as "this file just got written".
  const FILE_TOUCHING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

  function safeEmit(evt) {
    try { onEvent?.(evt); } catch (err) { onError?.(err); }
  }

  function handleEnvelope(env) {
    if (!env || typeof env !== "object") return;
    const t = env.type;
    if (t === "system" && env.subtype === "init") {
      if (env.session_id) {
        safeEmit(events.sessionInit({
          sessionId: String(env.session_id),
          model: env.model || null,
          cwd: env.cwd || null,
        }));
      }
      return;
    }
    if (t === "assistant" && env.message) {
      const content = env.message.content || [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string" && part.text.length) {
          safeEmit(events.chunk({ text: part.text, role: "assistant" }));
        } else if (part.type === "tool_use") {
          const tool = normaliseToolName(part.name);
          const args = formatToolArgs(part.name, part.input);
          const ts = Date.now();
          // Capture the file path now so we can fire file_change when
          // the matching tool_result comes back successful. Only set for
          // tools that actually write to disk.
          const filePath = FILE_TOUCHING_TOOLS.has(part.name)
            ? (part.input?.file_path || part.input?.path || null)
            : null;
          pendingTools.set(part.id, { tool, ts, rawName: part.name, filePath });
          safeEmit(events.toolStart({
            tool,
            args,
            summary: `${tool} ${args}`.trim(),
            ts,
          }));
        }
      }
      return;
    }
    if (t === "user" && env.message) {
      const result = extractToolResult(env.message.content);
      if (result) {
        const pending = pendingTools.get(result.toolUseId);
        const tool = pending?.tool || "tool";
        pendingTools.delete(result.toolUseId);
        safeEmit(events.toolEnd({ tool, ok: !result.isError }));
        // If a file-touching tool just succeeded, signal "this file
        // changed" so the coordinator can diff + broadcast hunks. The
        // adapter doesn't run git itself — it only emits the path.
        if (pending?.filePath && !result.isError) {
          safeEmit(events.fileChange({ path: pending.filePath }));
        }
        // Forward the tool output as a chunk so the squad activity
        // ticker shows what came back — truncated by the consumer.
        if (result.body) {
          safeEmit(events.chunk({
            text: result.body,
            role: "tool_result",
            isStderr: result.isError,
          }));
        }
      }
      return;
    }
    if (t === "result") {
      resultEmitted = true;
      const status = env.is_error ? "error" : "done";
      const final = typeof env.result === "string" ? env.result : null;
      safeEmit(events.result({
        status,
        exitCode: exitCode ?? (env.is_error ? 1 : 0),
        durationMs: Number.isFinite(env.duration_ms) ? env.duration_ms : (Date.now() - startedAt),
        costUsd: Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : null,
        error: env.is_error ? (final || env.subtype || "claude reported an error") : null,
        final,
      }));
      return;
    }
    // Unknown envelope type — surface as a debug chunk so we don't
    // lose information silently. Cheap, only fires for novelties.
    if (t && process.env.CLAUDE_DEBUG_UNKNOWN) {
      safeEmit(events.chunk({ text: `[unknown ${t}] ${JSON.stringify(env).slice(0, 400)}`, role: "assistant" }));
    }
  }

  child.stdout.on("data", (buf) => {
    stdoutBuf += buf.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const raw = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const line = raw.trim();
      if (!line) continue;
      try {
        handleEnvelope(JSON.parse(line));
      } catch (err) {
        // Not JSON — most likely diagnostic output. Forward as a
        // chunk so it still surfaces in the UI.
        safeEmit(events.chunk({ text: raw, role: "assistant" }));
      }
    }
  });

  // ── stderr: forward verbatim ───────────────────────────────────────
  child.stderr.on("data", (buf) => {
    const text = buf.toString("utf8");
    if (text) safeEmit(events.chunk({ text, role: "assistant", isStderr: true }));
  });

  child.on("error", (err) => {
    onError?.(err);
  });

  child.on("close", (code) => {
    exitCode = code;
    // If the process exited before emitting a `result` envelope (e.g.
    // crashed mid-stream), synthesize one so the coordinator can mark
    // the task finished and unwedge the seat.
    if (!resultEmitted) {
      safeEmit(events.result({
        status: code === 0 ? "done" : "error",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        error: code === 0 ? null : `claude exited with code ${code}`,
      }));
    }
    onClose?.(code);
  });

  return {
    child,
    kill(signal = "SIGTERM") {
      try { child.kill(signal); } catch {}
    },
  };
}

// Convenience export: callers do `import * as claude from '...'; claude.spawn(...)`.
export { spawn_ as spawn };

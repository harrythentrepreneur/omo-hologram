// src/runtimes/hermes_acp.js — Hermes ACP runtime adapter (scaffold).
//
// Replaces the regex-scraping `-q` adapter (src/runtimes/hermes.js) with
// a structured Agent-Client-Protocol client. Hermes ships an ACP server
// (`hermes acp`) speaking JSON-RPC 2.0 over stdio with NDJSON framing
// (one message per line). This adapter:
//
//   1. Spawns `hermes acp` as a child with piped stdin/stdout/stderr
//   2. Initializes the protocol (initialize → server caps)
//   3. Opens a session (session/new with cwd) — or session/load to resume
//   4. Sends the user prompt (session/prompt)
//   5. Listens for session/update notifications and translates them into
//      our canonical events (src/runtimes/events.js): tool_start/end,
//      chunk, file_change, result
//   6. Handles client-side methods Hermes calls back into us:
//      - session/request_permission → translate to omo's approval flow
//        (today: auto-approve in 'auto' mode; surface to user in 'ask')
//      - fs/read_text_file / fs/write_text_file → bridge to Node fs
//      - terminal/* → out of scope for now (Hermes can fall back)
//
// Protocol reference:
//   ~/.hermes/hermes-agent/website/docs/developer-guide/acp-internals.md
//   ~/.hermes/hermes-agent/venv/lib/python3.11/site-packages/acp/meta.py
//
// Hard rules (CLAUDE.md):
//   • never throw at module load
//   • detect() is sync + cheap
//   • spawn() returns immediately with a handle; canonical events flow via onEvent
//
// STATUS: scaffold. The framing + initialize + session/new + session/prompt
// happy-path flows. Event translation covers the most common session/update
// payloads (agent_message_chunk, tool_call, plan). Permission + fs/terminal
// callbacks are stubbed with auto-approve / file-system bridge / refusal.
// See the marked TODOs to extend.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as events from "./events.js";

// ─── Bin discovery (mirrors hermes.js) ────────────────────────────────

const BIN_CANDIDATES = [
  process.env.HERMES_BIN,
  join(homedir(), ".local", "bin", "hermes"),
  join(homedir(), ".npm-global", "bin", "hermes"),
  "/usr/local/bin/hermes",
  "/opt/homebrew/bin/hermes",
].filter(Boolean);

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
      const m = String(r.stdout || "").match(/v?(\d+\.\d+\.\d+)/);
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

// ─── ACP protocol constants ───────────────────────────────────────────

const PROTOCOL_VERSION = 1;
// Agent methods we may invoke on the Hermes-side ACP server.
const AGENT_METHODS = {
  initialize:                   "initialize",
  authenticate:                 "authenticate",
  session_cancel:               "session/cancel",
  session_close:                "session/close",
  session_fork:                 "session/fork",
  session_list:                 "session/list",
  session_load:                 "session/load",
  session_new:                  "session/new",
  session_prompt:               "session/prompt",
  session_resume:               "session/resume",
  session_set_config_option:    "session/set_config_option",
  session_set_mode:             "session/set_mode",
  session_set_model:            "session/set_model",
};
// Client methods Hermes may invoke on US (we must respond).
const CLIENT_METHODS = {
  fs_read_text_file:           "fs/read_text_file",
  fs_write_text_file:          "fs/write_text_file",
  session_request_permission:  "session/request_permission",
  session_update:              "session/update",
  terminal_create:             "terminal/create",
  terminal_kill:               "terminal/kill",
  terminal_output:             "terminal/output",
  terminal_release:            "terminal/release",
  terminal_wait_for_exit:      "terminal/wait_for_exit",
};

// ─── Spawn a hermes ACP child + drive the session ──────────────────────
//
// Same shape as claude.js / hermes.js spawn so the coordinator wires
// it identically.
//
// opts:
//   prompt        — string, required (the user's task message)
//   sessionId     — optional, passed to session/load; otherwise session/new
//   cwd           — working directory for the agent
//   model         — optional model override (session/set_model after new)
//   permissionMode — 'auto' (default, auto-approve) | 'ask' (refuse, surface
//                    to onEvent so caller can prompt user)
//   onEvent       — (evt) => void; canonical events from ./events.js
//   onError       — (err) => void
//   onClose       — (exitCode) => void
export function spawn_({
  prompt,
  sessionId = null,
  cwd = null,
  model = null,
  permissionMode = "auto",
  onEvent, onError, onClose,
} = {}) {
  if (!cache.warmedAt) detect();
  if (!cache.installed) {
    const err = new Error("hermes is not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    const err = new Error("missing prompt");
    err.code = "MISSING_PROMPT";
    throw err;
  }

  const env = { ...process.env, NO_COLOR: process.env.NO_COLOR || "1" };
  const args = ["acp", "--accept-hooks"];
  let child;
  try {
    child = spawn(cache.bin, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = new Error(`failed to spawn hermes acp: ${err?.message || err}`);
    e.code = "SPAWN_FAILED";
    throw e;
  }

  const startedAt = Date.now();
  let nextRequestId = 1;
  // request id → { resolve, reject, method, sentAt }
  const pending = new Map();
  let activeSessionId = null;       // set after session/new succeeds
  let resultEmitted = false;
  let stdoutBuf = "";
  let finalText = "";              // accumulated final agent text for the result event

  // Track in-flight tools so we can pair start/end events. Map by
  // toolCallId (Hermes-issued) → { tool, args, ts }.
  const activeTools = new Map();

  function safeEmit(evt) {
    try { onEvent?.(evt); } catch (err) { onError?.(err); }
  }

  // ── Send a JSON-RPC request and return a promise for the response ──
  function sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      pending.set(id, { resolve, reject, method, sentAt: Date.now() });
      child.stdin.write(payload + "\n");
    });
  }

  // ── Send a JSON-RPC notification (no id, no response expected) ─────
  function sendNotification(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    child.stdin.write(payload + "\n");
  }

  // ── Send a JSON-RPC response to a server-initiated request ─────────
  function sendResponse(id, resultOrError) {
    const isErr = resultOrError && typeof resultOrError === "object" && "code" in resultOrError && "message" in resultOrError;
    const payload = isErr
      ? JSON.stringify({ jsonrpc: "2.0", id, error: resultOrError })
      : JSON.stringify({ jsonrpc: "2.0", id, result: resultOrError });
    child.stdin.write(payload + "\n");
  }

  // ── Translate a single ACP session/update payload into canonical events ─
  function translateSessionUpdate(update) {
    if (!update || typeof update !== "object") return;
    // ACP variants we know to handle: agent_message_chunk, agent_thought_chunk,
    // tool_call, tool_call_update, plan, current_mode_update, available_commands_update.
    // Variant key is `sessionUpdate` (e.g. "agent_message_chunk") OR shape detection.
    const variant = update.sessionUpdate || detectVariant(update);
    switch (variant) {
      case "agent_message_chunk": {
        const text = extractTextFromContent(update.content);
        if (!text) return;
        finalText += text;
        safeEmit(events.chunk({ text, role: "assistant" }));
        return;
      }
      case "agent_thought_chunk": {
        const text = extractTextFromContent(update.content);
        if (!text) return;
        // Thinking goes through as a chunk too — squad UI buckets it
        // separately by inspecting role; future work could promote it.
        safeEmit(events.chunk({ text, role: "assistant", isThought: true }));
        return;
      }
      case "tool_call": {
        const toolCallId = update.toolCallId || update.tool_call_id || null;
        const toolName = update.title || update.kind || "tool";
        const argsText = extractToolArgs(update);
        const ts = Date.now();
        if (toolCallId) activeTools.set(toolCallId, { tool: toolName, args: argsText, ts });
        safeEmit(events.toolStart({ tool: normaliseTool(toolName), args: argsText, summary: argsText, ts }));
        return;
      }
      case "tool_call_update": {
        const toolCallId = update.toolCallId || update.tool_call_id || null;
        const status = update.status; // 'in_progress' | 'completed' | 'failed'
        if (status === "completed" || status === "failed") {
          const pending = toolCallId ? activeTools.get(toolCallId) : null;
          const tool = pending?.tool || update.title || "tool";
          if (toolCallId) activeTools.delete(toolCallId);
          safeEmit(events.toolEnd({ tool: normaliseTool(tool), ok: status === "completed" }));
          // Emit any returned content as a tool_result chunk so the squad
          // sidebar's collated activity panel still shows output.
          const out = extractTextFromContent(update.content);
          if (out) safeEmit(events.chunk({ text: out, role: "tool_result", isStderr: status === "failed" }));
          // File-touching tools: if the tool was a write/edit, fire a
          // file_change event so the AI coding loop sees the move.
          if (status === "completed") {
            const fp = extractFilePathFromTool(update);
            if (fp) safeEmit(events.fileChange({ path: fp }));
          }
        }
        return;
      }
      case "plan": {
        // Plan mode emits a plan tree — surface as a chunk with a marker
        // role so the squad UI's reasoning tab can pick it up.
        const text = JSON.stringify(update.entries || update.plan || update);
        safeEmit(events.chunk({ text: `[plan]\n${text}`, role: "assistant" }));
        return;
      }
      case "current_mode_update":
      case "available_commands_update":
        // Informational — squad UI doesn't render these yet.
        return;
      default:
        // Unknown variants: forward as a debug chunk only when explicitly
        // requested (helps when adding support for new ACP variants).
        if (process.env.OMO_ACP_DEBUG_UNKNOWN) {
          safeEmit(events.chunk({ text: `[acp ${variant || "?"}] ${JSON.stringify(update).slice(0, 400)}`, role: "assistant" }));
        }
    }
  }

  // ── Handle a server-initiated request from Hermes ──────────────────
  async function handleClientRequest(message) {
    const { id, method, params } = message;
    try {
      switch (method) {
        case CLIENT_METHODS.fs_read_text_file: {
          // Hermes asks us to read a file (e.g. it's running in an editor
          // that owns the buffer). Bridge to local fs.
          const path = params?.path;
          if (!path) return sendResponse(id, { code: -32602, message: "missing path" });
          const text = readFileSync(path, "utf8");
          return sendResponse(id, { content: text });
        }
        case CLIENT_METHODS.fs_write_text_file: {
          const { path, content } = params || {};
          if (!path) return sendResponse(id, { code: -32602, message: "missing path" });
          writeFileSync(path, content ?? "", "utf8");
          // Surface as a canonical file_change for AI coding loop awareness.
          safeEmit(events.fileChange({ path }));
          return sendResponse(id, { success: true });
        }
        case CLIENT_METHODS.session_request_permission: {
          // Permission prompt for a dangerous operation. In 'auto' mode
          // we accept once; in 'ask' we deny + emit a chunk so the caller
          // (omo voice flow) can ask the user and re-issue via the relevant
          // session_set_config_option. TODO: a richer ack/wait round-trip.
          if (permissionMode === "auto") {
            return sendResponse(id, { outcome: { selected_option_id: "allow_once" } });
          }
          // In 'ask' mode: refuse + surface a synthetic chunk.
          safeEmit(events.chunk({
            text: `[permission requested] ${JSON.stringify(params || {}).slice(0, 400)}`,
            role: "assistant",
          }));
          return sendResponse(id, { outcome: { selected_option_id: "reject" } });
        }
        case CLIENT_METHODS.terminal_create:
        case CLIENT_METHODS.terminal_kill:
        case CLIENT_METHODS.terminal_output:
        case CLIENT_METHODS.terminal_release:
        case CLIENT_METHODS.terminal_wait_for_exit: {
          // Out of scope for the scaffold — Hermes will gracefully handle
          // a refusal by falling back to subprocess exec inside the agent.
          return sendResponse(id, { code: -32601, message: "terminal/* not implemented yet" });
        }
        default:
          return sendResponse(id, { code: -32601, message: `method not implemented: ${method}` });
      }
    } catch (err) {
      onError?.(err);
      try { sendResponse(id, { code: -32000, message: String(err?.message || err) }); } catch {}
    }
  }

  function handleEnvelope(env) {
    if (!env || typeof env !== "object") return;
    // Response to one of our requests
    if (env.id !== undefined && (env.result !== undefined || env.error !== undefined)) {
      const p = pending.get(env.id);
      if (!p) return;
      pending.delete(env.id);
      if (env.error) p.reject(Object.assign(new Error(env.error.message || "rpc error"), { code: env.error.code, data: env.error.data }));
      else p.resolve(env.result);
      return;
    }
    // Notification or server-initiated request
    if (env.method) {
      if (env.method === CLIENT_METHODS.session_update) {
        translateSessionUpdate(env.params?.update || env.params);
      } else if (env.id !== undefined) {
        // Server-initiated request requiring a response
        handleClientRequest(env);
      } else {
        // Pure notification with no handler — ignore.
      }
    }
  }

  // ── stdout: NDJSON parser ───────────────────────────────────────────
  child.stdout.on("data", (buf) => {
    stdoutBuf += buf.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const raw = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!raw) continue;
      try { handleEnvelope(JSON.parse(raw)); }
      catch { /* malformed line — skip */ }
    }
  });

  // Stderr is human-readable diagnostics from Hermes — forward as
  // assistant chunks tagged stderr so the squad UI can render them.
  child.stderr.on("data", (buf) => {
    const text = buf.toString("utf8");
    if (text) safeEmit(events.chunk({ text, role: "assistant", isStderr: true }));
  });

  child.on("error", (err) => onError?.(err));

  child.on("close", (code) => {
    if (!resultEmitted) {
      resultEmitted = true;
      safeEmit(events.result({
        status: code === 0 ? "done" : "error",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        error: code === 0 ? null : `hermes acp exited ${code}`,
        final: finalText.trim().slice(-8000),
      }));
    }
    onClose?.(code);
  });

  // ── Drive the session: initialize → new → prompt ────────────────────
  // Errors at any step finish the task.
  (async () => {
    try {
      await sendRequest(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { read_text_file: true, write_text_file: true },
        },
      });

      const newOrLoad = sessionId
        ? AGENT_METHODS.session_load
        : AGENT_METHODS.session_new;
      const sessionParams = sessionId
        ? { sessionId, cwd: cwd || process.cwd() }
        : { cwd: cwd || process.cwd(), mcpServers: [] };
      const sessionRes = await sendRequest(newOrLoad, sessionParams);
      activeSessionId = sessionRes?.sessionId || sessionRes?.session_id || null;
      if (activeSessionId) {
        safeEmit(events.sessionInit({ sessionId: activeSessionId, model, cwd: cwd || process.cwd() }));
      }

      if (model && activeSessionId) {
        try { await sendRequest(AGENT_METHODS.session_set_model, { sessionId: activeSessionId, modelId: model }); } catch {}
      }

      // Send the prompt as a single text content block.
      const promptRes = await sendRequest(AGENT_METHODS.session_prompt, {
        sessionId: activeSessionId,
        prompt: [{ type: "text", text: trimmed }],
      });
      // promptRes.stopReason ∈ "end_turn" | "max_turn_requests" | "cancelled" | ...
      const stopReason = promptRes?.stopReason || promptRes?.stop_reason || "end_turn";
      const ok = stopReason === "end_turn" || stopReason === "complete";
      if (!resultEmitted) {
        resultEmitted = true;
        safeEmit(events.result({
          status: ok ? "done" : "error",
          exitCode: ok ? 0 : 1,
          durationMs: Date.now() - startedAt,
          error: ok ? null : `prompt stopped: ${stopReason}`,
          final: finalText.trim().slice(-8000),
        }));
      }
    } catch (err) {
      if (!resultEmitted) {
        resultEmitted = true;
        safeEmit(events.result({
          status: "error",
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          error: err?.message || String(err),
        }));
      }
      try { child.kill("SIGTERM"); } catch {}
    }
  })();

  return {
    child,
    kill(signal = "SIGTERM") {
      // Try a graceful cancel first.
      if (activeSessionId) {
        try { sendNotification(AGENT_METHODS.session_cancel, { sessionId: activeSessionId }); } catch {}
      }
      try { child.kill(signal); } catch {}
    },
  };
}

export { spawn_ as spawn };

// ─── helpers ───────────────────────────────────────────────────────────

function detectVariant(update) {
  if (update.content) return "agent_message_chunk";
  if (update.toolCallId || update.tool_call_id) {
    if (update.status) return "tool_call_update";
    return "tool_call";
  }
  if (update.entries) return "plan";
  return null;
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text || p?.content || "")))
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "object") {
    return content.text || content.content || "";
  }
  return "";
}

function extractToolArgs(update) {
  // Hermes ACP tool_call has shape { kind, title, content, locations, ... }.
  // Pick the most useful display string; truncated to 400 chars.
  const t = update.title || update.kind || "";
  const loc = Array.isArray(update.locations) && update.locations[0]?.path;
  if (loc) return `${t}: ${loc}`.slice(0, 400);
  return String(t).slice(0, 400);
}

function extractFilePathFromTool(update) {
  if (Array.isArray(update.locations) && update.locations[0]?.path) {
    return update.locations[0].path;
  }
  return null;
}

const TOOL_NAME_NORMALISE = {
  "read_file": "read",
  "write_file": "write",
  "patch": "edit",
  "search_files": "grep",
  "execute_code": "bash",
  "terminal": "bash",
  "delegate_task": "task",
};
function normaliseTool(name) {
  if (!name) return "tool";
  const k = String(name).toLowerCase().replace(/\s+/g, "_");
  return TOOL_NAME_NORMALISE[k] || k;
}

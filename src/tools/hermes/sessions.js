// src/tools/hermes_sessions.js — voice tools for Hermes session history.
//
// Four tools that wrap `hermes sessions {list,rename,export,delete}`.
// Hermes sessions live in a SQLite store separate from Claude Code's
// session files; these tools are the voice surface onto that store.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_sessions_list ─────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_sessions_list",
  description:
    "List recent HERMES CHAT SESSIONS (conversation history transcripts) from the SQLite store. " +
    "Use when the user wants to see past CHATS with hermes, not kanban tasks. " +
    "Voice: 'show me hermes sessions', 'what sessions do I have', 'list yesterday's chats with hermes', 'my hermes chat history'. " +
    "**NOT for kanban tasks — that's hermes_kanban_list. This one is chat-thread history.**",
  parameters: {
    type: "object",
    properties: {
      limit:  { type: "number", description: "Max sessions to show. Default 20." },
      source: { type: "string", description: "Filter by source channel (cli, telegram, discord, etc.)." },
    },
    additionalProperties: false,
  },
};

export async function runHermesSessionsList(args) {
  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
  const cli = ["sessions", "list", "--limit", String(limit)];
  if (args?.source) cli.push("--source", String(args.source));

  const r = runHermes(cli, { timeoutMs: 15000 });
  if (r.error) return { error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    limit,
    source: args?.source || null,
    output: stripAnsi(r.stdout).slice(0, 6000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Summarize: count of sessions, the most recent 2-3 by title (or 'untitled' + a hint). " +
      "Don't read every row — offer 'want me to export one or rename one?'",
  };
}

// ─── hermes_sessions_rename ───────────────────────────────────────────

export const renameDefinition = {
  type: "function",
  name: "hermes_sessions_rename",
  description:
    "Set or change a Hermes session's title for easy resume later. " +
    "Voice: 'name that last hermes session X', 'call the inbox-clean session Y', '给那个 session 起个名叫 X'.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The session id (from hermes_sessions_list)." },
      title:      { type: "string", description: "The new title — short, human-readable." },
    },
    required: ["session_id", "title"],
    additionalProperties: false,
  },
};

export async function runHermesSessionsRename(args) {
  const sessionId = String(args?.session_id || "").trim();
  const title = String(args?.title || "").trim();
  if (!sessionId) return { error: "missing session_id", note: "Ask the user which session — list them first if unsure." };
  if (!title)     return { error: "missing title", note: "Ask the user what to name it." };

  const r = runHermes(["sessions", "rename", sessionId, title], { timeoutMs: 10000 });
  if (r.error) return { error: r.error, code: r.code, session_id: sessionId };
  const ok = r.exitCode === 0;
  return {
    ok,
    session_id: sessionId,
    title,
    output: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note: ok
      ? `Cute confirmation — '改好啦，现在叫 ${title}~' / 'named it ${title}.'`
      : "Rename failed — most likely the session_id wasn't found. Offer to list sessions again.",
  };
}

// ─── hermes_sessions_export ───────────────────────────────────────────

export const exportDefinition = {
  type: "function",
  name: "hermes_sessions_export",
  description:
    "Export a Hermes session (or all sessions) to a JSONL file on disk. " +
    "Voice: 'export that session', 'save the chat with hermes', 'dump session X to a file'. " +
    "Returns the absolute file path so the user can grab it.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Specific session to export. Omit to export all (filtered by source if given)." },
      source:     { type: "string", description: "Filter by source channel when exporting many." },
      output:     { type: "string", description: "Optional output path. Defaults to a temp file." },
    },
    additionalProperties: false,
  },
};

export async function runHermesSessionsExport(args) {
  const sessionId = args?.session_id ? String(args.session_id).trim() : null;
  const source = args?.source ? String(args.source).trim() : null;
  const output = args?.output
    ? String(args.output).trim()
    : join(tmpdir(), `hermes-session-${Date.now()}.jsonl`);

  const cli = ["sessions", "export"];
  if (sessionId) cli.push("--session-id", sessionId);
  if (source)    cli.push("--source", source);
  cli.push(output);

  const r = runHermes(cli, { timeoutMs: 30000 });
  if (r.error) return { error: r.error, code: r.code, output };
  const ok = r.exitCode === 0;
  let bytes = null;
  try {
    if (ok && existsSync(output)) {
      const data = readFileSync(output);
      bytes = data.byteLength;
    }
  } catch {}
  return {
    ok,
    session_id: sessionId,
    source,
    output_path: output,
    bytes,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note: ok
      ? "Tell the user where the file landed (output_path) and roughly how big it is. Don't read the contents."
      : "Export failed — quote the stderr plainly.",
  };
}

// ─── hermes_sessions_delete ───────────────────────────────────────────

export const deleteDefinition = {
  type: "function",
  name: "hermes_sessions_delete",
  description:
    "Permanently delete a Hermes session. ⚠️ destructive — only after the user explicitly asks. " +
    "Voice: 'delete that session', 'forget that chat', '删了那段记录'. --yes is passed automatically.",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session id to delete." },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
};

export async function runHermesSessionsDelete(args) {
  const sessionId = String(args?.session_id || "").trim();
  if (!sessionId) return { error: "missing session_id", note: "Ask the user which session id to delete." };

  const r = runHermes(["sessions", "delete", "--yes", sessionId], { timeoutMs: 10000 });
  if (r.error) return { error: r.error, code: r.code, session_id: sessionId };
  const ok = r.exitCode === 0;
  return {
    ok,
    session_id: sessionId,
    output: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note: ok
      ? "Brief, matter-of-fact: '没了~' / 'gone.' Don't over-confirm — the user asked for it."
      : "Delete failed — quote the stderr; most likely the session_id was wrong.",
  };
}

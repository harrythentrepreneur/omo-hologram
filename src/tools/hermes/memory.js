// src/tools/hermes_memory.js — voice tools for Hermes memory.
//
// `hermes memory` is a *provider-configuration* command (setup / status /
// off / reset) — it doesn't expose CRUD on individual memory entries. The
// actual "what hermes remembers about me" lives in two markdown files:
//   ~/.hermes/MEMORY.md   (auto-curated long-term notes)
//   ~/.hermes/USER.md     (user-supplied biographical facts)
// (paths discovered by src/runtimes/hermes.js::readMemoryShared)
//
// So we ship two read-only voice tools:
//   • hermes_memory_show              — pulls MEMORY.md + USER.md content
//   • hermes_memory_provider_status   — wraps `hermes memory status`
//
// CRUD on memory entries happens INSIDE a hermes chat session (the curator
// writes them autonomously); there's no CLI seam to insert one directly.

import { readMemoryShared } from "../../runtimes/hermes.js";
import { runHermes, stripAnsi } from "./_hermes_cli.js";

const MAX_CHARS = 4000;

// ─── hermes_memory_show ───────────────────────────────────────────────

export const showDefinition = {
  type: "function",
  name: "hermes_memory_show",
  description:
    "Show MY HERMES MEMORY CONTENT — reads the actual notes (~/.hermes/MEMORY.md auto-curated long-term notes + " +
    "~/.hermes/USER.md biographical facts). Use when the user asks WHAT hermes remembers about them. " +
    "Voice: 'what does hermes remember about me', '看看 hermes memory', 'show my hermes memory', " +
    "'hermes 都记了我啥', 'read me my hermes notes'. **DO NOT confuse with hermes_memory_provider_status, which shows the BACKEND CONFIG, not the content.** Returns the file contents (capped). Read-only.",
  parameters: {
    type: "object",
    properties: {
      include_user: { type: "boolean", description: "Also include USER.md. Default true." },
    },
    additionalProperties: false,
  },
};

export async function runHermesMemoryShow(args) {
  const includeUser = args?.include_user !== false;
  let shared;
  try {
    shared = readMemoryShared();
  } catch (err) {
    return {
      error: String(err?.message || err),
      code: "READ_FAILED",
      note: "Tell the user Hermes memory couldn't be read — maybe Hermes isn't set up yet.",
    };
  }
  const memory = (shared?.memory || "").slice(0, MAX_CHARS);
  const user = includeUser ? (shared?.user || "").slice(0, MAX_CHARS) : null;
  const hasAny = Boolean(memory || user);
  return {
    ok: true,
    has_any: hasAny,
    memory_path: shared?.memoryPath || null,
    user_path: shared?.userPath || null,
    memory: memory || null,
    user,
    memory_truncated: (shared?.memory || "").length > MAX_CHARS,
    user_truncated: includeUser && (shared?.user || "").length > MAX_CHARS,
    note: hasAny
      ? "Don't read the whole file — summarize 2-4 key things Hermes remembers (names, projects, preferences). " +
        "Offer 'want me to read a specific section?'"
      : "Hermes hasn't recorded anything yet — be upbeat: '她目前还没记下啥~ 多聊几次她就会开始攒了。'",
  };
}

// ─── hermes_memory_provider_status ────────────────────────────────────

export const providerStatusDefinition = {
  type: "function",
  name: "hermes_memory_provider_status",
  description:
    "Show the HERMES MEMORY PROVIDER CONFIGURATION — which external backend is wired (honcho, openviking, mem0, etc.) and whether it's healthy. " +
    "Use when the user asks about the CONFIG / PLUMBING, not the content. " +
    "Voice: 'is hermes memory connected', 'what memory provider is hermes using', 'hermes 现在用的啥 memory', 'is the memory backend healthy'. " +
    "**DO NOT confuse with hermes_memory_show, which dumps the actual remembered notes.** Read-only.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export async function runHermesMemoryProviderStatus() {
  const r = runHermes(["memory", "status"], { timeoutMs: 10000 });
  if (r.error) return { error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    output: stripAnsi(r.stdout).slice(0, 3000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Tell the user which provider is active (or 'built-in only' if none external). " +
      "If status looks unhealthy, suggest `hermes memory setup` to reconfigure.",
  };
}

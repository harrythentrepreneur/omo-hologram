// src/tools/hermes_tools.js — voice tools for per-platform tool enablement.
//
// Wraps `hermes tools <subcommand>`. CLI surface (v0.13.x):
//   • hermes tools list [--platform P]      — non-interactive
//   • hermes tools enable [--platform P] NAME [NAME ...]   — non-interactive
//   • hermes tools disable [--platform P] NAME [NAME ...]  — non-interactive
//   • hermes tools (no subcommand)          — INTERACTIVE UI (not exposed)
//   • hermes tools --summary                — DOCUMENTED as non-interactive
//        but in practice ALSO needs a TTY ("requires an interactive
//        terminal"), so we don't expose it. Call list per platform instead.
//
// Tool NAMEs are toolset slugs (e.g. 'web', 'browser', 'memory', 'spotify')
// or MCP tools in 'server:tool' notation.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_tools_list ─────────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_tools_list",
  description:
    "List Hermes toolsets and which are enabled/disabled for a given platform (cli, telegram, discord, slack, etc.). " +
    "Read-only. Voice: 'what hermes tools are enabled', 'show me hermes tools for telegram', " +
    "'which tools does hermes have on the CLI', '都有什么 hermes 工具'.",
  parameters: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        description: "Platform: cli (default), telegram, discord, slack, signal, whatsapp, etc.",
      },
    },
    additionalProperties: false,
  },
};
export async function runList(args) {
  const cmd = ["tools", "list"];
  if (args?.platform) cmd.push("--platform", String(args.platform));
  const r = runHermes(cmd, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    platform: args?.platform || "cli",
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? "Summarize in 2-3 sentences: count enabled vs disabled; call out 1-2 surprising toggles (e.g. browser off, spotify on). Don't read the whole list."
        : "Quote the error plainly.",
  };
}

// ─── hermes_tools_enable ───────────────────────────────────────────────

export const enableDefinition = {
  type: "function",
  name: "hermes_tools_enable",
  description:
    "Enable one or more Hermes toolsets on a platform. ⚠️ WRITE — request_approval first; read tool name + platform back to the user. " +
    "Built-in toolsets use plain names (e.g. 'web', 'browser', 'memory', 'spotify'). MCP tools use 'server:tool' form. " +
    "Voice: 'enable the browser tool for hermes', 'turn on memory in hermes CLI', 'enable spotify and tts on telegram', " +
    "'在 hermes 上启用 X 工具'.",
  parameters: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "Toolset name (e.g. 'web', 'browser', 'memory') or 'server:tool' for MCP. Use this OR `tools`.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Optional array of multiple toolset names to enable in one call.",
      },
      platform: {
        type: "string",
        description: "Platform: cli (default), telegram, discord, slack, signal, whatsapp, etc.",
      },
    },
    additionalProperties: false,
  },
};
export async function runEnable(args) {
  const names = collectToolNames(args);
  if (names.length === 0) {
    return { error: "missing tool name(s)", note: "Ask which toolset(s) to enable; offer hermes_tools_list to read the names." };
  }
  const cmd = ["tools", "enable"];
  if (args?.platform) cmd.push("--platform", String(args.platform));
  for (const name of names) cmd.push(name);
  const r = runHermes(cmd, { timeoutMs: 12000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    tools: names,
    platform: args?.platform || "cli",
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? `⚠️ WRITE applied: enabled ${names.join(", ")} on ${args?.platform || "cli"}. Confirm to the user; new Hermes runs will see the change.`
        : "Quote the error — Hermes may not recognize the toolset name; offer hermes_tools_list.",
  };
}

// ─── hermes_tools_disable ──────────────────────────────────────────────

export const disableDefinition = {
  type: "function",
  name: "hermes_tools_disable",
  description:
    "Disable one or more Hermes toolsets on a platform. ⚠️ WRITE — request_approval first; read tool name + platform back to the user. " +
    "Voice: 'disable the browser tool for hermes', 'turn off memory in hermes', 'disable spotify on telegram', " +
    "'在 hermes 上禁用 X 工具'.",
  parameters: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "Toolset name (e.g. 'web', 'browser', 'memory') or 'server:tool' for MCP. Use this OR `tools`.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Optional array of multiple toolset names to disable in one call.",
      },
      platform: {
        type: "string",
        description: "Platform: cli (default), telegram, discord, slack, signal, whatsapp, etc.",
      },
    },
    additionalProperties: false,
  },
};
export async function runDisable(args) {
  const names = collectToolNames(args);
  if (names.length === 0) {
    return { error: "missing tool name(s)", note: "Ask which toolset(s) to disable; offer hermes_tools_list to read the names." };
  }
  const cmd = ["tools", "disable"];
  if (args?.platform) cmd.push("--platform", String(args.platform));
  for (const name of names) cmd.push(name);
  const r = runHermes(cmd, { timeoutMs: 12000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    tools: names,
    platform: args?.platform || "cli",
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? `⚠️ WRITE applied: disabled ${names.join(", ")} on ${args?.platform || "cli"}. Confirm to the user; new Hermes runs won't load this toolset.`
        : "Quote the error — Hermes may not recognize the toolset name; offer hermes_tools_list.",
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

function collectToolNames(args) {
  const out = [];
  if (typeof args?.tool === "string" && args.tool.trim()) out.push(args.tool.trim());
  if (Array.isArray(args?.tools)) {
    for (const t of args.tools) {
      if (typeof t === "string" && t.trim()) out.push(t.trim());
    }
  }
  // De-dupe while preserving order.
  return [...new Set(out)];
}

// src/tools/hermes_mcp.js — voice tools for Hermes MCP server management.
//
// Wraps `hermes mcp <subcommand>` — Hermes can both connect to OTHER MCP
// servers (so its agents inherit more tools) AND expose itself as one. The
// subcommands we expose here are connection-management only; we deliberately
// skip `serve` (it's a long-running foreground process — not a voice action)
// and `login` is folded into `mcp_test` retry guidance.
//
// CLI surface (v0.13+):
//   serve / add / remove (rm) / list (ls) / test / configure (config) / login
//
// `configure` is interactive (TTY tool-toggle picker) — we run it with a
// closed stdin and return the rendered output so Momo can describe what's
// available, but we DO NOT attempt to drive the picker by voice. The note
// tells Momo to suggest the user run it themselves if they want to toggle
// individual tools.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_mcp_list ──────────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_mcp_list",
  description:
    "List MCP servers currently configured for Hermes. Voice: 'what MCP servers are connected', " +
    "'show me hermes mcp', 'list mcp connections', '都连了哪些 mcp'. " +
    "Read 2-3 names back and offer to test or remove any.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesMcpList() {
  const r = runHermes(["mcp", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout).slice(0, 4000);
  return {
    ok: r.exitCode === 0,
    stdout,
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Read 2-3 server names with a short note about each. If the output says 'No MCP servers configured', tell the user nothing's connected yet and offer to add one."
      : "Quote the error plainly so the user knows what went wrong.",
  };
}

// ─── hermes_mcp_add ───────────────────────────────────────────────────

export const addDefinition = {
  type: "function",
  name: "hermes_mcp_add",
  description:
    "Connect Hermes to a new MCP server. ⚠️ WRITE — request_approval first because new servers can introduce external tools. " +
    "Voice: 'connect the github mcp', 'add the stripe mcp server', '加一个 mcp'. " +
    "Provide EITHER `url` (HTTP/SSE endpoint) OR `command`+`args` (stdio), or use `preset` for a known one.",
  parameters: {
    type: "object",
    properties: {
      name:    { type: "string", description: "Server name — used as config key and in /mcp routes." },
      url:     { type: "string", description: "HTTP/SSE endpoint URL (use this OR command+args)." },
      command: { type: "string", description: "Stdio command, e.g. 'npx' (use with args)." },
      args:    { type: "array", items: { type: "string" }, description: "Arguments for the stdio command." },
      auth:    { type: "string", enum: ["oauth", "header"], description: "Auth method (HTTP servers only)." },
      preset:  { type: "string", description: "Known MCP preset name (e.g. 'github', 'stripe' if Hermes ships one)." },
      env:     { type: "array", items: { type: "string" }, description: "Env vars for stdio servers in KEY=VALUE form." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesMcpAdd(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask the user what to call this server." };

  const cli = ["mcp", "add", name];
  if (args?.url)     cli.push("--url", String(args.url));
  if (args?.command) cli.push("--command", String(args.command));
  if (Array.isArray(args?.args) && args.args.length) {
    cli.push("--args", ...args.args.map(String));
  }
  if (args?.auth)    cli.push("--auth", String(args.auth));
  if (args?.preset)  cli.push("--preset", String(args.preset));
  if (Array.isArray(args?.env) && args.env.length) {
    cli.push("--env", ...args.env.map(String));
  }

  const r = runHermes(cli, { timeoutMs: 30000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  const ok = r.exitCode === 0;
  return {
    ok,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `⚠️ WRITE done — confirm "${name}" is connected. If auth was OAuth, tell the user they may need to complete login in a browser; offer hermes_mcp_test to verify.`
      : "Add failed — quote the stderr plainly. Common causes: missing --url or --command, bad preset name, OAuth not completed.",
  };
}

// ─── hermes_mcp_remove ────────────────────────────────────────────────

export const removeDefinition = {
  type: "function",
  name: "hermes_mcp_remove",
  description:
    "Remove an MCP server connection. ⚠️ DESTRUCTIVE — request_approval first. " +
    "Voice: 'disconnect the github mcp', 'remove that mcp server', '把那个 mcp 删了'.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Server name to remove." } },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesMcpRemove(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask which server to disconnect; hermes_mcp_list reads the names." };

  const r = runHermes(["mcp", "remove", name], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  const ok = r.exitCode === 0;
  return {
    ok,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `⚠️ DESTRUCTIVE done — confirm "${name}" is disconnected. Don't make a big deal of it.`
      : "Remove failed — quote the stderr. Probably the name was wrong; offer to list configured servers.",
  };
}

// ─── hermes_mcp_test ──────────────────────────────────────────────────

export const testDefinition = {
  type: "function",
  name: "hermes_mcp_test",
  description:
    "Test the connection to a configured MCP server (read-only). Voice: 'test the github mcp', " +
    "'is the stripe mcp working', '测试一下那个 mcp'. Good for diagnosing OAuth/auth issues after `hermes_mcp_add`.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Server name to test." } },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesMcpTest(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask which server to test." };

  const r = runHermes(["mcp", "test", name], { timeoutMs: 20000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  const ok = r.exitCode === 0;
  return {
    ok,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `Tell the user "${name}" is reachable; mention how many tools it exposes if the output says so.`
      : "Connection test failed — quote the error. If it mentions auth/OAuth, suggest `hermes mcp login <name>` (no voice tool for that yet).",
  };
}

// ─── hermes_mcp_configure ─────────────────────────────────────────────

export const configureDefinition = {
  type: "function",
  name: "hermes_mcp_configure",
  description:
    "Show the tool toggle picker for an MCP server (which tools are enabled). ⚠️ The interactive picker " +
    "needs a TTY — this tool runs it with stdin closed so we just capture the rendered listing. " +
    "Voice: 'what tools does the github mcp expose', 'show me the github mcp tools'. " +
    "If the user wants to TOGGLE tools on/off, tell them to run `hermes mcp configure <name>` in a terminal themselves — we can't drive the picker by voice.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Server name to inspect." } },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesMcpConfigure(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask which server to inspect." };

  // The picker is interactive; closing stdin makes it bail after rendering
  // the tool list. We'll surface whatever text it printed.
  const r = runHermes(["mcp", "configure", name], { timeoutMs: 15000, input: "" });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  return {
    ok: r.exitCode === 0,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note:
      "Summarize which tools the server exposes (2-3 names). If the user wants to enable/disable a specific tool, " +
      "tell them they need to run `hermes mcp configure " + name + "` in a terminal — voice can't drive the picker. " +
      "Non-zero exit is expected when the picker exits early without input; treat partial stdout as informational.",
  };
}

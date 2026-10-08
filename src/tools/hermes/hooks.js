// src/tools/hermes_hooks.js — voice tools for Hermes shell-script hooks.
//
// Wraps `hermes hooks <subcommand>` — read/inspect surface only. Hooks
// are declared in ~/.hermes/config.yaml and the first-use consent
// allowlist lives in ~/.hermes/shell-hooks-allowlist.json. Editing
// hook definitions requires a text editor on the YAML file, so we
// don't expose add/edit by voice — just list, inspect-via-test,
// allowlist-revoke, and doctor.
//
// CLI surface (v0.13+):
//   list (ls) / test / revoke (remove, rm) / doctor

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_hooks_list ────────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_hooks_list",
  description:
    "List Hermes shell-script hooks (matcher, timeout, consent status). Voice: 'what hooks do I have', " +
    "'show me hermes hooks', 'list the shell hooks', '都有哪些 hook'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesHooksList() {
  const r = runHermes(["hooks", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout).slice(0, 4000);
  const empty = /no shell hooks configured/i.test(stdout);
  return {
    ok: r.exitCode === 0,
    empty,
    stdout,
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: empty
      ? "Tell the user no hooks are configured yet. Editing hooks needs a text editor on ~/.hermes/config.yaml — voice can't add them."
      : r.exitCode === 0
        ? "Read 2-3 hook names with what event they match and whether they're consented. Offer to inspect any with hermes_hooks_inspect or check health with hermes_hooks_doctor."
        : "Quote the error plainly.",
  };
}

// ─── hermes_hooks_inspect ─────────────────────────────────────────────
//
// Hermes doesn't ship a dedicated `hooks show` — `hooks test <event>` fires
// a synthetic payload through every matching hook, which doubles as the
// canonical "show me what this hook does + does it work" surface. We
// expose it under the `_inspect` name the caller asked for, with optional
// `for_tool` to scope to a specific tool matcher.

export const inspectDefinition = {
  type: "function",
  name: "hermes_hooks_inspect",
  description:
    "Fire a synthetic payload through hooks matching <event> to inspect what they'd do. " +
    "Read-only — the hook runs against a fake payload, not real tool output. " +
    "Voice: 'inspect the pre_tool_call hooks', 'check what the subagent_stop hook does', " +
    "'test fire that hook'. Optionally scope to one tool with for_tool (only relevant for pre_tool_call/post_tool_call).",
  parameters: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "Hook event name. Common: 'pre_tool_call', 'post_tool_call', 'pre_llm_call', 'subagent_stop'.",
      },
      for_tool: {
        type: "string",
        description: "Only fire hooks whose matcher matches this tool name (pre/post_tool_call only).",
      },
    },
    required: ["event"],
    additionalProperties: false,
  },
};

export async function runHermesHooksInspect(args) {
  const event = String(args?.event || "").trim();
  if (!event) return { error: "missing event", note: "Ask which event to inspect — common ones are pre_tool_call, post_tool_call, subagent_stop." };

  const cli = ["hooks", "test", event];
  if (args?.for_tool) cli.push("--for-tool", String(args.for_tool));

  const r = runHermes(cli, { timeoutMs: 20000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, event };
  return {
    ok: r.exitCode === 0,
    event,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `Summarize what each matching hook did (1 sentence per hook). Don't dump the full output.`
      : "Quote the error — maybe no hooks match that event.",
  };
}

// ─── hermes_hooks_doctor ──────────────────────────────────────────────

export const doctorDefinition = {
  type: "function",
  name: "hermes_hooks_doctor",
  description:
    "Health-check every configured Hermes hook (exec bit, allowlist, mtime drift, JSON validity, synthetic timing). " +
    "Voice: 'are the hooks healthy', 'hook doctor', 'check the hooks', '检查一下 hooks'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesHooksDoctor() {
  const r = runHermes(["hooks", "doctor"], { timeoutMs: 20000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Tell the user 'all hooks healthy' (or quote the first failure plainly). Don't read every row."
      : "Quote the error plainly — some hooks may be misconfigured.",
  };
}

// ─── hermes_hooks_revoke ──────────────────────────────────────────────

export const revokeDefinition = {
  type: "function",
  name: "hermes_hooks_revoke",
  description:
    "Revoke a command's first-use consent entries in ~/.hermes/shell-hooks-allowlist.json. " +
    "⚠️ WRITE — request_approval first. The hook will prompt for consent again on next restart. " +
    "Voice: 'revoke that hook', 'take back consent for X', '撤销那个 hook 的授权'. " +
    "Note: this does NOT remove the hook from config.yaml — that needs manual editing.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Exact command string to revoke (as declared in config.yaml)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export async function runHermesHooksRevoke(args) {
  const command = String(args?.command || "").trim();
  if (!command) return { error: "missing command", note: "Ask which command's consent to revoke — hermes_hooks_list shows the configured commands." };

  const r = runHermes(["hooks", "revoke", command], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, command };
  const ok = r.exitCode === 0;
  return {
    ok,
    command,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `⚠️ WRITE done — consent revoked. Remind the user the hook will prompt again on next Hermes restart, and this didn't remove the hook itself (config.yaml still has it).`
      : "Revoke failed — quote the stderr. Maybe the command string didn't match any allowlist entry.",
  };
}

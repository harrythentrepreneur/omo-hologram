// src/tools/hermes_config.js — voice tools for Hermes configuration.
//
// Wraps `hermes config <subcommand>`. The CLI surface (v0.13.x) is:
//   show / edit / set / path / env-path / check / migrate
//
// Notes from running `--help`:
//   • There is NO `config get` subcommand. To read a single key, the user
//     reads `config show` (or `status`). We expose `hermes_config_show`
//     and rely on Momo to extract the value the user asked about.
//   • `config set <key> <value>` works non-interactively. WRITE — gated by
//     request_approval in the persona.
//   • `config edit` opens $EDITOR — useless from a voice tool, skipped.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_config_show ────────────────────────────────────────────────

export const showDefinition = {
  type: "function",
  name: "hermes_config_show",
  description:
    "Show the current Hermes configuration — paths, API keys (set/unset), default model, max turns, " +
    "display options, terminal backend, timezone. Read-only. " +
    "Voice: 'show me hermes config', 'what's my hermes setup', '看一下 hermes 的配置', " +
    "'hermes config', 'what API keys do I have set in hermes'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runShow() {
  const r = runHermes(["config", "show"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const plain = stripAnsi(r.stdout);
  return {
    ok: r.exitCode === 0,
    stdout: plain.slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? "Summarize in 2-3 sentences: default model + provider, which API keys are set vs missing, anything unusual. Do NOT read the whole table — pick the highlights."
        : "Quote the error plainly.",
  };
}

// ─── hermes_config_path ────────────────────────────────────────────────

export const pathDefinition = {
  type: "function",
  name: "hermes_config_path",
  description:
    "Print the path to Hermes' config file (and optionally .env file). Read-only. " +
    "Voice: 'where's my hermes config', 'show me the hermes config path', 'hermes 配置文件在哪'.",
  parameters: {
    type: "object",
    properties: {
      env: { type: "boolean", description: "If true, print the .env path instead of the config.yaml path." },
    },
    additionalProperties: false,
  },
};
export async function runPath(args) {
  const cmd = args?.env ? ["config", "env-path"] : ["config", "path"];
  const r = runHermes(cmd, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 500),
    note:
      r.exitCode === 0
        ? "Read the path back to the user; offer to open it if they want to edit by hand."
        : "Quote the error plainly.",
  };
}

// ─── hermes_config_check ───────────────────────────────────────────────

export const checkDefinition = {
  type: "function",
  name: "hermes_config_check",
  description:
    "Check Hermes config for missing or outdated options (does NOT modify anything). Read-only. " +
    "Voice: 'is my hermes config up to date', 'check hermes config', 'are there missing settings'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runCheck() {
  const r = runHermes(["config", "check"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? "Tell the user if the config is healthy or if there are missing/outdated options. Offer hermes_config_migrate to apply defaults if outdated."
        : "Quote the error plainly.",
  };
}

// ─── hermes_config_set ─────────────────────────────────────────────────

export const setDefinition = {
  type: "function",
  name: "hermes_config_set",
  description:
    "Set a Hermes config value by key. ⚠️ WRITE — request_approval first; read the key+value back to the user. " +
    "Common keys: 'model' (default model id, e.g. anthropic/claude-sonnet-4.6), 'provider', 'terminal.backend', " +
    "'max_turns', 'personality'. Voice: 'set hermes default model to X', 'change hermes max turns to 80', " +
    "'把 hermes 的默认模型改成 X'. For full key list, run hermes_config_show first.",
  parameters: {
    type: "object",
    properties: {
      key:   { type: "string", description: "Config key (e.g. 'model', 'terminal.backend', 'max_turns')." },
      value: { type: "string", description: "Value to set. Strings are fine; numbers/booleans will be coerced by the CLI." },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
};
export async function runSet(args) {
  const key = String(args?.key || "").trim();
  const value = args?.value == null ? "" : String(args.value);
  if (!key) return { error: "missing config key", note: "Ask the user which config key to set; offer hermes_config_show." };
  if (!value) return { error: "missing config value", note: "Ask the user what value to set the key to." };
  const r = runHermes(["config", "set", key, value], { timeoutMs: 12000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    key,
    value,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? `⚠️ WRITE applied: config "${key}" is now "${value}". Confirm to the user; note that already-running Hermes agents may need a restart to pick up changes.`
        : "Quote the error plainly — Hermes may have rejected the key or value.",
  };
}

// src/tools/hermes_plugins.js — voice tools for Hermes plugins.
//
// Plugins are separate from skills — they extend Hermes itself, not the
// agent's per-session toolset. Subcommands available:
//   install / update / remove (rm, uninstall) / list (ls) / enable / disable

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_plugins_list ───────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_plugins_list",
  description:
    "List installed Hermes plugins. Voice: 'what plugins do I have', 'show me hermes plugins', '装了哪些插件'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runList() {
  const r = runHermes(["plugins", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    note: "Read 3-5 plugin names with a one-line note each; offer to enable/disable/remove any.",
  };
}

// ─── hermes_plugins_install ────────────────────────────────────────────

export const installDefinition = {
  type: "function",
  name: "hermes_plugins_install",
  description:
    "Install a Hermes plugin from a Git URL or owner/repo. ⚠️ WRITE — pulls third-party code. " +
    "request_approval first. Voice: 'install the X plugin', 'add the github.com/foo/bar plugin'.",
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Git URL (https://...) or owner/repo (e.g. 'foo/bar' on github).",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
};
export async function runInstall(args) {
  const source = String(args?.source || "").trim();
  if (!source) return { error: "missing plugin source", note: "Ask the user for the URL or owner/repo." };
  const r = runHermes(["plugins", "install", source], { timeoutMs: 60000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    source,
    stdout: stripAnsi(r.stdout).slice(0, 2500),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note: r.exitCode === 0
      ? `Confirm "${source}" is installed; mention it may need a hermes restart to take effect.`
      : "Quote the error — usually a git fetch failure or invalid source.",
  };
}

// ─── hermes_plugins_update ─────────────────────────────────────────────

export const updateDefinition = {
  type: "function",
  name: "hermes_plugins_update",
  description:
    "Pull latest changes for an installed Hermes plugin. Voice: 'update the X plugin', " +
    "'pull latest on plugins', '更新插件'.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Plugin name. Omit to update ALL (CLI default)." } },
    additionalProperties: false,
  },
};
export async function runUpdate(args) {
  const cmd = ["plugins", "update"];
  if (args?.name) cmd.push(String(args.name));
  const r = runHermes(cmd, { timeoutMs: 60000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 2500),
    note: r.exitCode === 0
      ? "Confirm update succeeded; if any plugins changed, note that a hermes restart may be needed."
      : "Quote the error plainly.",
  };
}

// ─── hermes_plugins_remove ─────────────────────────────────────────────

export const removeDefinition = {
  type: "function",
  name: "hermes_plugins_remove",
  description:
    "Uninstall a Hermes plugin. ⚠️ DESTRUCTIVE — request_approval first. Voice: 'remove the X plugin', " +
    "'uninstall Y'.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Plugin name." } },
    required: ["name"], additionalProperties: false,
  },
};
export async function runRemove(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing plugin name", note: "Ask which plugin to remove." };
  const r = runHermes(["plugins", "remove", name], { timeoutMs: 15000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 1500),
    note: r.exitCode === 0 ? `Confirm "${name}" uninstalled.` : "Quote the error plainly.",
  };
}

// ─── hermes_plugins_enable / disable ───────────────────────────────────

export const enableDefinition = {
  type: "function",
  name: "hermes_plugins_enable",
  description: "Enable a previously-disabled Hermes plugin. Voice: 'enable the X plugin', 'turn on Y plugin'.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
};
export async function runEnable(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing plugin name", note: "Ask which plugin to enable." };
  const r = runHermes(["plugins", "enable", name], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return { ok: r.exitCode === 0, stdout: stripAnsi(r.stdout).slice(0, 1000), note: r.exitCode === 0 ? `Confirm "${name}" enabled.` : "Quote the error plainly." };
}

export const disableDefinition = {
  type: "function",
  name: "hermes_plugins_disable",
  description:
    "Disable a Hermes plugin without removing it. Voice: 'disable the X plugin', 'turn off Y plugin', " +
    "'mute the X plugin for now'.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
};
export async function runDisable(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing plugin name", note: "Ask which plugin to disable." };
  const r = runHermes(["plugins", "disable", name], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return { ok: r.exitCode === 0, stdout: stripAnsi(r.stdout).slice(0, 1000), note: r.exitCode === 0 ? `Confirm "${name}" disabled.` : "Quote the error plainly." };
}

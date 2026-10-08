// src/tools/hermes_lifecycle.js — voice tools for Hermes version + update lifecycle.
//
// Wraps `hermes version` and `hermes update {--check, install}`. The
// uninstall subcommand is intentionally NOT exposed — too destructive for a
// voice surface.
//
// Voice contract: { ok, stdout, stderr, error?, code?, note }. Tools never
// throw — the model + persona handle approval gating.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_version ───────────────────────────────────────────────────

export const versionDefinition = {
  type: "function",
  name: "hermes_version",
  description:
    "Show installed Hermes version, project path, Python version, OpenAI SDK version, and whether an update is available. " +
    "Read-only. Voice: 'what version of hermes', 'hermes version', 'is hermes up to date', " +
    "'hermes 版本号', 'hermes 有没有更新'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesVersion() {
  const r = runHermes(["version"], { timeoutMs: 5000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout);

  // Best-effort structured extraction so Momo can narrate without parsing freeform text.
  const verMatch  = stdout.match(/Hermes Agent\s+v?(\S+)/i);
  const projMatch = stdout.match(/Project:\s*(\S+)/i);
  const pyMatch   = stdout.match(/Python:\s*(\S+)/i);
  const sdkMatch  = stdout.match(/OpenAI SDK:\s*(\S+)/i);
  const updateAvailable = /update available/i.test(stdout);

  return {
    ok: r.exitCode === 0,
    version: verMatch ? verMatch[1] : null,
    project_path: projMatch ? projMatch[1] : null,
    python: pyMatch ? pyMatch[1] : null,
    openai_sdk: sdkMatch ? sdkMatch[1] : null,
    update_available: updateAvailable,
    stdout: stdout.slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: updateAvailable
      ? "Tell the user the version + that an update is available. Offer hermes_update_install (needs approval)."
      : "Read back the version in one sentence and confirm Hermes is up to date.",
  };
}

// ─── hermes_update_check ──────────────────────────────────────────────

export const updateCheckDefinition = {
  type: "function",
  name: "hermes_update_check",
  description:
    "Check whether a Hermes update is available WITHOUT installing it (queries upstream git for new commits). " +
    "Read-only. Voice: 'check for hermes updates', 'is there a new hermes', 'any hermes updates', " +
    "'看看 hermes 有没有新版本'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesUpdateCheck() {
  const r = runHermes(["update", "--check"], { timeoutMs: 30000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout);
  const stderr = stripAnsi(r.stderr);
  const updateAvailable = /update available/i.test(stdout) || /update available/i.test(stderr);
  const upToDate = /up[- ]to[- ]date|already.*latest/i.test(stdout);
  const commitsMatch = (stdout + " " + stderr).match(/(\d+)\s+commits?\s+behind/i);

  return {
    ok: r.exitCode === 0,
    update_available: updateAvailable,
    up_to_date: upToDate && !updateAvailable,
    commits_behind: commitsMatch ? Number(commitsMatch[1]) : null,
    stdout: stdout.slice(0, 4000),
    stderr: stderr.slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: updateAvailable
      ? "Tell the user how many commits behind they are and offer to install (hermes_update_install — needs approval)."
      : "Confirm Hermes is up to date.",
  };
}

// ─── hermes_update_install ────────────────────────────────────────────

export const updateInstallDefinition = {
  type: "function",
  name: "hermes_update_install",
  description:
    "Pull the latest Hermes changes from git and reinstall dependencies. " +
    "⚠️ WRITE — modifies the installed Hermes code; request_approval first and warn the user any running Hermes processes may need a restart afterwards. " +
    "Voice: 'update hermes', 'install the hermes update', 'pull the latest hermes', '升级 hermes'. " +
    "--yes is passed automatically so the CLI doesn't hang on confirmation prompts.",
  parameters: {
    type: "object",
    properties: {
      backup: {
        type: "boolean",
        description:
          "Take a pre-update backup. Default: leave the CLI default (off, per Hermes config). Set true to force a backup, false to skip even if the config wanted one.",
      },
    },
    additionalProperties: false,
  },
};

export async function runHermesUpdateInstall(args) {
  const cli = ["update", "--yes"];
  if (args?.backup === true)  cli.push("--backup");
  if (args?.backup === false) cli.push("--no-backup");

  const r = runHermes(cli, { timeoutMs: 60000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout);
  return {
    ok: r.exitCode === 0,
    stdout: stdout.slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "⚠️ WRITE done — Hermes updated. Tell the user briefly what happened and remind them any running hermes processes (cron tick, gateway) should be restarted to pick it up."
      : "Update failed — quote the stderr plainly. Could be a network issue, a dirty working tree, or a dependency conflict. Offer to check `hermes_version` to confirm current state.",
  };
}

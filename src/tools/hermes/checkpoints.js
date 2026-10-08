// src/tools/hermes_checkpoints.js — voice tools for Hermes checkpoints.
//
// Hermes uses a shadow git repo (~/.hermes/checkpoints/) to snapshot working
// dirs BEFORE every write_file / patch / terminal call. /rollback in the TUI
// restores from one. The CLI exposes maintenance ops:
//   hermes checkpoints status   — size + per-project breakdown
//   hermes checkpoints list     — alias for status
//   hermes checkpoints prune    — drop stale / oversized projects
//   hermes checkpoints clear    — nuke the whole base (destructive)
//   hermes checkpoints clear-legacy — drop legacy-<ts>/ archives only
//
// /rollback itself only works inside the TUI — there's no CLI to restore
// a specific checkpoint. We don't fake it; the user does it in chat.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_checkpoints_list ──────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_checkpoints_list",
  description:
    "Show the Hermes checkpoint store: total disk size, project count, and per-project breakdown. " +
    "Voice: 'list checkpoints', 'how much space is hermes using', 'show me hermes checkpoints', " +
    "'hermes 的 checkpoint 占多少'.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max projects to list. Default 20." },
    },
    additionalProperties: false,
  },
};

export async function runHermesCheckpointsList(args) {
  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
  const r = runHermes(["checkpoints", "status", "--limit", String(limit)], { timeoutMs: 15000 });
  if (r.error) return { error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    limit,
    output: stripAnsi(r.stdout).slice(0, 5000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Tell the user the headline: total size + project count. Mention the biggest 1-2 projects if visible. " +
      "Offer 'want me to prune the old ones?'",
  };
}

// ─── hermes_checkpoints_prune ─────────────────────────────────────────

export const pruneDefinition = {
  type: "function",
  name: "hermes_checkpoints_prune",
  description:
    "Prune old / stale Hermes checkpoints. Drops projects whose last_touch is older than N days (default 7) " +
    "and trims oldest commits per project until the store is under max_size_mb (default 500). " +
    "Voice: 'clean up checkpoints', 'prune old checkpoints', '清一下 hermes 的 checkpoint'. " +
    "Less destructive than clear — only removes stale entries, not the active ones.",
  parameters: {
    type: "object",
    properties: {
      older_than_days: { type: "number", description: "Drop projects with last_touch older than N days. Default 7." },
      max_size_mb:     { type: "number", description: "After stale prune, trim oldest commits until total size <= this. Default 500." },
      keep_orphans:    { type: "boolean", description: "Skip deleting projects whose workdir no longer exists. Default false." },
    },
    additionalProperties: false,
  },
};

export async function runHermesCheckpointsPrune(args) {
  const cli = ["checkpoints", "prune"];
  if (args?.older_than_days != null) cli.push("--retention-days", String(args.older_than_days));
  if (args?.max_size_mb != null)     cli.push("--max-size-mb", String(args.max_size_mb));
  if (args?.keep_orphans)            cli.push("--keep-orphans");

  const r = runHermes(cli, { timeoutMs: 60000 });
  if (r.error) return { error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    output: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Tell the user how much was freed (look in the output for a 'freed N MB' line). " +
      "If nothing was pruned, say 'already pretty tidy~'.",
  };
}

// ─── hermes_checkpoints_clear ─────────────────────────────────────────

export const clearDefinition = {
  type: "function",
  name: "hermes_checkpoints_clear",
  description:
    "Delete the ENTIRE Hermes checkpoint base — all /rollback history across every project. " +
    "⚠️ destructive and irreversible — must be confirmed by the user first via request_approval. " +
    "Voice: 'nuke all checkpoints', 'wipe all hermes checkpoints', '全清掉 hermes checkpoint'. " +
    "-f is passed automatically so the CLI doesn't sit on a prompt.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export async function runHermesCheckpointsClear() {
  const r = runHermes(["checkpoints", "clear", "-f"], { timeoutMs: 30000 });
  if (r.error) return { error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    output: stripAnsi(r.stdout).slice(0, 3000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Brief, matter-of-fact: 'checkpoint store 全清了~'. Don't dramatize — the user asked. " +
      "Remind them that future write actions will start checkpointing again automatically.",
  };
}

// src/tools/hermes_backups.js — voice tools for Hermes disaster-recovery + support bundles.
//
// Wraps four Hermes CLI families:
//   • `hermes backup`        → zip ~/.hermes for safekeeping
//   • `hermes import`        → restore from a backup zip (overwrites current config)
//   • `hermes dump`          → plaintext support summary (read-only)
//   • `hermes debug share`   → upload logs/sysinfo to a paste service (data egress)
//
// Per the omo voice-tool contract every tool returns
//   { ok, stdout, stderr, error?, code?, note }
// — tools never throw. `note` is the voice-narration hint for Momo.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_backup_create ─────────────────────────────────────────────

export const createDefinition = {
  type: "function",
  name: "hermes_backup_create",
  description:
    "Create a zip backup of the entire Hermes home directory (~/.hermes — config, skills, sessions, cron, auth). " +
    "⚠️ WRITE — creates a file on disk (default: ~/hermes-backup-<timestamp>.zip). " +
    "Voice: 'back up hermes', 'snapshot my hermes config', 'save my hermes state', " +
    "'给 hermes 备份一下', '帮我备份一下 hermes 配置'.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional output path for the zip. Defaults to ~/hermes-backup-<timestamp>.zip in the user's home.",
      },
      quick: {
        type: "boolean",
        description:
          "Quick snapshot — only critical state files (config, state.db, .env, auth, cron). Faster but partial. Default false (full backup).",
      },
      label: {
        type: "string",
        description: "Optional label for the snapshot (used with quick:true).",
      },
    },
    additionalProperties: false,
  },
};

export async function runHermesBackupCreate(args) {
  const cli = ["backup"];
  if (args?.path) cli.push("--output", String(args.path));
  if (args?.quick) cli.push("--quick");
  if (args?.label) cli.push("--label", String(args.label));

  const r = runHermes(cli, { timeoutMs: 30000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const ok = r.exitCode === 0;
  return {
    ok,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: ok
      ? "⚠️ WRITE done — a backup zip was written. Read back the output path so the user knows where the file lives. Keep it short."
      : "Backup failed — quote the stderr plainly. Often a disk-space or permission issue.",
  };
}

// ─── hermes_backup_list ───────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_backup_list",
  description:
    "List existing Hermes backup zip files in the user's home directory (Hermes itself doesn't track them; we glob ~/hermes-backup-*.zip). " +
    "Voice: 'what hermes backups do I have', 'show my hermes snapshots', 'list backups', '我有几个 hermes 备份'.",
  parameters: {
    type: "object",
    properties: {
      dir: {
        type: "string",
        description: "Optional directory to scan. Defaults to the user's home dir.",
      },
    },
    additionalProperties: false,
  },
};

export async function runHermesBackupList(args) {
  const dir = args?.dir ? String(args.dir) : homedir();
  let entries = [];
  try {
    entries = readdirSync(dir)
      .filter((n) => /^hermes-backup-.*\.zip$/i.test(n))
      .map((name) => {
        const full = join(dir, name);
        let size = 0;
        let mtime = null;
        try {
          const s = statSync(full);
          size = s.size;
          mtime = new Date(s.mtimeMs).toISOString();
        } catch {}
        return { name, path: full, size_bytes: size, modified: mtime };
      })
      .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      code: "READDIR_FAILED",
      dir,
      note: "Couldn't read the backup directory — tell the user the path and ask if it should exist.",
    };
  }

  // Render a short, voice-friendly summary as stdout.
  const lines = entries.map(
    (e) => `${e.name}  ${(e.size_bytes / 1024 / 1024).toFixed(1)} MB  ${e.modified}`,
  );
  return {
    ok: true,
    dir,
    count: entries.length,
    backups: entries.slice(0, 20),
    stdout: lines.slice(0, 20).join("\n").slice(0, 4000),
    stderr: null,
    note: entries.length
      ? "Read the 1–2 most recent backup names + dates. Offer to restore the latest if the user wants."
      : "Tell the user there are no backups yet and offer hermes_backup_create.",
  };
}

// ─── hermes_backup_restore ────────────────────────────────────────────

export const restoreDefinition = {
  type: "function",
  name: "hermes_backup_restore",
  description:
    "Restore Hermes from a backup zip — extracts into ~/.hermes, overwriting current config, skills, sessions, cron. " +
    "⚠️ DESTRUCTIVE / WRITE — request_approval first and read the backup path back to the user. " +
    "Voice: 'restore that hermes backup', 'roll back hermes from the zip', '从备份恢复 hermes'. " +
    "--force is appended so it doesn't hang on stdin prompts.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the backup zip (typically from hermes_backup_list).",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export async function runHermesBackupRestore(args) {
  const path = String(args?.path || "").trim();
  if (!path) {
    return {
      ok: false,
      error: "missing path",
      note: "Ask the user which backup to restore — offer hermes_backup_list to read names.",
    };
  }
  const r = runHermes(["import", path, "--force"], { timeoutMs: 30000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const ok = r.exitCode === 0;
  return {
    ok,
    path,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: ok
      ? "⚠️ DESTRUCTIVE done — ~/.hermes was overwritten from the zip. Confirm success, then remind the user they may need to restart any running hermes processes."
      : "Restore failed — quote the stderr. Could be a corrupted zip or permission issue.",
  };
}

// ─── hermes_dump_setup ────────────────────────────────────────────────

export const dumpDefinition = {
  type: "function",
  name: "hermes_dump_setup",
  description:
    "Produce a plain-text Hermes setup summary (config, providers, integrations, key state) for support / debugging. " +
    "Read-only — nothing is uploaded. Voice: 'dump hermes setup', 'show me my hermes config summary', " +
    "'support bundle', 'what does my hermes look like', '把 hermes 配置摘要给我看下'.",
  parameters: {
    type: "object",
    properties: {
      show_keys: {
        type: "boolean",
        description:
          "Show redacted API-key prefixes (first/last 4 chars) instead of just 'set/not set'. Default false.",
      },
    },
    additionalProperties: false,
  },
};

export async function runHermesDumpSetup(args) {
  const cli = ["dump"];
  if (args?.show_keys) cli.push("--show-keys");
  const r = runHermes(cli, { timeoutMs: 15000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note:
      "Summarize the key parts in 2–3 sentences (provider, model, integrations connected). Don't read the whole dump — offer to copy it to clipboard if needed.",
  };
}

// ─── hermes_debug_logs ────────────────────────────────────────────────

export const debugDefinition = {
  type: "function",
  name: "hermes_debug_logs",
  description:
    "Generate a Hermes debug report (system info + recent logs). " +
    "⚠️ DATA EGRESS by default — uploads a redacted paste to a public paste service and returns a shareable URL. " +
    "Set upload:false to keep the report local instead (no network). " +
    "Voice: 'upload hermes logs for support', 'share my hermes debug bundle', 'help me debug hermes', " +
    "'给 hermes 工程师打包日志'. Upload path requires request_approval first.",
  parameters: {
    type: "object",
    properties: {
      upload: {
        type: "boolean",
        description:
          "true (default): upload to a paste service and print URL. false: print the report locally — no network call.",
      },
      lines: {
        type: "number",
        description: "Number of log lines per file to include (default 200).",
      },
      expire_days: {
        type: "number",
        description: "Paste expiry in days (default 7). Only applies when upload:true.",
      },
    },
    additionalProperties: false,
  },
};

export async function runHermesDebugLogs(args) {
  const upload = args?.upload !== false; // default true
  const cli = ["debug", "share"];
  if (!upload) cli.push("--local");
  if (Number.isFinite(args?.lines)) cli.push("--lines", String(Math.max(1, Math.floor(args.lines))));
  if (upload && Number.isFinite(args?.expire_days)) {
    cli.push("--expire", String(Math.max(1, Math.floor(args.expire_days))));
  }

  const r = runHermes(cli, { timeoutMs: 30000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout);
  // Try to surface a paste URL if uploaded.
  const urlMatch = upload ? stdout.match(/https?:\/\/\S+/) : null;
  return {
    ok: r.exitCode === 0,
    upload,
    paste_url: urlMatch ? urlMatch[0] : null,
    stdout: stdout.slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: upload
      ? "⚠️ DATA EGRESS done — logs were redacted then uploaded. Read the paste URL out loud (or offer to copy it). Mention that secrets were redacted before upload."
      : "Local-only debug report — quote the first line or two so the user knows it ran. Nothing was uploaded.",
  };
}

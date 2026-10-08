// src/tools/hermes_pairing.js — voice tools for Hermes DM pairing codes.
//
// `hermes pairing` manages user-authorization codes that bind external DM
// platforms (telegram / discord / slack / whatsapp) to this Hermes install.
//
// Important: the actual CLI does NOT generate codes (codes come from the
// messaging platform when a user pairs); it only:
//   list / approve <platform> <code> / revoke <platform> <user_id> / clear-pending
//
// So the omo voice surface here is: list + approve + revoke + clear-pending.
// (Not "create" — the prompt asked for a creator but the CLI doesn't expose one.)
//
// Pairing codes are credentials → approval is gated behind request_approval
// in the persona. Tools never throw; they return the standard
// { ok, stdout, stderr, error?, code?, note } shape.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

const ALLOWED_PLATFORMS = new Set(["telegram", "discord", "slack", "whatsapp"]);

// ─── hermes_pairing_list ──────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_pairing_list",
  description:
    "List pending and approved Hermes pairing entries (which DM users have paired with this Hermes install). " +
    "Read-only. Voice: 'list pairing codes', 'who has access to my hermes', 'show my hermes pairings', " +
    "'谁绑定了我的 hermes'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesPairingList() {
  const r = runHermes(["pairing", "list"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout);
  return {
    ok: r.exitCode === 0,
    stdout: stdout.slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note:
      "Tell the user how many pending vs approved entries exist. If empty, say no one has paired yet and explain pairing starts on the DM platform side (Telegram/Discord/Slack/WhatsApp), then comes here to approve.",
  };
}

// ─── hermes_pairing_approve ───────────────────────────────────────────

export const approveDefinition = {
  type: "function",
  name: "hermes_pairing_approve",
  description:
    "Approve a pending Hermes pairing code (binds an external DM account to this Hermes install). " +
    "⚠️ WRITE — pairing codes are credentials; request_approval first and read the platform + code back to the user. " +
    "Voice: 'approve that pairing code', 'let them in', 'authorize the telegram pairing', '批准那个配对码'.",
  parameters: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        description: "DM platform: telegram, discord, slack, or whatsapp.",
        enum: ["telegram", "discord", "slack", "whatsapp"],
      },
      code: {
        type: "string",
        description: "Pairing code shown by hermes_pairing_list under the pending section.",
      },
    },
    required: ["platform", "code"],
    additionalProperties: false,
  },
};

export async function runHermesPairingApprove(args) {
  const platform = String(args?.platform || "").trim().toLowerCase();
  const code = String(args?.code || "").trim();
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return {
      ok: false,
      error: "invalid platform",
      note: "Tell the user which platforms are supported: telegram, discord, slack, whatsapp.",
    };
  }
  if (!code) {
    return {
      ok: false,
      error: "missing code",
      note: "Ask the user for the pairing code (offer hermes_pairing_list to read pending entries).",
    };
  }
  const r = runHermes(["pairing", "approve", platform, code], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    platform,
    code,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `⚠️ WRITE done — pairing approved on ${platform}. Confirm the user is bound.`
      : "Approve failed — quote the stderr. The code may have expired or the platform name was off.",
  };
}

// ─── hermes_pairing_revoke ────────────────────────────────────────────

export const revokeDefinition = {
  type: "function",
  name: "hermes_pairing_revoke",
  description:
    "Revoke a Hermes pairing (kicks an external DM user off this Hermes install). " +
    "⚠️ DESTRUCTIVE — request_approval first; read the platform + user_id back. " +
    "Voice: 'revoke that telegram user', 'kick them out', 'remove the discord pairing for user X', '撤销那个绑定'.",
  parameters: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        description: "DM platform: telegram, discord, slack, or whatsapp.",
        enum: ["telegram", "discord", "slack", "whatsapp"],
      },
      user_id: {
        type: "string",
        description: "User id to revoke (shown by hermes_pairing_list under the approved section).",
      },
    },
    required: ["platform", "user_id"],
    additionalProperties: false,
  },
};

export async function runHermesPairingRevoke(args) {
  const platform = String(args?.platform || "").trim().toLowerCase();
  const userId = String(args?.user_id || "").trim();
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return {
      ok: false,
      error: "invalid platform",
      note: "Tell the user which platforms are supported: telegram, discord, slack, whatsapp.",
    };
  }
  if (!userId) {
    return {
      ok: false,
      error: "missing user_id",
      note: "Ask which user to revoke — offer hermes_pairing_list to find the id.",
    };
  }
  const r = runHermes(["pairing", "revoke", platform, userId], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    platform,
    user_id: userId,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `⚠️ DESTRUCTIVE done — ${userId} on ${platform} can no longer reach this Hermes.`
      : "Revoke failed — quote the stderr. The user_id may not match.",
  };
}

// ─── hermes_pairing_clear_pending ─────────────────────────────────────

export const clearPendingDefinition = {
  type: "function",
  name: "hermes_pairing_clear_pending",
  description:
    "Drop ALL pending Hermes pairing codes (does not affect already-approved users). " +
    "⚠️ DESTRUCTIVE — request_approval first. " +
    "Voice: 'clear pending pairings', 'wipe all the unapproved codes', 'reset pairing requests', '清空待批准的配对'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesPairingClearPending() {
  const r = runHermes(["pairing", "clear-pending"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "⚠️ DESTRUCTIVE done — pending pairing codes cleared. Already-approved users are unaffected."
      : "Clear-pending failed — quote the stderr plainly.",
  };
}

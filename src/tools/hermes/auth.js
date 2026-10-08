// src/tools/hermes_auth.js — voice tools for Hermes provider auth.
//
// Hermes pools provider credentials (multiple OpenAI keys, Anthropic keys,
// etc.) and rotates among them. Subcommands:
//   add (interactive — skip), list, remove, reset (clear exhaustion),
//   status, logout, spotify (PKCE — interactive — skip)
//
// We voice-expose the read-only / safe-write subset.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── list ─────────────────────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_auth_list",
  description:
    "List Hermes pooled credentials (provider, label, status). " +
    "Voice: 'show me hermes auth', 'list my hermes credentials', 'what providers do I have', '看看 hermes 都连了哪些'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runList() {
  const r = runHermes(["auth", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    note: "Read providers + label briefly; flag any marked exhausted/expired and offer reset.",
  };
}

// ─── status ───────────────────────────────────────────────────────────

export const statusDefinition = {
  type: "function",
  name: "hermes_auth_status",
  description:
    "Show auth status for a provider (current creds, exhaustion, last error). " +
    "Voice: 'is my anthropic auth ok', 'what's the openai status', 'check provider auth'.",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Provider name (e.g. 'anthropic', 'openai', 'nous'). Required." },
    },
    required: ["provider"],
    additionalProperties: false,
  },
};
export async function runStatus(args) {
  const provider = String(args?.provider || "").trim();
  if (!provider) return { error: "missing provider", note: "Ask the user which provider to check." };
  const r = runHermes(["auth", "status", provider], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    provider,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    note: r.exitCode === 0
      ? `Tell the user whether ${provider} auth is healthy.`
      : "Quote the error plainly.",
  };
}

// ─── remove ───────────────────────────────────────────────────────────

export const removeDefinition = {
  type: "function",
  name: "hermes_auth_remove",
  description:
    "Remove a Hermes pooled credential by index, id, or label. ⚠️ DESTRUCTIVE — request_approval first; " +
    "credentials can't be recovered, only re-added. Voice: 'remove that auth', 'delete the openai key labelled X'.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Credential reference: index (e.g. '0'), id, or label." },
    },
    required: ["ref"],
    additionalProperties: false,
  },
};
export async function runRemove(args) {
  const ref = String(args?.ref || "").trim();
  if (!ref) return { error: "missing credential ref", note: "Ask which credential to remove (offer hermes_auth_list to read labels)." };
  const r = runHermes(["auth", "remove", ref], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    ref,
    stdout: stripAnsi(r.stdout).slice(0, 1000),
    note: r.exitCode === 0 ? `Confirm "${ref}" removed.` : "Quote the error plainly.",
  };
}

// ─── reset (clear exhaustion) ─────────────────────────────────────────

export const resetDefinition = {
  type: "function",
  name: "hermes_auth_reset",
  description:
    "Clear exhaustion status for all credentials of a provider — let Hermes try them again after a rate-limit cooldown. " +
    "Voice: 'reset anthropic auth', 'unmark openai as exhausted', 'try those keys again'.",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Provider name to reset." },
    },
    required: ["provider"],
    additionalProperties: false,
  },
};
export async function runReset(args) {
  const provider = String(args?.provider || "").trim();
  if (!provider) return { error: "missing provider", note: "Ask which provider's exhaustion to clear." };
  const r = runHermes(["auth", "reset", provider], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    provider,
    stdout: stripAnsi(r.stdout).slice(0, 1000),
    note: r.exitCode === 0 ? `Confirm ${provider} keys are unmarked.` : "Quote the error plainly.",
  };
}

// ─── logout ───────────────────────────────────────────────────────────

export const logoutDefinition = {
  type: "function",
  name: "hermes_auth_logout",
  description:
    "Log out a provider and clear stored auth state. ⚠️ DESTRUCTIVE — request_approval first; " +
    "user must re-run `hermes login` afterwards. Voice: 'log out of nous', 'forget that login'.",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Provider name to log out from." },
    },
    required: ["provider"],
    additionalProperties: false,
  },
};
export async function runLogout(args) {
  const provider = String(args?.provider || "").trim();
  if (!provider) return { error: "missing provider", note: "Ask which provider to log out." };
  const r = runHermes(["auth", "logout", provider], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    provider,
    stdout: stripAnsi(r.stdout).slice(0, 1000),
    note: r.exitCode === 0
      ? `Logged out of ${provider}. Tell the user they'll need 'hermes login --provider ${provider}' in their terminal to re-auth.`
      : "Quote the error plainly.",
  };
}

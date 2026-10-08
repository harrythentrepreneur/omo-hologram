// src/tools/hermes_profile.js — voice tools for Hermes profile switching.
//
// Hermes profiles are isolated configurations (different creds, skills,
// memory, defaults). The "list / use / show" trio is the high-frequency
// surface; create/delete/rename/export/import are advanced and stay CLI-
// only for now.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_profile_list ───────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_profile_list",
  description:
    "List Hermes profiles. Voice: 'what hermes profiles do I have', '都有哪些 profile', " +
    "'list profiles', 'what's my current profile'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runList() {
  const r = runHermes(["profile", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    note:
      "Read the profile names and call out which one is current (Hermes marks it with a star or 'current'). Offer to switch if there are multiple.",
  };
}

// ─── hermes_profile_use ────────────────────────────────────────────────

export const useDefinition = {
  type: "function",
  name: "hermes_profile_use",
  description:
    "Switch the default Hermes profile (sticky — applies to all future hermes calls until changed again). " +
    "⚠️ Changes which credentials / skills / memory are active. Voice: 'switch to my work profile', " +
    "'use the side-project profile', '换到 X profile', '切回 default'.",
  parameters: {
    type: "object",
    properties: {
      profile: { type: "string", description: "Profile name. Use 'default' to revert to the built-in default." },
    },
    required: ["profile"],
    additionalProperties: false,
  },
};
export async function runUse(args) {
  const name = String(args?.profile || "").trim();
  if (!name) return { error: "missing profile name", note: "Ask which profile to switch to; offer hermes_profile_list to read names." };
  const r = runHermes(["profile", "use", name], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    profile: name,
    stdout: stripAnsi(r.stdout).slice(0, 1500),
    stderr: r.stderr ? r.stderr.slice(0, 500) : null,
    note:
      r.exitCode === 0
        ? `Confirm Hermes is now on the "${name}" profile. Remind the user that any already-running Hermes agents stay on their original profile until reaped.`
        : "Quote the error — likely the profile name doesn't exist; offer hermes_profile_list.",
  };
}

// ─── hermes_profile_show ───────────────────────────────────────────────

export const showDefinition = {
  type: "function",
  name: "hermes_profile_show",
  description:
    "Show details of a Hermes profile (paths, defaults, plugin count). Voice: 'show me my work profile', " +
    "'what's in this profile', 'profile details'. Defaults to the current profile if no name given.",
  parameters: {
    type: "object",
    properties: { profile: { type: "string", description: "Profile name. Omit for the current profile." } },
    additionalProperties: false,
  },
};
export async function runShow(args) {
  const cmd = ["profile", "show"];
  if (args?.profile) cmd.push(String(args.profile));
  const r = runHermes(cmd, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    note: "Summarize 2-3 lines: profile path, hermes-home, plugin/skill count if shown. Don't dump full config.",
  };
}

// src/tools/hermes_skills.js — voice tools for Hermes "skills".
//
// Five tools that wrap `hermes skills {search,install,list,inspect,uninstall}`.
// Skills are Hermes-only (Claude has its own /skills surface elsewhere) — the
// MOMO persona block must pick the right family based on whether the user
// said "hermes" or "claude" / nothing.
//
// install + uninstall are WRITE actions — Momo gates them behind
// request_approval per persona. The tool itself doesn't block; it trusts the
// model+persona to confirm before invoking.

import { runHermes, stripAnsi, tryJson } from "./_hermes_cli.js";

const ALLOWED_SOURCES = new Set([
  "all", "official", "skills-sh", "well-known", "github", "clawhub", "lobehub",
]);

const ALLOWED_LIST_SOURCES = new Set(["all", "hub", "builtin", "local"]);

// ─── hermes_skills_search ─────────────────────────────────────────────

export const searchDefinition = {
  type: "function",
  name: "hermes_skills_search",
  description:
    "Search Hermes skill registries (skills.sh, ClawHub, GitHub, well-known endpoints) for installable skills. " +
    "Use when the user says 'find me a skill for X', '搜一下 X 的 skill', 'are there skills for stripe', " +
    "'install a skill for github prs'. Returns top candidates — DO NOT install yet, ask which one first.",
  parameters: {
    type: "object",
    properties: {
      query:  { type: "string", description: "What to search for, e.g. 'stripe', 'github prs', 'meta ads'." },
      source: {
        type: "string",
        description: "Restrict to one registry. Default 'all'.",
        enum: ["all", "official", "skills-sh", "well-known", "github", "clawhub", "lobehub"],
      },
      limit:  { type: "number", description: "Max results (default 10)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export async function runHermesSkillsSearch(args) {
  const query = String(args?.query || "").trim();
  if (!query) return { error: "missing query", note: "Ask the user what to search for." };
  const source = args?.source && ALLOWED_SOURCES.has(args.source) ? args.source : "all";
  const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 30);

  const r = runHermes(
    ["skills", "search", query, "--source", source, "--limit", String(limit)],
    { timeoutMs: 30000 },
  );
  if (r.error) return { error: r.error, code: r.code, query };
  return {
    ok: r.exitCode === 0,
    query,
    source,
    limit,
    output: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Tell the user the top 2-3 candidates by name + a one-line description. " +
      "Don't install yet — ask which one. If the output looks empty, say 'didn't find anything — try a different keyword?'",
  };
}

// ─── hermes_skills_install ────────────────────────────────────────────

export const installDefinition = {
  type: "function",
  name: "hermes_skills_install",
  description:
    "Install a Hermes skill by identifier or URL. ⚠️ WRITE action — skills can introduce external code, " +
    "so this MUST be confirmed first via request_approval. " +
    "**ALWAYS run hermes_skills_search first if you don't have an exact identifier — never guess the identifier, and never auto-install right after a search without asking the user which candidate they meant.** " +
    "Voice: 'install that skill', 'go ahead and install X', 'install the first one'. " +
    "Pass identifier from a prior hermes_skills_search result. --yes is appended automatically.",
  parameters: {
    type: "object",
    properties: {
      identifier: { type: "string", description: "Skill identifier (e.g. 'openai/skills/skill-creator') or HTTPS URL to a SKILL.md." },
      category:   { type: "string", description: "Optional category folder to install into." },
      name:       { type: "string", description: "Optional name override (only needed when installing from a URL whose SKILL.md has no name)." },
      force:      { type: "boolean", description: "Install despite a blocked scan verdict. Default false." },
    },
    required: ["identifier"],
    additionalProperties: false,
  },
};

export async function runHermesSkillsInstall(args) {
  const identifier = String(args?.identifier || "").trim();
  if (!identifier) {
    return { error: "missing identifier", note: "Ask the user which skill — usually the name from the search results." };
  }
  const cli = ["skills", "install", identifier, "--yes"];
  if (args?.category) cli.push("--category", String(args.category));
  if (args?.name)     cli.push("--name", String(args.name));
  if (args?.force)    cli.push("--force");

  const r = runHermes(cli, { timeoutMs: 60000 });
  if (r.error) return { error: r.error, code: r.code, identifier };
  const ok = r.exitCode === 0;
  return {
    ok,
    identifier,
    output: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 2000) || null,
    exit_code: r.exitCode,
    note: ok
      ? "Confirm install succeeded, name the skill, and let the user know it's available for any future Hermes task."
      : "Install failed — quote the stderr plainly so the user knows what went wrong. If it says 'blocked' or 'scan', offer to retry with force:true after confirming.",
  };
}

// ─── hermes_skills_list ───────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_skills_list",
  description:
    "List installed Hermes skills. Voice: 'what skills do I have', 'show me hermes skills', " +
    "'我装了哪些 skill'. Read 3-5 names back with a short note and offer to inspect any specific one.",
  parameters: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Filter by source. Default 'all'.",
        enum: ["all", "hub", "builtin", "local"],
      },
      enabled_only: { type: "boolean", description: "Hide disabled skills. Default false." },
    },
    additionalProperties: false,
  },
};

export async function runHermesSkillsList(args) {
  const source = args?.source && ALLOWED_LIST_SOURCES.has(args.source) ? args.source : "all";
  const cli = ["skills", "list", "--source", source];
  if (args?.enabled_only) cli.push("--enabled-only");

  const r = runHermes(cli, { timeoutMs: 15000 });
  if (r.error) return { error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    source,
    output: stripAnsi(r.stdout).slice(0, 6000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Read 3-5 skill names with a short note about each (1 sentence). Don't dump the whole list — " +
      "summarize and offer 'want me to inspect any of these?'",
  };
}

// ─── hermes_skills_inspect ────────────────────────────────────────────

export const inspectDefinition = {
  type: "function",
  name: "hermes_skills_inspect",
  description:
    "Preview a Hermes skill without installing — shows description, capabilities, source. " +
    "Voice: 'tell me more about X skill', 'what does Y do', 'preview that skill before I install'.",
  parameters: {
    type: "object",
    properties: {
      identifier: { type: "string", description: "Skill identifier (from search results)." },
    },
    required: ["identifier"],
    additionalProperties: false,
  },
};

export async function runHermesSkillsInspect(args) {
  const identifier = String(args?.identifier || "").trim();
  if (!identifier) return { error: "missing identifier", note: "Ask the user which skill to look at." };

  const r = runHermes(["skills", "inspect", identifier], { timeoutMs: 20000 });
  if (r.error) return { error: r.error, code: r.code, identifier };
  return {
    ok: r.exitCode === 0,
    identifier,
    output: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note:
      "Summarize what the skill does in 1-2 sentences. Mention the source/author if visible. " +
      "Then ask: 'want me to install it?' (which would need request_approval).",
  };
}

// ─── hermes_skills_uninstall ──────────────────────────────────────────

export const uninstallDefinition = {
  type: "function",
  name: "hermes_skills_uninstall",
  description:
    "Remove an installed Hermes skill. ⚠️ WRITE — must be confirmed first. " +
    "Voice: 'remove X', 'uninstall the Y skill', '删了那个 skill'.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Installed skill name to remove." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesSkillsUninstall(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask the user which skill to remove." };

  const r = runHermes(["skills", "uninstall", name], { timeoutMs: 30000 });
  if (r.error) return { error: r.error, code: r.code, name };
  const ok = r.exitCode === 0;
  return {
    ok,
    name,
    output: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1000) || null,
    exit_code: r.exitCode,
    note: ok
      ? "Confirm the skill is gone — '已经撤掉啦~' / 'removed.' Don't make a big deal of it."
      : "Uninstall failed — quote the stderr plainly. Maybe the name was wrong; offer to list installed skills.",
  };
}

// Re-export tryJson so consumers can reach it through this module if needed.
export { tryJson };

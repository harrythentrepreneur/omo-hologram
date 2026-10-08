// src/tools/hermes_cron.js — voice tools for Hermes scheduled jobs.
//
// Wraps `hermes cron <subcommand>`. Lets the user schedule recurring
// agent work by voice: "every weekday at 9am, have Atlas summarize
// overnight Stripe activity", "pause that morning briefing", etc.
//
// Subcommands available on the CLI (v0.13.0):
//   list / create (add) / edit / pause / resume / run / remove (rm, delete)
//   / status / tick

import { runHermes, tryJson } from "./_hermes_cli.js";

// ─── hermes_cron_list ──────────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_cron_list",
  description:
    "List Hermes scheduled jobs (cron). Voice: 'what scheduled tasks do I have', " +
    "'show me hermes cron', 'list my recurring jobs', '都有什么定时任务'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runList() {
  const r = runHermes(["cron", "list"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const json = tryJson(r.stdout);
  return {
    ok: r.exitCode === 0,
    jobs: Array.isArray(json) ? json : null,
    stdout: r.stdout.slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1000) : null,
    note: r.exitCode === 0
      ? "Read 2-3 jobs by name + cadence; offer to pause/resume/remove."
      : "Quote the error plainly.",
  };
}

// ─── hermes_cron_create ────────────────────────────────────────────────

export const createDefinition = {
  type: "function",
  name: "hermes_cron_create",
  description:
    "Schedule a NEW RECURRING Hermes cron job (one-time creation that then runs on its schedule). ⚠️ WRITE — confirm with the user first (read the schedule + prompt back). " +
    "Use when the user wants to set up a fresh recurring task. " +
    "Voice: 'schedule Atlas to brief me on overnight Stripe every weekday at 9am', " +
    "'every Sunday at 8pm, run the weekly retrospective skill', " +
    "'每周一早上 9 点让 Atlas 把上周的 PR 总结发给我', 'set up a daily job to X'. " +
    "**NOT for triggering an EXISTING job right now — that's hermes_cron_run_now. This one CREATES the schedule.**",
  parameters: {
    type: "object",
    properties: {
      schedule: {
        type: "string",
        description:
          "Schedule expression. Examples: '30m' (every 30 min), 'every 2h', " +
          "'0 9 * * 1-5' (9am weekdays, cron syntax), 'every monday at 9am'.",
      },
      prompt: {
        type: "string",
        description:
          "The task prompt the agent runs on each tick. Make it self-contained — the cron agent has no prior chat context.",
      },
      name: { type: "string", description: "Optional human-readable job name." },
      deliver: {
        type: "string",
        description:
          "Where to deliver output. Built-ins: 'origin' (default), 'local', 'telegram', 'discord', 'signal'. Or 'platform:chat_id' for a specific channel.",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "Optional skills to attach to the job (passed as repeated --skill flags).",
      },
      workdir: { type: "string", description: "Absolute path for the job's cwd (loads AGENTS.md / CLAUDE.md from there)." },
      repeat:  { type: "integer", minimum: 1, description: "Optional max repeat count (omit = forever)." },
    },
    required: ["schedule"],
    additionalProperties: false,
  },
};
export async function runCreate(args) {
  const schedule = String(args?.schedule || "").trim();
  if (!schedule) return { error: "missing schedule", note: "Ask the user for the schedule expression." };
  const cmd = ["cron", "create", schedule];
  if (args?.prompt)  cmd.push(String(args.prompt));
  if (args?.name)    cmd.push("--name", String(args.name));
  if (args?.deliver) cmd.push("--deliver", String(args.deliver));
  if (Array.isArray(args?.skills)) {
    for (const s of args.skills) { if (s) cmd.push("--skill", String(s)); }
  }
  if (args?.workdir) cmd.push("--workdir", String(args.workdir));
  if (args?.repeat)  cmd.push("--repeat", String(args.repeat));
  const r = runHermes(cmd, { timeoutMs: 15000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout.slice(0, 2000),
    stderr: r.stderr ? r.stderr.slice(0, 1000) : null,
    schedule,
    note: r.exitCode === 0
      ? "Confirm the job is scheduled. Read the cadence back so the user knows what they signed up for."
      : "Quote the error plainly — Hermes may not have liked the schedule syntax.",
  };
}

// ─── hermes_cron_pause / resume ────────────────────────────────────────

export const pauseDefinition = {
  type: "function",
  name: "hermes_cron_pause",
  description:
    "Pause a Hermes scheduled job (it stops firing until resumed). Voice: 'pause the morning briefing', " +
    "'stop that recurring task', '暂停那个定时任务'.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Job id or name." } },
    required: ["id"], additionalProperties: false,
  },
};
export async function runPause(args) {
  const id = String(args?.id || "").trim();
  if (!id) return { error: "missing job id", note: "Ask which job to pause; offer hermes_cron_list to read names." };
  const r = runHermes(["cron", "pause", id], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return { ok: r.exitCode === 0, stdout: r.stdout.slice(0, 1000), note: r.exitCode === 0 ? `Confirm "${id}" is paused.` : "Quote the error plainly." };
}

export const resumeDefinition = {
  type: "function",
  name: "hermes_cron_resume",
  description: "Resume a paused Hermes scheduled job. Voice: 'resume the morning briefing', 'turn that one back on'.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};
export async function runResume(args) {
  const id = String(args?.id || "").trim();
  if (!id) return { error: "missing job id", note: "Ask which job to resume." };
  const r = runHermes(["cron", "resume", id], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return { ok: r.exitCode === 0, stdout: r.stdout.slice(0, 1000), note: r.exitCode === 0 ? `Confirm "${id}" is live again.` : "Quote the error plainly." };
}

// ─── hermes_cron_run (one-off) ─────────────────────────────────────────

export const runOnceDefinition = {
  type: "function",
  name: "hermes_cron_run_now",
  description:
    "Execute an ALREADY-EXISTING scheduled job RIGHT NOW (out-of-band one-off trigger, regardless of its normal schedule). Pass the job id or name. " +
    "Voice: 'run the morning briefing now', 'fire that job once', 'kick off the X cron', 'execute the briefing now'. " +
    "**NOT for creating a new schedule — that's hermes_cron_create. This one TRIGGERS an existing one.**",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};
export async function runRunNow(args) {
  const id = String(args?.id || "").trim();
  if (!id) return { error: "missing job id", note: "Ask which job to fire." };
  const r = runHermes(["cron", "run", id], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return { ok: r.exitCode === 0, stdout: r.stdout.slice(0, 1000), note: r.exitCode === 0 ? `Confirm "${id}" will fire on the next tick.` : "Quote the error plainly." };
}

// ─── hermes_cron_remove ────────────────────────────────────────────────

export const removeDefinition = {
  type: "function",
  name: "hermes_cron_remove",
  description:
    "Delete a Hermes scheduled job permanently. ⚠️ DESTRUCTIVE — request_approval first. " +
    "Voice: 'delete that cron', 'remove the morning briefing job', '把那个定时任务删了'.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
};
export async function runRemove(args) {
  const id = String(args?.id || "").trim();
  if (!id) return { error: "missing job id", note: "Ask which job to delete." };
  const r = runHermes(["cron", "remove", id], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return { ok: r.exitCode === 0, stdout: r.stdout.slice(0, 1000), note: r.exitCode === 0 ? `Confirm "${id}" deleted.` : "Quote the error plainly." };
}

// ─── hermes_cron_status ────────────────────────────────────────────────

export const statusDefinition = {
  type: "function",
  name: "hermes_cron_status",
  description:
    "Check if the Hermes cron scheduler is running. Voice: 'is the hermes scheduler running', 'cron status', 'are my crons live'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runStatus() {
  const r = runHermes(["cron", "status"], { timeoutMs: 5000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    running: /running|active|alive/i.test(r.stdout),
    stdout: r.stdout.slice(0, 1000),
    note: "Tell the user if the scheduler is running and offer to start it if not (they run `hermes cron tick` or set it up via setup wizard).",
  };
}

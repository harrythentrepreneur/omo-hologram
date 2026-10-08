// src/tools/hermes_curator.js — voice tools for the Hermes background curator.
//
// The curator is an auxiliary-model background task that periodically reviews
// agent-created skills, archives stale ones, consolidates overlaps. Wraps
// `hermes curator {status,run,pause,pin}` — bundled & hub-installed skills
// are never touched by the curator itself.
//
// Voice contract: { ok, stdout, stderr, error?, code?, note }. Tools must
// never throw.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_curator_status ────────────────────────────────────────────

export const statusDefinition = {
  type: "function",
  name: "hermes_curator_status",
  description:
    "Show Hermes curator status — whether it's enabled, runs to date, last run timestamp, interval, " +
    "and current skill counts. Read-only. " +
    "Voice: 'is the curator running', 'what is the curator doing', 'curator status', " +
    "'hermes curator 状态'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesCuratorStatus() {
  const r = runHermes(["curator", "status"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout);
  const enabled = /\bENABLED\b/i.test(stdout);
  const paused = /\bPAUSED\b/i.test(stdout);
  return {
    ok: r.exitCode === 0,
    enabled,
    paused,
    stdout: stdout.slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note:
      "Tell the user in one sentence: enabled/paused, last run, interval. Offer hermes_curator_run if they want to force a pass.",
  };
}

// ─── hermes_curator_run ───────────────────────────────────────────────

export const runDefinition = {
  type: "function",
  name: "hermes_curator_run",
  description:
    "Force the Hermes curator to do a review pass now (it would otherwise wait for its next interval). " +
    "Use dry_run:true to preview what it would change without modifying anything. " +
    "Voice: 'run the curator now', 'kick off a curator pass', 'have the curator check my skills', " +
    "'让 curator 跑一遍'.",
  parameters: {
    type: "object",
    properties: {
      dry_run: {
        type: "boolean",
        description: "Preview only — no state changes, no archives, no consolidation. Default false.",
      },
      background: {
        type: "boolean",
        description:
          "Run in a background thread and return immediately (otherwise we wait for the LLM pass to finish). Default false.",
      },
    },
    additionalProperties: false,
  },
};

export async function runHermesCuratorRun(args) {
  const cli = ["curator", "run"];
  if (args?.dry_run) cli.push("--dry-run");
  if (args?.background) cli.push("--background");
  else cli.push("--sync");
  // Sync pass can take a while — give it 60s; background returns fast.
  const timeoutMs = args?.background ? 10000 : 60000;
  const r = runHermes(cli, { timeoutMs });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    dry_run: !!args?.dry_run,
    background: !!args?.background,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Read the 1-line summary of what the curator did (or would do, for dry_run). Keep it short."
      : "Curator run failed — quote the stderr plainly.",
  };
}

// ─── hermes_curator_pause ─────────────────────────────────────────────

export const pauseDefinition = {
  type: "function",
  name: "hermes_curator_pause",
  description:
    "Pause the Hermes curator so it stops doing auto-maintenance until resumed. ⚠️ WRITE — request_approval first. " +
    "Voice: 'pause the curator', 'stop the curator from running', 'turn off curator', '暂停 curator'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesCuratorPause() {
  const r = runHermes(["curator", "pause"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "⚠️ WRITE done — curator is paused. Tell the user it won't run again until they resume."
      : "Pause failed — quote the stderr plainly.",
  };
}

// ─── hermes_curator_resume ────────────────────────────────────────────

export const resumeDefinition = {
  type: "function",
  name: "hermes_curator_resume",
  description:
    "Resume the Hermes curator after a pause. WRITE. " +
    "Voice: 'resume the curator', 'turn the curator back on', '让 curator 继续跑'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesCuratorResume() {
  const r = runHermes(["curator", "resume"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Curator is live again — confirm in one sentence."
      : "Resume failed — quote the stderr plainly.",
  };
}

// ─── hermes_curator_pin ───────────────────────────────────────────────

export const pinDefinition = {
  type: "function",
  name: "hermes_curator_pin",
  description:
    "Pin a Hermes skill so the curator never auto-transitions it (won't archive, consolidate, or prune). " +
    "⚠️ WRITE — request_approval first. Voice: 'pin the X skill', 'protect that skill from the curator', " +
    "'don't let the curator touch X', '把 X 这个 skill 固定住'.",
  parameters: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Installed skill name to pin." },
    },
    required: ["skill"],
    additionalProperties: false,
  },
};

export async function runHermesCuratorPin(args) {
  const skill = String(args?.skill || "").trim();
  if (!skill) {
    return {
      ok: false,
      error: "missing skill",
      note: "Ask the user which skill to pin — offer hermes_skills_list to read names.",
    };
  }
  const r = runHermes(["curator", "pin", skill], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    skill,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: stripAnsi(r.stderr).slice(0, 1500) || null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `⚠️ WRITE done — "${skill}" is pinned. Curator will leave it alone from now on.`
      : "Pin failed — quote the stderr plainly. Could be the skill name was wrong.",
  };
}

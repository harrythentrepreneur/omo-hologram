// src/tools/hermes_health.js — voice tools for Hermes diagnostics.
//
// Three read-only tools wrapping:
//   • `hermes status [--all] [--deep]`  — component health summary
//   • `hermes doctor [--fix] [--ack ID]` — config/dep issues (run without --fix)
//   • `hermes logs [LOG] [-n N] [--level L] [--component C] [--session S] [--since T]`
//
// We never pass `--fix` here — that's a write op the user should run in a
// terminal. We never pass `-f` (follow) — that'd hang the subprocess.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_status ─────────────────────────────────────────────────────

export const statusDefinition = {
  type: "function",
  name: "hermes_status",
  description:
    "Show Hermes component health: environment, model+provider, API key presence, auth providers, etc. Read-only. " +
    "Voice: 'is hermes ok', 'check hermes status', 'hermes 状态怎么样', 'are all hermes services up'. " +
    "Pass `deep: true` to run deeper checks (slower).",
  parameters: {
    type: "object",
    properties: {
      all:  { type: "boolean", description: "Show all details (redacted for sharing)." },
      deep: { type: "boolean", description: "Run deep checks; may take longer." },
    },
    additionalProperties: false,
  },
};
export async function runHermesStatus(args) {
  const cmd = ["status"];
  if (args?.all)  cmd.push("--all");
  if (args?.deep) cmd.push("--deep");
  const r = runHermes(cmd, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? "Summarize in 2-3 sentences: model+provider, which auth is logged in, anything missing or broken. Don't dump the full table."
        : "Quote the error plainly.",
  };
}

// ─── hermes_doctor ─────────────────────────────────────────────────────

export const doctorDefinition = {
  type: "function",
  name: "hermes_doctor",
  description:
    "Diagnose Hermes setup issues — missing dependencies, config problems, advisory banners. Read-only by default. " +
    "Voice: 'is hermes healthy', 'run hermes doctor', '诊断一下 hermes', 'what's wrong with hermes', 'check hermes setup'. " +
    "We never auto-apply fixes; if the user wants `hermes doctor --fix`, tell them to run it in a terminal.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runHermesDoctor() {
  const r = runHermes(["doctor"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? "Summarize in 2-3 sentences: healthy or not, biggest issue first, count of warnings/advisories. Offer to walk through fixes one by one (the user must run `hermes doctor --fix` in their terminal — we don't auto-apply)."
        : "Quote the error plainly.",
  };
}

// ─── hermes_logs ───────────────────────────────────────────────────────

export const logsDefinition = {
  type: "function",
  name: "hermes_logs",
  description:
    "Tail Hermes log files (agent.log default; also errors / gateway). Read-only — never follows. " +
    "Voice: 'show me hermes logs', 'what's the last error from hermes', 'tail hermes', " +
    "'show me hermes errors from the last hour', 'hermes 日志看一下'. " +
    "Filters: `log` (agent / errors / gateway / list), `lines` (default 50), `level` (DEBUG/INFO/WARNING/ERROR), " +
    "`component` (gateway/agent/tools/cli/cron), `session` (id substring), `since` (e.g. '1h', '30m', '2d').",
  parameters: {
    type: "object",
    properties: {
      log:       { type: "string", description: "Which log: 'agent' (default), 'errors', 'gateway', or 'list' to see available files." },
      lines:     { type: "integer", minimum: 1, maximum: 1000, description: "Number of lines to show (default 50)." },
      level:     { type: "string", description: "Minimum log level: DEBUG, INFO, WARNING, ERROR." },
      component: { type: "string", description: "Component filter: gateway, agent, tools, cli, cron." },
      session:   { type: "string", description: "Filter lines containing this session ID substring." },
      since:     { type: "string", description: "Show lines since TIME ago: '1h', '30m', '2d', etc." },
      // `filter` is a friendly alias the caller spec mentioned; we map it to --component.
      filter:    { type: "string", description: "Alias for `component` — kept for compatibility with voice phrasing." },
    },
    additionalProperties: false,
  },
};
export async function runHermesLogs(args) {
  const cmd = ["logs"];
  if (args?.log) cmd.push(String(args.log));
  if (Number.isInteger(args?.lines))    cmd.push("-n", String(args.lines));
  if (args?.level)                      cmd.push("--level", String(args.level));
  const comp = args?.component || args?.filter;
  if (comp)                             cmd.push("--component", String(comp));
  if (args?.session)                    cmd.push("--session", String(args.session));
  if (args?.since)                      cmd.push("--since", String(args.since));
  // Never pass -f / --follow — would hang the subprocess.
  const r = runHermes(cmd, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    log: args?.log || "agent",
    lines: args?.lines || 50,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? "Read the 1-3 most recent / most important log lines (errors first). Don't dump the whole tail — quote what matters."
        : "Quote the error plainly — the log may not exist; offer log='list' to see available files.",
  };
}

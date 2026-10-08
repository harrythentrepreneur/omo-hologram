// src/tools/hermes_insights.js — voice tool for Hermes usage analytics.
//
// Wraps `hermes insights [--days N] [--source platform]`. Lets the user
// ask "how much did I burn this week" / "what tools am I leaning on" /
// "show me hermes usage trends" by voice and get a concise summary.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

export const definition = {
  type: "function",
  name: "hermes_insights",
  description:
    "Show Hermes usage insights — token usage, costs, tool patterns, activity trends — from session history. " +
    "Voice: 'how much did I burn on hermes this week', '我这周用 hermes 花了多少', " +
    "'show me hermes usage', 'what tools am I leaning on', 'hermes cost trend'. " +
    "Default scope is 30 days; pass `days` to narrow (7 = this week, 1 = today, 30 = month).",
  parameters: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        minimum: 1,
        maximum: 365,
        description: "Number of days to analyze. Defaults to 30. Common: 1 (today), 7 (week), 30 (month).",
      },
      source: {
        type: "string",
        description: "Optional platform filter (cli, telegram, discord, etc.).",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const cmd = ["insights"];
  if (Number.isInteger(args?.days))  cmd.push("--days", String(args.days));
  if (args?.source)                  cmd.push("--source", String(args.source));
  const r = runHermes(cmd, { timeoutMs: 12000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const plain = stripAnsi(r.stdout);
  return {
    ok: r.exitCode === 0,
    days: args?.days || 30,
    source: args?.source || null,
    stdout: plain.slice(0, 6000),
    stderr: r.stderr ? r.stderr.slice(0, 800) : null,
    note:
      r.exitCode === 0
        ? "Summarize in 2-3 spoken sentences: total cost (if present), main model used, busiest day, top 1-2 tools. **Don't dump the full table.** Pick the headline + one surprising stat."
        : "Quote the error plainly.",
  };
}

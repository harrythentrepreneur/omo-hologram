// src/tools/hermes_gateway.js — voice tools for the Hermes messaging gateway.
//
// The gateway is the long-running service that bridges Hermes ↔ Telegram /
// Discord / WhatsApp. We expose status/list/start/stop/restart by voice;
// install/setup/uninstall are deliberately omitted (interactive wizards
// that don't translate well to voice).

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── status ───────────────────────────────────────────────────────────

export const statusDefinition = {
  type: "function",
  name: "hermes_gateway_status",
  description:
    "Show Hermes messaging gateway status (whether telegram/discord/whatsapp bridges are running). " +
    "Voice: 'is the hermes gateway up', 'gateway status', 'are my bots online', 'hermes 通讯网关好吗'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runStatus() {
  const r = runHermes(["gateway", "status"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const text = stripAnsi(r.stdout);
  return {
    ok: r.exitCode === 0,
    running: /running|active|started|live/i.test(text) && !/not\s+running|stopped|inactive/i.test(text),
    stdout: text.slice(0, 2500),
    note:
      r.exitCode === 0
        ? "Tell the user whether the gateway is up. If down, offer hermes_gateway_start to bring it back."
        : "Quote the error plainly.",
  };
}

// ─── list ─────────────────────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_gateway_list",
  description:
    "List all Hermes profiles and their gateway status (which bridges configured per profile). " +
    "Voice: 'show me hermes gateway profiles', 'which profiles have bots', 'gateway 都连了哪些'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runList() {
  const r = runHermes(["gateway", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    note: "Summarize 2-3 profiles with which platforms each one has wired up; offer details on any.",
  };
}

// ─── start / stop / restart ───────────────────────────────────────────

export const startDefinition = {
  type: "function",
  name: "hermes_gateway_start",
  description:
    "Start the Hermes gateway service (systemd/launchd background). ⚠️ WRITE — affects long-running services. " +
    "Voice: 'start the hermes gateway', 'bring my bots back online', '启动 hermes 网关'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runStart() {
  const r = runHermes(["gateway", "start"], { timeoutMs: 15000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 1500),
    stderr: r.stderr ? r.stderr.slice(0, 800) : null,
    note: r.exitCode === 0
      ? "Confirm the gateway started. If it errored saying 'not installed', tell the user they need `hermes gateway install` in a terminal first."
      : "Quote the error plainly.",
  };
}

export const stopDefinition = {
  type: "function",
  name: "hermes_gateway_stop",
  description:
    "Stop the Hermes gateway service (cuts telegram/discord/whatsapp bridges). " +
    "⚠️ WRITE — silences external messaging. Voice: 'stop the hermes gateway', 'pause my bots', " +
    "'shut down hermes gateway', '停掉 hermes 网关'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runStop() {
  const r = runHermes(["gateway", "stop"], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 1500),
    note: r.exitCode === 0 ? "Confirm gateway stopped; remind user that incoming messages won't reach them until restarted." : "Quote the error plainly.",
  };
}

export const restartDefinition = {
  type: "function",
  name: "hermes_gateway_restart",
  description:
    "Restart the Hermes gateway service (config-change pickup, recover from a hung bridge). " +
    "Voice: 'restart hermes gateway', 'reload the bots', 'cycle the gateway'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runRestart() {
  const r = runHermes(["gateway", "restart"], { timeoutMs: 20000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 1500),
    note: r.exitCode === 0 ? "Confirm gateway cycled successfully." : "Quote the error plainly.",
  };
}

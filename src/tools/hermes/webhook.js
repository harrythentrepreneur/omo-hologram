// src/tools/hermes_webhook.js — voice tools for Hermes dynamic webhook subscriptions.
//
// Wraps `hermes webhook <subcommand>`. Webhooks let external services
// (GitHub, Stripe, Vercel, …) POST events that activate a Hermes agent.
// They require the webhook gateway platform to be enabled in
// ~/.hermes/config.yaml — `list`/`subscribe` will tell the user how to
// turn it on if it isn't yet.
//
// CLI surface (v0.13+):
//   subscribe (add) / list (ls) / remove (rm) / test

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_webhook_list ──────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_webhook_list",
  description:
    "List Hermes webhook subscriptions. Voice: 'what webhooks do I have', 'show me hermes webhooks', " +
    "'list my webhook routes', '都订了哪些 webhook'. " +
    "If the output mentions 'webhook platform is not enabled', explain the user has to enable it in ~/.hermes/config.yaml first.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesWebhookList() {
  const r = runHermes(["webhook", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const stdout = stripAnsi(r.stdout).slice(0, 4000);
  const notEnabled = /not enabled|gateway setup/i.test(stdout);
  return {
    ok: r.exitCode === 0,
    stdout,
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    webhook_platform_enabled: !notEnabled,
    note: notEnabled
      ? "Webhook platform isn't enabled yet. Tell the user they need to run `hermes gateway setup` (or set WEBHOOK_ENABLED=true in ~/.hermes/.env) before any webhook tools work."
      : r.exitCode === 0
        ? "Read 2-3 subscription names + what they trigger. Offer to remove or test any."
        : "Quote the error plainly.",
  };
}

// ─── hermes_webhook_subscribe ─────────────────────────────────────────

export const subscribeDefinition = {
  type: "function",
  name: "hermes_webhook_subscribe",
  description:
    "Create a Hermes webhook subscription. ⚠️ WRITE — request_approval first; exposes a new POST route at /webhooks/<name>. " +
    "Voice: 'subscribe to github pr events', 'wire stripe charge.succeeded to summarize the payment', " +
    "'每次有新 github issue 就让 atlas 总结一下'. " +
    "`prompt` accepts {dot.notation} payload refs (e.g. 'New PR by {pull_request.user.login}: {pull_request.title}').",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Route name — used in the URL as /webhooks/<name>." },
      prompt: {
        type: "string",
        description:
          "Prompt template the agent runs. Use {dot.notation} to interpolate payload fields, " +
          "e.g. 'Summarize this PR: {pull_request.html_url} (by {pull_request.user.login})'.",
      },
      events: { type: "string", description: "Comma-separated event types to accept (provider-specific)." },
      description: { type: "string", description: "Optional human-readable description of what this subscription does." },
      skills: { type: "string", description: "Comma-separated skill names to load for the agent." },
      deliver: {
        type: "string",
        description:
          "Where to deliver the agent's output. Defaults to log. Common: 'log', 'telegram', 'discord', 'slack'.",
      },
      deliver_chat_id: { type: "string", description: "Target chat id for cross-platform delivery (telegram/discord/slack)." },
      secret: { type: "string", description: "HMAC secret for verifying inbound payloads. Auto-generated if omitted." },
      deliver_only: {
        type: "boolean",
        description:
          "If true, skip the agent — render the prompt template directly as a message. Zero LLM cost. Requires deliver to be a real target (not 'log').",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesWebhookSubscribe(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask what to call the webhook route." };

  const cli = ["webhook", "subscribe", name];
  if (args?.prompt)          cli.push("--prompt", String(args.prompt));
  if (args?.events)          cli.push("--events", String(args.events));
  if (args?.description)     cli.push("--description", String(args.description));
  if (args?.skills)          cli.push("--skills", String(args.skills));
  if (args?.deliver)         cli.push("--deliver", String(args.deliver));
  if (args?.deliver_chat_id) cli.push("--deliver-chat-id", String(args.deliver_chat_id));
  if (args?.secret)          cli.push("--secret", String(args.secret));
  if (args?.deliver_only)    cli.push("--deliver-only");

  const r = runHermes(cli, { timeoutMs: 15000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  const ok = r.exitCode === 0;
  return {
    ok,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `⚠️ WRITE done — confirm /webhooks/${name} is live. If the output shows an HMAC secret, tell the user to copy it into the provider's webhook config (don't read the secret out loud).`
      : "Subscribe failed — quote the stderr. If it says 'webhook platform not enabled', tell the user to run `hermes gateway setup` first.",
  };
}

// ─── hermes_webhook_remove ────────────────────────────────────────────

export const removeDefinition = {
  type: "function",
  name: "hermes_webhook_remove",
  description:
    "Remove a Hermes webhook subscription. ⚠️ DESTRUCTIVE — request_approval first. " +
    "Voice: 'remove the github webhook', 'unsubscribe from stripe', '把那个 webhook 删了'.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Subscription name to remove." } },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesWebhookRemove(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask which webhook to remove; offer hermes_webhook_list to read names." };

  const r = runHermes(["webhook", "remove", name], { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  const ok = r.exitCode === 0;
  return {
    ok,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `⚠️ DESTRUCTIVE done — confirm "${name}" is gone. Tell the user to also disable the webhook on the provider side.`
      : "Remove failed — quote the stderr. Maybe the name was wrong; offer to list active subscriptions.",
  };
}

// ─── hermes_webhook_test ──────────────────────────────────────────────

export const testDefinition = {
  type: "function",
  name: "hermes_webhook_test",
  description:
    "Send a synthetic test POST to a webhook route (read-only — just fires the agent with a fake payload). " +
    "Voice: 'test the github webhook', 'fire a test payload to that route', '测试一下那个 webhook'.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Subscription name to test." },
      payload: { type: "string", description: "Optional JSON payload string to send (default: built-in test payload)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

export async function runHermesWebhookTest(args) {
  const name = String(args?.name || "").trim();
  if (!name) return { error: "missing name", note: "Ask which webhook to test." };

  const cli = ["webhook", "test", name];
  if (args?.payload) cli.push("--payload", String(args.payload));

  const r = runHermes(cli, { timeoutMs: 20000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, name };
  return {
    ok: r.exitCode === 0,
    name,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `Confirm the test fired and quote a one-line summary of what the agent did with the payload.`
      : "Test failed — quote the stderr. Common: webhook platform not enabled, or the route name was wrong.",
  };
}

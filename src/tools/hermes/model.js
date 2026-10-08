// src/tools/hermes_model.js — voice tools for Hermes default model & fallback chain.
//
// CLI surface discovered from `--help` (v0.13.x):
//   • `hermes model` is INTERACTIVE-ONLY — opens a provider/model picker.
//     There is no `model show` / `model set` / `model list`. The default
//     model is stored in config under the `model` key.
//   • `hermes fallback {list|ls|add|remove|rm|clear}` exists, but `add`
//     and `remove` are interactive pickers (no positional args). `list`
//     and `clear` are non-interactive.
//
// What we expose by voice:
//   • hermes_model_show     — non-interactive read of the current default
//   • hermes_model_set      — non-interactive write via `config set model …`
//   • hermes_fallback_list  — list the fallback chain
//   • hermes_fallback_clear — wipe the fallback chain (destructive)
//
// What we DON'T expose (would hang in a non-TTY child process):
//   • hermes model (interactive picker) → tell the user to run it in their terminal
//   • hermes fallback add / remove (interactive pickers) → same
// hermes_model_set is the workaround for picker-free model switching.

import { runHermes, stripAnsi } from "./_hermes_cli.js";

// ─── hermes_model_show ─────────────────────────────────────────────────

export const showDefinition = {
  type: "function",
  name: "hermes_model_show",
  description:
    "Show Hermes' current default model + provider (from `hermes status`). Read-only. " +
    "Voice: 'what model is hermes on', 'what's my default hermes model', '现在 hermes 用的什么模型', " +
    "'hermes 默认模型是什么'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runShow() {
  // `hermes status` is the most concise place to read model+provider.
  const r = runHermes(["status"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const plain = stripAnsi(r.stdout);
  // Try to pull model/provider out for a tight voice line.
  const modelMatch    = plain.match(/Model:\s+([^\n]+)/);
  const providerMatch = plain.match(/Provider:\s+([^\n]+)/);
  return {
    ok: r.exitCode === 0,
    model:    modelMatch ? modelMatch[1].trim() : null,
    provider: providerMatch ? providerMatch[1].trim() : null,
    stdout: plain.slice(0, 4000),
    note:
      r.exitCode === 0
        ? "Read the model + provider in one short sentence. Skip the rest of the status table."
        : "Quote the error plainly.",
  };
}

// ─── hermes_model_set ──────────────────────────────────────────────────

export const setDefinition = {
  type: "function",
  name: "hermes_model_set",
  description:
    "Set Hermes' default model (whole profile, sticky — not per-task). ⚠️ WRITE — request_approval first; read the model back to the user. " +
    "Goes through `hermes config set model <id>` because `hermes model` itself is interactive-only. " +
    "Pass a model id like 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.4', 'google/gemini-3.1-flash'. " +
    "Optional `provider` sets the provider key separately. " +
    "Voice: 'set hermes default model to claude sonnet 4.6', 'switch hermes to gemini 3.1', " +
    "'把 hermes 的默认模型换成 X'.",
  parameters: {
    type: "object",
    properties: {
      model:    { type: "string", description: "Model id (e.g. 'anthropic/claude-sonnet-4.6')." },
      provider: { type: "string", description: "Optional provider key (e.g. 'anthropic', 'openrouter', 'openai-codex')." },
    },
    required: ["model"],
    additionalProperties: false,
  },
};
export async function runSet(args) {
  const model = String(args?.model || "").trim();
  if (!model) return { error: "missing model id", note: "Ask the user which model to switch to." };
  const r = runHermes(["config", "set", "model", model], { timeoutMs: 12000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  let providerResult = null;
  if (r.exitCode === 0 && args?.provider) {
    providerResult = runHermes(["config", "set", "provider", String(args.provider)], { timeoutMs: 12000 });
  }
  const both_ok = r.exitCode === 0 && (!providerResult || providerResult.exitCode === 0);
  return {
    ok: both_ok,
    model,
    provider: args?.provider || null,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? r.stderr.slice(0, 1000) : null,
    provider_stdout: providerResult ? stripAnsi(providerResult.stdout || "").slice(0, 1000) : null,
    provider_stderr: providerResult?.stderr ? providerResult.stderr.slice(0, 800) : null,
    note: both_ok
      ? `⚠️ WRITE applied: Hermes default model is now "${model}"${args?.provider ? ` (provider: ${args.provider})` : ""}. Note: already-running Hermes agents stay on their original model until reaped. To pick interactively with the full provider list, run \`hermes model\` in a terminal.`
      : "Quote the error — Hermes may not recognize the model id. Suggest running `hermes model` interactively in a terminal to see the live picker.",
  };
}

// ─── hermes_fallback_list ──────────────────────────────────────────────

export const fallbackListDefinition = {
  type: "function",
  name: "hermes_fallback_list",
  description:
    "List Hermes' fallback provider chain (models tried in order when the primary fails with rate-limit / overload / connection errors). " +
    "Read-only. Voice: 'what's my hermes fallback chain', 'show hermes fallbacks', '备用模型有哪些', " +
    "'list fallback providers'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runFallbackList() {
  const r = runHermes(["fallback", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const plain = stripAnsi(r.stdout);
  const empty = /no fallback providers/i.test(plain);
  return {
    ok: r.exitCode === 0,
    empty,
    stdout: plain.slice(0, 4000),
    stderr: r.stderr ? r.stderr.slice(0, 1500) : null,
    note:
      r.exitCode === 0
        ? (empty
            ? "Tell the user the fallback chain is empty and offer to set one up — but note that adding/removing fallbacks must be done in a terminal (`hermes fallback add` is an interactive picker)."
            : "Read the fallback chain in order. Mention that re-ordering or adding/removing entries requires running `hermes fallback add`/`remove` in a terminal (interactive picker).")
        : "Quote the error plainly.",
  };
}

// ─── hermes_fallback_clear ─────────────────────────────────────────────

export const fallbackClearDefinition = {
  type: "function",
  name: "hermes_fallback_clear",
  description:
    "Remove ALL entries from the Hermes fallback chain. ⚠️ WRITE / DESTRUCTIVE — request_approval first; this can't be undone except by re-adding entries one by one in a terminal. " +
    "Voice: 'clear my hermes fallback chain', 'wipe fallback providers', '把备用模型全清掉'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
export async function runFallbackClear() {
  const r = runHermes(["fallback", "clear"], { timeoutMs: 12000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? r.stderr.slice(0, 1000) : null,
    note:
      r.exitCode === 0
        ? "⚠️ DESTRUCTIVE done: fallback chain is empty. To rebuild it, the user runs `hermes fallback add` in a terminal."
        : "Quote the error plainly.",
  };
}

// ─── NOTE: Why hermes_fallback_add and hermes_fallback_remove are missing ──
//
// `hermes fallback add` and `hermes fallback remove` are INTERACTIVE-ONLY
// pickers (same UI as `hermes model`). They take no positional args and
// cannot be driven from a non-TTY subprocess — they'd hang waiting for a
// keypress and time out. Momo should tell the user to run them in their
// terminal directly if they want to add or remove individual entries.

// src/local_voice/ollama_chat.js — local Ollama chat with omo's tool registry.
//
// This is the brain of the local-voice path. The browser captures speech,
// sends transcripts here, and we run a tool-calling loop against a local
// LLM via Ollama's /api/chat. Tool calls are dispatched through the same
// in-process registry the cloud /tool endpoint uses, so every tool omo
// already exposes (orders, ads, gmail_read, spawn_agent_task, viz, …)
// works identically — no second wiring.
//
// Flow per turn:
//   1. Append the new user transcript to the running conversation.
//   2. POST messages + tool schemas to Ollama (/api/chat, stream=false).
//   3. If the assistant message contains tool_calls, execute each via
//      runTool, append the result as a role:'tool' message, and loop.
//   4. Stop when the assistant returns a message with no tool_calls.
//   5. Cap iterations so a misbehaving model can't loop forever.
//
// The shape of an Ollama assistant turn is:
//   {
//     role: "assistant",
//     content: "...",
//     tool_calls: [{ function: { name, arguments: { ... } } }]
//   }
// Note: arguments is already a parsed object (not a JSON string),
// unlike OpenAI's API. We defend against the string form anyway.

import { runTool } from "../tools/index.js";
import { TOOLS, MOMO_INSTRUCTIONS } from "./tools_for_ollama.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";
const MAX_TOOL_ITERATIONS = 8;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Run one chat turn through Ollama. Pass in the prior `messages` array
 * (or [] for a fresh conversation) plus the new user transcript.
 *
 * Returns:
 *   {
 *     ok: true,
 *     reply: "the assistant's final user-facing text",
 *     messages: [...updatedConversation],
 *     toolCalls: [{ name, args, result }],
 *     iterations: <number>,
 *   }
 *
 * On failure: { ok: false, error, messages }.
 */
export async function chatTurn({ messages = [], userText, systemOverride } = {}) {
  if (!userText || typeof userText !== "string") {
    return { ok: false, error: "userText required", messages };
  }

  // Seed the system message on the first turn. We reuse omo's existing
  // persona instructions verbatim so behaviour matches the cloud path.
  const conversation = messages.slice();
  if (conversation.length === 0 || conversation[0]?.role !== "system") {
    conversation.unshift({
      role: "system",
      content: systemOverride || MOMO_INSTRUCTIONS,
    });
  }
  conversation.push({ role: "user", content: userText });

  const toolCalls = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let res;
    try {
      res = await postChat(conversation);
    } catch (err) {
      return { ok: false, error: err.message, messages: conversation, iterations: iter };
    }
    if (!res.ok) return { ok: false, error: res.error, messages: conversation, iterations: iter };

    const msg = res.message || {};
    // Always append the assistant turn (with tool_calls if present) so
    // the next iteration's request includes the model's reasoning chain.
    conversation.push({
      role: "assistant",
      content: msg.content || "",
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      return {
        ok: true,
        reply: String(msg.content || "").trim(),
        messages: conversation,
        toolCalls,
        iterations: iter + 1,
      };
    }

    // Execute every tool call serially. Parallel would be marginally
    // faster but risks racing dataset-store writes and the event bus —
    // not worth it for a voice loop where we're dispatching 1-2 tools
    // per turn typically.
    for (const call of calls) {
      const fn = call.function || {};
      const name = String(fn.name || "").trim();
      let args = fn.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      args = args || {};

      let result;
      try {
        result = await runTool(name, args);
      } catch (err) {
        result = { error: String(err?.message || err) };
      }
      toolCalls.push({ name, args, result });

      conversation.push({
        role: "tool",
        // Ollama's chat API wants the tool name on each tool message so
        // the model can correlate. content must be a string.
        name,
        content: safeStringify(result),
      });
    }
    // Loop and ask the model what to do next given the tool results.
  }

  // We hit the iteration cap. Force a final reply by asking for a plain
  // narration of what we know so far — surface as the user-facing text.
  return {
    ok: true,
    reply: extractTrailingAssistant(conversation) || "(I ran out of steps before I had a clear answer.)",
    messages: conversation,
    toolCalls,
    iterations: MAX_TOOL_ITERATIONS,
    truncated: true,
  };
}

async function postChat(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        tools: TOOLS,
        stream: false,
        // Lower temperature than chat default — voice replies should be
        // crisp, not creative. Tool selection accuracy improves too.
        options: { temperature: 0.3 },
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { ok: false, error: `ollama ${r.status}: ${text.slice(0, 400)}` };
    }
    const json = await r.json();
    return { ok: true, message: json.message || {} };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, error: "ollama request timed out" };
    return { ok: false, error: `ollama unreachable at ${OLLAMA_URL}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function safeStringify(v) {
  try {
    if (typeof v === "string") return v;
    return JSON.stringify(v).slice(0, 8_000);
  } catch {
    return String(v).slice(0, 8_000);
  }
}

function extractTrailingAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && m.content) return String(m.content).trim();
  }
  return "";
}

export async function health() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, reason: `ollama ${r.status}` };
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name);
    const hasModel = models.some((n) => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL.split(":")[0] + ":"));
    return {
      ok: true,
      url: OLLAMA_URL,
      model: OLLAMA_MODEL,
      modelInstalled: hasModel,
      installedModels: models,
      hint: hasModel ? null : `run: ollama pull ${OLLAMA_MODEL}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `ollama unreachable at ${OLLAMA_URL}: ${err.message}`,
      hint: "install ollama (https://ollama.com) and start it, then `ollama pull " + OLLAMA_MODEL + "`",
    };
  }
}

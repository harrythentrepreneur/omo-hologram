// LLM driver for the local voice pipeline. Two backends, selected at
// session-create time via LLM_BACKEND env:
//
//   LLM_BACKEND=gemini      (default) — Gemini 2.5 Flash text mode.
//                            Requires GEMINI_API_KEY. Cheap, cloud.
//   LLM_BACKEND=mlx_omni    — local mlx-omni-server (OpenAI-compatible).
//                            Default base URL http://localhost:10240/v1.
//                            Default model is Qwen3-8B-4bit MLX
//                            (~5 GB, fits comfortably on the M3 Pro;
//                            mlx-lm has no loader for Qwen3-Omni's
//                            Talker arch yet — STT/TTS are separate).
//
// Both backends expose the same per-session interface:
//   conversation.turn(userText)         → AsyncIterable<event>
//   conversation.submitToolResult(id, …)
//
// And the same yielded event shapes:
//   { type: 'text_delta', text }
//   { type: 'tool_call', id, name, args }
//   { type: 'turn_end' }
//   { type: 'error', message }
//
// Tool-call dispatch always happens on the *browser* (mirrors Gemini
// Live's existing path), so the only thing that changes between
// backends here is how we ask the model and how we keep history.

import { GoogleGenAI } from '@google/genai';
import { GEMINI_FUNCTION_DECLARATIONS } from '../tools/index.js';
import { MOMO_INSTRUCTIONS } from '../session.js';

const BACKEND = process.env.LLM_BACKEND || 'gemini';
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite';
const MLX_MODEL = process.env.MLX_LLM_MODEL || 'mlx-community/Qwen3-8B-4bit';
const MLX_BASE_URL = process.env.MLX_OMNI_BASE_URL || 'http://localhost:10240/v1';
const MAX_TOOL_HOPS = 6;
const TURN_TIMEOUT_MS = 60_000;

// Gemini's function-decl shape is `{name, description, parameters}`.
// OpenAI's chat-completions tools shape is `{type:"function", function:{...}}`.
// The cheapest converter: wrap each declaration in the function envelope.
function geminiToOpenAITools(decls) {
  return decls.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters || { type: 'object', properties: {} },
    },
  }));
}

// Same business-snapshot splice both backends use as their grounding prompt.
export async function buildSystemInstruction() {
  const integrationDb = await import('../store/integration_db.js');
  const SOURCES = [
    { key: 'stripe', label: 'STRIPE',     order: ['balance', 'account', 'payout', 'charge', 'subscription', 'invoice', 'customer', 'product', 'dispute'], limit: 25, budget: 8000 },
    { key: 'meta',   label: 'META ADS',   order: ['account', 'insight', 'campaign', 'adset', 'ad', 'creative'], limit: 20, budget: 6000 },
    { key: 'gmail',  label: 'GMAIL',      order: ['profile', 'label', 'message'], limit: 30, budget: 8000 },
    { key: 'drive',  label: 'GOOGLE DRIVE', order: ['file'], limit: 30, budget: 2500 },
    { key: 'github', label: 'GITHUB',     order: ['repo', 'pr', 'workflow_run', 'release', 'issue', 'notification'], limit: 30, budget: 5000 },
  ];
  const sections = [];
  await Promise.all(SOURCES.map(async (s) => {
    try {
      const body = await integrationDb.plaintextBySource(s.key, { kindOrder: s.order, limitPerKind: s.limit });
      if (!body || body.startsWith('(database not configured')) return;
      let trimmed = body.trim();
      if (trimmed.length > s.budget) {
        const cut = trimmed.lastIndexOf('\n', s.budget);
        const end = cut > s.budget * 0.5 ? cut : s.budget;
        trimmed = trimmed.slice(0, end) + `\n… (truncated — ${trimmed.length - end} more chars available via hq_query)`;
      }
      sections.push(`──── ${s.label} ────\n${trimmed}`);
    } catch { /* skip */ }
  }));

  if (!sections.length) return MOMO_INSTRUCTIONS;
  const snapshot = [
    '',
    '',
    '='.repeat(72),
    '当前业务实时数据快照 (BUSINESS STATE SNAPSHOT)',
    `生成于 ${new Date().toISOString()} · 来自 /hq 的真实数据，不是 mock。`,
    '这些数字是用户业务的当前真实状态——被问到时可以直接引用，不需要再调工具。',
    '='.repeat(72),
    '',
    sections.join('\n\n'),
    '',
    '='.repeat(72),
    '快照结束 · 以上就是你知道的全部业务状态。',
    '='.repeat(72),
  ].join('\n');
  return MOMO_INSTRUCTIONS + snapshot;
}

// ─── Gemini backend ──────────────────────────────────────────────────
function createGeminiConversation({ systemInstruction }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing — required for LLM_BACKEND=gemini');
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const tools = GEMINI_FUNCTION_DECLARATIONS.length
    ? [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }]
    : undefined;

  const contents = [];
  const pendingResults = new Map();

  function submitToolResult(callId, result) {
    const r = pendingResults.get(callId);
    if (r) { pendingResults.delete(callId); r(result); }
  }

  async function* turn(userText, { signal } = {}) {
    if (userText) contents.push({ role: 'user', parts: [{ text: userText }] });
    const turnDeadline = Date.now() + TURN_TIMEOUT_MS;

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      if (signal?.aborted) { yield { type: 'error', message: 'aborted' }; return; }
      if (Date.now() > turnDeadline) { yield { type: 'error', message: 'turn timeout' }; return; }

      let stream;
      try {
        stream = await ai.models.generateContentStream({
          model: TEXT_MODEL,
          contents,
          config: { systemInstruction, tools, thinkingConfig: { thinkingBudget: 0 } },
        });
      } catch (err) { yield { type: 'error', message: String(err?.message || err) }; return; }

      const collectedText = [];
      const collectedCalls = [];
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) return;
          const parts = chunk?.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (typeof part.text === 'string' && part.text) {
              collectedText.push(part.text);
              yield { type: 'text_delta', text: part.text };
            }
            if (part.functionCall) collectedCalls.push(part.functionCall);
          }
        }
      } catch (err) { yield { type: 'error', message: String(err?.message || err) }; return; }

      const modelParts = [];
      if (collectedText.length) modelParts.push({ text: collectedText.join('') });
      for (const c of collectedCalls) modelParts.push({ functionCall: c });
      if (modelParts.length) contents.push({ role: 'model', parts: modelParts });

      if (collectedCalls.length === 0) { yield { type: 'turn_end' }; return; }

      const responseParts = [];
      for (const call of collectedCalls) {
        const callId = call.id || `tc_${Math.random().toString(36).slice(2, 10)}`;
        const resultPromise = new Promise((resolve) => pendingResults.set(callId, resolve));
        yield { type: 'tool_call', id: callId, name: call.name, args: call.args || {} };
        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`tool ${call.name} timed out`)), 30_000)),
        ]).catch((err) => ({ error: String(err?.message || err) }));
        responseParts.push({ functionResponse: { id: call.id, name: call.name, response: { result: typeof result === 'object' ? result : { value: result } } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
    yield { type: 'error', message: 'tool-call hop limit hit' };
  }

  return { turn, submitToolResult, contents };
}

// ─── mlx-omni-server (OpenAI-compatible) backend ─────────────────────
function createMlxOmniConversation({ systemInstruction }) {
  const tools = geminiToOpenAITools(GEMINI_FUNCTION_DECLARATIONS);

  // OpenAI-style message list. System prompt is a single role:'system'
  // message at index 0 — the model sees it on every request.
  // `/no_think` suppresses Qwen3's reasoning block so we don't stream
  // <think>…</think> into the TTS pipeline. Harmless on other models.
  const messages = [{ role: 'system', content: systemInstruction + '\n/no_think' }];
  const pendingResults = new Map();

  function submitToolResult(callId, result) {
    const r = pendingResults.get(callId);
    if (r) { pendingResults.delete(callId); r(result); }
  }

  async function chatRequest(signal) {
    const res = await fetch(`${MLX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MLX_MODEL,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        // Streaming gives us text-deltas earlier so TTS can pipeline.
        // mlx-omni-server emits the OpenAI SSE format.
        stream: true,
        // Cap tokens to keep the model from rambling — Momo's reply
        // fits well under this budget.
        max_tokens: 1024,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const errText = res.body ? await res.text() : `${res.status}`;
      throw new Error(`mlx-omni ${res.status}: ${errText.slice(0, 300)}`);
    }
    return res;
  }

  // Parse a single SSE event line ("data: {...}" or "data: [DONE]"). Returns
  // null for keepalives or terminal markers.
  function parseSseLine(line) {
    if (!line.startsWith('data:')) return null;
    const body = line.slice(5).trim();
    if (!body || body === '[DONE]') return null;
    try { return JSON.parse(body); } catch { return null; }
  }

  async function* streamCompletion(signal) {
    const res = await chatRequest(signal);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Streaming tool calls arrive in pieces — `tool_calls[].function.arguments`
    // is concatenated chunk by chunk. We accumulate per-index and emit
    // once the run completes.
    const accumulated = new Map();   // index → { id, name, args }
    let toolPhase = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const evt = parseSseLine(line);
        if (!evt) continue;
        const delta = evt.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          yield { kind: 'text', text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          toolPhase = true;
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const slot = accumulated.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
            accumulated.set(idx, slot);
          }
        }
      }
    }

    if (toolPhase && accumulated.size) {
      const finished = [...accumulated.values()].filter((s) => s.name);
      yield { kind: 'tool_calls', calls: finished };
    } else {
      yield { kind: 'done' };
    }
  }

  async function* turn(userText, { signal } = {}) {
    if (userText) messages.push({ role: 'user', content: userText });
    const turnDeadline = Date.now() + TURN_TIMEOUT_MS;

    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      if (signal?.aborted) { yield { type: 'error', message: 'aborted' }; return; }
      if (Date.now() > turnDeadline) { yield { type: 'error', message: 'turn timeout' }; return; }

      let textBuf = '';
      let calls = null;
      // Qwen3 emits <think>…</think> blocks before the user-visible reply
      // unless /no_think is in the system prompt. Even with /no_think it
      // sometimes still emits an empty pair. Skip everything inside the
      // tags so TTS only sees user-visible text.
      let inThink = false;
      let pendingTag = '';
      try {
        for await (const ev of streamCompletion(signal)) {
          if (ev.kind === 'text') {
            textBuf += ev.text;
            let s = pendingTag + ev.text;
            pendingTag = '';
            let out = '';
            while (s.length) {
              if (inThink) {
                const close = s.indexOf('</think>');
                if (close === -1) { s = ''; break; }
                s = s.slice(close + '</think>'.length);
                inThink = false;
              } else {
                const open = s.indexOf('<think>');
                if (open === -1) {
                  // could be a partial tag at end of buffer; hold it
                  const tail = s.slice(-7);
                  if (tail.length && '<think>'.startsWith(tail)) {
                    out += s.slice(0, s.length - tail.length);
                    pendingTag = tail;
                  } else {
                    out += s;
                  }
                  s = '';
                } else {
                  out += s.slice(0, open);
                  s = s.slice(open + '<think>'.length);
                  inThink = true;
                }
              }
            }
            if (out) yield { type: 'text_delta', text: out };
          } else if (ev.kind === 'tool_calls') {
            calls = ev.calls;
          } else if (ev.kind === 'done') {
            // pure text turn
          }
        }
      } catch (err) { yield { type: 'error', message: String(err?.message || err) }; return; }

      // Persist what the assistant produced this hop.
      const asstMsg = { role: 'assistant', content: textBuf || '' };
      if (calls && calls.length) {
        asstMsg.tool_calls = calls.map((c) => ({
          id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        }));
      }
      messages.push(asstMsg);

      if (!calls || !calls.length) { yield { type: 'turn_end' }; return; }

      // Dispatch each tool call to the browser, collect results.
      for (const call of asstMsg.tool_calls) {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch {}
        const resultPromise = new Promise((resolve) => pendingResults.set(call.id, resolve));
        yield { type: 'tool_call', id: call.id, name: call.function.name, args: parsedArgs };
        const result = await Promise.race([
          resultPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`tool ${call.function.name} timed out`)), 30_000)),
        ]).catch((err) => ({ error: String(err?.message || err) }));
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
      // continue loop — model now has tool results, will produce text or more calls.
    }
    yield { type: 'error', message: 'tool-call hop limit hit' };
  }

  return { turn, submitToolResult, messages };
}

export function createConversation({ systemInstruction }) {
  if (BACKEND === 'mlx_omni') return createMlxOmniConversation({ systemInstruction });
  return createGeminiConversation({ systemInstruction });
}

export const LLM_BACKEND_INFO = {
  backend: BACKEND,
  model: BACKEND === 'mlx_omni' ? MLX_MODEL : TEXT_MODEL,
  base_url: BACKEND === 'mlx_omni' ? MLX_BASE_URL : null,
};

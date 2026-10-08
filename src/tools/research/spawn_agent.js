// spawn_research_agent — Momo's "send a tiny character running off to find
// out" tool. Runs a small Gemini loop INSIDE this process, exposes hq_query + web_search as
// tools to it, and broadcasts agent:started / agent:complete / agent:error
// events onto dataCore's bus so the visual layer can animate the dispatch.
//
// v1 is synchronous: Momo waits up to 30s (3 tool iterations max) and gets
// the finding back in a single tool return. The events are still fired so
// /omo/ws consumers see the dispatch + completion regardless.

import { GoogleGenAI } from '@google/genai';
import { randomBytes } from 'node:crypto';
import * as dc from '../../data_core.js';
import * as datasets from '../../store/datasets.js';
import * as hqQuery from './hq_query.js';
import * as webSearch from './web_search.js';

const MODEL = process.env.GEMINI_MODEL_AGENT
  || process.env.GEMINI_MODEL
  || 'gemini-3.1-flash-lite';
const MAX_ITERATIONS = 3;
const TOTAL_TIMEOUT_MS = 30_000;

function makeAgentId() {
  return 'ra_' + randomBytes(3).toString('hex');
}

function broadcast(event) {
  // dataCore.emit inserts into the ring AND fans out over /omo/ws, so
  // the visual layer can pick up agent lifecycle without new plumbing.
  dc.emit({
    id: `agent_${randomBytes(6).toString('hex')}`,
    source: 'agents',
    kind: event.type,
    ts: event.ts || Date.now(),
    title: event.title || event.type,
    summary: event.summary || '',
    data: event,
  });
}

// Gemini function declarations — strip the OpenAI `type:'function'` wrapper.
function asGeminiDecl(def) {
  const { type, ...rest } = def;
  return rest;
}

// Compact "what is this tool call looking for?" string derived from the
// tool arguments. Keeps the client-side squad label short and human.
// Kept separate from the dispatcher so the formatting lives next to the
// broadcaster rather than leaking into unrelated code paths.
function summariseToolArgs(name, args) {
  try {
    const a = args || {};
    if (name === 'hq_query') {
      const src = a.source ? String(a.source) : '';
      const q = a.question || a.query || '';
      const both = src ? `${src}:${q}` : q;
      return truncateText(both || 'hq query', 60);
    }
    return truncateText(name || 'tool', 60);
  } catch {
    return truncateText(name || 'tool', 60);
  }
}

// Compact summary of a tool result for the agent:tool_end payload. Picks
// the most informative single field we can find without leaking data.
function summariseToolResult(name, result) {
  if (!result || typeof result !== 'object') return truncateText(String(result || 'ok'), 60);
  if (result.error) return truncateText(String(result.error), 60);
  const candidates = [result.summary, result.title, result.name, result.count, result.id, result.message];
  for (const c of candidates) {
    if (c != null && c !== '') return truncateText(typeof c === 'number' ? String(c) : String(c), 60);
  }
  return 'ok';
}

function truncateText(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Dispatch a function_call from the sub-agent. Keep the surface tight —
// only hq_query + web_search are exposed; anything else is a soft error
// so the model picks a different path.
async function dispatch(name, args) {
  if (name === 'hq_query') return hqQuery.run(args || {});
  if (name === 'web_search') return webSearch.run(args || {});
  return { error: `tool "${name}" not available to research agent` };
}

export const definition = {
  type: 'function',
  name: 'spawn_research_agent',
  description:
    "Dispatch a background research sub-agent that can query /hq event streams and search the web. Use for factual lookups you don't already have cached — e.g. 'is there news about X?' or 'what did we hear from Sarah about the launch?'. Returns the agent's 2-3 sentence finding plus any dataset ids it produced. Synchronous, ~30s max. The visual layer animates a tiny character running off and back.",
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'One-sentence description of what to find out. The sub-agent receives this verbatim.',
      },
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['hq', 'web'] },
        description:
          "Which tools to expose. Default ['hq','web']. Drop 'web' if you only want internal data, drop 'hq' for pure external research.",
      },
      urgency: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Hint the agent picks up on; does not change the budget.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const task = String(args.task || '').trim();
  const agentId = makeAgentId();
  const startTs = Date.now();

  if (!task) {
    return { agent_id: agentId, task: '', status: 'error', error: 'task is required', duration_ms: 0 };
  }

  const sources = Array.isArray(args.sources) && args.sources.length
    ? args.sources.filter((s) => s === 'hq' || s === 'web')
    : ['hq', 'web'];
  const urgency = ['low', 'normal', 'high'].includes(args.urgency) ? args.urgency : 'normal';

  broadcast({
    type: 'agent:started',
    agent_id: agentId,
    task,
    sources,
    urgency,
    ts: startTs,
    title: 'research agent dispatched',
    summary: task.slice(0, 140),
  });

  if (!process.env.GEMINI_API_KEY) {
    const duration_ms = Date.now() - startTs;
    broadcast({
      type: 'agent:error',
      agent_id: agentId,
      error: 'GEMINI_API_KEY not set',
      duration_ms,
      ts: Date.now(),
      title: 'research agent error',
      summary: 'GEMINI_API_KEY not set',
    });
    return {
      agent_id: agentId,
      task,
      status: 'error',
      error: 'GEMINI_API_KEY not set',
      duration_ms,
    };
  }

  // Assemble the tool belt based on requested sources.
  const decls = [];
  if (sources.includes('hq')) decls.push(asGeminiDecl(hqQuery.definition));
  if (sources.includes('web')) decls.push(asGeminiDecl(webSearch.definition));

  const systemInstruction =
    "You're a research sub-agent for Momo. Use hq_query for internal data (emails, Stripe, Meta, transcripts) and web_search for external facts. Loop up to 3 tool calls, then reply with a 2-3 sentence finding plus an optional bullet list of sources/data_refs. Be concise; Momo will narrate to the user. If you can't answer, say so plainly. Reply in the SAME LANGUAGE the user wrote the task in — if the task is in English, reply in English; if it's in Simplified Chinese, reply in Simplified Chinese. Never switch languages on the user.";

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const contents = [{ role: 'user', parts: [{ text: task }] }];
  const dataset_refs = [];

  // Global deadline across the whole loop.
  const deadline = startTs + TOTAL_TIMEOUT_MS;

  let findings = null;
  let lastErr = null;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { lastErr = 'timeout'; break; }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let resp;
      try {
        resp = await ai.models.generateContent({
          model: MODEL,
          contents,
          config: {
            systemInstruction,
            tools: decls.length ? [{ functionDeclarations: decls }] : undefined,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
      } catch (err) {
        lastErr = String(err?.message || err);
        break;
      } finally {
        clearTimeout(timer);
      }

      // Pull function calls (if any) from the response.
      const candidate = resp?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const textPart = parts
        .filter((p) => typeof p.text === 'string' && p.text)
        .map((p) => p.text)
        .join('\n')
        .trim();

      if (calls.length === 0) {
        // Model returned prose — finish.
        findings = textPart || resp?.text || '(no content)';
        break;
      }

      // Push the model's assistant turn (function calls) then each tool response.
      contents.push({ role: 'model', parts: calls.map((c) => ({ functionCall: c })) });

      for (const call of calls) {
        const name = call.name;
        const callArgs = call.args || {};
        // Per-tool lifecycle broadcast so the client-side squad layer
        // can drive the right scout for each sub-agent tool invocation.
        // Fire-and-forget: additive events; existing agent:* shapes
        // are untouched.
        const toolStartTs = Date.now();
        const querySummary = summariseToolArgs(name, callArgs);
        broadcast({
          type: 'agent:tool_start',
          agent_id: agentId,
          tool_name: name,
          query_summary: querySummary,
          ts: toolStartTs,
          title: `agent ${name}`,
          summary: querySummary,
        });
        let result;
        let toolOk = true;
        try {
          result = await dispatch(name, callArgs);
          if (result && typeof result === 'object' && result.error) toolOk = false;
        } catch (err) {
          result = { error: String(err?.message || err) };
          toolOk = false;
        }
        const toolDurationMs = Date.now() - toolStartTs;
        broadcast({
          type: 'agent:tool_end',
          agent_id: agentId,
          tool_name: name,
          ok: toolOk,
          summary: summariseToolResult(name, result),
          duration_ms: toolDurationMs,
          ts: Date.now(),
          title: `agent ${name} ${toolOk ? 'done' : 'fail'}`,
          summary_text: summariseToolResult(name, result),
        });
        if (result && typeof result === 'object' && typeof result.id === 'string') {
          dataset_refs.push(result.id);
        }
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: result && typeof result === 'object' ? result : { result },
            },
          }],
        });
      }
    }
  } catch (err) {
    lastErr = String(err?.message || err);
  }

  const duration_ms = Date.now() - startTs;

  if (!findings) {
    broadcast({
      type: 'agent:error',
      agent_id: agentId,
      error: lastErr || 'no findings produced',
      duration_ms,
      ts: Date.now(),
      title: 'research agent error',
      summary: (lastErr || 'no findings produced').slice(0, 140),
    });
    return {
      agent_id: agentId,
      task,
      status: 'error',
      error: lastErr || 'no findings produced',
      duration_ms,
      dataset_refs,
    };
  }

  // Store the finding as a dataset so Momo can render it as a report card.
  const findingsId = datasets.put('research_finding', {
    task,
    agent_id: agentId,
    findings,
    dataset_refs,
    duration_ms,
  });

  broadcast({
    type: 'agent:complete',
    agent_id: agentId,
    task,
    findings,
    dataset_refs,
    findings_id: findingsId,
    duration_ms,
    ts: Date.now(),
    title: 'research agent complete',
    summary: String(findings).slice(0, 140),
  });

  return {
    agent_id: agentId,
    task,
    status: 'complete',
    findings,
    findings_id: findingsId,
    dataset_refs,
    duration_ms,
  };
}

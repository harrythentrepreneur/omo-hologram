// Text-mode chat for omo — same persona, same tool registry, same `/tool`
// dispatcher as the voice path, but driven by Gemini Flash text generation
// instead of the (more expensive) Gemini Live audio model. Useful for cheap
// dev/testing without the cost of speech-to-speech.
//
// Flow per /text/chat POST:
//   1. Append user text to in-memory conversation (keyed by sid).
//   2. Loop generateContent with the full tool belt, dispatching each
//      function_call through runTool() (the same dispatcher /tool uses).
//   3. Collect tool results into an events[] array so the frontend can
//      mount viz iframes / panes / status cards inline, mirroring the
//      side-effect handling in public/holo_cylinder.html.
//   4. Return { text, events } once the model produces prose with no
//      further tool calls (or the iteration cap is hit).
//
// Conversation state is in-memory only; this is a testing surface, not a
// persistence layer. TTL-evicted to keep the map bounded.
//
// Cost note: defaults to gemini-3.1-flash-lite (matches GEMINI_MODEL_AGENT).
// Override via TEXT_CHAT_MODEL if you want a different tier.

import { GoogleGenAI } from '@google/genai';
import { randomBytes } from 'node:crypto';
import { GEMINI_FUNCTION_DECLARATIONS, runTool } from './tools/index.js';
import { MOMO_INSTRUCTIONS } from './session.js';

const MODEL = process.env.TEXT_CHAT_MODEL
  || process.env.GEMINI_MODEL_AGENT
  || 'gemini-3.1-flash-lite';
const MAX_ITERATIONS = 8;
const ITERATION_TIMEOUT_MS = 30_000;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 200;

// TTS — Fish Audio. Multilingual (zh/en/ja/ko handled by speech-1.5+),
// ~10× cheaper per char than Gemini preview-tts on the speech-1.5 tier.
// Per-language voice IDs come from fish.audio/voice. /text/speak picks
// FISH_VOICE_ID_ZH for CJK input and FISH_VOICE_ID_EN otherwise; falls
// back to FISH_VOICE_ID, then the model default.
// FISH_MODEL: speech-1.5 | s1-mini | s1 (best, pricier).
const FISH_API_BASE = process.env.FISH_API_BASE || 'https://api.fish.audio';
const FISH_MODEL = process.env.FISH_MODEL || 'speech-1.5';
const FISH_VOICE_ID = process.env.FISH_VOICE_ID || '';
const FISH_VOICE_ID_EN = process.env.FISH_VOICE_ID_EN || '';
const FISH_VOICE_ID_ZH = process.env.FISH_VOICE_ID_ZH || '';

// CJK range — Han + Hiragana + Katakana + Hangul. Any CJK char in the
// reply flips us to the ZH voice.
function hasCJK(text) {
  return /[　-鿿가-힯＀-￯]/.test(text);
}
function pickFishVoice(text, override) {
  if (override) return override;
  if (hasCJK(text)) return FISH_VOICE_ID_ZH || FISH_VOICE_ID || '';
  return FISH_VOICE_ID_EN || FISH_VOICE_ID || '';
}

// sid -> { contents: [...turns], updatedAt }
const sessions = new Map();

function gcSessions() {
  const now = Date.now();
  for (const [sid, sess] of sessions) {
    if (now - sess.updatedAt > SESSION_TTL_MS) sessions.delete(sid);
  }
  if (sessions.size > MAX_SESSIONS) {
    // Evict oldest first.
    const entries = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const drop = entries.slice(0, sessions.size - MAX_SESSIONS);
    for (const [sid] of drop) sessions.delete(sid);
  }
}

function getSession(sid) {
  let sess = sessions.get(sid);
  if (!sess) {
    sess = { contents: [], updatedAt: Date.now() };
    sessions.set(sid, sess);
  }
  return sess;
}

function newSid() {
  return 'txt_' + randomBytes(6).toString('hex');
}

// Translate a tool result into a side-effect hint the browser can act on
// (mount a viz iframe, mount a pane, etc.). Mirrors the tool-name switch
// in public/holo_cylinder.html::handleFunctionCall.
function eventFromTool(name, result) {
  if (!result || typeof result !== 'object') return null;
  if (result.error) return { kind: 'tool_error', name, error: String(result.error) };

  if (name === 'render_viz' && result.viz_id) {
    return {
      kind: 'viz',
      viz_id: result.viz_id,
      size: result.size || 'wide',
      width: result.width,
      height: result.height,
      chart_type: result.chart_type,
    };
  }
  if (name === 'dismiss_viz' && result.ok) {
    return { kind: 'viz_dismiss', viz_id: result.viz_id || null };
  }
  if (name === 'show_pane' && result.ok) {
    return {
      kind: 'pane',
      url: result.url,
      title: result.title,
      page: result.page,
      slot: result.slot,
      view: result.view,
    };
  }
  if (name === 'dismiss_pane' && result.ok) {
    return { kind: 'pane_dismiss' };
  }
  if (name === 'show_raw_data' && result.ok && result.url) {
    return { kind: 'pane', url: result.url, title: result.title || 'RAW', page: 'raw' };
  }
  if (result.pane && result.pane.url) {
    return { kind: 'pane', url: result.pane.url, title: result.pane.title, page: result.pane.page || 'detail' };
  }
  if (name === 'render_status' && result.ok) {
    return { kind: 'status', title: result.title, detail: result.detail, variant: result.variant, ttl_ms: result.ttl_ms };
  }
  if (name === 'render_notification' && result.ok) {
    return { kind: 'notification', title: result.title, body: result.body };
  }
  if (name === 'set_ui_language' && result.ok) {
    return { kind: 'ui_language', lang: result.lang };
  }
  return null;
}

// Compact, JSON-safe summary of a tool result for the transcript panel.
function summariseToolResult(result) {
  if (result == null) return '—';
  if (typeof result !== 'object') return String(result).slice(0, 240);
  if (result.error) return `error: ${String(result.error).slice(0, 200)}`;
  for (const k of ['summary', 'title', 'note', 'count', 'id', 'viz_id', 'projectable_id', 'message']) {
    const v = result[k];
    if (v != null && v !== '') return `${k}: ${String(v).slice(0, 200)}`;
  }
  try { return JSON.stringify(result).slice(0, 200); } catch { return 'ok'; }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

// Strip the OpenAI `type:'function'` wrapper Gemini doesn't use. The
// session.js path does the same thing for the Live API.
const FUNCTION_DECLARATIONS = GEMINI_FUNCTION_DECLARATIONS;

// System instruction tweaks for text mode: spoken-language flourishes
// don't translate to text the same way. Trim the persona slightly so
// responses are punchier in a chat box, and tell the model it's in text
// mode (so it doesn't say "let me play that for you" or similar).
const TEXT_MODE_SUFFIX = `

──── TEXT-MODE 模式提示 (text-mode override) ────
你现在不是在用语音对话——是用键盘聊天的纯文本模式。
- 回复要短、要俏皮，但不要写 *动作* (例：不要写 "*点点头*" 或 "*伸手指一下*")。
- 该上图就上图（render_viz / show_pane / 各种卡片），用户在聊天框右边能看见。
- 用 markdown 让重点突出：粗体、斜体、行内代码 \`like_this\`、列表都行。
- 不要假装在播放音频——没有 "I'll say that out loud" 或 "let me speak this"。
- The user may type in English or Chinese; reply in the same language they used.
`;

function buildContents(sess, userText) {
  // Gemini contents array uses { role, parts }. Pre-existing turns include
  // model function-call turns and our function-response turns from the
  // previous request — keep them in order.
  return [
    ...sess.contents,
    { role: 'user', parts: [{ text: userText }] },
  ];
}

// ─── Gemini client + context cache ───────────────────────────────────
//
// Why this matters: each tool-call hop is a fresh generateContentStream
// request that — without caching — re-uploads the same multi-kilobyte
// systemInstruction and tool declarations every time. For a 3-hop reply
// (think → call tool → think → call tool → final text) that's the same
// 10–20 KB of context paid for 5 times, both in upload bandwidth and in
// model TTFT (the model re-tokenises the prefix).
//
// Gemini Live avoids this entirely by holding the conversation in a
// persistent WebSocket session. Without going to Live (expensive), the
// best HTTP equivalent is **explicit context caching**: we register the
// system+tools prefix as a server-side cache once per ~30 min, then
// every generateContentStream call references it by name and only the
// chat-history tail flies over the wire. Tokens in the cache count at a
// fraction of normal input cost AND TTFT improves because Gemini doesn't
// re-process the cached prefix.
//
// The cache is lazy-initialised on first request and shared across all
// sessions in the process. If creation fails (Flash-Lite minimum token
// rules, API quirks, transient errors), we fall back to inline
// systemInstruction+tools per-request — same behaviour as before.

let _genAi = null;
function getGenAi() {
  if (!_genAi && process.env.GEMINI_API_KEY) {
    _genAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return _genAi;
}

const CACHE_TTL_SECONDS = 1800;          // 30 min — typical chat session
const CACHE_REFRESH_HEADROOM_MS = 5 * 60 * 1000;  // refresh when <5 min left
const CACHE_DISABLED = String(process.env.TEXT_CHAT_CACHE || '').toLowerCase() === 'off';

// { name, expiresAt, model, promise } — promise dedupes concurrent creates.
let _cacheState = null;

function sysInstruction() {
  return MOMO_INSTRUCTIONS + TEXT_MODE_SUFFIX;
}

// Remove JSON-Schema keywords Gemini's caches API doesn't accept (it's
// stricter than generateContent). `additionalProperties` is the
// concrete reject we hit; the others are common JSON-Schema extras that
// also aren't part of Gemini's accepted dialect.
const CACHE_DROP_SCHEMA_KEYS = new Set(['additionalProperties', '$schema', '$id', '$ref', 'definitions']);
function sanitizeFunctionDeclarations(decls) {
  return JSON.parse(JSON.stringify(decls, (key, value) => {
    if (CACHE_DROP_SCHEMA_KEYS.has(key)) return undefined;
    return value;
  }));
}

async function ensureCache(ai) {
  if (CACHE_DISABLED || !ai) return null;
  const model = MODEL;
  const now = Date.now();
  if (_cacheState && _cacheState.model === model && _cacheState.name) {
    const remaining = _cacheState.expiresAt - now;
    if (remaining > CACHE_REFRESH_HEADROOM_MS) return _cacheState.name;
    if (remaining > 0) {
      // Refresh in the background; current name is still valid.
      refreshCache(ai).catch(() => {});
      return _cacheState.name;
    }
    // Expired — fall through to recreate.
    _cacheState = null;
  }
  if (_cacheState?.promise) return _cacheState.promise;
  const state = { model, name: null, expiresAt: 0, promise: null };
  _cacheState = state;
  state.promise = (async () => {
    try {
      const cache = await ai.caches.create({
        model,
        config: {
          systemInstruction: sysInstruction(),
          // Gemini's caches API is stricter than generateContent: it
          // rejects JSON-Schema extras like `additionalProperties` even
          // though the inline tool path accepts them. Strip them so the
          // cache payload validates.
          tools: [{ functionDeclarations: sanitizeFunctionDeclarations(FUNCTION_DECLARATIONS) }],
          ttl: `${CACHE_TTL_SECONDS}s`,
        },
      });
      state.name = cache.name;
      state.expiresAt = Date.now() + CACHE_TTL_SECONDS * 1000;
      return state.name;
    } catch (err) {
      console.warn('[text-chat] context cache create failed — falling back to inline systemInstruction:', err?.message || err);
      _cacheState = null;
      return null;
    } finally {
      state.promise = null;
    }
  })();
  return state.promise;
}

async function refreshCache(ai) {
  const state = _cacheState;
  if (!state?.name) return;
  try {
    await ai.caches.update({ name: state.name, config: { ttl: `${CACHE_TTL_SECONDS}s` } });
    state.expiresAt = Date.now() + CACHE_TTL_SECONDS * 1000;
  } catch (err) {
    console.warn('[text-chat] context cache refresh failed:', err?.message || err);
    _cacheState = null;  // recreate on next use
  }
}

function invalidateCache(reason) {
  if (_cacheState) {
    console.warn('[text-chat] invalidating context cache:', reason);
    _cacheState = null;
  }
}

// Build the per-request config: either `cachedContent` (preferred) or
// inline systemInstruction+tools (fallback).
function buildRequestConfig(cacheName) {
  const base = { thinkingConfig: { thinkingBudget: 0 } };
  if (cacheName) return { ...base, cachedContent: cacheName };
  return {
    ...base,
    systemInstruction: sysInstruction(),
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
  };
}

function isCacheNotFoundError(err) {
  const msg = String(err?.message || err || '');
  return /CachedContent not found|cache.*expired|cachedContent.*invalid/i.test(msg);
}

// Run one user turn through the model + tool loop, streaming output via
// callbacks. Returns { text, events, toolCalls, stopReason } and mutates
// sess.contents so the next turn has full history.
//
// Callbacks (all optional):
//   onTextDelta(delta)  — fires for each text chunk in the final (no-tool)
//                          iteration, as it arrives from generateContentStream.
//                          Earlier iterations buffer text silently because
//                          the model often emits "let me check…" preamble
//                          alongside a function_call we'd rather skip.
//   onEvent(sideEffect) — fires when a tool produces a viz/pane/etc. side
//                          effect the browser should mount immediately.
//   onToolCall(call)    — fires after each tool dispatch with a compact
//                          summary, for transcript UIs.
async function runTurn(sess, userText, callbacks = {}) {
  const onTextDelta = typeof callbacks.onTextDelta === 'function' ? callbacks.onTextDelta : null;
  const onEvent = typeof callbacks.onEvent === 'function' ? callbacks.onEvent : null;
  const onToolCall = typeof callbacks.onToolCall === 'function' ? callbacks.onToolCall : null;

  const ai = getGenAi();
  if (!ai) {
    const msg = '(server missing GEMINI_API_KEY — set it in .env to use text mode)';
    if (onTextDelta) onTextDelta(msg);
    return { text: msg, events: [], toolCalls: [], stopReason: 'no_api_key' };
  }

  // Resolve the context cache for this turn. If it's null we fall back to
  // inline systemInstruction+tools — same behaviour as before, just no
  // prefix-caching speedup.
  let cacheName = await ensureCache(ai);

  const contents = buildContents(sess, userText);
  const events = [];
  const toolCalls = [];
  let finalText = '';
  let stopReason = null;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let stream;
    let openErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        stream = await withTimeout(
          ai.models.generateContentStream({
            model: MODEL,
            contents,
            config: buildRequestConfig(cacheName),
          }),
          ITERATION_TIMEOUT_MS,
          `generateContentStream iter ${iter} (open)`,
        );
        openErr = null;
        break;
      } catch (err) {
        openErr = err;
        // If the cache vanished mid-session (TTL expired in transit, or
        // server-side eviction), retry once with the inline config.
        if (cacheName && isCacheNotFoundError(err)) {
          invalidateCache('cache-not-found on open');
          cacheName = null;
          continue;
        }
        break;
      }
    }
    if (openErr) {
      stopReason = `model_error: ${openErr?.message || openErr}`;
      break;
    }

    // Stream chunks. Strategy:
    //   - Emit text deltas eagerly *until* we see a functionCall in the
    //     same iteration. In practice Gemini emits either pure-text OR
    //     pure-function_call per iteration, so the eager path is safe
    //     and gives the client ~hundreds of ms head-start on TTS.
    //   - If a functionCall does appear mid-stream after some text, we
    //     stop emitting and treat this as a tool iteration; any text
    //     already sent was preamble ("let me check…") which is fine to
    //     keep — the next iteration's text will follow naturally.
    const calls = [];
    const textChunks = [];
    let sawFunctionCall = false;
    let streamErr = null;
    try {
      for await (const chunk of stream) {
        const candidate = chunk?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        for (const p of parts) {
          if (p.functionCall) {
            calls.push(p.functionCall);
            sawFunctionCall = true;
          }
          if (typeof p.text === 'string' && p.text) {
            textChunks.push(p.text);
            if (!sawFunctionCall && onTextDelta) onTextDelta(p.text);
          }
        }
      }
    } catch (err) {
      streamErr = err;
    }
    if (streamErr) {
      if (cacheName && isCacheNotFoundError(streamErr)) {
        invalidateCache('cache-not-found mid-stream');
        cacheName = null;
        iter--;  // retry this iteration inline
        continue;
      }
      stopReason = `model_error: ${streamErr?.message || streamErr}`;
      break;
    }

    if (calls.length === 0) {
      finalText = textChunks.join('').trim();
      if (finalText) {
        contents.push({ role: 'model', parts: [{ text: finalText }] });
      }
      stopReason = 'final_text';
      break;
    }

    // Push the model's tool-call turn before dispatching, so the next
    // stream sees the matched functionCall/functionResponse pair.
    contents.push({ role: 'model', parts: calls.map((c) => ({ functionCall: c })) });

    // Run all tool calls in parallel. Voice mode (Gemini Live) does this
    // implicitly by fire-and-forget-ing each handleFunctionCall, and Live
    // feels fast partly because of that — N tools in one turn cost
    // max(T_i) instead of Σ T_i. We also surface each side-effect
    // (viz / pane / status) the moment its tool resolves, so the user's
    // hologram updates without waiting for the full turn.
    const results = await Promise.all(calls.map(async (call) => {
      const name = call.name;
      const callArgs = call.args || {};
      let result;
      try {
        result = await runTool(name, callArgs);
      } catch (err) {
        result = { error: String(err?.message || err) };
      }
      const summary = summariseToolResult(result);
      const sideEffect = eventFromTool(name, result);
      if (onToolCall) onToolCall({ name, args: callArgs, summary });
      if (sideEffect && onEvent) onEvent(sideEffect);
      return { name, args: callArgs, result, summary, sideEffect };
    }));

    for (const r of results) {
      toolCalls.push({ name: r.name, args: r.args, summary: r.summary });
      if (r.sideEffect) events.push(r.sideEffect);
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: r.name,
            response: r.result && typeof r.result === 'object' ? r.result : { result: r.result },
          },
        }],
      });
    }
  }

  if (!stopReason) stopReason = 'max_iterations';

  // Persist this whole turn (user + tool round-trips + model prose) into
  // sess.contents so the next request sees the full history.
  sess.contents = contents;
  sess.updatedAt = Date.now();

  return { text: finalText, events, toolCalls, stopReason };
}

// ─── HTTP routes ──────────────────────────────────────────────────────
//
// Two response modes for /text/chat:
//   - JSON (default) — full turn at end. Used by /text (text.html chat UI).
//   - SSE (Accept: text/event-stream OR ?stream=1) — incremental events
//     for the floating bar overlay, so it can start TTS on the first
//     sentence and mount viz/pane side-effects the moment a tool resolves.
//
// Event names on the SSE channel:
//   sid    { sid }                            once, near the top
//   tool   { name, args, summary }            after each tool dispatch
//   event  { kind, ... }                      tool side-effects (viz/pane/…)
//   text   { delta }                          final text chunks
//   done   { stopReason, model }              terminal — close after this
//   error  { error }                          terminal — close after this
export function mountRoutes(app) {
  app.post('/text/chat', async (req, res) => {
    const wantsSse = (req.headers.accept || '').includes('text/event-stream')
      || String(req.query?.stream || '') === '1'
      || String((req.body || {}).stream || '') === '1';
    if (wantsSse) return handleChatSse(req, res);
    try {
      const body = req.body || {};
      const message = String(body.message || '').trim();
      if (!message) return res.status(400).json({ error: 'message is required' });

      gcSessions();
      const sid = (typeof body.sid === 'string' && body.sid.startsWith('txt_')) ? body.sid : newSid();
      const sess = getSession(sid);

      const { text, events, toolCalls, stopReason } = await runTurn(sess, message);
      res.json({ sid, text, events, tool_calls: toolCalls, stop_reason: stopReason, model: MODEL });
    } catch (err) {
      console.error('[text-chat] error', err);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post('/text/reset', (req, res) => {
    const sid = String(req.body?.sid || '').trim();
    if (sid) sessions.delete(sid);
    res.json({ ok: true });
  });

  app.post('/text/speak', (req, res) => streamFishAudio(req, res, {
    text: String(req.body?.text || '').trim(),
    voiceOverride: String(req.body?.voice || ''),
    model: String(req.body?.model || FISH_MODEL),
  }));

  // GET form so the client can hand the URL straight to an <audio>
  // element. Browsers progressively download audio/mpeg with the native
  // streaming machinery — the first MP3 frames start playing while the
  // tail is still in flight from Fish. Significantly faster than fetch
  // → blob → URL.createObjectURL, which buffers everything.
  app.get('/text/speak', (req, res) => streamFishAudio(req, res, {
    text: String(req.query?.text || '').trim(),
    voiceOverride: String(req.query?.voice || ''),
    model: String(req.query?.model || FISH_MODEL),
  }));
}

async function handleChatSse(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Disable Nagle's algorithm so small SSE frames flush to the wire
  // immediately. Without this, tiny writes (a 4-byte "PONG" delta + the
  // "done" event) sit in the kernel buffer until ~200ms or until enough
  // bytes accumulate — defeating the whole point of streaming. Without
  // setNoDelay, the client only saw `sid` and then nothing until the
  // socket eventually flushed.
  try { res.socket?.setNoDelay(true); } catch {}
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Detect client disconnect via the *response* stream — not the
  // request. `req.on('close')` fires when express.json finishes draining
  // the request body, which happens before the handler even runs, so
  // listening on req would drop every subsequent emit. The response
  // stream's `close` only fires when the underlying socket actually
  // goes away.
  let closed = false;
  res.on('close', () => { closed = true; });

  const emit = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data || {})}\n\n`);
    } catch {}
  };

  try {
    const body = req.body || {};
    const message = String(body.message || '').trim();
    if (!message) {
      emit('error', { error: 'message is required' });
      return res.end();
    }
    gcSessions();
    const sid = (typeof body.sid === 'string' && body.sid.startsWith('txt_')) ? body.sid : newSid();
    const sess = getSession(sid);

    emit('sid', { sid });

    const { stopReason } = await runTurn(sess, message, {
      onTextDelta: (delta) => emit('text', { delta }),
      onEvent: (sideEffect) => emit('event', sideEffect),
      onToolCall: (tc) => emit('tool', tc),
    });

    emit('done', { stop_reason: stopReason, model: MODEL });
  } catch (err) {
    console.error('[text-chat-sse] error', err);
    emit('error', { error: String(err?.message || err) });
  } finally {
    if (!closed) try { res.end(); } catch {}
  }
}

// Fish Audio TTS — text in, mp3 out. Pipes the upstream MP3 byte stream
// directly to the client without buffering, so playback starts as soon
// as the first frame arrives. `latency: 'balanced'` and a smaller
// chunk_length both shave hundreds of ms off time-to-first-byte.
async function streamFishAudio(req, res, { text, voiceOverride, model }) {
  try {
    if (!process.env.FISH_API_KEY) {
      return res.status(503).json({ error: 'FISH_API_KEY not set' });
    }
    if (!text) return res.status(400).json({ error: 'text is required' });
    const voice = pickFishVoice(text, voiceOverride);

    const body = {
      text,
      format: 'mp3',
      mp3_bitrate: 128,
      chunk_length: 100,
      normalize: true,
      latency: 'balanced',
    };
    if (voice) body.reference_id = voice;

    const upstream = await fetch(`${FISH_API_BASE}/v1/tts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FISH_API_KEY}`,
        'Content-Type': 'application/json',
        'model': model || FISH_MODEL,
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error('[text-tts] fish', upstream.status, errText.slice(0, 400));
      return res.status(502).json({ error: `fish tts ${upstream.status}`, detail: errText.slice(0, 400) });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let aborted = false;
    res.on('close', () => { aborted = true; });

    // upstream.body is a Web ReadableStream in Node 18+. Stream chunks
    // straight onto the response — never buffer the whole MP3 server-side.
    for await (const chunk of upstream.body) {
      if (aborted) break;
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    if (!aborted) res.end();
  } catch (err) {
    console.error('[text-tts] error', err);
    if (!res.headersSent) {
      res.status(500).json({ error: String(err?.message || err) });
    } else {
      try { res.end(); } catch {}
    }
  }
}

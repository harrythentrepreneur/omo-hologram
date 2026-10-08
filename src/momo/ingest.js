// src/momo/ingest.js — bridges Momo's voice + decisions onto the Data
// Core event ring so /hq and /agents-grid see the same stream.
//
// Two producers feed in:
//
//   1. Browser (hologram pages) POSTs transcripts. Gemini Live emits
//      `inputTranscription` (what the user said) and `outputTranscription`
//      (what Momo said) in the browser only — the server never sees them
//      otherwise. Pages call POST /omo/ingest/momo with finalized turns.
//
//   2. Server wraps POST /tool (see wrapToolEndpoint) so every tool call
//      auto-emits `tool_call` and `tool_result` events without any
//      browser cooperation. This is the authoritative record of what
//      Momo decided to do.
//
// All events flow through dataCore.emit with source:"momo" so the
// existing /omo/ws fanout reaches /hq's LOG pane + the /agents-grid
// ticker with no extra plumbing.
//
// Event shape (matches the rest of the ring — see src/data_core.js):
//
//   { id, source: "momo", kind, ts, title, summary, data }
//
// Kinds:
//   · "user_said"     — voice input from the microphone, finalized turn
//   · "momo_said"     — Momo's voice reply, finalized turn
//   · "tool_call"     — server-side: a tool was dispatched
//   · "tool_result"   — server-side: a tool returned (or errored)
//   · "session_start" — page opened a live session
//   · "session_end"   — page torn down

import { randomUUID } from "node:crypto";

// How many chars of text to keep in title/summary; the rest rides the
// detail field. 160 fits the /hq log line without wrapping.
const TITLE_MAX = 160;
const SUMMARY_MAX = 240;

// Per-IP soft rate limit on the ingest endpoint. The browser side batches
// 250ms, so legitimate traffic is well under this. Prevents a runaway
// page from flooding the ring.
const RATE_WINDOW_MS = 1000;
const RATE_MAX_PER_WINDOW = 30;
const rateTable = new Map();

function rateAllow(ip) {
  const now = Date.now();
  const bucket = rateTable.get(ip) || { start: now, n: 0 };
  if (now - bucket.start > RATE_WINDOW_MS) { bucket.start = now; bucket.n = 0; }
  bucket.n += 1;
  rateTable.set(ip, bucket);
  return bucket.n <= RATE_MAX_PER_WINDOW;
}

function sliceText(v, n) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function oneLine(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

// ─── Emitter ────────────────────────────────────────────────────────────

let emit = null;

export function attach(dataCore) {
  emit = typeof dataCore?.emit === "function" ? dataCore.emit : null;
}

function emitMomo({ kind, title, summary, data }) {
  if (!emit) return null;
  const ev = {
    id: randomUUID(),
    source: "momo",
    kind,
    ts: Date.now(),
    title: sliceText(title || "", TITLE_MAX),
    summary: sliceText(summary || title || "", SUMMARY_MAX),
    data: data || {},
  };
  try { return emit(ev); } catch { return null; }
}

// ─── HTTP ingest (from hologram pages) ─────────────────────────────────

export function mountRoutes(app) {
  app.post("/omo/ingest/momo", (req, res) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    if (!rateAllow(ip)) return res.status(429).json({ error: "rate limited" });

    const body = req.body;
    // The browser may batch multiple events — accept an array OR a single
    // object. sendBeacon sometimes ends up with the Content-Type stripped,
    // so also accept plain text that's a JSON string.
    let events = Array.isArray(body) ? body : [body];
    if (events.length === 1 && typeof events[0] === "string") {
      try { events = JSON.parse(events[0]); if (!Array.isArray(events)) events = [events]; } catch { return res.status(400).json({ error: "bad body" }); }
    }

    let accepted = 0;
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const kind = String(raw.kind || "").slice(0, 40);
      if (!KIND_HANDLERS[kind]) continue; // silently skip unknown kinds
      const text = oneLine(raw.text || "");
      const page = String(raw.page || "").slice(0, 32) || "holo";
      const sid  = String(raw.sid  || "").slice(0, 48) || null;
      const shaped = KIND_HANDLERS[kind]({ text, page, sid, raw });
      if (shaped) { emitMomo(shaped); accepted++; }
    }

    res.status(202).json({ accepted });
  });
}

const KIND_HANDLERS = {
  user_said: ({ text, page, sid }) => text ? {
    kind: "user_said",
    title: text,
    summary: `heard · ${page}`,
    data: { role: "user", text, page, sid },
  } : null,

  momo_said: ({ text, page, sid }) => text ? {
    kind: "momo_said",
    title: text,
    summary: `momo · ${page}`,
    data: { role: "assistant", text, page, sid },
  } : null,

  session_start: ({ page, sid, raw }) => ({
    kind: "session_start",
    title: `momo online · ${page}`,
    summary: `model=${raw?.model || "?"} voice=${raw?.voice || "?"}`,
    data: { page, sid, model: raw?.model, voice: raw?.voice },
  }),

  session_end: ({ page, sid, raw }) => ({
    kind: "session_end",
    title: `momo offline · ${page}`,
    summary: raw?.reason ? String(raw.reason).slice(0, 80) : "",
    data: { page, sid, reason: raw?.reason },
  }),
};

// ─── Server-side tool wrap (called from server.js) ─────────────────────
// Wraps POST /tool so every tool call emits tool_call before runTool and
// tool_result after, regardless of which page initiated it. The wrapped
// handler preserves the original response contract exactly.

// Hard server-side timeout for tool dispatch. Gemini Live blocks the
// model's audio output until it receives a functionResponse — so if any
// tool hangs (an external HTTP call without a timeout, a stuck DB query,
// a dropped TCP socket), Momo goes silent indefinitely until the server
// is restarted. We've reproduced that sticky-freeze. The fix: never let
// /tool wait forever for the inner tool. Race against a timeout and
// always send SOMETHING back so the model can move on.
//
// 60s is generous — most tools finish in <50ms; the slowest legitimate
// case is spawn_research_agent's 30s Gemini-loop budget. Anything past
// 60s is almost certainly hung, not slow.
//
// IMPORTANT (per the "tool calls have #1 priority" rule): a timed-out
// tool's underlying work is NOT aborted here — runTool's promise just
// stops blocking the HTTP response. If the tool eventually resolves the
// late result is logged but the response was already sent. This is
// intentional: aborting mid-flight could leave external services in
// inconsistent states (half-sent emails, half-written DB rows).
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 60_000);

export function wrapToolEndpoint(runTool) {
  return async function (req, res) {
    const { name, arguments: args } = req.body || {};
    const t0 = Date.now();

    // Tool call: announce up front so the /hq log shows it in sync with
    // the slot animation that spawn_agent_task triggers on /agents-grid.
    const shortArgs = summariseArgs(args);
    emitMomo({
      kind: "tool_call",
      title: `→ ${name || "tool"}${shortArgs ? " " + shortArgs : ""}`,
      summary: name || "tool",
      data: { name, args: args || {}, phase: "call" },
    });
    console.log(`[tool] → ${name || "tool"}${shortArgs ? " " + shortArgs : ""}`);

    // If the tool is taking suspiciously long, surface that to the console
    // so freezes are visible (rather than just "the screen sat there"). The
    // notice fires once at 1s and again at 5s; cleared on completion.
    const slowAt1s = setTimeout(() => {
      console.warn(`[tool] ⏳ ${name || "tool"} still running after 1000ms`);
    }, 1000);
    const slowAt5s = setTimeout(() => {
      console.warn(`[tool] ⏳ ${name || "tool"} still running after 5000ms — likely freezing the UI`);
    }, 5000);

    let responded = false;
    let timeoutHandle = null;
    const send = (status, body) => {
      if (responded) return;
      responded = true;
      clearTimeout(slowAt1s);
      clearTimeout(slowAt5s);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try { res.status(status).json(body); } catch (err) {
        console.error(`[tool] response send failed for ${name}:`, err?.message || err);
      }
    };

    // Hard timeout — fires send() so the client never waits past this.
    // The inner runTool promise keeps running; we attach a late-result
    // log below so we can tell which tool was actually hung.
    timeoutHandle = setTimeout(() => {
      const ms = Date.now() - t0;
      const msg = `tool timed out after ${ms}ms`;
      emitMomo({
        kind: "tool_result",
        title: `⏱ ${name || "tool"} · ${msg}`,
        summary: name || "tool",
        data: { name, error: msg, durationMs: ms, phase: "timeout" },
      });
      console.error(`[tool] ⏱ ${name || "tool"} · ${msg} — replying so client unblocks; tool still running in background`);
      send(504, { error: msg });
    }, TOOL_TIMEOUT_MS);

    // Run the tool. Resolution path uses send() which is idempotent —
    // if the timeout already fired, this becomes a no-op for the HTTP
    // response but we still log the late result so it's visible.
    runTool(name, args || {}).then(
      (result) => {
        const ms = Date.now() - t0;
        if (responded) {
          console.warn(`[tool] ↩ ${name || "tool"} · late resolve at ${ms}ms (after timeout)${summariseResult(result)}`);
          return;
        }
        emitMomo({
          kind: "tool_result",
          title: `← ${name || "tool"} · ${ms}ms${summariseResult(result)}`,
          summary: name || "tool",
          data: { name, result, durationMs: ms, phase: "result" },
        });
        const slowTag = ms >= 1000 ? " SLOW" : "";
        console.log(`[tool] ← ${name || "tool"} · ${ms}ms${summariseResult(result)}${slowTag}`);
        send(200, { result });
      },
      (err) => {
        const ms = Date.now() - t0;
        const msg = String(err?.message || err);
        if (responded) {
          console.warn(`[tool] ↩ ${name || "tool"} · late reject at ${ms}ms (after timeout) · ${msg}`);
          return;
        }
        emitMomo({
          kind: "tool_result",
          title: `✗ ${name || "tool"} · ${msg.slice(0, 100)}`,
          summary: name || "tool",
          data: { name, error: msg, durationMs: ms, phase: "error" },
        });
        console.error(`[tool] ✗ ${name || "tool"} · ${ms}ms · ${msg}`);
        send(400, { error: msg });
      },
    );
  };
}

// Argument summariser — the original args object can be huge (chart
// datasets etc.) and we don't want to flood the log line. Keep it to a
// few identifying fields per common tool.
function summariseArgs(args) {
  if (!args || typeof args !== "object") return "";
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  // Prefer these keys in order; fall back to first key.
  const prefer = ["task", "intent", "chart_type", "agent", "title", "to", "subject", "query"];
  for (const k of prefer) {
    if (args[k] != null) {
      const v = typeof args[k] === "string" ? args[k] : JSON.stringify(args[k]);
      return `(${k}: ${sliceText(oneLine(v), 60)})`;
    }
  }
  const k = keys[0];
  const v = typeof args[k] === "string" ? args[k] : JSON.stringify(args[k]);
  return `(${k}: ${sliceText(oneLine(v), 60)})`;
}

function summariseResult(result) {
  if (!result || typeof result !== "object") return "";
  // Lift a few common fields to the log line — id, viz_id, task_id, error.
  if (result.error) return ` · err`;
  const bits = [];
  if (result.id) bits.push(String(result.id));
  if (result.viz_id) bits.push(String(result.viz_id));
  if (result.task_id) bits.push(String(result.task_id));
  if (result.slot != null) bits.push(`slot=${result.slot}`);
  return bits.length ? " · " + bits.join(" ") : "";
}

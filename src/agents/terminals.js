// src/agents/terminals.js — the 4-slot "agent grid" backend.
//
// Momo talks to the hologram; in parallel, the user watches a second screen
// showing four agents working in a 2×2 terminal grid. This module is the
// seam between Momo's dispatches (currently Browserbase via browser_tasks.js)
// and that grid.
//
// Slot display identities (Atlas / Cinder / Prism / Quill) are UX labels.
// Each slot binds to a logical agent id; the frontend shows both.
//
// Data flow: tasks.js / browser_tasks.js bus events (task_spawn /
// task_progress / task_complete) route to the slot that reserved the
// task_id. The module is stateless beyond the slot array + task→slot map.

import { WebSocketServer } from "ws";
import * as bus from "./bus.js";
import * as momoIngest from "../momo/ingest.js";

// ─── Slot display identities ───────────────────────────────────────────
// Fixed UX roster. The realAgentId field is resolved at boot against the
// the slot's declared agentId.

const SLOT_DEFS = [
  { slot: 0, display: "ATLAS",  role: "RESEARCH", sigil: "A", tone: "amber",      glyph: "◈", agentId: "atlas"  },
  { slot: 1, display: "CINDER", role: "CODE",     sigil: "C", tone: "phosphor",   glyph: "◇", agentId: "cinder" },
  { slot: 2, display: "PRISM",  role: "DATA",     sigil: "P", tone: "periwinkle", glyph: "◆", agentId: "prism"  },
  { slot: 3, display: "QUILL",  role: "WRITING",  sigil: "Q", tone: "coral",      glyph: "◉", agentId: "quill"  },
];

const MAX_LINES = 120;           // per-slot ring depth; terse CRT-style log
const IDLE_RESET_MS = 12_000;    // keep DONE/ERROR state visible for ~12s
const TICKER_DEPTH = 80;

// ─── State ─────────────────────────────────────────────────────────────

const slots = SLOT_DEFS.map((def) => ({
  slot: def.slot,
  display: def.display,
  role: def.role,
  sigil: def.sigil,
  tone: def.tone,
  glyph: def.glyph,
  realAgentId: def.agentId,
  realAgentName: def.display,
  model: null,
  workspace: null,
  status: "idle",
  currentTaskId: null,
  currentSessionId: null,
  currentTask: null,
  currentLabel: null,
  thinking: null,
  startedAt: null,
  endedAt: null,
  durationMs: null,
  tokensIn: 0,
  tokensOut: 0,
  toolCalls: 0,
  lineBuffer: [],
  lastUpdate: Date.now(),
  _idleTimer: null,
  // Browserbase-specific fields — populated when a slot is hosting a
  // spawn_browser_agent run.
  runtime: null,           // "browserbase" | null (idle)
  liveViewUrl: null,       // embed URL for the debug iframe (live)
  liveViewFullscreenUrl: null,
  browserSessionId: null,
  // Browserbase's session-recording URL — set once the session is
  // allocated. Survives task completion so the user can click "REPLAY ↗"
  // on a finished slot to see the full timeline (network, console,
  // every screenshot).
  replayUrl: null,
  // Google Doc URL written by browser_tasks.exportToGoogleDoc on
  // successful completion. Same lifecycle as replayUrl: lingers after
  // the task ends so the user can click "DOC ↗" on a done slot.
  docUrl: null,
  docId: null,
  docError: null,
  // Browser results we want to keep visible after the task exits, since
  // the slot stays in "DONE" state until a new task replaces it (see the
  // skip-idle-reset block in onTaskEvent).
  finalAnswer: null,
  finalError: null,
}));

const taskToSlot = new Map();       // taskId → slot

const tickerRing = [];  // recent events, newest first

// ─── WebSocket fanout ──────────────────────────────────────────────────

const clients = new Set();

// Live count of /agents/ws subscribers (the agents-grid second screen).
// Exported so browser_tasks.js can union it with the /omo/ws count for
// the no-UI-presence abort.
export function getClientCount() {
  return clients.size;
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const c of clients) {
    try { if (c.readyState === 1) c.send(payload); } catch {}
  }
}

// ─── Ring writers ──────────────────────────────────────────────────────

function pushLine(slot, line, kind = "log", meta = null) {
  const entry = { ts: Date.now(), line, kind, meta };
  slot.lineBuffer.push(entry);
  if (slot.lineBuffer.length > MAX_LINES) slot.lineBuffer.shift();
  broadcast({ type: "line", slot: slot.slot, entry });
}

function pushState(slot) {
  slot.lastUpdate = Date.now();
  broadcast({ type: "state", slot: slot.slot, state: stateOf(slot) });
}

function pushTicker(entry) {
  const row = { ts: Date.now(), ...entry };
  tickerRing.unshift(row);
  if (tickerRing.length > TICKER_DEPTH) tickerRing.length = TICKER_DEPTH;
  broadcast({ type: "ticker", entry: row });
}

function stateOf(s) {
  return {
    slot: s.slot,
    display: s.display,
    role: s.role,
    sigil: s.sigil,
    tone: s.tone,
    glyph: s.glyph,
    realAgentId: s.realAgentId,
    realAgentName: s.realAgentName,
    model: s.model,
    workspace: s.workspace,
    status: s.status,
    currentTaskId: s.currentTaskId,
    currentSessionId: s.currentSessionId,
    currentTask: s.currentTask,
    currentLabel: s.currentLabel,
    triggerText: s.triggerText,
    thinking: s.thinking,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMs: s.durationMs,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    toolCalls: s.toolCalls,
    lastUpdate: s.lastUpdate,
    runtime: s.runtime,
    liveViewUrl: s.liveViewUrl,
    liveViewFullscreenUrl: s.liveViewFullscreenUrl,
    browserSessionId: s.browserSessionId,
    replayUrl: s.replayUrl,
    docUrl: s.docUrl,
    docId: s.docId,
    docError: s.docError,
    finalAnswer: s.finalAnswer,
    finalError: s.finalError,
  };
}

// ─── Formatting helpers ────────────────────────────────────────────────

function truncate(v, n) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function oneLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function cleanErrorText(raw) {
  const s = String(raw || "").trim().replace(/\n{2,}/g, "\n");
  return s || "no error detail";
}

// Classify an assistant text line by its leading narration marker. Returns
// { kind, line } where kind is one of "plan" | "finding" | "question" |
// "conclusion" | "assistant" (fallback).
function classifyAssistantLine(raw) {
  const s = String(raw || "").trimStart();
  if (!s) return { kind: "assistant", line: raw };
  const ch = s.charAt(0);
  if (ch === "→") return { kind: "plan",       line: s.slice(1).trimStart() };
  if (ch === "✓") return { kind: "finding",    line: s.slice(1).trimStart() };
  if (ch === "?" || ch === "？") return { kind: "question", line: s.slice(1).trimStart() };
  if (ch === "▣") return { kind: "conclusion", line: s.slice(1).trimStart() };
  return { kind: "assistant", line: raw };
}

// ─── Bus: task lifecycle (from browser_tasks.js) ──────────────────────

function onTaskEvent(ev) {
  if (!ev || !ev.data) return;
  const taskId = ev.data.id;
  if (!taskId) return;
  const slot = taskToSlot.get(taskId);
  if (!slot) return;

  if (ev.kind === "task_spawn") {
    if (ev.data.pid) pushLine(slot, `pid=${ev.data.pid} · thinking=${ev.data.thinking || "medium"}`, "meta");
    // Browserbase path: the spawn event re-fires once a remote session is
    // allocated, carrying liveViewUrl. Copy it onto the slot so the grid
    // UI can swap in the iframe.
    if (ev.data.runtime === "browserbase") {
      slot.runtime = "browserbase";
      if (ev.data.liveViewUrl && slot.liveViewUrl !== ev.data.liveViewUrl) {
        slot.liveViewUrl = ev.data.liveViewUrl;
        slot.liveViewFullscreenUrl = ev.data.fullscreenLiveViewUrl || null;
        slot.browserSessionId = ev.data.sessionId || null;
        slot.replayUrl = ev.data.replayUrl || null;
        pushLine(slot, `browser ready · session=${String(ev.data.sessionId || "").slice(0,8)}`, "meta");
      }
    }
    if (slot.status === "dispatching") slot.status = "running";
    console.log(`[terminals] task_spawn    slot=${slot.slot} (${slot.display}) task=${taskId} runtime=${ev.data.runtime || "-"}${ev.data.liveViewUrl ? " (live)" : ""}`);
    pushState(slot);
    return;
  }

  if (ev.kind === "task_progress") {
    if (slot.status === "dispatching") slot.status = "running";
    const turn = ev.data.turn || ev.data.lastTurn;

    if (turn?.sessionId && slot.currentSessionId !== turn.sessionId) {
      slot.currentSessionId = turn.sessionId;
    }

    // Render the agent's actual work. task_progress is task-scoped so
    // there's no ambiguity about which slot a turn belongs to.
    if (turn?.kind === "tool_use") {
      slot.toolCalls += 1;
      const name = turn.toolName || "tool";
      // Show the full tool input (not just the first 80 chars) so the
      // grid surfaces what the agent actually asked for. The grid CSS
      // wraps long lines so width is no longer a constraint.
      const input = truncate(oneLine(turn.toolInput), 1200);
      // fullInput keeps newlines + full structure — the inspector's EYES
      // pane renders it verbatim so the user can read exactly what the
      // agent searched for / where it looked.
      const fullInput = (() => {
        if (turn.toolInputRaw == null) return turn.toolInput || "";
        if (typeof turn.toolInputRaw === "string") return turn.toolInputRaw.slice(0, 8000);
        try { return JSON.stringify(turn.toolInputRaw, null, 2).slice(0, 8000); }
        catch { return String(turn.toolInputRaw).slice(0, 8000); }
      })();
      pushLine(slot, input ? `${name}(${input})` : `${name}()`, "tool_use", {
        toolName: name,
        toolUseId: turn.toolUseId || null,
        fullInput,
      });
    } else if (turn?.kind === "tool_result") {
      // Show the full tool result body. Errors get a slightly higher cap
      // since stack traces eat space; both are well above what fits on a
      // single line so the grid CSS wraps them.
      const limit = turn.isError ? 2000 : 1500;
      // fullBody keeps newlines so the EYES pane can show file contents
      // / grep matches / diffs the agent received as readable code.
      const fullBody = String(turn.snippetRaw ?? turn.snippet ?? "").slice(0, 12000);
      pushLine(slot, truncate(oneLine(turn.snippet), limit), turn.isError ? "tool_err" : "tool_result", {
        toolUseId: turn.toolUseId || null,
        isError: !!turn.isError,
        fullBody,
      });
    } else if (turn?.kind === "text") {
      if (turn.role === "assistant") {
        // Split on newlines so a multi-line assistant turn that contains
        // several markers (e.g. "→ plan\n✓ finding") surfaces as distinct
        // styled lines on the grid rather than one squashed blob.
        const chunks = String(turn.text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
        if (chunks.length === 0) {
          pushLine(slot, truncate(oneLine(turn.text), 1500), "assistant");
        } else {
          for (const raw of chunks) {
            const { kind, line } = classifyAssistantLine(raw);
            // Conclusion lines carry the full answer; the rest are now
            // also generously sized so the grid surfaces full thoughts
            // instead of mid-sentence ellipses.
            const limit = kind === "conclusion" ? 2000 : 1500;
            pushLine(slot, truncate(oneLine(line), limit), kind);
          }
        }
      } else {
        pushLine(slot, truncate(oneLine(turn.text), 1500), "user");
      }
    } else if (ev.data.phase === "heartbeat") {
      pushLine(slot, "… still thinking", "dim");
    }

    pushState(slot);
    return;
  }

  if (ev.kind === "task_complete") {
    const ok = ev.data.status === "done";
    slot.status = ok ? "done" : "error";
    slot.endedAt = ev.data.endedAt || Date.now();
    slot.durationMs = ev.data.durationMs || null;
    // Stash the final answer / error on the slot so the grid can keep
    // rendering it after the line-buffer is cleared on the next dispatch.
    if (ok) {
      slot.finalAnswer = ev.data.result || null;
      slot.finalError = null;
    } else {
      slot.finalAnswer = null;
      slot.finalError = cleanErrorText(ev.data.error || "unknown error");
    }
    // Stash the Google Doc URL on the slot so the footer "DOC ↗" link
    // stays usable after the task ends. Same survival rules as replayUrl:
    // cleared by reserveSlot on the next dispatch.
    if (ev.data.docUrl) slot.docUrl = ev.data.docUrl;
    if (ev.data.docId) slot.docId = ev.data.docId;
    if (ev.data.docError) slot.docError = ev.data.docError;
    console.log(`[terminals] task_complete slot=${slot.slot} (${slot.display}) task=${taskId} status=${slot.status} ms=${slot.durationMs}`);
    if (ok) {
      // Surface the final answer without mid-sentence truncation. If the
      // agent followed the OUTPUT STYLE contract the result already starts
      // with "▣ "; strip the marker so rendering matches in-stream
      // conclusion lines.
      if (ev.data.result) {
        let finalText = oneLine(ev.data.result);
        let finalKind = "done";
        if (finalText.startsWith("▣")) {
          finalText = finalText.slice(1).trimStart();
          finalKind = "conclusion";
        }
        pushLine(slot, truncate(finalText, 2400), finalKind);
      }
      // If the runner archived the answer to a Google Doc, surface the
      // URL inline so the user can click straight from the grid. docError
      // (e.g. "google not connected") is shown dimmed so it's never silent.
      if (ev.data.docUrl) {
        pushLine(slot, `📄 ${ev.data.docUrl}`, "finding");
      } else if (ev.data.docError) {
        pushLine(slot, `doc skip · ${ev.data.docError}`, "dim");
      }
      pushLine(slot, `done · ${formatDuration(slot.durationMs)}`, "meta");
    } else {
      // Errors deserve the same visual weight as conclusions — raise the
      // cap way above the 220-char default so the real cause isn't
      // chopped mid-sentence, and let the grid CSS wrap them. Also emit
      // as multi-line if the error string contains newlines so each line
      // stands alone rather than running on as one blob.
      const errText = cleanErrorText(ev.data.error || "unknown error");
      const chunks = errText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      if (chunks.length <= 1) {
        pushLine(slot, truncate(oneLine(errText), 1200), "error");
      } else {
        for (const line of chunks) {
          pushLine(slot, truncate(oneLine(line), 400), "error");
        }
      }
      pushLine(slot, `error · ${formatDuration(slot.durationMs)}`, "meta");
    }
    pushState(slot);

    taskToSlot.delete(taskId);

    // Skip auto-idle-reset for Browserbase tasks. Browser tasks have a
    // replay URL + final answer the user wants to read after completion.
    // The slot clears on next dispatch via reserveSlot.
    if (slot.runtime === "browserbase") {
      console.log(`[terminals] idle-reset skipped (browserbase) slot=${slot.slot} — keeping DONE state visible until next dispatch`);
      return;
    }

    if (slot._idleTimer) clearTimeout(slot._idleTimer);
    slot._idleTimer = setTimeout(() => {
      if (slot.currentTaskId === taskId) {
        console.log(`[terminals] idle-reset   slot=${slot.slot} (${slot.display}) after task=${taskId}`);
        slot.status = "idle";
        slot.currentTaskId = null;
        slot.currentSessionId = null;
        slot.currentTask = null;
        slot.currentLabel = null;
        slot.triggerText = null;
        slot.thinking = null;
        slot.startedAt = null;
        slot.endedAt = null;
        slot.tokensIn = 0;
        slot.tokensOut = 0;
        slot.toolCalls = 0;
        slot.runtime = null;
        slot.liveViewUrl = null;
        slot.liveViewFullscreenUrl = null;
        slot.browserSessionId = null;
        slot.replayUrl = null;
        slot.docUrl = null;
        slot.docId = null;
        slot.docError = null;
        slot.finalAnswer = null;
        slot.finalError = null;
        pushState(slot);
      } else {
        console.log(`[terminals] idle-reset skipped  slot=${slot.slot} — slot already owned by task=${slot.currentTaskId}`);
      }
    }, IDLE_RESET_MS);
    slot._idleTimer.unref?.();
    return;
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function onBusEvent(ev) {
  if (!ev) return;
  if (ev.kind === "task_spawn" || ev.kind === "task_progress" || ev.kind === "task_complete") {
    return onTaskEvent(ev);
  }
}

bus.subscribe(onBusEvent);

// ─── Slot reservation (called from spawn_agent_task) ───────────────────

export function pickSlot(preferredSlot) {
  if (preferredSlot != null) {
    const n = Number(preferredSlot);
    if (Number.isInteger(n) && n >= 0 && n < slots.length) {
      const s = slots[n];
      if (s.status === "idle" || s.status === "done" || s.status === "error") return s;
    }
  }
  const candidates = slots.filter((s) => s.status !== "running" && s.status !== "dispatching");
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.lastUpdate || 0) - (b.lastUpdate || 0));
  return candidates[0];
}

// Slot agent id resolver. Each slot binds to its own specialist (atlas,
// cinder, prism, quill). Callers pass either the display name ("Atlas"),
// the lowercase id ("atlas"), or a slot number.
export function resolveAgentId(displayOrSlotId) {
  if (displayOrSlotId == null) return slots[0]?.realAgentId || null;
  if (typeof displayOrSlotId === "number") {
    return slots[displayOrSlotId]?.realAgentId || null;
  }
  const key = String(displayOrSlotId).toLowerCase();
  const match = slots.find(
    (s) => s.agentId?.toLowerCase() === key || s.display?.toLowerCase() === key,
  );
  return match?.realAgentId || slots[0]?.realAgentId || null;
}

export function reserveSlot({ slot, taskId, task, label, thinking, runtime }) {
  const s = typeof slot === "number" ? slots[slot] : slot;
  if (!s) throw new Error("invalid slot");
  if (s._idleTimer) { clearTimeout(s._idleTimer); s._idleTimer = null; }

  // Evict any prior task bindings still pointing at this slot so a stale
  // binding doesn't route fresh turns to the wrong dispatch.
  for (const [tid, boundSlot] of taskToSlot.entries()) {
    if (boundSlot === s && tid !== taskId) taskToSlot.delete(tid);
  }

  s.status = "dispatching";
  s.currentTaskId = taskId;
  s.currentSessionId = null;
  s.currentTask = task;
  s.currentLabel = label || null;
  // Connect the three surfaces: the most recent user utterance (from
  // Momo ingest) is what the user said to prompt this dispatch. Show it
  // on the slot header so /agents-grid, /hq LOG, and /holo all reference
  // the same triggering line.
  s.triggerText = momoIngest.getLastUserSaid?.() || null;
  s.thinking = thinking || "medium";
  s.runtime = runtime || null;
  // Reset any stale Browserbase state from a prior run. liveViewUrl will
  // be filled in by the task_spawn re-emit once the session is up.
  // replayUrl/finalAnswer/finalError linger after a browser task completes
  // (we skip the idle-reset for those) — so a new dispatch has to clear
  // them explicitly here, otherwise the new slot would inherit the prior
  // task's outcome panel.
  s.liveViewUrl = null;
  s.liveViewFullscreenUrl = null;
  s.browserSessionId = null;
  s.replayUrl = null;
  s.docUrl = null;
  s.docId = null;
  s.docError = null;
  s.finalAnswer = null;
  s.finalError = null;
  // Clear the line buffer too, so the grid renders this dispatch on a
  // clean slate rather than mixing the previous task's tool calls in.
  s.lineBuffer = [];
  s.startedAt = Date.now();
  s.endedAt = null;
  s.durationMs = null;
  s.tokensIn = 0;
  s.tokensOut = 0;
  s.toolCalls = 0;
  taskToSlot.set(taskId, s);

  pushLine(s, `▶ DISPATCH ${taskId}`, "dispatch");
  if (label) pushLine(s, `${label}`, "dispatch-label");
  pushLine(s, truncate(oneLine(task), 220), "dispatch-task");
  pushState(s);

  console.log(`[terminals] reserve      slot=${s.slot} (${s.display}) task=${taskId} trigger="${(s.triggerText || "").slice(0,50)}"`);
  broadcast({ type: "dispatch", slot: s.slot, taskId, task, label: label || null });
  return s;
}

// ─── Introspection ─────────────────────────────────────────────────────

export function snapshot() {
  return {
    slots: slots.map((s) => ({ ...stateOf(s), buffer: s.lineBuffer.slice() })),
    ticker: tickerRing.slice(0, TICKER_DEPTH),
  };
}

export function listSlots() {
  return slots.map(stateOf);
}

// ─── HTTP / WebSocket mounts ───────────────────────────────────────────

export function mountRoutes(app) {
  app.get("/omo/api/agents/terminals", (_req, res) => {
    res.json(snapshot());
  });
  app.get("/omo/api/agents/terminals/slots", (_req, res) => {
    res.json({ slots: listSlots() });
  });
}

export function mountWebSocket(httpServer) {
  // noServer + manual upgrade routing so we coexist with /omo/ws.
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    clients.add(socket);
    try { socket.send(JSON.stringify({ type: "snapshot", ...snapshot() })); } catch {}
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  httpServer.on("upgrade", (req, sock, head) => {
    const path = (req.url || "").split("?")[0];
    if (path !== "/agents/ws") return;
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
  });

  return wss;
}

// src/agents/browser_tasks.js — registry for Browserbase-driven agent tasks.
//
// Owns tasks whose runtime is Browserbase: we create a remote browser
// session, run a Gemini+Playwright loop against it, and stream progress
// onto the agents bus as task_spawn / task_progress / task_complete events.
//
// Lifecycle:
//   spawn({ task, slot, label })
//     → task_spawn   (carries runtime:"browserbase", liveViewUrl)
//     → task_progress (streamed from browser_runner.emit hook)
//     → task_complete (ok with result, or error)
// The Browserbase session is always released at the end.

import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import * as bus from "./bus.js";
import * as bb from "./browserbase.js";
import * as datasets from "../store/datasets.js";
import { run as runBrowserAgent } from "./browser_runner.js";
import * as gdocs from "../connectors/google_docs.js";
import * as gauth from "../connectors/google.js";
import * as dataCore from "../data_core.js";
import * as terminals from "./terminals.js";

// How often to poll Browserbase for a refreshed live-view debug URL while
// a task is running. The debug URL is per-page (per-tab) — when the agent
// opens a new tab or the active page rotates, the page id in the URL
// goes stale and the iframe shows the previous tab. 5s is the sweet spot:
// page transitions are caught within one screencast frame's-worth of UI
// reaction time, but we don't burn 30 API calls/min while the page is
// stable (which it is for the vast majority of a run).
const LIVE_VIEW_REFRESH_MS = 5000;

// UI-presence watchdog. If no client is connected to either /omo/ws (the
// hologram) or /agents/ws (the agents-grid second screen) for this long,
// running browser tasks are aborted — there's nobody to narrate to and
// nobody to watch the live view, so it's effectively timed out and we'd
// just be burning Browserbase credits + a Playwright session worth of
// memory. Override with BROWSER_TASKS_NO_UI_GRACE_MS; set to 0 to disable.
const NO_UI_GRACE_MS = Number(process.env.BROWSER_TASKS_NO_UI_GRACE_MS || 60 * 60 * 1000);
const NO_UI_POLL_MS = 30_000;

function uiClientCount() {
  let n = 0;
  try { n += dataCore.getClientCount() || 0; } catch {}
  try { n += terminals.getClientCount() || 0; } catch {}
  return n;
}

const MAX_HISTORY = 100;
const ring = [];
const byId = new Map();

const NARRATION_MIN_GAP_MS = 12_000;
const SUMMARY_CHANGE_RATIO = 0.35;

// Persistence — append-only JSONL so completed tasks survive a server
// restart. Lets the user pull up the Browserbase replay URL even after
// a crash, and gives `/omo/api/agents/browser_tasks` real history rather
// than just the last in-memory ring.
const HISTORY_PATH = process.env.BROWSER_TASKS_HISTORY_PATH ||
  new URL("../../data/browser_tasks.jsonl", import.meta.url).pathname;

// Browserbase exposes a session recording at this URL — public to anyone
// signed into the project's dashboard. Storing it on the record gives the
// grid a "REPLAY ↗" link that opens the full session timeline (network,
// console, every screenshot) so the user can post-mortem failures.
function replayUrlFor(sessionId) {
  return sessionId ? `https://www.browserbase.com/sessions/${sessionId}` : null;
}

// The system prompt in browser_runner.js requires the agent to end with:
//   TLDR: <one-line voice summary>
//   DETAILS:
//   <full data the user actually wants in the doc>
// This parser splits the two so each downstream surface gets the right
// portion: voice/card → TLDR; doc body / grid → DETAILS. If the agent
// drifts off-format we fall back to the whole answer so nothing breaks.
function parseFinalAnswer(raw) {
  const text = String(raw || "").trim();
  if (!text) return { tldr: "", details: "", full: "" };
  const tldrMatch = text.match(/^[\s>\-*•]*TLDR\s*[:：]\s*([\s\S]*?)(?:\n\s*DETAILS\s*[:：]|$)/i);
  const detailsMatch = text.match(/\n\s*DETAILS\s*[:：]\s*([\s\S]+)$/i);
  if (tldrMatch || detailsMatch) {
    return {
      tldr: (tldrMatch?.[1] || "").trim(),
      details: (detailsMatch?.[1] || "").trim(),
      full: text,
    };
  }
  // Off-format fallback — first sentence as TLDR, rest as details.
  const firstBreak = text.search(/(?<=[.。!?！？])\s+/);
  return firstBreak > 0 && firstBreak < 280
    ? { tldr: text.slice(0, firstBreak).trim(), details: text.slice(firstBreak).trim(), full: text }
    : { tldr: text.slice(0, 280), details: text, full: text };
}

// Shape the agent's free-form answer into the data contract render_viz
// expects for chart_type:"report_card" (see src/kitchen/templates/report_card.js).
// We give Momo a directly-mountable card so she can do
//   render_viz({ chart_type:"report_card", data_refs:[finding_id], intent:"…" })
// without any reshaping. Stored via datasets.put under kind "browser_finding"
// — the prefix becomes "brow_" so ids are visually distinct.
function toReportCard(record) {
  const { tldr: tldrRaw, details } = parseFinalAnswer(record.result);
  const tldr = tldrRaw.replace(/\s+/g, " ").trim().slice(0, 280);
  // Split DETAILS into bullets — first try existing bullet/numbered
  // markers, then fall back to sentence boundaries. Cap at 8 bullets
  // since the card UI can't show much more than that legibly.
  const detailLines = details
    .split(/\n+/)
    .map((l) => l.replace(/^[\s>\-*•·]+|[\s]+$/g, ""))
    .filter(Boolean);
  const bullets = detailLines.length > 1
    ? detailLines.slice(0, 8)
    : (details
        .split(/(?<=[。！？!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8));

  return {
    title: record.label || "Browser finding",
    kicker: `BROWSER · ${(record.task || "").slice(0, 60)}`,
    tldr: tldr || "(no answer)",
    sections: [
      bullets.length > 1
        ? { heading: "FINDINGS", bullets }
        : { heading: "FINDINGS", body: details || tldr || "(no answer)" },
      {
        heading: "META",
        bullets: [
          record.sessionId ? `Session ${String(record.sessionId).slice(0, 8)}` : null,
          record.durationMs ? `${(record.durationMs / 1000).toFixed(1)}s · ${record.steps || record.progressSteps || "?"} steps` : null,
          record.replayUrl || replayUrlFor(record.sessionId) ? "Replay available on Browserbase dashboard" : null,
        ].filter(Boolean),
      },
    ],
    tags: ["browser", record.agentId].filter(Boolean),
  };
}

function persist(record) {
  // Only persist terminal records — running ones flap too fast and would
  // bloat the file. The on-disk row is a snapshot; the in-memory record
  // remains authoritative until it's evicted from the ring.
  if (record.status !== "done" && record.status !== "error") return;
  try {
    mkdirSync(dirname(HISTORY_PATH), { recursive: true });
    appendFileSync(HISTORY_PATH, JSON.stringify(serialise(record)) + "\n");
  } catch (err) {
    console.warn(`[browser_tasks] persist failed: ${err.message}`);
  }
}

// Hydrate the in-memory ring from disk on module load. Best-effort —
// missing/corrupt file is fine, we just start with an empty ring.
function loadFromDisk() {
  if (!existsSync(HISTORY_PATH)) return;
  try {
    const lines = readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
    // Take the most recent MAX_HISTORY entries (file is append-order).
    const tail = lines.slice(-MAX_HISTORY);
    for (const line of tail) {
      try {
        const r = JSON.parse(line);
        // Records on disk are already serialised; rehydrate enough to
        // satisfy `get()` and `list()` consumers.
        ring.push(r);
        byId.set(r.id, r);
      } catch { /* skip corrupt line */ }
    }
    // Reverse so the ring stays newest-first.
    ring.reverse();
    if (ring.length) {
      console.log(`[browser_tasks] hydrated ${ring.length} task(s) from ${HISTORY_PATH}`);
    }
  } catch (err) {
    console.warn(`[browser_tasks] load failed: ${err.message}`);
  }
}

loadFromDisk();

function newId() {
  return "btsk_" + randomUUID().replace(/-/g, "").slice(0, 10);
}

function deriveLabel(task) {
  const flat = String(task || "").replace(/\s+/g, " ").trim();
  return flat.split(/[,.!?;:\n]/)[0].slice(0, 64).toLowerCase();
}

function insert(record) {
  ring.unshift(record);
  if (ring.length > MAX_HISTORY) {
    const dropped = ring.pop();
    byId.delete(dropped.id);
  }
  byId.set(record.id, record);
}

function serialise(r) {
  return {
    id: r.id,
    agentId: r.agentId,
    label: r.label,
    task: r.task,
    origin: r.origin,
    status: r.status,
    runtime: "browserbase",
    sessionId: r.sessionId || null,
    liveViewUrl: r.liveViewUrl || null,
    fullscreenLiveViewUrl: r.fullscreenLiveViewUrl || null,
    replayUrl: replayUrlFor(r.sessionId),
    findingId: r.findingId || null,
    docId: r.docId || null,
    docUrl: r.docUrl || null,
    docError: r.docError || null,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    result: r.result,
    error: r.error,
    steps: r.steps,
    progressSummary: r.progressSummary,
    progressSteps: r.progressSteps,
    lastProgressAt: r.lastProgressAt,
  };
}

function emitEvent(kind, record, extra = {}) {
  bus.emit({
    kind,
    title: `${kind} · ${record.label}`,
    summary: summaryFor(kind, record),
    data: { ...serialise(record), ...extra },
  });
}

function summaryFor(kind, r) {
  if (kind === "task_spawn") return r.task.slice(0, 140);
  if (kind === "task_progress") return (r.progressSummary || r.status).slice(0, 200);
  if (kind === "task_complete") {
    return r.status === "done"
      ? (r.result || r.label).slice(0, 140)
      : `error: ${(r.error || "unknown").slice(0, 140)}`;
  }
  return r.label;
}

// ─── Public API ────────────────────────────────────────────────────────

export async function spawn({ task, label, slot, agent = "browser", origin = "momo" } = {}) {
  if (!task || typeof task !== "string") throw new Error("task (string) required");
  if (!bb.isConfigured()) {
    const reason = bb.missingConfigReason();
    const id = newId();
    const record = {
      id,
      agentId: agent,
      label: label || deriveLabel(task),
      task,
      origin,
      runtime: "browserbase",
      status: "error",
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 0,
      result: null,
      error: `Browserbase not configured: ${reason}`,
      steps: 0,
      progressSummary: null,
      progressSteps: 0,
      lastProgressAt: null,
      slot,
    };
    insert(record);
    emitEvent("task_spawn", record);
    emitEvent("task_complete", record);
    persist(record);
    return record;
  }

  const id = newId();
  const record = {
    id,
    agentId: agent,
    label: label || deriveLabel(task),
    task,
    origin,
    runtime: "browserbase",
    status: "spawning",
    sessionId: null,
    liveViewUrl: null,
    fullscreenLiveViewUrl: null,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    result: null,
    error: null,
    steps: 0,
    progressSummary: null,
    progressSteps: 0,
    lastProgressAt: null,
    // Seed the narration timer at spawn so the 12s gap suppresses
    // redundant chatter inside Momo's opening handoff line (the tool
    // response already instructs her to say "Atlas 去看看啦~" on return).
    lastNarrationAt: Date.now(),
    _narratedSummary: null,
    // Per-step assistant text accumulated as the agent works. Used as
    // the DETAILS fallback in the Google Doc when the agent's final
    // `done` message is just a meta-summary instead of the actual data.
    // Capped at 60 entries so a runaway loop can't blow memory.
    assistantTrail: [],
    slot,
  };
  insert(record);
  emitEvent("task_spawn", record);

  // Kick off the background run without blocking the caller.
  runTask(record).catch((err) => {
    // Safety net — all paths inside runTask should already have recorded
    // their own failures.
    console.error(`[browser_tasks] unexpected error for ${record.id}:`, err);
  });

  return record;
}

export function get(id) {
  const r = byId.get(id);
  return r ? serialise(r) : null;
}

export function list({ limit = 20, active = false } = {}) {
  const out = [];
  for (const r of ring) {
    if (active && r.status !== "running" && r.status !== "spawning") continue;
    out.push(serialise(r));
    if (out.length >= limit) break;
  }
  return out;
}

export function activeCount() {
  let n = 0;
  for (const r of ring) if (r.status === "running" || r.status === "spawning") n++;
  return n;
}

// ─── Runner ────────────────────────────────────────────────────────────

async function runTask(record) {
  // Stagehand manages the Browserbase session internally, so the flow
  // here is simpler than the old raw-SDK version: we hand the runner an
  // `onSessionReady` callback that fires once Stagehand has allocated
  // the session and we can surface liveViewUrl to the grid.
  //
  // Metadata stamped on the Browserbase session shows up at
  // browserbase.com/sessions so the dashboard rows are searchable by
  // omo task id / label instead of opaque UUIDs.
  const metadata = {
    taskId: record.id,
    label: record.label,
    agent: record.agentId,
    origin: record.origin,
    task: record.task.slice(0, 120),
  };
  // Per-task abort controller — fed by the no-UI-presence watchdog so a
  // user closing every browser tab eventually cancels the run instead of
  // letting a stale Browserbase session burn for the full 1-hour wall cap.
  const abortController = new AbortController();
  startNoUiWatchdog(record, abortController);
  try {
    const result = await runBrowserAgent({
      task: record.task,
      metadata,
      signal: abortController.signal,
      onSessionReady: ({ sessionId, liveViewUrl, fullscreenLiveViewUrl }) => {
        record.sessionId = sessionId;
        record.liveViewUrl = liveViewUrl;
        record.fullscreenLiveViewUrl = fullscreenLiveViewUrl;
        record.status = "running";
        record.progressSummary = "browser ready";
        record.progressSteps += 1;
        record.lastProgressAt = Date.now();
        // Re-announce task_spawn so subscribers (notably terminals.js)
        // get the liveViewUrl. The first emit happened before Stagehand
        // had a session — terminals.js uses taskId to dedupe, so this
        // is an update rather than a new record.
        emitEvent("task_spawn", record, { phase: "session_ready" });
        // Browserbase's debug() URL is per-page (per-tab). When the agent
        // opens a new tab or the active page rotates, the page id in the
        // URL goes stale and the iframe shows the previous tab. Poll
        // every 2s while running and re-emit task_spawn on change so the
        // grid swaps iframe.src to the current page.
        startLiveViewRefresh(record);
      },
      emit: (ev) => onRunnerEvent(record, ev),
    });

    record.endedAt = Date.now();
    record.durationMs = record.endedAt - record.startedAt;
    record.steps = result.steps || record.progressSteps;
    if (result.ok) {
      record.status = "done";
      record.result = result.answer || null;
      // Push the answer into the dataset store as a render-ready
      // report_card payload. Momo can then mount it on the hologram via
      // render_viz({ chart_type:"report_card", data_refs:[finding_id] })
      // — no reshaping in the kitchen, no second agent round-trip.
      // Failure here is non-fatal: dataset cache is in-memory only and
      // it's better to lose the card than to break the task_complete
      // event (per "tool calls have #1 priority").
      try {
        const card = toReportCard(record);
        record.findingId = datasets.put("browser_finding", card);
      } catch (err) {
        console.warn(`[browser_tasks] dataset put failed: ${err.message}`);
      }
      // Persist the answer to a Google Doc via the existing google_docs
      // connector — the user wanted every successful run archived as a
      // doc with its own title + body. Best-effort: failures (no refresh
      // token, API error) are recorded on the record but never rethrown,
      // so they can't break the task_complete event.
      await exportToGoogleDoc(record);
    } else {
      record.status = "error";
      record.error = result.error || "unknown error";
    }
    stopLiveViewRefresh(record);
    stopNoUiWatchdog(record);
    emitEvent("task_complete", record, completeExtras(record));
    persist(record);
  } catch (err) {
    record.endedAt = Date.now();
    record.durationMs = record.endedAt - record.startedAt;
    record.status = "error";
    record.error = err?.message || String(err);
    stopLiveViewRefresh(record);
    stopNoUiWatchdog(record);
    emitEvent("task_complete", record);
    persist(record);
  }
  // No explicit session release — Stagehand.close() inside runBrowserAgent
  // handles that in its finally block.
}

// Per-record live-view-URL refresh poller. Each running task gets its own
// interval so concurrent dispatches stay isolated. Errors from the debug
// API (transient 5xx during navigation, session-not-ready) are swallowed
// — the next tick will retry. Stopped on completion / error / timeout.
function startLiveViewRefresh(record) {
  stopLiveViewRefresh(record); // defensive: clear any prior poller
  record._liveViewPoller = setInterval(async () => {
    if (!record || record.status !== "running" || !record.sessionId) return;
    try {
      const debug = await bb.refreshDebug(record.sessionId);
      if (!debug?.debugUrl) return;
      if (debug.debugUrl !== record.liveViewUrl) {
        const oldPageId = pageIdFromDebugUrl(record.liveViewUrl);
        const newPageId = pageIdFromDebugUrl(debug.debugUrl);
        record.liveViewUrl = debug.debugUrl;
        record.fullscreenLiveViewUrl =
          debug.debuggerFullscreenUrl || record.fullscreenLiveViewUrl || null;
        console.log(
          `[browser_tasks] ${record.id} live view refreshed · session=${String(record.sessionId).slice(0, 8)} ` +
          `page=${oldPageId || "—"}→${newPageId || "—"}`,
        );
        // Re-emit task_spawn — terminals.js dedupes by taskId and treats
        // this as an update, swapping iframe.src on the grid via
        // applyLiveView (only if URL actually changed).
        emitEvent("task_spawn", record, { phase: "live_url_refreshed" });
      }
    } catch (err) {
      // Don't spam — debug() can flap during page transitions. Log once
      // per minute so we still see persistent failures.
      const now = Date.now();
      if (!record._lastDebugErrLog || now - record._lastDebugErrLog > 60_000) {
        record._lastDebugErrLog = now;
        console.warn(`[browser_tasks] ${record.id} refreshDebug failed: ${err?.message || err}`);
      }
    }
  }, LIVE_VIEW_REFRESH_MS);
  record._liveViewPoller.unref?.();
}

function stopLiveViewRefresh(record) {
  if (record?._liveViewPoller) {
    clearInterval(record._liveViewPoller);
    record._liveViewPoller = null;
  }
}

// No-UI-presence watchdog. While at least one client is connected to
// /omo/ws or /agents/ws, the task runs unrestricted. As soon as the
// combined client count drops to zero we start a grace timer; if it stays
// at zero for NO_UI_GRACE_MS, we abort the task. Any reconnect inside the
// window resets the timer. Disabled when NO_UI_GRACE_MS=0.
function startNoUiWatchdog(record, controller) {
  if (!NO_UI_GRACE_MS) return;
  record._noUiSince = uiClientCount() === 0 ? Date.now() : null;
  record._noUiPoller = setInterval(() => {
    if (controller.signal.aborted) return;
    const present = uiClientCount() > 0;
    if (present) {
      record._noUiSince = null;
      return;
    }
    if (record._noUiSince == null) {
      record._noUiSince = Date.now();
      return;
    }
    const idle = Date.now() - record._noUiSince;
    if (idle >= NO_UI_GRACE_MS) {
      console.warn(
        `[browser_tasks] ${record.id} aborting: no UI client for ${(idle / 60_000).toFixed(1)}min ` +
        `(grace=${(NO_UI_GRACE_MS / 60_000).toFixed(1)}min)`,
      );
      try { controller.abort(new Error("no UI presence")); } catch {}
      stopNoUiWatchdog(record);
    }
  }, NO_UI_POLL_MS);
  record._noUiPoller.unref?.();
}

function stopNoUiWatchdog(record) {
  if (record?._noUiPoller) {
    clearInterval(record._noUiPoller);
    record._noUiPoller = null;
  }
  record._noUiSince = null;
}

// Browserbase debug URLs end with `/devtools/page/<PAGE_ID>?...`. Extract
// just the PAGE_ID for log clarity ("page=ABC123→DEF456" beats two 200-
// char URL dumps).
function pageIdFromDebugUrl(url) {
  if (!url) return null;
  const m = String(url).match(/\/devtools\/page\/([A-F0-9]+)/i);
  return m ? m[1].slice(0, 8) : null;
}

// Build the title + body and create a Google Doc with the agent's full
// output. Stamps docId/docUrl/docError onto the record so the holo
// narration line + grid REPLAY-row can mention it.
async function exportToGoogleDoc(record) {
  if (!record.result) return; // nothing to save
  if (!gauth.hasRefreshToken()) {
    record.docError = "google not connected (no refresh token)";
    return;
  }
  const title = `[omo · ${record.agentId || "browser"}] ${record.label || record.task.slice(0, 60)}`;
  // Pull the agent's TLDR + DETAILS apart so the doc leads with the
  // headline, then has the full findings as the body. Falls back to:
  //   1. the per-step assistant trail (substantive reasoning the agent
  //      emitted while browsing — the actual data, not a meta-summary)
  //   2. the raw result if everything else is empty
  // The trail is the safety net for when the agent ignores TLDR/DETAILS
  // and just writes "I successfully navigated and compiled..." — without
  // it, the doc body was useless for research-type tasks.
  const { tldr, details, full } = parseFinalAnswer(record.result);
  const trail = Array.isArray(record.assistantTrail) ? record.assistantTrail.filter(Boolean) : [];
  const trailBody = trail.length ? trail.join("\n\n") : "";
  const resultBlocks = [];
  if (tldr) resultBlocks.push("TL;DR", tldr, "");
  if (details) {
    resultBlocks.push("Findings", details);
  } else if (trailBody) {
    resultBlocks.push("Findings (per-step transcript)", trailBody);
    if (!tldr && full) {
      resultBlocks.push("", "Final summary", full);
    }
  } else if (!tldr) {
    resultBlocks.push(full || "(no answer)");
  }
  const lines = [
    `Title: ${record.label || "(untitled)"}`,
    `Agent: ${record.agentId || "browser"} · runtime=browserbase`,
    `Task: ${record.task}`,
    record.sessionId ? `Session: ${record.sessionId}` : null,
    record.replayUrl || replayUrlFor(record.sessionId)
      ? `Replay: ${record.replayUrl || replayUrlFor(record.sessionId)}`
      : null,
    record.durationMs ? `Duration: ${(record.durationMs / 1000).toFixed(1)}s` : null,
    record.steps ? `Steps: ${record.steps}` : null,
    `Started: ${new Date(record.startedAt).toISOString()}`,
    record.endedAt ? `Finished: ${new Date(record.endedAt).toISOString()}` : null,
    "",
    "── Result ──",
    ...resultBlocks,
  ].filter((l) => l !== null);
  const body = lines.join("\n");
  try {
    const doc = await gdocs.createDoc({ title, content: body });
    record.docId = doc.docId;
    record.docUrl = doc.url;
    console.log(`[browser_tasks] exported ${record.id} → ${doc.url}`);
  } catch (err) {
    record.docError = err?.message || String(err);
    console.warn(`[browser_tasks] doc export failed for ${record.id}: ${record.docError}`);
  }
}

// Build the `extra` payload for task_complete so subscribers (holo
// narration, terminals, history) get the doc + finding refs in one shot.
function completeExtras(record) {
  const extras = {};
  if (record.findingId) extras.findingId = record.findingId;
  if (record.docId) extras.docId = record.docId;
  if (record.docUrl) extras.docUrl = record.docUrl;
  if (record.docError) extras.docError = record.docError;
  return extras;
}

function onRunnerEvent(record, ev) {
  if (!ev) return;
  const ts = Date.now();
  record.lastProgressAt = ts;
  record.progressSteps += 1;

  // Translate runner events into the same `turn` shape tasks.js emits so
  // terminals.js can render them identically. `priority` drives whether
  // we nudge Momo's voice:
  //   low  — tool_use and successful tool_result (too noisy to narrate)
  //   high — tool_result with isError (user needs to know)
  //   med  — assistant `think` text (narrated, gated by time gap + diff)
  let turn;
  let priority = "low";
  if (ev.phase === "tool_use") {
    turn = {
      role: "assistant",
      kind: "tool_use",
      toolName: ev.toolName || "action",
      toolInput: ev.toolInput || "",
      ts,
    };
    record.progressSummary = `${ev.toolName || "action"} ${ev.toolInput || ""}`.slice(0, 240);
  } else if (ev.phase === "tool_result") {
    turn = {
      role: "assistant",
      kind: "tool_result",
      snippet: ev.snippet || (ev.isError ? "error" : "ok"),
      isError: !!ev.isError,
      ts,
    };
    record.progressSummary = (ev.snippet || "").slice(0, 240);
    if (ev.isError) priority = "high";
  } else if (ev.phase === "text") {
    turn = {
      role: ev.role || "assistant",
      kind: "text",
      text: ev.text || "",
      ts,
    };
    record.progressSummary = (ev.text || "").slice(0, 240);
    if (ev.role !== "user") priority = "med";
    // Capture the agent's substantive reasoning for the doc archive.
    // Skip our own runner-emitted system lines (those start with "·"
    // and are decorative — proxy fallback notices, "browser ready",
    // Stagehand logger pass-throughs prefixed with "· [agent]") so
    // the trail only contains real model output.
    const text = String(ev.text || "").trim();
    const isSystemLine = text.startsWith("·") || text.startsWith("[stagehand:") || !text;
    if (ev.role !== "user" && !isSystemLine && Array.isArray(record.assistantTrail)) {
      record.assistantTrail.push(text);
      if (record.assistantTrail.length > 60) record.assistantTrail.shift();
    }
  } else {
    return;
  }

  const narrate = priority !== "low" && shouldNarrate(record, priority);
  if (narrate) record.lastNarrationAt = ts;

  emitEvent("task_progress", record, {
    phase: ev.phase,
    turn,
    narrate,
    source: "browserbase",
  });
}

function shouldNarrate(record, priority) {
  const now = Date.now();
  if (!record.lastNarrationAt) record.lastNarrationAt = 0;
  if (now - record.lastNarrationAt < NARRATION_MIN_GAP_MS) return false;
  if (priority === "high") return true;
  const prev = record._narratedSummary || "";
  const diff = roughDiffRatio(prev, record.progressSummary || "");
  if (diff >= SUMMARY_CHANGE_RATIO) {
    record._narratedSummary = record.progressSummary;
    return true;
  }
  return false;
}

function roughDiffRatio(a, b) {
  if (!a) return 1;
  if (a === b) return 0;
  const A = new Set(a.slice(0, 240));
  const B = new Set(b.slice(0, 240));
  const inter = [...A].filter((c) => B.has(c)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return 1 - inter / uni;
}

export function snapshot() {
  return {
    active: list({ limit: 20, active: true }),
    recent: list({ limit: 20 }),
    activeCount: activeCount(),
  };
}

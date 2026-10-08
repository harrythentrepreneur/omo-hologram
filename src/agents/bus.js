// src/agents/bus.js — agent event bus and message ring.
// Bridges agent events onto the shared Data Core event stream so they
// ride the existing /omo/ws fanout and the in-memory ring (visible in
// /omo/api/events?source=agents). Also keeps a dedicated 200-deep ring
// of agent-to-agent messages for the hydration endpoint.

import { randomUUID } from "node:crypto";

let emitToCore = null; // set by attachDataCore(dataCore)

const MAX_MESSAGES = 200;
const messageRing = []; // newest first

const localSubs = new Set();

export function attachDataCore(dataCore) {
  emitToCore = dataCore.emit ?? null;
}

export function subscribe(fn) {
  localSubs.add(fn);
  return () => localSubs.delete(fn);
}

function fanout(ev) {
  for (const fn of localSubs) {
    try { fn(ev); } catch {}
  }
}

// One public emit — every agent-layer event goes through here so there's
// a single seam to the Data Core and to local subscribers.
export function emit(ev) {
  const stamped = {
    id: ev.id || randomUUID(),
    source: "agents",
    ts: ev.ts || Date.now(),
    ...ev,
  };
  if (stamped.kind === "message" && stamped.data) {
    messageRing.unshift({ ...stamped.data, ts: stamped.ts });
    if (messageRing.length > MAX_MESSAGES) messageRing.length = MAX_MESSAGES;
  }
  if (emitToCore) {
    try { emitToCore(stamped); } catch {}
  }
  fanout(stamped);
  return stamped;
}

export function emitMessage(msg) {
  const data = { from: msg.from, to: msg.to, kind: msg.kind || "msg", text: msg.text };
  return emit({
    kind: "message",
    title: `${msg.from} → ${msg.to}`,
    summary: msg.text?.slice(0, 140) ?? "",
    data,
  });
}

export function emitAgentUpdate(patch) {
  return emit({
    kind: "agent_update",
    title: `agent ${patch.id} update`,
    summary: patch.task?.slice(0, 140) ?? "",
    data: patch,
  });
}

export function emitWorkflowUpdate(patch) {
  return emit({
    kind: "workflow_update",
    title: `workflow ${patch.id}`,
    summary: `${patch.state || ""} · ${patch.progress ?? ""}%`.trim(),
    data: patch,
  });
}

export function emitOrchUpdate(patch) {
  return emit({
    kind: "orch_update",
    title: "orchestrator update",
    summary: patch.workflow || patch.task || "",
    data: patch,
  });
}

export function emitBudgetUpdate(patch) {
  return emit({
    kind: "budget_update",
    title: "budget update",
    summary: patch.today != null ? `today $${patch.today.toFixed(2)}` : "",
    data: patch,
  });
}

export function listMessages({ limit = 50 } = {}) {
  return messageRing.slice(0, Math.max(1, Math.min(MAX_MESSAGES, limit | 0)));
}

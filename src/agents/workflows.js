// src/agents/workflows.js — predefined workflow templates + runtime state.
// Workflows are recipes the orchestrator can dispatch; each has an ordered
// sequence of legs (delegation steps). Advanced in place by the tick loop;
// state is broadcast via the bus on every state change.

import * as bus from "./bus.js";

export const TEMPLATES = {
  "weekly-intelligence-report": {
    label: "weekly-intelligence-report",
    description: "Wraps up the week: sources, analysis, digest, charts.",
    legs: [
      { to: "atlas",  text: "gather 7-day cross-source context · return top 10 signals" },
      { to: "prism",  text: "rank signals by customer-impact and recency · produce table id" },
      { to: "lumen",  text: "render hbar_rank for the top signals · palette cyan→pink" },
      { to: "quill",  text: "draft digest · lead with the biggest finding · ≤180 words" },
      { to: "warden", text: "review digest for claims without citations" },
      { to: "aurora", text: "merge and narrate" },
      { to: "pulse",  text: "log completion and schedule next run" },
    ],
  },
  "self-heal-docs": {
    label: "self-heal-docs",
    description: "Re-sync GLOSSARY.md / TEAM.md / AGENTS.md against current code.",
    legs: [
      { to: "atlas",  text: "diff docs vs src · flag stale sections" },
      { to: "cinder", text: "patch stale sections · do not rewrite tone" },
      { to: "warden", text: "verify no claims drift" },
    ],
  },
  "parallel-quality-gates": {
    label: "parallel-quality-gates",
    description: "Fan-out review: security, style, correctness in parallel.",
    legs: [
      { to: "warden", text: "security + sanitiser" },
      { to: "cinder", text: "style + duplication" },
      { to: "prism",  text: "correctness + edge-cases" },
      { to: "aurora", text: "merge verdict" },
    ],
    parallel: true,
  },
  "budget-audit": {
    label: "budget-audit",
    description: "Recompute spend, arbitrage, ceiling proximity.",
    legs: [
      { to: "pulse",  text: "pull 24h entries from budget.js" },
      { to: "prism",  text: "attribute cost by agent and tool" },
      { to: "quill",  text: "summarise in a 3-bullet note" },
    ],
  },
  "publish-pipeline": {
    label: "publish-pipeline",
    description: "Draft → review → publish loop.",
    legs: [
      { to: "atlas",  text: "gather recent dev-log entries" },
      { to: "quill",  text: "draft post" },
      { to: "warden", text: "review" },
      { to: "lumen",  text: "hero chart" },
      { to: "cinder", text: "publish via MDX file" },
    ],
  },
};

const ORDER = [
  "weekly-intelligence-report",
  "self-heal-docs",
  "parallel-quality-gates",
  "budget-audit",
  "publish-pipeline",
];

// Runtime mirror: { id, legs: "n / m legs", eta, progress, state }
export const runtime = ORDER.map((id) => ({
  id,
  label: TEMPLATES[id].label,
  total: TEMPLATES[id].legs.length,
  doneLegs: 0,
  legs: `0 / ${TEMPLATES[id].legs.length} legs`,
  eta: "queued",
  progress: 0,
  state: "queued",
}));

export function snapshot() {
  return runtime.map((w) => ({ ...w }));
}

export function getById(id) {
  return runtime.find((w) => w.id === id);
}

export function getTemplate(id) {
  return TEMPLATES[id];
}

export function start(id) {
  const w = getById(id);
  if (!w) return null;
  w.state = "running";
  w.doneLegs = 0;
  w.progress = 0;
  w.legs = `0 / ${w.total} legs`;
  w.eta = "in-flight";
  bus.emitWorkflowUpdate(w);
  return w;
}

export function advance(id, { progressNudge = 6 } = {}) {
  const w = getById(id);
  if (!w || w.state !== "running") return null;
  w.progress = Math.min(100, w.progress + progressNudge);
  const legsDone = Math.min(w.total, Math.floor((w.progress / 100) * w.total));
  if (legsDone > w.doneLegs) {
    w.doneLegs = legsDone;
    w.legs = `${w.doneLegs} / ${w.total} legs`;
  }
  w.eta = estimateEta(w);
  if (w.progress >= 100) {
    w.state = "done";
    w.eta = "done";
    w.doneLegs = w.total;
    w.legs = `${w.total} / ${w.total} legs`;
  }
  bus.emitWorkflowUpdate(w);
  return w;
}

export function queue(id) {
  const w = getById(id);
  if (!w) return null;
  w.state = "queued";
  w.progress = 0;
  w.doneLegs = 0;
  w.legs = `0 / ${w.total} legs`;
  w.eta = "queued";
  bus.emitWorkflowUpdate(w);
  return w;
}

function estimateEta(w) {
  const remaining = Math.max(0, 100 - w.progress);
  const secs = Math.max(10, Math.round((remaining / 100) * 60 * 4));
  if (secs > 120) return `ETA ${Math.round(secs / 60)}m`;
  return `ETA ${secs}s`;
}

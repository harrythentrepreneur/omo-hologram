// src/agents/orchestrator.js — hub-and-spoke dispatcher.
// Tick loop:
//   · advances active workflows
//   · fires realistic a2a messages between Aurora and specialists
//   · nudges per-agent progress, rotates tasks, charges their model on budget
//   · publishes everything through the bus so /hq (and any future
//     consumer) sees the same picture as the backend.
// This module is deliberately deterministic-ish: mock data, but the shape
// and cadence match what a real implementation would look like once we
// swap the tick body for real model / tool calls.

import * as bus from "./bus.js";
import * as budget from "./budget.js";
import * as workflows from "./workflows.js";
import { ORCHESTRATOR, AGENTS, getAgent, snapshotAgents, updateAgent } from "./registry.js";

const orchState = {
  workflow: "weekly-intelligence-report",
  task: "routing <em>weekly-intelligence-report</em> · 4 of 7 legs dispatched",
  inFlight: 4,
  bootTs: Date.now(),
  mode: "demo",
};

// ───────────────────────────────────────────────────────────── Realistic text

const DELEGATIONS = {
  atlas: [
    "pull community implementations of pattern B · return top 3 with links",
    "enumerate recent PRs touching src/kitchen · summarise each",
    "scan last 48h gmail for pricing-related threads",
  ],
  cinder: [
    "extract generator retry loop into its own module",
    "add eslint-style fix for unused imports in public/",
    "normalise emit() call sites in src/data_core.js",
  ],
  prism: [
    "segment stripe customers by lifecycle stage · return dataset id",
    "compute meta_ads CTR by creative over the last 7 days",
    "rank gmail senders by average reply-wait",
  ],
  quill: [
    "draft digest · lead with the churn finding · ≤180 words",
    "rewrite the release-note header to remove the word 'just'",
    "turn these three bullets into a single crisp paragraph",
  ],
  warden: [
    "audit viz.js allowlist · flag anything not in policy",
    "re-check the CSP on /viz/:id · suggest tightenings",
    "review per-agent sandbox rules for the new specialists",
  ],
  pulse: [
    "sample /omo/ws p95 · alert if over 500ms",
    "check ring buffer headroom · alert if under 10%",
    "verify GLOSSARY.md freshness",
  ],
  lumen: [
    "render kpi_grid for the weekly digest hero",
    "pick a palette that reads on glass reflectors",
    "rebuild hbar_rank with log scale when spread > 10x",
  ],
  echo: [
    "pre-warm 16kHz worklet",
    "listen for wake-word",
    "stand by for mic arm",
  ],
};

const DELIVERIES = {
  atlas: (w) => `delivered ${3 + Math.floor(Math.random() * 5)} sources for ${w}`,
  cinder: () => "patch staged · diff clean · no lint regressions",
  prism: () => `dataset ready · id prsm_${Math.random().toString(36).slice(2, 8)} · rows=${120 + Math.floor(Math.random() * 800)}`,
  quill: () => `draft v${1 + Math.floor(Math.random() * 3)} · ${120 + Math.floor(Math.random() * 80)}w · tone tight`,
  warden: () => "review done · 0 blocking · 2 nits · see trail",
  pulse: () => `ok · p95=${(0.12 + Math.random() * 0.3).toFixed(2)}s · headroom 38%`,
  lumen: () => `rendered · viz_id vz_${Math.random().toString(36).slice(2, 6)} · ready to mount`,
  echo: () => "transcript flushed · text in audio:transcript",
};

const ALERTS = [
  { from: "pulse", kind: "alert", text: "ws p95 drifted to 340ms (ceiling 500ms) · still green" },
  { from: "warden", kind: "review", text: "viz.js allowlist missing 'esm.sh/echarts-stat' · add before merge" },
  { from: "pulse", kind: "alert", text: "ring buffer 612 / 1000 · healthy" },
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function coin(p = 0.5) { return Math.random() < p; }

// Approximate per-model dollars per 1k tokens (output-weighted, rough).
const MODEL_RATE = {
  "claude-opus-4-7":       0.045,
  "claude-sonnet-4-6":     0.012,
  "claude-haiku-4-5":      0.004,
  "gemini-3-pro":          0.020,
  "gemini-3.1-flash":      0.006,
  "gemini-3.1-flash-lite": 0.003,
  "gemini-live-2.5":       0.015,
};

function chargeAgent(agent, tokens) {
  const rate = MODEL_RATE[agent.model] ?? 0.010;
  const usd = (tokens / 1000) * rate;
  budget.record({ agentId: agent.id, model: agent.model, usd });
  agent.cost = +(agent.cost + usd).toFixed(3);
}

// ───────────────────────────────────────────────────────────── Per-tick actions

function delegate(toId) {
  const agent = getAgent(toId);
  if (!agent) return;
  const text = pick(DELEGATIONS[toId] || ["do the thing"]);
  bus.emitMessage({ from: "aurora", to: toId, kind: "delegate", text });
  agent.task = text;
  agent.status = "active";
  orchState.inFlight = Math.min(7, orchState.inFlight + 1);
  bus.emitAgentUpdate({ id: agent.id, task: agent.task, status: agent.status });
}

function deliver(fromId) {
  const agent = getAgent(fromId);
  if (!agent) return;
  const text = (DELIVERIES[fromId] || (() => "delivered"))(orchState.workflow);
  bus.emitMessage({ from: fromId, to: "aurora", kind: "delivery", text });
  orchState.inFlight = Math.max(0, orchState.inFlight - 1);
}

function nudgeAgent(agent) {
  if (agent.status !== "active") {
    // small chance to wake from idle
    if (coin(0.03)) {
      agent.status = "active";
      agent.task = pick(DELEGATIONS[agent.id] || ["starting up"]);
      agent.progress = 6;
      bus.emitAgentUpdate({ id: agent.id, task: agent.task, status: agent.status, progress: agent.progress });
    }
    return;
  }
  const delta = Math.random() * 7 - 0.8;
  agent.progress = Math.min(100, Math.max(0, agent.progress + delta));
  const tokenSpend = Math.round(180 + Math.random() * 520);
  agent.tokens += tokenSpend;
  chargeAgent(agent, tokenSpend);

  if (agent.progress >= 100) {
    deliver(agent.id);
    agent.ran24h += 1;
    agent.progress = 6 + Math.random() * 16;
    agent.task = pick(DELEGATIONS[agent.id] || ["next task"]);
  }

  agent.avgLatency = +(Math.max(0.3, Math.min(4.5, agent.avgLatency + (Math.random() - 0.5) * 0.08))).toFixed(1);
  bus.emitAgentUpdate({
    id: agent.id,
    task: agent.task,
    progress: agent.progress,
    status: agent.status,
    tokens: agent.tokens,
    cost: agent.cost,
    ran24h: agent.ran24h,
    avgLatency: agent.avgLatency,
  });
}

function nudgeWorkflows() {
  const runtime = workflows.snapshot();
  const running = runtime.filter((w) => w.state === "running");
  if (running.length === 0) {
    // promote a queued one
    const queued = runtime.find((w) => w.state === "queued");
    if (queued) {
      workflows.start(queued.id);
      orchState.workflow = queued.id;
      orchState.task = `routing <em>${queued.id}</em> · dispatching legs`;
      bus.emitOrchUpdate({ workflow: orchState.workflow, task: orchState.task });
    }
    return;
  }
  for (const w of running) {
    const updated = workflows.advance(w.id, { progressNudge: 1 + Math.random() * 5 });
    if (updated?.state === "done") {
      bus.emitMessage({
        from: "aurora",
        to: "pulse",
        kind: "ack",
        text: `${updated.id} · done · ${updated.total} legs shipped`,
      });
    }
  }
  // active workflow + task copy
  const primary = running[0];
  if (primary && primary.id !== orchState.workflow) {
    orchState.workflow = primary.id;
  }
  const legsText = workflows.getById(orchState.workflow);
  if (legsText) {
    orchState.task = `routing <em>${orchState.workflow}</em> · ${legsText.doneLegs} of ${legsText.total} legs dispatched`;
    bus.emitOrchUpdate({
      workflow: orchState.workflow,
      task: orchState.task,
      inFlight: orchState.inFlight,
    });
  }
}

function maybeEmitAlert() {
  if (coin(0.18)) {
    const a = pick(ALERTS);
    bus.emitMessage(a);
  }
}

function maybeDelegate() {
  if (coin(0.45)) {
    const target = pick(AGENTS).id;
    delegate(target);
  }
}

function pushBudget() {
  const snap = budget.snapshot();
  bus.emitBudgetUpdate(snap);
}

// ───────────────────────────────────────────────────────────── Public API

export function snapshot() {
  const agents = snapshotAgents();
  const activeAgents = agents.filter((a) => a.status === "active").length;
  return {
    mode: orchState.mode,
    orchestrator: {
      ...ORCHESTRATOR,
      workflow: orchState.workflow,
      task: orchState.task,
      inFlight: orchState.inFlight,
      activeAgents,
      totalAgents: agents.length,
      uptimeMs: Date.now() - orchState.bootTs,
    },
    agents,
    workflows: workflows.snapshot(),
    budget: budget.snapshot(),
    arbitrage: budget.arbitrage(),
    recentMessages: bus.listMessages({ limit: 40 }),
  };
}

let loopTimers = [];

export async function start() {
  startDemo();
}

function startDemo() {
  orchState.mode = "demo";
  // seed arbitrage / budget
  budget.seed();
  // start with one workflow already running
  workflows.start("weekly-intelligence-report");
  workflows.start("self-heal-docs");
  orchState.bootTs = Date.now() - (14 * 3600 + 22 * 60) * 1000; // "14h 22m uptime"

  // seed stream
  const seed = [
    { from: "atlas",  to: "aurora", kind: "delivery", text: "delivered 12 sources for weekly-intelligence-report" },
    { from: "aurora", to: "prism",  kind: "delegate", text: "analyse stripe churn cohort · return dataset id" },
    { from: "prism",  to: "aurora", kind: "delivery", text: "cohort id prsm_9fa21c · 4.2% MoM churn, Team plan" },
    { from: "aurora", to: "quill",  kind: "delegate", text: "draft digest · lead with churn · ≤180 words" },
    { from: "pulse",  to: "aurora", kind: "alert",    text: "ws p95 latency 340ms · still green" },
    { from: "warden", to: "cinder", kind: "review",   text: "flag: viz.js allowlist missing echarts-stat" },
  ];
  const now = Date.now();
  seed.reverse().forEach((m, i) => bus.emitMessage({ ...m, ts: now - (i + 1) * 22_000 }));

  loopTimers.push(setInterval(nudgeWorkflows,    2400).unref?.());
  loopTimers.push(setInterval(() => { for (const a of AGENTS) nudgeAgent(a); }, 1800).unref?.());
  loopTimers.push(setInterval(maybeEmitAlert,    6000).unref?.());
  loopTimers.push(setInterval(maybeDelegate,     5200).unref?.());
  loopTimers.push(setInterval(pushBudget,        4000).unref?.());

  // first broadcast so late-subscribing clients see state
  bus.emitOrchUpdate({ workflow: orchState.workflow, task: orchState.task, inFlight: orchState.inFlight });
  pushBudget();
}

export function stop() {
  for (const t of loopTimers) clearInterval(t);
  loopTimers = [];
}

// Manual trigger for dev/testing — fire a synthetic message or kick a workflow.
export function trigger({ action, payload }) {
  if (action === "delegate" && payload?.to) {
    delegate(payload.to);
    return { ok: true };
  }
  if (action === "run_workflow" && payload?.id) {
    workflows.start(payload.id);
    return { ok: true };
  }
  if (action === "message" && payload?.from && payload?.to && payload?.text) {
    bus.emitMessage(payload);
    return { ok: true };
  }
  return { ok: false, error: "unknown action" };
}

// src/agents/index.js — public entry for the Master Agents backend.
//
// The Agents layer sits above the Data Core. It owns:
//   · an orchestrator (hub) that routes work to specialist agents (spokes)
//   · a message bus that bridges agent events onto the Data Core ring and
//     the shared /omo/ws fanout — consumers don't need a second socket
//   · a workflow engine with predefined templates
//   · a centralised budget / model-arbitrage tracker
//
// Boot from the server entry with:
//   import * as agents from "./src/agents/index.js";
//   agents.attach(dataCoreModule);    // bridge agent events → dataCore ring
//   agents.mountRoutes(app);          // /omo/api/agents/*
//   agents.start();                   // start tick loops

import * as bus from "./bus.js";
import * as orchestrator from "./orchestrator.js";
import * as workflows from "./workflows.js";
import * as budget from "./budget.js";
import * as terminals from "./terminals.js";
import { AGENTS, ORCHESTRATOR, getAgent } from "./registry.js";

export { bus, orchestrator, workflows, budget, terminals, AGENTS, ORCHESTRATOR };

let attached = false;

export function attach(dataCore) {
  bus.attachDataCore(dataCore);
  attached = true;
}

export async function start() {
  if (!attached) {
    console.warn("[agents] start() called before attach() — events won't reach the Data Core ring");
  }
  await orchestrator.start();
  const snap = orchestrator.snapshot();
  console.log(`[agents] mode=${snap.mode} · ${snap.agents.length} agent(s) · orchestrator=${ORCHESTRATOR.id}`);
}

export function snapshot() {
  return orchestrator.snapshot();
}

// ──────────────────────────────────────────────────────────────────── HTTP

export function mountRoutes(app) {
  // Full state snapshot — used by consumers on first paint and on
  // reconnect. Cheap to compute; can be polled.
  app.get("/omo/api/agents/state", (_req, res) => {
    res.json(orchestrator.snapshot());
  });

  // Terminal grid (4-slot view) — snapshot + slot metadata endpoints.
  // The live stream rides /agents/ws (mounted from server.js).
  terminals.mountRoutes(app);

  // Roster — lean listing for badges / tooltips / future admin UI.
  app.get("/omo/api/agents/roster", (_req, res) => {
    res.json({
      orchestrator: ORCHESTRATOR,
      agents: AGENTS.map((a) => ({
        id: a.id, name: a.name, role: a.role, model: a.model,
        color: a.color, tools: a.tools, tier: a.tier, description: a.description,
      })),
    });
  });

  // Workflow catalogue + runtime state.
  app.get("/omo/api/agents/workflows", (_req, res) => {
    const catalogue = {};
    for (const [id, tpl] of Object.entries(workflows.TEMPLATES)) {
      catalogue[id] = { id, label: tpl.label, description: tpl.description, legs: tpl.legs, parallel: !!tpl.parallel };
    }
    res.json({ catalogue, runtime: workflows.snapshot() });
  });

  // Recent agent-to-agent messages.
  app.get("/omo/api/agents/messages", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    res.json({ messages: bus.listMessages({ limit }) });
  });

  // Budget + arbitrage.
  app.get("/omo/api/agents/budget", (_req, res) => {
    res.json({ ...budget.snapshot(), arbitrage: budget.arbitrage() });
  });

  // Manual trigger — dev-only; gated behind AGENT_TRIGGER_ALLOW=1 since it
  // can synthesise messages and kick workflows.
  app.post("/omo/api/agents/trigger", (req, res) => {
    if (!process.env.AGENT_TRIGGER_ALLOW) {
      return res.status(403).json({ error: "set AGENT_TRIGGER_ALLOW=1 to enable" });
    }
    const result = orchestrator.trigger(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // Single-agent detail — wildcard route LAST so named routes win.
  app.get("/omo/api/agents/:id", (req, res) => {
    const a = getAgent(req.params.id);
    if (!a) return res.status(404).json({ error: "unknown agent" });
    res.json(a);
  });
}

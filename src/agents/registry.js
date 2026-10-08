// src/agents/registry.js — canonical specialist roster.
// Shared source of truth for agent identity, roles, models, colour, and
// per-agent runtime defaults. Loaded once at boot; mutated in place by
// the orchestrator as agents progress through work.

export const ORCHESTRATOR = {
  id: "aurora",
  name: "AURORA",
  role: "Orchestrator",
  model: "claude-opus-4-7",
  color: "#00e5ff",
  tier: 1,
  description:
    "Hub-and-spoke orchestrator. Never performs leaf work; routes to specialists via sessions_spawn and direct a2a messaging.",
};

export const AGENTS = [
  {
    id: "atlas",
    name: "Atlas",
    role: "Research · Web",
    model: "gemini-3.1-flash-lite",
    color: "#fbbf24",
    sigil: "A",
    tier: 2,
    tools: ["web_search", "web_fetch", "github_read", "docs_read"],
    description: "Wide-context research, web fetch, prior-art scouting.",
    task: "scanning 14 gh repos for multi-agent patterns",
    status: "active",
    progress: 12,
    tokens: 214_400,
    cost: 1.72,
    ran24h: 38,
    avgLatency: 1.9,
  },
  {
    id: "cinder",
    name: "Cinder",
    role: "Code · Refactor",
    model: "claude-sonnet-4-6",
    color: "#5eead4",
    sigil: "C",
    tier: 2,
    tools: ["read", "edit", "bash", "grep", "git"],
    description: "Code edits, refactors, package surgery, test scaffolding.",
    task: "refactoring src/kitchen/generator.js retry loop",
    status: "active",
    progress: 38,
    tokens: 182_900,
    cost: 2.41,
    ran24h: 22,
    avgLatency: 2.4,
  },
  {
    id: "prism",
    name: "Prism",
    role: "Data · Analysis",
    model: "claude-opus-4-7",
    color: "#a78bfa",
    sigil: "P",
    tier: 2,
    tools: ["get_orders", "get_products", "get_customers", "get_ads", "sql_readonly"],
    description: "Cohort analysis, rollups, correlation, data-tool composition.",
    task: "correlating stripe churn vs feature usage cohorts",
    status: "active",
    progress: 41,
    tokens: 338_200,
    cost: 4.92,
    ran24h: 17,
    avgLatency: 3.1,
  },
  {
    id: "quill",
    name: "Quill",
    role: "Writing · Comms",
    model: "claude-sonnet-4-6",
    color: "#ff66b3",
    sigil: "Q",
    tier: 2,
    tools: ["summarise", "draft_email", "edit_doc"],
    description: "Digests, drafts, tone, terse declarative copy.",
    task: "drafting weekly digest · 4 paragraphs so far",
    status: "active",
    progress: 28,
    tokens: 96_200,
    cost: 1.28,
    ran24h: 24,
    avgLatency: 1.7,
  },
  {
    id: "warden",
    name: "Warden",
    role: "Security · QA",
    model: "claude-opus-4-7",
    color: "#ef4444",
    sigil: "W",
    tier: 2,
    tools: ["read", "grep", "sanitiser_check"],
    description: "Threat modelling, allowlist audits, review of risky changes.",
    task: "reviewing src/tools/viz.js sanitiser allowlist",
    status: "active",
    progress: 76,
    tokens: 142_000,
    cost: 2.08,
    ran24h: 11,
    avgLatency: 2.8,
  },
  {
    id: "pulse",
    name: "Pulse",
    role: "Ops · Monitoring",
    model: "claude-haiku-4-5",
    color: "#8ab4f8",
    sigil: "P",
    tier: 2,
    tools: ["read_metric", "health_check", "alert"],
    description: "Cheap, constantly-on monitor; pages peers on anomalies.",
    task: "watching /omo/ws latency · 14 clients connected",
    status: "active",
    progress: 100,
    tokens: 48_700,
    cost: 0.21,
    ran24h: 147,
    avgLatency: 0.4,
  },
  {
    id: "lumen",
    name: "Lumen",
    role: "Visual · Charts",
    model: "gemini-3-pro",
    color: "#f472b6",
    sigil: "L",
    tier: 2,
    tools: ["render_viz", "highlight_viz", "dismiss_viz"],
    description: "Chart intents → ECharts iframes via the kitchen pipeline.",
    task: "rendering hbar_rank for weekly senders",
    status: "active",
    progress: 55,
    tokens: 74_900,
    cost: 0.96,
    ran24h: 19,
    avgLatency: 2.1,
  },
  {
    id: "echo",
    name: "Echo",
    role: "Voice · Dictation",
    model: "gemini-live-2.5",
    color: "#00e5ff",
    sigil: "E",
    tier: 2,
    tools: ["transcribe", "speak", "pcm_in"],
    description: "Gemini Live speech-to-speech channel for omo.",
    task: "standby · awaiting mic arm",
    status: "idle",
    progress: 0,
    tokens: 162_300,
    cost: 0.85,
    ran24h: 84,
    avgLatency: 0.6,
  },
];

const BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
BY_ID[ORCHESTRATOR.id] = ORCHESTRATOR;

export function getAgent(id) {
  return BY_ID[id];
}

export function snapshotAgents() {
  // deep-clone so callers can't mutate our internal state
  return AGENTS.map((a) => ({ ...a }));
}

export function updateAgent(id, patch) {
  const a = BY_ID[id];
  if (!a) return null;
  Object.assign(a, patch);
  return { ...a };
}

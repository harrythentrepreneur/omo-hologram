// src/agents/budget.js — centralised spend + model arbitrage tracker.
// Holds a rolling 24h window of cost entries keyed by (agentId, model)
// so we can produce the arbitrage breakdown without walking the event
// ring. Ceiling is soft — over-ceiling triggers a warning message from
// Pulse; it does not hard-gate anything yet.

const DAY_MS = 24 * 60 * 60 * 1000;

const state = {
  ceiling: Number(process.env.AGENT_DAY_CEILING_USD) || 40,
  runwayUsdPerMonth: 1200, // assumed monthly envelope
  entries: [], // { ts, agentId, model, usd }
};

// per-model colour used by arbitrage-bar consumers — kept server-side
// so the backend is the single source of truth.
const MODEL_COLOR = {
  "claude-opus-4-7":       "#00e5ff",
  "claude-sonnet-4-6":     "#5eead4",
  "claude-haiku-4-5":      "#8ab4f8",
  "gemini-3-pro":          "#f472b6",
  "gemini-3.1-flash":      "#fbbf24",
  "gemini-3.1-flash-lite": "#fbbf24",
  "gemini-live-2.5":       "#00e5ff",
};

export function record({ agentId, model, usd }) {
  if (!Number.isFinite(usd) || usd <= 0) return;
  state.entries.push({ ts: Date.now(), agentId, model, usd });
  const cutoff = Date.now() - DAY_MS;
  while (state.entries.length && state.entries[0].ts < cutoff) state.entries.shift();
}

export function today() {
  const cutoff = Date.now() - DAY_MS;
  let sum = 0;
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.ts < cutoff) break;
    sum += e.usd;
  }
  return +sum.toFixed(2);
}

export function arbitrage() {
  const cutoff = Date.now() - DAY_MS;
  const byModel = new Map();
  let total = 0;
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e.ts < cutoff) break;
    const cur = byModel.get(e.model) || { cost: 0 };
    cur.cost += e.usd;
    byModel.set(e.model, cur);
    total += e.usd;
  }
  const rows = [];
  for (const [model, row] of byModel) {
    rows.push({
      label: model,
      cost: +row.cost.toFixed(2),
      pct: total > 0 ? Math.round((row.cost / total) * 100) : 0,
      color: MODEL_COLOR[model] || "#00e5ff",
    });
  }
  rows.sort((a, b) => b.cost - a.cost);
  return rows;
}

export function snapshot() {
  const spendToday = today();
  const burnPerHour = spendToday / 24;
  // rough runway calc: monthly envelope / projected daily spend / remaining
  const runwayDays = burnPerHour > 0
    ? Math.max(1, Math.round(state.runwayUsdPerMonth / (burnPerHour * 24)))
    : 999;
  return {
    today: spendToday,
    ceiling: state.ceiling,
    burnPerHour: +burnPerHour.toFixed(3),
    runwayDays,
    overBudget: spendToday > state.ceiling,
    pctCeiling: state.ceiling > 0 ? +Math.min(100, (spendToday / state.ceiling) * 100).toFixed(1) : 0,
  };
}

// Seed with a realistic 24h backfill so consumers aren't empty on boot.
export function seed() {
  const now = Date.now();
  const seeds = [
    ["prism",  "claude-opus-4-7",       5.2],
    ["warden", "claude-opus-4-7",       2.0],
    ["cinder", "claude-sonnet-4-6",     2.4],
    ["quill",  "claude-sonnet-4-6",     1.3],
    ["atlas",  "gemini-3.1-flash-lite", 1.7],
    ["lumen",  "gemini-3-pro",          3.1],
    ["pulse",  "claude-haiku-4-5",      0.2],
    ["echo",   "gemini-live-2.5",       0.85],
  ];
  for (const [agentId, model, usd] of seeds) {
    state.entries.push({ ts: now - Math.floor(Math.random() * DAY_MS * 0.8), agentId, model, usd });
  }
  state.entries.sort((a, b) => a.ts - b.ts);
}

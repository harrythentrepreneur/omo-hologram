// src/tools/agent_status.js
//
// Returns the current state of the squad office: who's there right now,
// who's busy, who's idle (lingering), and what each one is working on.
// Designed for Momo to call when the user asks via voice — e.g.
// "Who's working right now?", "What is Nimbus up to?", "Who's free?".

import * as hermes from "../../hermes/index.js";

function fmtElapsed(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + "m" + (r < 10 ? "0" : "") + r + "s";
}

function summariseAgent(a, now) {
  const name = a.name;
  const status = a.status || "idle";
  if (status === "running" || status === "dispatching") {
    const started = a.current_task?.startedAt || a.last_activity_at;
    const elapsed = fmtElapsed(now - (started || now));
    const task = a.current_task?.prompt || "(unknown task)";
    return `${name} — working on "${task}"${elapsed ? " · " + elapsed : ""}`;
  }
  if (status === "done") {
    const ago = fmtElapsed(now - (a.last_activity_at || now));
    return `${name} — done${ago ? ", finished " + ago + " ago" : ""}, lingering`;
  }
  if (status === "error") {
    return `${name} — last task failed`;
  }
  return `${name} — idle, hanging around`;
}

export const definition = {
  type: "function",
  name: "agent_status",
  description:
    "Snapshot of the squad office: which agents are on stage right now, what each is doing, and who's idle (lingering after a finished task). Call this when the user asks who's busy / what they're working on / who's free, or before suggesting which agent to call back. Each entry includes status, current_task, elapsed and a one-line summary you can narrate. Cheap to call.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Optional — filter to a specific agent (by name or agent_id). If omitted, returns every agent currently on stage.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const now = Date.now();
  let agents;
  try {
    agents = hermes.listAgents() || [];
  } catch (err) {
    return {
      error: "agents not available",
      detail: String(err?.message || err),
    };
  }

  const ref = args?.agent ? String(args.agent).trim() : null;
  if (ref) {
    const lower = ref.toLowerCase();
    agents = agents.filter(
      (a) => a.agent_id === ref || a.name?.toLowerCase() === lower,
    );
  }

  const enriched = agents.map((a) => ({
    agent_id: a.agent_id,
    name: a.name,
    color: a.color,
    sigil: a.sigil,
    seat: a.seat,
    status: a.status,
    current_task: a.current_task?.prompt || null,
    task_id: a.current_task?.id || null,
    session_id: a.session_id || null,
    started_at: a.current_task?.startedAt || null,
    elapsed_ms:
      a.status === "running" && a.current_task?.startedAt
        ? now - a.current_task.startedAt
        : null,
    summary: summariseAgent(a, now),
  }));

  const lines = enriched.map((a) => "• " + a.summary);
  const running = enriched.filter((a) => a.status === "running" || a.status === "dispatching").length;
  const idle = enriched.filter((a) => a.status === "idle" || a.status === "done").length;

  if (enriched.length === 0) {
    return {
      agents: [],
      running: 0,
      idle: 0,
      summary: "no agents on stage right now",
      note: ref
        ? `No agent matching "${ref}" is on stage. Tell the user they've left or were never spawned, and offer to spawn one.`
        : "Tell the user the office is empty right now and offer to spawn one with spawn_agent_task.",
    };
  }

  return {
    agents: enriched,
    running,
    idle,
    summary: lines.join("\n"),
    note:
      ref
        ? "Read the matching summary line back to the user, naturally."
        : "Read the lines back conversationally — don't read the bullets verbatim. If the user asked who's free, list only the idle ones.",
  };
}

// src/tools/stop_agent.js
//
// Voice tool: SIGTERM a running agent. Resolves the user's free-form
// reference (callsign or agent_id) via hermes.resolveActiveAgent then
// calls interruptAgent — same code path the red "stop" button on the
// /squad monitor uses.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "./agent_context.js";

export const definition = {
  type: "function",
  name: "stop_agent",
  description:
    "Stop a running background agent. Sends SIGTERM (then SIGKILL after 1s if it doesn't exit). Use when the user asks to stop / cancel / kill / interrupt an agent's task — e.g. \"stop cinder\", \"叫 Nimbus 停下来\", \"cancel that\", \"kill the task\", \"打住\". Pass the agent's callsign or agent_id when named; otherwise omit it and the focused /feather tile is used. Only stops the SPECIFIC agent — not the whole squad. The agent's last partial work stays visible in the monitor.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Which agent to stop. Accepts the callsign Momo gave the worker (e.g. 'Nimbus') or the agent_id. Case-insensitive; prefix match works.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) {
    return {
      error: "missing agent reference",
      note: "Tell the user which agent to stop — name/id, or focus a /feather tile first.",
    };
  }
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length === 0) {
    return {
      error: `no active agent matches "${ref}"`,
      note: "Tell the user that agent isn't running — nothing to stop. Don't fabricate a stop confirmation.",
    };
  }
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Ask the user WHICH one to stop — read their full callsigns. Don't guess; stopping the wrong agent is destructive.",
    };
  }
  const match = matches[0];
  let ok = false;
  try {
    ok = hermes.interruptAgent(match.agent_id);
  } catch (err) {
    return {
      error: String(err?.message || err),
      note: "Could not stop the agent — quote the error plainly.",
    };
  }
  if (!ok) {
    return {
      agent_id: match.agent_id,
      name: match.name,
      ok: false,
      note: `${match.name} wasn't actually running — nothing to stop. Tell the user gently.`,
    };
  }
  return {
    agent_id: match.agent_id,
    name: match.name,
    ok: true,
    note:
      "Say one short cute line confirming the stop in the SAME language the user just used, like '好嘞~ 已经叫 " +
      match.name +
      " 停下来啦~' or \"stopped " +
      match.name +
      " ✋\". One sentence — don't explain SIGTERM.",
  };
}

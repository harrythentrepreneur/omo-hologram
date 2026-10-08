// src/tools/stop_all_agents.js
//
// Voice tool: SIGTERM every running agent. Panic-stop for runaway-cost
// or "we're heading down the wrong path" moments. Use ONLY on explicit
// "stop everyone / 全部停 / kill them all" phrasing — single-agent stop
// goes through stop_agent.

import * as hermes from "../../hermes/index.js";

export const definition = {
  type: "function",
  name: "stop_all_agents",
  description:
    "SIGTERM every running agent at once. Panic-stop for 'something's gone wrong, halt the squad'. Only call on EXPLICIT stop-everyone phrasing — '全部停下' / 'stop everyone' / 'kill all of them' / '都停了' / 'halt the squad'. NEVER infer this from a single-agent stop request — if the user names one agent, use stop_agent({agent}) instead. Returns the list it actually signaled.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export async function run() {
  let stopped;
  try {
    stopped = hermes.interruptAllAgents();
  } catch (err) {
    return {
      error: String(err?.message || err),
      note: "Could not stop the squad — quote the error plainly.",
    };
  }
  if (!stopped || stopped.length === 0) {
    return {
      ok: true,
      stopped: [],
      count: 0,
      note: "No agents were running. Tell the user gently — don't fabricate a stop.",
    };
  }
  const names = stopped.map((s) => s.name).join(", ");
  return {
    ok: true,
    stopped,
    count: stopped.length,
    note:
      "Say one short cute line confirming the stop in the SAME language the user just used. Name them like '已经叫 " +
      names +
      " 都停下来啦~' or \"stopped " +
      names +
      " ✋\". One sentence — don't list agent_ids.",
  };
}

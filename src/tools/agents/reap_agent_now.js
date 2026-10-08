// src/tools/reap_agent_now.js — force-reap an agent NOW.
//
// Voice equivalent of the /squad "Reap" button on the worktrees panel.
// Different from stop_agent: stop_agent kills the running task and lets
// the agent linger; reap_agent_now tears down the seat AND the worktree.
// Use when the user wants the workspace gone — typically after they've
// accepted (and the work is now in main, so the worktree is redundant)
// or when an agent has been idle for too long and they want a clean slate.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "./agent_context.js";

export const definition = {
  type: "function",
  name: "reap_agent_now",
  description:
    "Tear down an agent's seat and workspace immediately — don't wait for the linger timer. Use when the user is done with that agent's work and wants to free the seat: 'reap Reed', 'send her home', 'I'm done with that workspace', 'clean up Wren', '把 Reed 送走', '清理一下'. If the user says this while looking at /feather, omit `agent` and the focused tile is used. Pass force:true to interrupt a running task first (otherwise we refuse on a busy agent). NOT for 'stop her task but keep her seated' — that's stop_agent.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent callsign or agent_id.",
      },
      force: {
        type: "boolean",
        description: "If true, SIGTERM the running task before reaping. Default false — refuse if busy.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) return { error: "missing agent reference", note: "Ask the user which agent to reap, or have them focus a /feather tile first." };

  const result = hermes.reapAgentNow(ref, { force: !!args?.force });
  if (!result.ok) {
    if (result.code === "AGENT_BUSY") {
      return {
        ...result,
        note: "Tell the user that agent is still working. Offer to (a) wait, (b) force-reap with force:true (kills the task too), or (c) stop_agent first then retry.",
      };
    }
    if (result.code === "AMBIGUOUS") {
      return {
        ...result,
        note: "Ask the user WHICH agent.",
      };
    }
    if (result.code === "NO_AGENT") {
      return {
        ...result,
        note: "Tell the user that agent isn't around (already reaped, never existed, or the name is wrong).",
      };
    }
    return { ...result, note: "Quote the error plainly." };
  }
  return {
    ok: true,
    agent_id: result.agent_id,
    agent_name: result.name,
    note:
      "Confirm in one cute sentence — name the agent. Their workspace is gone; seat is free for someone new.",
  };
}

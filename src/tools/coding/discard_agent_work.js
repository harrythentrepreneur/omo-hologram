// src/tools/discard_agent_work.js — reset an agent's worktree.
//
// `git reset --hard HEAD && git clean -fdx`. Destroys whatever the agent
// did since the worktree's baseline. The agent is left in place (seat
// preserved, identity preserved) so the user can dispatch a new task to
// the same agent with a clean slate.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "../agents/agent_context.js";

export const definition = {
  type: "function",
  name: "discard_agent_work",
  description:
    "Throw away everything an agent has done since their last clean baseline. Use ONLY on explicit reject: \"scrap that\", \"throw it away\", \"undo Reed\", \"撤回 Reed 的\", \"nah, restart\". If the user says \"scrap that\" while looking at /feather, omit `agent` and the focused tile is used. Agent must be idle (no force option — discarding mid-task is what stop_agent + this combo is for). Does NOT remove the agent — they stay seated for a follow-up task. Returns the files that were cleared.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent callsign or agent_id.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) return { error: "missing agent reference", note: "Ask the user which agent's work to scrap, or have them focus a /feather tile first." };

  const result = hermes.discardAgentWork(ref);

  if (!result.ok) {
    const code = result.code;
    if (code === "AGENT_BUSY") {
      return {
        error: result.error,
        code,
        note: "Tell the user the agent is still working — stop them first with stop_agent, then scrap.",
      };
    }
    if (code === "NO_WORKTREE") {
      return {
        error: result.error,
        code,
        note: "Tell the user that agent has no workspace to clean.",
      };
    }
    if (code === "NO_AGENT" || code === "AMBIGUOUS") {
      return {
        error: result.error,
        candidates: result.candidates || null,
        note: code === "AMBIGUOUS" ? "Ask WHICH agent." : "Tell the user that agent isn't around.",
      };
    }
    return {
      error: result.error || "discard failed",
      code,
      note: "Quote the error plainly.",
    };
  }

  const files = result.files_cleared || [];
  const count = files.length;
  return {
    ok: true,
    agent_id: result.agent_id,
    agent_name: result.agent_name,
    files_cleared: files,
    stat: result.stat,
    summary: count === 0
      ? `${result.agent_name}'s workspace was already clean.`
      : `cleared ${count} file${count === 1 ? "" : "s"} from ${result.agent_name}'s workspace.`,
    note:
      count === 0
        ? "Tell the user gently — nothing was there to scrap."
        : "Confirm in one cute sentence: name the agent and the file count. They're still seated and ready for the next task.",
  };
}

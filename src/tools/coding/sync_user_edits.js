// src/tools/sync_user_edits.js — copy the user's uncommitted edits into
// an agent's worktree so the agent can "finish what I started".
//
// Without this, the agent's worktree starts at HEAD and never sees the
// user's in-progress work. With it: agent picks up exactly where the
// user paused — even on files the user hasn't committed yet.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "../agents/agent_context.js";

export const definition = {
  type: "function",
  name: "sync_user_edits",
  description:
    "Copy the user's uncommitted edits (in the main checkout) into an agent's workspace BEFORE dispatching. Use when the user says things like 'have Reed finish what I started', 'pass my changes to Wren', '让 Cinder 接着改我的'. If the user says 'sync this' while looking at /feather, omit `agent` and the focused tile is used. Call this right before spawn_agent_task / continue_agent_task so the agent's first read of the file shows the user's latest state — not just HEAD. Fails if the agent's workspace isn't clean enough to take the patch (caller should discard_agent_work first).",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent callsign or agent_id whose workspace to sync into.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) return { error: "missing agent reference", note: "Ask the user which agent to hand work to, or have them focus a /feather tile first." };

  const result = await hermes.syncUserEdits(ref);
  if (!result.ok) {
    const code = result.code;
    if (code === "AGENT_BUSY") {
      return {
        error: result.error,
        code,
        note: "Tell the user the agent is busy — sync only works between tasks.",
      };
    }
    if (code === "NO_WORKTREE") {
      return {
        error: result.error,
        code,
        note: "Tell the user that agent has no isolated workspace — there's nothing to sync into.",
      };
    }
    if (code === "CONFLICT") {
      return {
        error: result.error,
        code,
        stderr: result.stderr,
        note: "Tell the user the agent's workspace already has overlapping edits. Offer to scrap them first (discard_agent_work) then sync.",
      };
    }
    if (code === "BASELINE_FAILED") {
      return {
        error: result.error,
        code,
        note: "Tell the user the handoff copied files but could not make a clean baseline, so we should not continue until that is fixed.",
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
      error: result.error || "sync failed",
      code,
      note: "Quote the error plainly. Don't claim it worked.",
    };
  }

  const files = result.files || [];
  if (files.length === 0) {
    return {
      ok: true,
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      files: [],
      summary: "no uncommitted edits to sync",
      note: "Tell the user gently — there's nothing in their checkout to hand over.",
    };
  }
  return {
    ok: true,
    agent_id: result.agent_id,
    agent_name: result.agent_name,
    files,
    stat: result.stat,
    summary: `synced ${files.length} file${files.length === 1 ? "" : "s"} into ${result.agent_name}'s workspace`,
    note:
      "Confirm in one cute sentence. Then encourage the user to give the agent the next task — spawn_agent_task or continue_agent_task — so the work picks up from where they left off.",
  };
}

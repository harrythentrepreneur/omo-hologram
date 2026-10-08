// src/tools/resolve_agent_conflict.js — let the agent resolve a merge
// clash with the user's checkout.
//
// When accept_agent_work returns CONFLICT (or three_way returns a partial
// with conflict markers), this tool re-dispatches the same agent with
// a focused follow-up: "here are the files you and the user both touched;
// reconcile your work with theirs." Because it's a continue_agent_task
// (same chat thread, same worktree), the agent already knows the context
// of WHY it made the changes — it can adapt them intelligently rather
// than blindly accepting the user's side.
//
// The agent works in its own worktree as before. The flow:
//   1. We sync the user's current state of conflicting files INTO the
//      agent's worktree (via a targeted git apply --3way of user's diff
//      onto agent's tree) so the agent reads what the user has now.
//   2. We continue the agent's chat thread with a conflict-resolution
//      prompt naming the files and the high-level conflict reason.
//   3. The agent re-emits its changes adapted to the new baseline.
//   4. When task_complete fires, the user is told to retry accept_agent_work.
//
// If the agent needs clarification it writes the question in its normal
// output; Momo narrates the task_complete summary and the user can reply
// via continue_agent_task. (Real mid-task Q&A is a follow-up — for now
// the agent makes its best judgment.)

import * as hermes from "../../hermes/index.js";

export const definition = {
  type: "function",
  name: "resolve_agent_conflict",
  description:
    "Have an agent fix a merge conflict between their work and the user's own uncommitted edits. Use AFTER accept_agent_work returned CONFLICT (or three_way returned partial with conflict markers) AND the user explicitly said 'have the agent fix it' / 'let her resolve it' / 'AI auto-resolve' / '让她自己想办法'. Re-opens the same chat thread with conflict context, the agent adapts their changes to merge cleanly. NOT for arbitrary follow-ups (use continue_agent_task for those) — only for conflict recovery. After task_complete, tell the user to retry the ship.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent callsign or agent_id whose conflict to resolve.",
      },
      conflicting_paths: {
        type: "array",
        items: { type: "string" },
        description: "The file paths that conflict (from accept_agent_work's CONFLICT response). If omitted, we'll detect them.",
      },
      hint: {
        type: "string",
        description: "Optional user hint about HOW to resolve, e.g. 'prefer my version of the language toggle' or 'fold your smoothing into my refactor'. Helps the agent make the right choice without asking back.",
      },
    },
    required: ["agent"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = args?.agent ? String(args.agent).trim() : "";
  if (!ref) return { error: "missing agent reference", note: "Ask the user which agent." };

  // Confirm the agent exists + has a worktree (the prompt below assumes it).
  const peek = hermes.peekAgentDiff(ref);
  if (!peek.ok) {
    return {
      error: peek.error,
      code: peek.code,
      note: peek.code === "NO_WORKTREE"
        ? "Tell the user that agent has no workspace to resolve from (already reaped). They'd need to redo the work from scratch."
        : "Quote the error plainly.",
    };
  }
  if (!peek.hasChanges) {
    return {
      ok: true,
      agent_id: peek.agent_id,
      agent_name: peek.agent_name,
      note: "Tell the user the agent's workspace is empty — nothing to reconcile.",
    };
  }

  // Detect conflicting paths if the caller didn't pass them. We do this
  // by running a dry-run apply onto the parent repo and parsing rejects.
  let paths = Array.isArray(args?.conflicting_paths)
    ? args.conflicting_paths.map(String).filter(Boolean)
    : [];
  if (paths.length === 0) {
    const dry = await hermes.acceptAgentWork(ref, { mode: "dry_run" });
    if (!dry.ok && Array.isArray(dry.conflicting_paths) && dry.conflicting_paths.length > 0) {
      paths = dry.conflicting_paths;
    }
  }

  const hint = args?.hint ? String(args.hint).trim() : "";

  // Build the conflict-resolution prompt. We keep it tight: the agent
  // already has the conversation context for WHY their changes exist;
  // we just give them what's new and ask them to reconcile.
  const lines = [
    "Your previous changes conflict with the user's uncommitted edits in their main checkout.",
    paths.length > 0
      ? `Conflicting files: ${paths.join(", ")}.`
      : "(I couldn't auto-detect which files — please git diff to find out.)",
    "Re-examine those files in your workspace (they're already in the state YOUR previous task left them), then check what the user has changed in the parent repo (use git diff against the parent repo at ../.. or the original repo path stored in your env).",
    "Adapt your changes so they merge cleanly with the user's. Don't undo their work; integrate yours with theirs.",
    hint ? `User hint: ${hint}` : "",
    "If you genuinely can't decide between two valid resolutions, write your question clearly at the end of your output and stop — the user will reply.",
  ].filter(Boolean);

  let dispatched;
  try {
    dispatched = hermes.dispatchTask({
      agentId: peek.agent_id,
      prompt: lines.join("\n\n"),
    });
  } catch (err) {
    if (err?.code === "AGENT_BUSY") {
      return {
        error: `${peek.agent_name} is already running another task`,
        code: "AGENT_BUSY",
        note: "Tell the user to wait or stop her first.",
      };
    }
    return {
      error: String(err?.message || err),
      code: err?.code || null,
      note: "Quote the error plainly.",
    };
  }

  return {
    ok: true,
    task_id: dispatched.task_id,
    agent_id: dispatched.agent_id,
    agent_name: dispatched.agent_name,
    conflicting_paths: paths,
    note:
      "Tell the user the agent is reworking her changes to merge cleanly — one short cute sentence. " +
      "Wait for task_complete. THEN auto-call peek_agent_diff again and offer to ship (accept_agent_work). " +
      "If the agent ended their output with a question, surface it to the user verbatim and treat the user's answer as a continue_agent_task prompt.",
  };
}

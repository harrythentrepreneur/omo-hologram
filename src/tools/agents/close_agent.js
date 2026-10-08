// close_agent — voice-friendly "close that terminal" / "close X" /
// "close everyone" tool. Thin wrapper around hermes.reapAgentNow with
// three smart-default behaviours:
//
//   1) `agent` named explicitly → reap that one
//   2) `all:true`               → reap every seated agent (or only idle
//                                  ones if `idle_only:true` is also set)
//   3) neither                  → reap whichever agent the user has
//                                  focused on /feather (via momoView)
//
// **Not** to be confused with close_agent_screen (which just hides the
// pane on the hologram — agent stays alive in the background). This is
// the full teardown: SIGTERM the task if needed, free the seat, remove
// the worktree. Persona instructs Momo to disambiguate by phrasing —
// "close the terminal" / "close her" / "close everyone" → here;
// "close that pane / hide it / 收起来" → close_agent_screen.

import * as hermes from "../../hermes/index.js";
import * as momoView from "../../momo/view.js";
import * as dataCore from "../../data_core.js";

// Tell /feather to re-reconcile its tile list against the server. Fires
// after every close_agent run so named-but-already-gone ghosts get swept
// off the screen too — not just the agents we actually reaped.
function nudgeFeatherReconcile() {
  try {
    dataCore.emit({
      source: "feather",
      kind: "action",
      data: { action: "reconcile" },
    });
  } catch {}
}

export const definition = {
  type: "function",
  name: "close_agent",
  description: [
    "Close (reap) one or more agents — frees the seat AND tears down the worktree.",
    "Use this when the user says any of:",
    "  • 'close the Atlas terminal' / 'close Cinder' / 'close Reed' / '关掉 Reed 的终端' / '把 Atlas 关了' → agent:'<name>'",
    "  • 'close this' / 'close that one' / 'close this terminal' / '关掉这个' (no name) → omit agent (defaults to the focused tile on /feather)",
    "  • 'close all' / 'close everyone' / 'close every terminal' / '全部关掉' / '都关掉' → all:true",
    "  • 'close all the idle ones' / 'close idle terminals' / '关掉空闲的' → all:true, idle_only:true",
    "If the agent is busy, the tool refuses (AGENT_BUSY); call again with force:true after confirming with the user.",
    "If the agent has unaccepted work (changes in her worktree), still allow close but mention it in your confirmation so the user knows the work is going away.",
    "NOT for 'just stop her current task but keep the seat' — that's stop_agent.",
    "NOT for 'hide the pane on screen' — that's close_agent_screen.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Agent name or id. Optional — defaults to the focused tile on /feather. Ignored when all:true.",
      },
      all: {
        type: "boolean",
        description: "If true, reap every seated agent at once.",
      },
      idle_only: {
        type: "boolean",
        description:
          "Only used together with all:true — skips agents currently running a task.",
      },
      force: {
        type: "boolean",
        description:
          "If true, SIGTERM the running task before reaping (use only after the user confirms killing a busy agent's work).",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const all = !!args?.all;
  const force = !!args?.force;
  const idleOnly = !!args?.idle_only;

  // Always sweep ghost tiles after a close attempt, regardless of outcome.
  // The user said "close X" — if X is already gone server-side, removing
  // the stale UI tile is exactly what they wanted.
  try { return all ? reapMany({ idleOnly, force }) : runSingle(args, force); }
  finally { nudgeFeatherReconcile(); }
}

function runSingle(args, force) {
  // Single-agent path: prefer explicit ref, fall back to focused-on-/feather.
  let ref = String(args?.agent || "").trim();
  if (!ref) {
    const v = momoView.getView();
    const fa = v && v.focused_agent;
    if (fa && (fa.agent_id || fa.id || fa.name)) {
      ref = String(fa.agent_id || fa.id || fa.name);
    }
  }
  if (!ref) {
    return {
      error: "no agent specified and none focused",
      note: "Ask the user WHICH terminal to close (read off the visible agent names) — or 'close all' to reap everyone.",
    };
  }
  const result = hermes.reapAgentNow(ref, { force });
  if (!result.ok) {
    if (result.code === "AGENT_BUSY") {
      return {
        ...result,
        note:
          "Tell the user that agent is still working. Offer: (a) wait until she's done, " +
          "(b) close anyway with force:true (kills her current task too), or (c) stop_agent first then retry.",
      };
    }
    if (result.code === "AMBIGUOUS") {
      return { ...result, note: "Read the candidate names back; ask which one." };
    }
    if (result.code === "NO_AGENT") {
      return {
        ...result,
        note:
          "Tell the user that agent isn't around (already closed, never existed, or wrong name).",
      };
    }
    return { ...result, note: "Quote the error plainly." };
  }
  return {
    ok: true,
    closed: [{ agent_id: result.agent_id, name: result.name }],
    note: `One cute confirmation naming ${result.name}. Her workspace is gone; seat is free.`,
  };
}

function reapMany({ idleOnly, force }) {
  let seated;
  try { seated = hermes.listAgents() || []; }
  catch (err) {
    return { error: String(err?.message || err), note: "Couldn't list agents — quote the error." };
  }
  const targets = seated.filter((a) => (idleOnly ? !a.current_task : true));
  if (targets.length === 0) {
    return {
      ok: true,
      closed: [],
      note: idleOnly
        ? "Tell the user there are no idle agents — everyone on stage is busy."
        : "Tell the user the office is already empty.",
    };
  }
  const closed = [];
  const failed = [];
  for (const a of targets) {
    const r = hermes.reapAgentNow(a.agent_id, { force });
    if (r.ok) closed.push({ agent_id: a.agent_id, name: a.name });
    else failed.push({ agent_id: a.agent_id, name: a.name, code: r.code, error: r.error });
  }
  const closedNames = closed.map((c) => c.name);
  if (failed.length === 0) {
    return {
      ok: true,
      closed,
      note: `Confirm cleanly — names: ${closedNames.join(", ")}. Office is ${
        idleOnly ? "tidier" : "empty"
      } now.`,
    };
  }
  return {
    ok: false,
    closed,
    failed,
    note:
      `Closed ${closedNames.join(", ") || "(none)"}, but ${failed.length} refused — usually because they're busy. ` +
      `Quote the busy names (${failed.map((f) => f.name).join(", ")}) and offer force:true to kill them too.`,
  };
}

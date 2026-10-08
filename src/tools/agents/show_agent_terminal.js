// src/tools/show_agent_terminal.js
//
// Voice tool: in ONE call, open the squad monitor for an agent AND switch
// to her @live tab so the user sees the actual TUI (Claude Code or Hermes
// PTY) without a second click. The shortcut for "show me her terminal".
//
// Mechanically: broadcasts a `ui_open_screen` followed by `ui_select_tab`
// with tab='live' on /hermes/ws. The squad client picks up both and lands
// on @live (selectMonitorTab routes the 'live' phrase to the @live panel —
// see public/squad.html).
//
// Distinct from show_agent_screen (opens the monitor; default tab is
// @live for runtimes with PTY, but the user might be on a different tab
// from a prior interaction). This forces them onto @live regardless.
//
// Distinct from show_agent_tab (only switches the current monitor's tab —
// requires the monitor to already be open AND the agent to already be in
// view). This combines both.
//
// Page-aware redirect: if the user is on /feather, the squad-broadcast path
// is a no-op (the feather page doesn't listen for ui_open_screen). We detect
// that via momoView and delegate to feather_focus({mode:'zoom1', agents:[ref]})
// so "zoom into X" / "show me X's terminal" works on either page.

import * as hermes from "../../hermes/index.js";
import * as momoView from "../../momo/view.js";
import * as featherFocus from "./feather_focus.js";
import { refOrFocused } from "./agent_context.js";

export const definition = {
  type: "function",
  name: "show_agent_terminal",
  description:
    "Open an agent's @live tab on the squad page in ONE step — pops the monitor for that agent AND " +
    "switches to her live terminal pane (the real Claude Code or Hermes TUI streamed via xterm). " +
    "Use when the user says: 'show me her terminal', 'show me Cinder's live terminal', " +
    "'open her PTY', 'let me watch her type', '让我看 Cinder 的终端', '把 Reed 的终端打开', " +
    "'open the live view'. **`agent` is OPTIONAL** — omit it when the user says \"her/this/that\" and the tool auto-targets the focused agent on /squad or the grid overlay. " +
    "Works for any agent on stage that has a PTY (claude or hermes runtime). " +
    "/squad must be visible — call show_pane({page:'squad'}) first if not.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Agent callsign or agent_id. Case-insensitive; prefix-match works for short names. OMIT to auto-target the currently-focused agent.",
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
      note: "Tell the user which agent — name or id. No agent is currently focused.",
    };
  }
  // /feather (legacy) and /squad's grid overlay both have their own layout —
  // squad's ui_open_screen is a no-op there. Forward the same intent to
  // feather_focus so "zoom into Atlas" works on every surface without the
  // model having to know which it's looking at.
  const pageNow = momoView.getView()?.page;
  if (pageNow === "feather" || pageNow === "squad_grid") {
    return featherFocus.run({ mode: "zoom1", agents: [ref] });
  }
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length === 0) {
    return {
      error: `no active agent matches "${ref}"`,
      note: "Tell the user that agent isn't on stage. Offer to spawn one fresh, or list who's around with agent_status.",
    };
  }
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Ask the user WHICH one — read the candidate names back. Don't guess.",
    };
  }
  const match = matches[0];

  // Step 1: open the monitor for this agent (the squad client routes
  // ui_open_screen → openMonitorForAgent which finds the most recent
  // task for the agent and pops the monitor).
  // Step 2: switch the active tab to @live (selectMonitorTab maps the
  // 'live' phrase to the @live panel — see public/squad.html). Both
  // events flow over /hermes/ws.
  try {
    hermes.broadcast({
      type: "ui_open_screen",
      agent_id: match.agent_id,
      name: match.name,
      ts: Date.now(),
    });
    // Small client-side delay isn't needed — the squad client processes
    // ui_select_tab AFTER the open call lands and openMonitorForAgent
    // is synchronous in the rendering path.
    hermes.broadcast({
      type: "ui_select_tab",
      agent_id: match.agent_id,
      name: match.name,
      tab: "live",
      ts: Date.now() + 1,
    });
  } catch (err) {
    return {
      error: String(err?.message || err),
      note: "Could not open the terminal — quote the error plainly.",
    };
  }

  return {
    ok: true,
    agent_id: match.agent_id,
    name: match.name,
    runtime: match.runtime || null,
    note:
      "Say one short cute line in the SAME language the user just used, like '好嘞~ 这是 " +
      match.name +
      " 的终端~' or \"here's " +
      match.name +
      "'s terminal ✨\". Don't read the terminal contents aloud — let the user watch.",
  };
}

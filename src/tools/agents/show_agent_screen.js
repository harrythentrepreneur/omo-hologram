// src/tools/show_agent_screen.js
//
// Voice tool: pop the glassmorphic "monitor" on /squad for a specific
// agent (by name or agent_id). The page listens for a `ui_open_screen`
// event on /hermes/ws and opens the screen-share view for that agent's
// most recent task.
//
// This is the voice handle for "let me show you what Nimbus is doing" —
// it doesn't dispatch any new work, just unhides the UI.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "./agent_context.js";

export const definition = {
  type: "function",
  name: "show_agent_screen",
  description:
    "Open the floating glass 'monitor' on /squad to reveal what one agent is actually doing on its computer right now (file being edited, search query, terminal command). Use when the user asks to see/look at an agent — e.g. '让我看看 Nimbus 在干嘛', \"show me Ember's screen\", \"show me her screen\", \"打开她的屏幕\", \"open up that agent\", \"show me what's running\". Pass the agent's name (case-insensitive prefix match works) or agent_id. **`agent` is OPTIONAL** — if the user says \"show me her/this/that\" without naming someone, omit `agent` and the tool auto-targets the focused agent on /squad or the grid overlay. /squad must be visible (use show_pane({page:'squad'}) first if not).",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Which agent's screen to open. Accepts the callsign Momo just gave the worker (e.g. 'Nimbus') or the agent_id. Case-insensitive; prefix-match works for short names. OMIT to auto-target the currently-focused agent (the monitor's open agent on /squad, or the focused tile in the grid overlay).",
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
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length === 0) {
    return {
      error: `no active agent matches "${ref}"`,
      note: "Tell the user that agent isn't on stage — they may have already left. Offer to spawn one fresh.",
    };
  }
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Ask the user WHICH one — name them by their full callsign (e.g. 'Cinder-1 还是 Cinder-2?'). Don't guess.",
    };
  }
  const match = matches[0];
  try {
    hermes.broadcast({
      type: "ui_open_screen",
      agent_id: match.agent_id,
      name: match.name,
      ts: Date.now(),
    });
  } catch (err) {
    return {
      error: String(err?.message || err),
      note: "Could not open the screen — quote the error plainly.",
    };
  }
  return {
    agent_id: match.agent_id,
    name: match.name,
    ok: true,
    note:
      "Say one short cute line in the SAME language the user just used, like '好嘞~ 这是 " +
      match.name +
      " 的屏幕~' or \"here's " +
      match.name +
      "'s screen ✨\". Don't list anything from it; let the user read it.",
  };
}

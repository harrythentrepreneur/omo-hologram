// src/tools/show_agent_tab.js
//
// Voice tool: switch the open monitor's active tab to a specific
// resource — chat/session, reasoning, result, a file, terminal, or a search query.
// Broadcasts a `ui_select_tab` event on /hermes/ws; the squad page's
// resolver fuzzy-matches the `tab` string against open panels and
// switches to whichever fits.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "./agent_context.js";

const TAB_HINTS = new Set([
  "chat", "conversation", "thread", "session", "claude", "code",
  "reasoning", "thoughts", "thinking", "why",   // → @thoughts
  "result", "outcome", "summary", "done", "what happened", // → @result
  "terminal", "shell", "console", "bash",       // → terminal
  "live", "pty", "tui",                          // → @live
]);

export const definition = {
  type: "function",
  name: "show_agent_tab",
  description:
    "Inside the agent monitor on /squad, switch to a specific tab so the user sees that resource. Use when the user asks to see a particular thing about the agent's work: 'show me cinder\\'s chat', 'show me cinder\\'s reasoning', '让我看看 atlas 想啥了', 'what did prism find', 'open the avatar.js tab', 'show the terminal', 'what was the result'. Also turns OFF auto-follow so the chosen tab stays pinned. **One-shot**: if no monitor is open (or it's on a different agent), this opens the right monitor first. **`agent` is optional** — defaults to the focused agent when the user says 'her/this/that'.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Which agent's monitor to control. Optional — omit to target the focused agent (whichever monitor is open, or the focused tile in the grid overlay). Pass the callsign or agent_id when targeting a specific one.",
      },
      tab: {
        type: "string",
        description:
          "What to switch to. Accepts: 'chat' / 'thread' / 'session' (the Claude Code style transcript), 'reasoning' / 'thoughts' (the reasoning panel), 'result' / 'outcome' (the result panel — only after task completes), 'terminal' / 'shell' (the terminal panel), 'live' / 'pty' (the live xterm), a file path or filename ('avatar.js', 'public/holo.html'), or a search query phrase. The squad page fuzzy-matches against open tabs.",
      },
    },
    required: ["tab"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const tab = args?.tab ? String(args.tab).trim() : "";
  if (!tab) {
    return {
      error: "missing tab reference",
      note: "Tell the user what to switch to — reasoning, result, a file name, or search query.",
    };
  }
  let agent_id = null;
  let name = null;
  // Resolve a target agent — explicit arg first, then the focused agent
  // on /squad / grid overlay. Stays null only if no monitor + no focus.
  const ref = refOrFocused(args?.agent);
  if (ref) {
    const matches = hermes.resolveActiveAgents(ref);
    if (matches.length === 0) {
      return {
        error: `no active agent matches "${ref}"`,
        note: "Tell the user that agent isn't on stage — they may have left.",
      };
    }
    if (matches.length > 1) {
      return {
        error: `ambiguous: "${ref}" matches ${matches.length} agents`,
        candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
        note: "Ask the user WHICH agent's tab to switch — read their full callsigns.",
      };
    }
    agent_id = matches[0].agent_id;
    name = matches[0].name;
  }
  try {
    // One-shot: if we have an agent reference, fire ui_open_screen first
    // so a closed (or wrong-agent) monitor pops on the right one BEFORE
    // the tab-select lands. The squad page processes them in order.
    if (agent_id) {
      hermes.broadcast({
        type: "ui_open_screen",
        agent_id,
        name,
        ts: Date.now(),
      });
    }
    hermes.broadcast({
      type: "ui_select_tab",
      agent_id,           // null = whichever monitor is open
      tab,
      ts: Date.now() + 1,
    });
  } catch (err) {
    return {
      error: String(err?.message || err),
      note: "Could not switch tabs — quote the error plainly.",
    };
  }
  const friendly = TAB_HINTS.has(tab.toLowerCase()) ? tab.toLowerCase() : `"${tab}"`;
  return {
    ok: true,
    agent_id,
    name,
    tab,
    note:
      "Say one short cute line in the SAME language the user just used, like '好嘞~ 切到 " +
      friendly +
      " 啦~' or \"switched to " +
      friendly +
      " ✨\". Don't read the tab content aloud.",
  };
}

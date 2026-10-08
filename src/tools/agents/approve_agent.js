// approve_agent — answer a Claude Code permission prompt by voice.
//
// Claude Code's permission TUI looks like:
//
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again for: <…>
//     3. No
//
// Pressing a digit (1–9) selects + submits that option immediately. Pressing
// Enter accepts whichever option is highlighted (always #1 = Yes by default).
// `agent_send_keys` with "y, enter" — which the persona used to recommend
// for these prompts — does NOT work, because the menu ignores 'y'.
//
// This tool maps the four phrases a user actually says to the keystrokes
// the menu actually expects:
//
//   yes    → "1" + Enter   (accept option 1)
//   always → "2" + Enter   (accept option 2, "don't ask again")
//   no     → "3" + Enter   (decline)
//   cancel → Esc           (universal cancel; works for any TUI prompt,
//                           not just permission menus)
//
// `agent` is optional — when the user is looking at /feather, the focused
// terminal is the target. /feather pushes `focused_agent` to
// /omo/ingest/view continuously, and resolveSessionOrError reads it.

import { resolveSessionOrError } from "./claude_pty.js";

const CHOICES = {
  yes:    "1\r",
  always: "2\r",
  no:     "3\r",
  cancel: "\x1b",
};

const CHOICE_LIST = Object.keys(CHOICES);

export const definition = {
  type: "function",
  name: "approve_agent",
  description: [
    "Answer a Claude Code permission prompt (or any short numbered-menu prompt)",
    "in an agent's terminal. Use this when the user says short approval-style",
    "replies WHILE looking at a paused terminal:",
    "  • 'yes proceed with Wren, it's fine' / 'answer yes on Wren' → agent:'Wren', choice:'yes'",
    "  • yes / proceed / go / do it / 好 / 可以 / 同意 → choice:'yes' (option 1)",
    "  • always / yes always / don't ask again / 总是 / 别再问 → choice:'always' (option 2)",
    "  • no / decline / 不要 / 不行 → choice:'no' (option 3)",
    "  • cancel / abort / stop / 取消 → choice:'cancel' (Esc — closes the prompt)",
    "`agent` is optional — defaults to the focused terminal on /feather. Don't",
    "narrate the keystroke; the menu disappears, that's enough. One cute one-liner",
    "in the user's language ('好嘞~' / 'shipped').",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent name or id. Optional — defaults to the focused terminal on /feather.",
      },
      choice: {
        type: "string",
        enum: CHOICE_LIST,
        description:
          "yes = accept option 1 (the default Yes). " +
          "always = accept option 2 ('Yes, don't ask again'). " +
          "no = accept option 3 (No). " +
          "cancel = send Escape (works for any prompt, not just numbered menus).",
      },
    },
    required: ["choice"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const r = resolveSessionOrError(args?.agent);
  if (r.error) return r;
  const choice = String(args?.choice || "").toLowerCase();
  const payload = CHOICES[choice];
  if (!payload) {
    return {
      error: `unknown choice '${choice}'`,
      valid: CHOICE_LIST,
      note: "Ask the user again — yes / always / no / cancel.",
    };
  }
  const ok = r.session.write(payload);
  return {
    ok,
    agent_id: r.agent.agent_id,
    agent_name: r.agent.name,
    choice,
    note: ok
      ? "One short cute confirmation ('好嘞~' / 'sent ✨'). Don't read keystrokes back; watch the terminal pane."
      : "The keystroke didn't land — her terminal may have just closed.",
  };
}

// src/tools/claude_pty.js — voice tools for the in-browser Claude Code
// terminal. These let Momo TYPE INTO a live `claude` PTY by voice — the
// natural way to drive the terminal hands-free.
//
// Four tools:
//   claude_send_text   — type a string (optionally followed by Enter)
//   claude_send_keys   — press named keys (tab/enter/esc/up/down/...)
//   claude_send_signal — SIGINT / SIGTSTP / SIGTERM (ctrl-c / ctrl-z / kill)
//   claude_slash       — convenience: types "/<name> <args>" + Enter
//
// All four route through hermes.getPtyForAgent(agent) → claude_pty session.
// If the agent has no live PTY yet, the tool returns a hint telling Momo to
// suggest opening the squad / claude-deck view first (or to spawn via
// spawn_agent_task with the new pty:true flag — coming in a later phase).

import * as hermes from "../../hermes/index.js";
import * as momoView from "../../momo/view.js";

// ─── shared helpers ───────────────────────────────────────────────────

const HERMES_TYPE_GAP_MS = Number(process.env.OMO_HERMES_VOICE_TYPE_GAP_MS || 18);
const HERMES_SUBMIT_GAP_MS = Number(process.env.OMO_HERMES_VOICE_SUBMIT_GAP_MS || 900);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTerminalText(session, agent, text, sendEnter) {
  const runtime = String(agent?.runtime || "").toLowerCase();
  if (runtime !== "hermes") {
    return session.write(sendEnter ? text + "\r" : text);
  }

  // Hermes' Ink text input can treat text+\r in the same stdin read as a
  // literal newline-in-input. For voice follow-ups, mimic human typing and
  // submit with a separate, later return key.
  let ok = true;
  for (const ch of String(text)) {
    ok = session.write(ch) && ok;
    if (HERMES_TYPE_GAP_MS > 0) await sleep(HERMES_TYPE_GAP_MS);
  }
  if (sendEnter) {
    if (HERMES_SUBMIT_GAP_MS > 0) await sleep(HERMES_SUBMIT_GAP_MS);
    ok = session.write("\r") && ok;
  }
  return ok;
}

// Resolve an agent ref (name or id). If omitted, fall back to whichever
// agent the user is currently focused on in /feather (or any UI that pings
// /omo/ingest/view with `focused_agent`). This is the seam that lets the
// user say "yes" / "y" by voice or text while looking at a paused terminal
// and have Momo route the reply to the right PTY without naming the agent.
export function resolveSessionOrError(agentRef) {
  let ref = String(agentRef || "").trim();
  if (!ref) {
    const v = momoView.getView();
    const fa = v && v.focused_agent;
    if (fa && (fa.agent_id || fa.id || fa.name)) {
      ref = String(fa.agent_id || fa.id || fa.name);
    }
  }
  if (!ref) {
    return {
      error: "missing agent reference",
      note: "No agent focused on screen — ask the user which agent (name or id).",
    };
  }
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Read the candidate names back and ask the user which one.",
    };
  }
  const target = matches[0] || null;
  if (!target) {
    return {
      error: `no active agent matches "${ref}"`,
      note: "Tell the user that agent isn't around. Offer spawn_agent_task to bring one online.",
    };
  }
  const session = hermes.getPtyForAgent(target.agent_id);
  if (!session || !session.alive) {
    return {
      error: `${target.name} has no live terminal session`,
      agent_id: target.agent_id,
      note:
        "Tell the user the agent is here but her terminal isn't open yet. " +
        "Offer to open /claude-deck/" + target.name + " or to dispatch a task " +
        "via spawn_agent_task (which will mint a PTY for her).",
    };
  }
  return { session, agent: target };
}

// ─── claude_send_text ─────────────────────────────────────────────────

export const sendTextDefinition = {
  type: "function",
  name: "claude_send_text",
  description:
    "Type a literal string into an agent's live Claude Code terminal (their PTY). " +
    "Use this for: 'ask Cinder to refactor avatar.js', '让 Reed 修一下 mouth lag', " +
    "'tell her to also add tests', or any free-form prompt the user wants the agent to act on. " +
    "Add enter:true (default) so the message is submitted. The agent reads it as if you typed it at her terminal.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id." },
      text:  { type: "string", description: "The literal text to type into her terminal." },
      enter: { type: "boolean", description: "If true (default), append Enter so Claude Code submits the message immediately." },
    },
    required: ["agent", "text"],
    additionalProperties: false,
  },
};

export async function runSendText(args) {
  const r = resolveSessionOrError(args?.agent);
  if (r.error) return r;
  const text = String(args?.text ?? "");
  if (!text) return { error: "missing text", note: "Ask the user what to type." };
  const sendEnter = args?.enter !== false; // default true
  const ok = await writeTerminalText(r.session, r.agent, text, sendEnter);
  return {
    ok,
    agent_id: r.agent.agent_id,
    agent_name: r.agent.name,
    sent: text.slice(0, 200),
    enter: sendEnter,
    note: ok
      ? "Say one short cute handoff in the user's language naming the agent (e.g. '好嘞~ 跟 Reed 说啦~' / 'told her — keep an eye on the deck'). Don't claim results; the agent's reply will stream into the terminal pane."
      : "Tell the user the keystroke didn't land — her terminal may have just closed.",
  };
}

// ─── claude_send_keys ─────────────────────────────────────────────────

// Named-key → ANSI sequence. Covers the keys a voice user is most likely
// to ask for. Anything not in this table goes through as a literal char.
const KEY_TABLE = {
  enter:     "\r",
  return:    "\r",
  tab:       "\t",
  escape:    "\x1b",
  esc:       "\x1b",
  backspace: "\x7f",
  delete:    "\x1b[3~",
  space:     " ",
  up:        "\x1b[A",
  down:      "\x1b[B",
  right:     "\x1b[C",
  left:      "\x1b[D",
  home:      "\x1b[H",
  end:       "\x1b[F",
  pageup:    "\x1b[5~",
  pagedown:  "\x1b[6~",
  "ctrl+a":  "\x01",
  "ctrl+b":  "\x02",
  "ctrl+c":  "\x03",
  "ctrl+d":  "\x04",
  "ctrl+e":  "\x05",
  "ctrl+f":  "\x06",
  "ctrl+k":  "\x0b",
  "ctrl+l":  "\x0c",
  "ctrl+n":  "\x0e",
  "ctrl+p":  "\x10",
  "ctrl+r":  "\x12",
  "ctrl+u":  "\x15",
  "ctrl+w":  "\x17",
  "ctrl+z":  "\x1a",
  "shift+tab": "\x1b[Z",
};

function keysToBytes(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(/[\s,+]+/).filter(Boolean);
  // If the caller passed a chord like "ctrl+c" as a single string, the
  // split above would have broken it. Look up the joined original first
  // before falling back to per-token lookup.
  const joined = (Array.isArray(input) ? input.join("+") : String(input || "")).trim().toLowerCase();
  if (KEY_TABLE[joined]) return KEY_TABLE[joined];
  return list
    .map((tok) => {
      const k = String(tok).trim().toLowerCase();
      if (KEY_TABLE[k]) return KEY_TABLE[k];
      // Single character — type it as-is.
      if (k.length === 1) return tok;
      return "";
    })
    .join("");
}

export const sendKeysDefinition = {
  type: "function",
  name: "claude_send_keys",
  description:
    "Press named keys in an agent's live Claude Code terminal. Use for navigation, accepting prompts, or escaping a menu. " +
    "Common keys: enter, tab, escape, up/down/left/right, backspace, ctrl+c, ctrl+r, shift+tab. " +
    "Examples: 'press tab to autocomplete' → keys:'tab'; 'say yes' → keys:'y, enter'; 'esc esc' → keys:'esc, esc'; 'arrow down' → keys:'down'.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id." },
      keys: {
        description:
          "Either an array of key names (['tab', 'enter']) or a comma-separated string ('tab, enter', 'ctrl+c'). " +
          "Single-character keys pass through literally.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
    },
    required: ["agent", "keys"],
    additionalProperties: false,
  },
};

export async function runSendKeys(args) {
  const r = resolveSessionOrError(args?.agent);
  if (r.error) return r;
  const bytes = keysToBytes(args?.keys);
  if (!bytes) return { error: "no recognised keys", note: "Tell the user that key combo didn't translate — ask again with simpler terms (enter, esc, tab, etc.)." };
  const ok = r.session.write(bytes);
  return {
    ok,
    agent_id: r.agent.agent_id,
    agent_name: r.agent.name,
    note: ok
      ? "Don't narrate keystrokes — silently watch what happens in the pane and react to the *result* if needed."
      : "Tell the user the keystroke didn't land.",
  };
}

// ─── claude_send_signal ───────────────────────────────────────────────

const ALLOWED_SIGNALS = new Set(["SIGINT", "SIGTSTP", "SIGTERM", "SIGQUIT", "SIGHUP"]);

export const sendSignalDefinition = {
  type: "function",
  name: "claude_send_signal",
  description:
    "Send a signal to an agent's live Claude Code process. SIGINT = ctrl-c (interrupt the current turn, keep the session alive). " +
    "SIGTERM = polite kill (closes the terminal). Use SIGINT when the user says 'stop her', 'abort', 'cancel that', '别 别 停一下'. " +
    "Don't use this to dismiss a permission prompt — type 'n' or escape instead.",
  parameters: {
    type: "object",
    properties: {
      agent:  { type: "string", description: "Agent name or id." },
      signal: { type: "string", description: "SIGINT (default), SIGTERM, SIGTSTP, SIGQUIT, or SIGHUP.", enum: ["SIGINT", "SIGTERM", "SIGTSTP", "SIGQUIT", "SIGHUP"] },
    },
    required: ["agent"],
    additionalProperties: false,
  },
};

export async function runSendSignal(args) {
  const r = resolveSessionOrError(args?.agent);
  if (r.error) return r;
  const sig = String(args?.signal || "SIGINT").toUpperCase();
  if (!ALLOWED_SIGNALS.has(sig)) {
    return { error: `signal ${sig} not allowed`, note: "Use SIGINT for ctrl-c, SIGTERM for hard stop." };
  }
  const ok = r.session.signal(sig);
  return {
    ok,
    agent_id: r.agent.agent_id,
    agent_name: r.agent.name,
    signal: sig,
    note: ok
      ? "Cute confirmation in the user's language ('好~ 停啦~' / 'caught — she's paused')."
      : "Signal didn't land — her terminal may have already exited.",
  };
}

// ─── claude_slash ─────────────────────────────────────────────────────

export const slashDefinition = {
  type: "function",
  name: "claude_slash",
  description:
    "Invoke a Claude Code slash command (skill) in an agent's terminal. Types '/<name> <args>' + Enter. " +
    "Examples: name:'review' (run the code-review skill on current diff), name:'init', name:'security-review', name:'compact'. " +
    "The agent picks it up the same way she would if you'd typed '/<name>' yourself in the terminal.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id." },
      name:  { type: "string", description: "Slash command / skill name without the leading '/'." },
      args:  { type: "string", description: "Optional arguments to append after the name." },
    },
    required: ["agent", "name"],
    additionalProperties: false,
  },
};

export async function runSlash(args) {
  const r = resolveSessionOrError(args?.agent);
  if (r.error) return r;
  const name = String(args?.name || "").trim().replace(/^\/+/, "");
  if (!name) return { error: "missing slash name", note: "Tell the user which slash command — /review, /init, etc." };
  const extra = String(args?.args || "").trim();
  const line = `/${name}${extra ? " " + extra : ""}`;
  const ok = await writeTerminalText(r.session, r.agent, line, true);
  return {
    ok,
    agent_id: r.agent.agent_id,
    agent_name: r.agent.name,
    sent: line,
    note: ok
      ? `Tell the user you fired '/${name}' in her terminal — watch the deck for the reply.`
      : "Slash didn't land — her terminal may have just closed.",
  };
}

// ─── Runtime-agnostic aliases ──────────────────────────────────────────
// Same implementation as claude_send_* — hermes.getPtyForAgent already
// resolves whichever PTY (claude or hermes) is alive for the agent, so
// these tools work uniformly across runtimes. Models that don't know
// which runtime an agent is on (most of the time) should reach for these
// instead of the claude_-prefixed names. The claude_send_* tools stay
// registered for back-compat.

export const agentSendTextDefinition = {
  type: "function",
  name: "agent_send_text",
  description:
    "Type a literal string into an agent's live terminal (Claude Code or Hermes — runtime-agnostic). " +
    "Use for free-form follow-ups AND for answering interactive prompts the agent's CLI is waiting on. " +
    "Examples: text:'y' (approve a permission prompt), text:'1' (pick option 1), text:'tell her to add tests'. " +
    "**`agent` is optional** — when the user is looking at /feather, leave it blank and the reply " +
    "routes to whichever terminal they have focused. Add enter:true (default) so the line is submitted.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id. Optional — defaults to the focused terminal on /feather." },
      text:  { type: "string", description: "The literal text to type into the terminal." },
      enter: { type: "boolean", description: "If true (default), append Enter so the line is submitted." },
    },
    required: ["text"],
    additionalProperties: false,
  },
};
export const runAgentSendText = runSendText;

export const agentSendKeysDefinition = {
  type: "function",
  name: "agent_send_keys",
  description:
    "Press named keys in an agent's live terminal (runtime-agnostic). Use for navigation, accepting prompts, escaping menus. " +
    "Common: enter, tab, escape, up/down/left/right, backspace, ctrl+c, ctrl+r, shift+tab. " +
    "Examples: keys:'tab', keys:'y, enter' (yes + submit), keys:'esc, esc', keys:'ctrl+c'. " +
    "**`agent` is optional** — defaults to the focused terminal on /feather, so 'yes' / 'no' replies route there automatically.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id. Optional — defaults to the focused terminal on /feather." },
      keys: {
        description: "Array of key names or comma-separated string. Single chars pass through.",
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
    },
    required: ["keys"],
    additionalProperties: false,
  },
};
export const runAgentSendKeys = runSendKeys;

export const agentSendSignalDefinition = {
  type: "function",
  name: "agent_send_signal",
  description:
    "Send a signal to an agent's live terminal process (runtime-agnostic). SIGINT = ctrl-c (interrupt current turn, keep session alive). " +
    "SIGTERM = polite kill (closes the terminal). Use SIGINT when the user says 'stop her', 'abort', 'cancel that', '别 别 停一下'. " +
    "**`agent` is optional** — defaults to the focused terminal on /feather.",
  parameters: {
    type: "object",
    properties: {
      agent:  { type: "string", description: "Agent name or id. Optional — defaults to the focused terminal on /feather." },
      signal: { type: "string", description: "SIGINT (default), SIGTERM, SIGTSTP, SIGQUIT, or SIGHUP.", enum: ["SIGINT", "SIGTERM", "SIGTSTP", "SIGQUIT", "SIGHUP"] },
    },
    additionalProperties: false,
  },
};
export const runAgentSendSignal = runSendSignal;

export const agentSlashDefinition = {
  type: "function",
  name: "agent_slash",
  description:
    "Invoke a slash command in an agent's live terminal (runtime-agnostic). Types '/<name> <args>' + Enter. " +
    "Claude examples: /review, /init, /security-review, /compact. Hermes examples: /rollback, /skills, /help. " +
    "**`agent` is optional** — defaults to the focused terminal on /feather.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id. Optional — defaults to the focused terminal on /feather." },
      name:  { type: "string", description: "Slash command name without the leading '/'." },
      args:  { type: "string", description: "Optional arguments to append after the name." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};
export const runAgentSlash = runSlash;

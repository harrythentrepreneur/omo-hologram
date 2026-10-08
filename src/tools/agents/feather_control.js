// feather_control — natural-language control shim for /feather.
//
// This is intentionally small and deterministic. It handles the phrases
// that should feel instant by voice: yes/no/always, Enter/Esc/arrows,
// stop-current-turn, and opening the preview drawer for the focused agent.

import { randomUUID } from "node:crypto";
import * as dataCore from "../../data_core.js";
import * as hermes from "../../hermes/index.js";
import { featherView, focusedAgentRef, awaitingAgentRef, refOrFocused } from "./agent_context.js";
import { run as runApproveAgent } from "./approve_agent.js";
import { runAgentSendKeys, runAgentSendSignal, runAgentSendText } from "./claude_pty.js";

export const definition = {
  type: "function",
  name: "feather_control",
  description: [
    "Natural-language control shim for /feather. Use this when the user is",
    "looking at /feather and gives a short control utterance instead of a full",
    "task: 'yes', 'always', 'no', 'enter', 'escape', 'down', '1', 'stop her',",
    "'preview this', 'show her work', or a focused-terminal follow-up like",
    "'tell her to also fix mobile'. The tool defaults to the focused tile,",
    "or the awaiting-input tile if one is active, so do not ask the user to",
    "name the agent unless the tool returns an ambiguity. For explicit ship",
    "or scrap requests, prefer accept_agent_work / discard_agent_work; those",
    "now also default to the focused /feather tile.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The user's raw short command or follow-up phrase.",
      },
      agent: {
        type: "string",
        description: "Optional agent name/id. Omit to use the focused or awaiting /feather tile.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const raw = String(args?.text || "").trim();
  if (!raw) return { error: "missing text", note: "Ask the user what to send or control." };

  const view = featherView();
  if (!view && !refOrFocused(args?.agent)) {
    return {
      error: "no /feather focus context",
      note: "Ask the user which agent, or have them focus a /feather tile first.",
    };
  }

  const explicit = String(args?.agent || "").trim();
  const targetRef = explicit || awaitingAgentRef() || focusedAgentRef();
  if (!targetRef) {
    return {
      error: "no focused agent",
      note: "Ask the user which terminal to control.",
    };
  }

  const lower = normalise(raw);
  const awaitingKind = String(view?.awaiting_agent?.prompt_kind || view?.focused_agent?.awaiting?.kind || "").toLowerCase();

  const surface = parseSurfaceAction(lower);
  if (surface) return emitAction(surface, targetRef);

  const stop = parseStop(lower);
  if (stop) {
    return runAgentSendSignal({ agent: targetRef, signal: "SIGINT" });
  }

  const choice = parseApproval(lower);
  if (choice) {
    if (awaitingKind === "yn" && (choice === "yes" || choice === "no")) {
      return runAgentSendKeys({ agent: targetRef, keys: `${choice === "yes" ? "y" : "n"}, enter` });
    }
    return runApproveAgent({ agent: targetRef, choice });
  }

  const keySeq = parseKeys(lower);
  if (keySeq) {
    return runAgentSendKeys({ agent: targetRef, keys: keySeq });
  }

  const numbered = parseNumberChoice(lower);
  if (numbered) {
    if (numbered === 1) return runApproveAgent({ agent: targetRef, choice: "yes" });
    if (numbered === 2) return runApproveAgent({ agent: targetRef, choice: "always" });
    if (numbered === 3) return runApproveAgent({ agent: targetRef, choice: "no" });
    return runAgentSendKeys({ agent: targetRef, keys: `${numbered}, enter` });
  }

  // Last resort: treat the utterance as a message to the focused terminal.
  // This is the voice equivalent of typing into the /feather compose bar.
  return runAgentSendText({ agent: targetRef, text: raw, enter: true });
}

function normalise(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[。！？；，、]/g, " ")
    .replace(/\s+/g, " ");
}

function isShort(s, maxWords = 5) {
  if (!s || s.length > 48) return false;
  return s.split(/\s+/).filter(Boolean).length <= maxWords;
}

function parseApproval(s) {
  if (!isShort(s, 6)) return null;
  if (/^(?:always|yes always|approve always|allow always|dont ask again|don't ask again|remember this|remember it|总是|一直允许|以后都允许|别再问|不要再问|记住)$/.test(s)) return "always";
  if (/^(?:yes|yeah|yep|y|ok|okay|sure|proceed|go|go ahead|do it|allow|approve|accept|continue|carry on|可以|好|好的|行|同意|批准|继续|你可以继续)$/.test(s)) return "yes";
  if (/^(?:no|nope|n|decline|reject|deny|dont|don't|do not|stop|不要|不行|不可以|拒绝|别|否)$/.test(s)) return "no";
  if (/^(?:cancel|abort|escape|esc|never mind|nevermind|算了|取消|退出|按退出)$/.test(s)) return "cancel";
  return null;
}

function parseKeys(s) {
  if (!isShort(s, 5)) return null;
  const exact = {
    enter: "enter",
    return: "enter",
    "hit enter": "enter",
    "press enter": "enter",
    "回车": "enter",
    "按回车": "enter",
    tab: "tab",
    "press tab": "tab",
    "shift tab": "shift+tab",
    "shift+tab": "shift+tab",
    escape: "escape",
    esc: "escape",
    "press escape": "escape",
    "按 esc": "escape",
    up: "up",
    "arrow up": "up",
    "上": "up",
    "上一个": "up",
    down: "down",
    "arrow down": "down",
    "下": "down",
    "下一个": "down",
    left: "left",
    "arrow left": "left",
    right: "right",
    "arrow right": "right",
    backspace: "backspace",
    delete: "delete",
  };
  return exact[s] || null;
}

function parseNumberChoice(s) {
  if (!isShort(s, 4)) return null;
  if (/^[1-9]$/.test(s)) return Number(s);
  const words = {
    one: 1, first: 1, "first one": 1, "option one": 1, "选一": 1, "选第一个": 1, "第一个": 1,
    two: 2, second: 2, "second one": 2, "option two": 2, "选二": 2, "选第二个": 2, "第二个": 2,
    three: 3, third: 3, "third one": 3, "option three": 3, "选三": 3, "选第三个": 3, "第三个": 3,
    four: 4, fourth: 4, "option four": 4, "选四": 4, "选第四个": 4, "第四个": 4,
  };
  return words[s] || null;
}

function parseStop(s) {
  if (!isShort(s, 6)) return false;
  return /^(?:stop|stop her|stop him|stop it|stop this|interrupt|interrupt her|cancel that turn|cancel this turn|ctrl c|ctrl-c|打住|停一下|让她停|中断她|中断当前)$/.test(s);
}

function parseSurfaceAction(s) {
  if (/^(?:preview|preview this|preview her work|show preview|show her work|show the work|show changes|show diff|open preview|let me see|让我看|看一下|预览|看看改动|打开预览)$/.test(s)) return "preview";
  if (/^(?:diff|open diff|show diff mode|切到 diff|看 diff)$/.test(s)) return "diff";
  if (/^(?:live|live preview|show live|切到 live|看 live)$/.test(s)) return "live";
  if (/^(?:sync|sync my changes|pass my changes|handoff my changes|同步我的改动|把我的改动给她)$/.test(s)) return "sync";
  return null;
}

function resolveOne(ref) {
  const matches = hermes.resolveActiveAgents(String(ref || ""));
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
    };
  }
  if (matches[0]) return { agent: matches[0] };
  return { error: `no active agent matches "${ref}"` };
}

function emitAction(action, ref) {
  const r = resolveOne(ref);
  if (r.error) {
    return {
      ...r,
      note: r.candidates ? "Ask the user which agent." : "Tell the user that agent isn't on /feather.",
    };
  }
  const agent = r.agent;
  const title = `feather ${action} · ${agent.name}`;
  dataCore.emit({
    id: randomUUID(),
    source: "feather",
    kind: "action",
    ts: Date.now(),
    title,
    summary: title,
    data: {
      action,
      agent_id: agent.agent_id,
      name: agent.name,
    },
  });
  return {
    ok: true,
    action,
    agent_id: agent.agent_id,
    agent_name: agent.name,
    note:
      action === "preview"
        ? `Say one short line: opening ${agent.name}'s preview.`
        : "One short confirmation. Don't explain implementation details.",
  };
}

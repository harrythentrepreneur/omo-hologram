// src/tools/continue_agent_task.js
//
// Voice tool: send a follow-up to an existing agent's conversation
// thread. Reuses the stored claudeSessionId / hermesSessionId on the
// agent's identity so the worker --resume's the same chat instead of
// starting from scratch. The natural way to iterate by voice without
// typing into the squad page's compose box.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "./agent_context.js";
import { run as runApproveAgent } from "./approve_agent.js";
import { runAgentSendKeys } from "./claude_pty.js";

export const definition = {
  type: "function",
  name: "continue_agent_task",
  description:
    "Send a follow-up to an existing agent's conversation. Resumes the SAME chat thread the agent already had — she remembers her last task and your last message. Use when the user wants to extend or correct work that just happened: 'tell cinder to also add tests', '让 atlas 再查一下 X', 'have her also check the mobile build', 'follow up with prism'. If the user says 'tell her...' while looking at /feather, omit `agent` and the focused tile is used. NOT for answering terminal prompts: 'yes proceed with Wren', 'it's fine', 'go ahead', 'no', 'always' should use approve_agent / feather_control. Server fallback: if you still call this with an approval-shaped prompt while the agent is busy, it will answer the terminal instead of returning AGENT_BUSY. NOT for spawning fresh work on a new topic — that's spawn_agent_task. Returns immediately with task_id; narrate later when task_complete arrives.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description:
          "Which agent to follow up with. Accepts the callsign (e.g. 'Cinder') or agent_id. Case-insensitive; prefix match works.",
      },
      prompt: {
        type: "string",
        description:
          "The follow-up instruction — written like one short message to the agent (e.g. 'now add a unit test for that envelope follower', 'also check mobile breakpoints'). Keep it concise; the agent already has the prior context.",
      },
      // Optional per-turn dials — apply to JUST this follow-up.
      model:           { type: "string",  description: "Override the model for this turn only." },
      effort:          { type: "string",  enum: ["low","medium","high","xhigh","max"], description: "Claude effort for this turn." },
      permission_mode: { type: "string",  enum: ["default","acceptEdits","auto","bypassPermissions","dontAsk","plan"], description: "Claude permission mode for this turn." },
      extra_dirs:      { type: "array",   items: { type: "string" }, description: "Claude extra --add-dir for this turn." },
      provider:        { type: "string",  description: "Hermes provider override for this turn." },
      toolsets:        { type: "array",   items: { type: "string" }, description: "Hermes toolsets (-t) for this turn." },
      skills:          { type: "array",   items: { type: "string" }, description: "Hermes preload skills (-s) for this turn." },
      max_turns:       { type: "integer", minimum: 1, maximum: 500, description: "Hermes max-turns cap for this turn." },
      checkpoints:     { type: "boolean", description: "Hermes: enable --checkpoints for this turn." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  const prompt = args?.prompt ? String(args.prompt).trim() : "";
  if (!ref) {
    return { error: "missing agent reference", note: "Tell the user which agent — name/id, or focus a /feather tile first." };
  }
  if (!prompt) {
    return { error: "missing prompt", note: "Ask the user what the follow-up should be." };
  }

  // Disambiguate among ACTIVE agents first. If none active, fall back
  // to the identity store so a recently-left agent can be revived in
  // the same thread.
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Ask the user WHICH agent to continue with — read their full callsigns.",
    };
  }
  let resolved = matches[0] || null;
  if (!resolved) {
    const remembered = hermes.resolveAgent(ref);
    if (!remembered) {
      return {
        error: `no agent matches "${ref}" (active or remembered)`,
        note: "Tell the user that agent isn't around. Offer to spawn a fresh one with spawn_agent_task instead.",
      };
    }
    resolved = remembered;
  }

  const approvalIntent = parseApprovalIntent(prompt);
  if (approvalIntent && resolved.current_task) {
    return answerTerminalPrompt(resolved, approvalIntent, "approval_followup_while_busy");
  }

  let dispatched;
  try {
    // dispatchTask will pick up the stored session id (claude or hermes)
    // for this agent_id, so we don't need to pass sessionId explicitly.
    dispatched = hermes.dispatchTask({
      agentId: resolved.agent_id,
      prompt,
      // Per-turn dials — same shape as spawn_agent_task. Each adapter
      // accepts the ones it understands, ignores the rest.
      model:          args?.model           ? String(args.model)          : null,
      effort:         args?.effort          ? String(args.effort)         : null,
      permissionMode: args?.permission_mode ? String(args.permission_mode) : null,
      addDirs:        Array.isArray(args?.extra_dirs) ? args.extra_dirs.map(String) : null,
      provider:       args?.provider        ? String(args.provider)       : null,
      toolsets:       Array.isArray(args?.toolsets)   ? args.toolsets.map(String)   : null,
      skills:         Array.isArray(args?.skills)     ? args.skills.map(String)     : null,
      maxTurns:       Number.isInteger(args?.max_turns) ? args.max_turns : null,
      checkpoints:    args?.checkpoints === true,
    });
  } catch (err) {
    if (err?.code === "AGENT_BUSY") {
      if (approvalIntent) {
        return answerTerminalPrompt(resolved, approvalIntent, "approval_followup_busy_error");
      }
      return {
        error: `${resolved.name} is already running another task`,
        current_task: err.currentTask || null,
        note: "Tell the user gently — offer to wait, queue (the squad page does this), or stop her first with stop_agent. If the user was answering a terminal prompt, call approve_agent instead.",
      };
    }
    if (err?.code === "NO_SEAT") {
      return {
        error: String(err.message || "office seats are all taken"),
        note: "Tell the user the office is full and suggest stopping someone first.",
      };
    }
    if (err?.code === "NOT_INSTALLED") {
      return {
        error: `${err.runtime || "agent runtime"} isn't installed`,
        note: "Tell the user the runtime is missing — say which one.",
      };
    }
    if (err?.code === "WORKTREE_FAILED") {
      return {
        error: "couldn't set up an isolated workspace for the follow-up",
        parent_repo: err?.parentRepo || null,
        note:
          "Tell the user we couldn't reach the agent's workspace (so we held off rather than touching their real checkout). Offer to retry or fall back to OMO_WORKTREE_MODE=optional.",
      };
    }
    return {
      error: String(err?.message || err),
      note: "Quote the error plainly.",
    };
  }

  return {
    task_id: dispatched.task_id,
    agent_id: dispatched.agent_id,
    name: dispatched.agent_name || resolved.name,
    runtime: dispatched.runtime,
    session_id: dispatched.session_id,
    started_at: dispatched.started_at,
    note:
      "Say one short cute handoff in the SAME language the user just used, like '好嘞~ 让 " +
      (dispatched.agent_name || resolved.name) +
      " 接着改~' or \"on it — " +
      (dispatched.agent_name || resolved.name) +
      " is picking it back up ✨\". Don't wait for results; narrate the later task_complete event when it arrives.",
  };
}

function parseApprovalIntent(text) {
  const s = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[。！？；，、]/g, " ")
    .replace(/\s+/g, " ");
  if (!s || s.length > 120) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 14) return null;

  if (/\b(?:always|approve always|yes always|don't ask again|dont ask again|remember this|remember it)\b|(?:总是|一直允许|以后都允许|别再问|不要再问|记住)/.test(s)) {
    return { choice: "always" };
  }
  if (/\b(?:cancel|abort|escape|esc|never mind|nevermind)\b|(?:算了|取消|退出)/.test(s)) {
    return { choice: "cancel" };
  }
  if (/\b(?:no|nope|nah|decline|reject|deny|do not|don't|dont)\b|(?:不要|不行|不可以|拒绝|否)/.test(s)) {
    return { choice: "no" };
  }
  if (/\b(?:yes|yeah|yep|ok|okay|sure|proceed|go ahead|go|do it|allow|approve|accept|continue|fine|it's fine|thats fine|that's fine)\b|(?:可以|好的|好|行|同意|批准|继续|没问题)/.test(s)) {
    return { choice: "yes" };
  }
  return null;
}

async function answerTerminalPrompt(agent, intent, reason) {
  const choice = intent.choice;
  if (choice === "yes" || choice === "no") {
    const awaitingKind = String(agent?.awaiting?.kind || agent?.prompt_kind || "").toLowerCase();
    if (awaitingKind === "yn") {
      const r = await runAgentSendKeys({
        agent: agent.agent_id,
        keys: `${choice === "yes" ? "y" : "n"}, enter`,
      });
      return markRerouted(r, agent, choice, reason);
    }
  }
  const r = await runApproveAgent({ agent: agent.agent_id, choice });
  return markRerouted(r, agent, choice, reason);
}

function markRerouted(result, agent, choice, reason) {
  if (result && typeof result === "object" && !result.error) {
    return {
      ...result,
      routed_from: "continue_agent_task",
      route_reason: reason,
      agent_id: result.agent_id || agent.agent_id,
      agent_name: result.agent_name || agent.name,
      choice,
      note:
        "The user was answering the running agent's terminal prompt, so this was routed as terminal approval instead of a new follow-up. Confirm briefly and don't mention the reroute unless asked.",
    };
  }
  return {
    ...(result || {}),
    routed_from: "continue_agent_task",
    route_reason: reason,
    choice,
  };
}

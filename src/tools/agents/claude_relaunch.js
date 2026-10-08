// src/tools/claude_relaunch.js — voice tool to relaunch an agent's PTY
// with different config. Closes the live `claude` session and spawns a
// fresh one in the same worktree, with the same agent identity. The
// worktree is preserved so any uncommitted work stays intact; only the
// in-process child + its session id is replaced.
//
// Use cases:
//   • "switch Cinder to opus xhigh"          → model:"opus", effort:"xhigh"
//   • "put her into plan mode"               → permission_mode:"plan"
//   • "restart her with bypassPermissions"   → permission_mode:"bypassPermissions"
//   • "relaunch with --add-dir ../sibling"   → extra_dirs:["..."]
//
// NOT for follow-ups within the same session — that's claude_send_text
// or continue_agent_task. This tool is the equivalent of quitting and
// restarting `claude` in the terminal with different flags.

import * as hermes from "../../hermes/index.js";
import * as claudePty from "../../runtimes/claude_pty.js";

const ALLOWED_MODES = new Set([
  "default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan",
]);
const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const definition = {
  type: "function",
  name: "claude_relaunch_session",
  description:
    "Restart an agent's live Claude Code terminal with different launch options. " +
    "The worktree (any uncommitted edits) is preserved; only the `claude` child process is replaced. " +
    "Use when the user wants to switch model / effort / permission mode / add dirs, e.g. " +
    "'switch Cinder to opus xhigh', 'put her in plan mode', 'restart her with bypass permissions', " +
    "'relaunch with extra dir ../sibling'. Returns immediately with the new session info.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name or id." },
      model: { type: "string", description: "Optional model override (e.g. 'opus', 'sonnet', 'haiku', or a full model id)." },
      effort: {
        type: "string",
        description: "Optional effort level.",
        enum: ["low", "medium", "high", "xhigh", "max"],
      },
      permission_mode: {
        type: "string",
        description:
          "Permission mode. bypassPermissions = auto / yolo (default — runs everything unattended). " +
          "acceptEdits = auto-accept Edit/Write only. " +
          "default = native y/n prompts (will appear in the terminal pane). " +
          "plan = plan mode (read-only until you exit). " +
          "dontAsk = silent.",
        enum: ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"],
      },
      extra_dirs: {
        type: "array",
        items: { type: "string" },
        description: "Additional directories to grant the agent read access (--add-dir).",
      },
      mcp_config: { type: "string", description: "Optional path to an MCP config JSON to load (--mcp-config)." },
      settings_path: { type: "string", description: "Optional path to a settings JSON file (--settings)." },
    },
    required: ["agent"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = String(args?.agent || "").trim();
  if (!ref) return { error: "missing agent reference", note: "Tell the user which agent." };

  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length === 0) {
    return {
      error: `no active agent matches "${ref}"`,
      note: "Tell the user that agent isn't around. Offer to spawn a fresh one.",
    };
  }
  if (matches.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
      note: "Read the candidate names back and ask the user which one.",
    };
  }
  const target = matches[0];

  // Validate enum-ish args before tearing down anything.
  if (args?.permission_mode && !ALLOWED_MODES.has(args.permission_mode)) {
    return { error: `permission_mode "${args.permission_mode}" not allowed`, note: "Use default, acceptEdits, plan, bypassPermissions, dontAsk, or auto." };
  }
  if (args?.effort && !ALLOWED_EFFORTS.has(args.effort)) {
    return { error: `effort "${args.effort}" not allowed`, note: "Use low, medium, high, xhigh, or max." };
  }

  // Teardown the existing PTY (worktree + agent identity stay).
  try { claudePty.removeSession(target.agent_id); } catch {}

  // Respawn with new opts. ensureAgentForPty re-uses the same worktree
  // because we didn't reap the agent — only its child process is fresh.
  let r;
  try {
    r = await hermes.ensureAgentForPty(target.agent_id, {
      model:           args?.model || null,
      effort:          args?.effort || null,
      permissionMode:  args?.permission_mode || "bypassPermissions",
      addDirs:         Array.isArray(args?.extra_dirs) ? args.extra_dirs : [],
      mcpConfig:       args?.mcp_config || null,
      settingsPath:    args?.settings_path || null,
    });
  } catch (err) {
    return {
      error: String(err?.message || err),
      code: err?.code || null,
      note: "Quote the error plainly to the user — the old session is already gone, the relaunch is what failed.",
    };
  }

  return {
    ok: true,
    agent_id: r.agent_id,
    agent_name: r.name,
    cwd: r.cwd,
    worktree_path: r.worktree_path,
    config: {
      model: args?.model || null,
      effort: args?.effort || null,
      permission_mode: args?.permission_mode || "bypassPermissions",
      extra_dirs: Array.isArray(args?.extra_dirs) ? args.extra_dirs : [],
      mcp_config: args?.mcp_config || null,
      settings_path: args?.settings_path || null,
    },
    note:
      "Tell the user the session restarted with the new flags. Anything she had typed but not submitted is gone " +
      "(the prompt buffer was in the dead process), but her worktree edits are intact. If they were watching the " +
      "terminal pane, the screen will repaint with the fresh banner.",
  };
}

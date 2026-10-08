import * as hermes from "../../hermes/index.js";
import { classifyTask } from "../../hermes/route.js";

function deriveLabel(task) {
  const flat = String(task || "").replace(/\s+/g, " ").trim();
  return flat.split(/[,.!?;:\n]/)[0].slice(0, 64).toLowerCase();
}

const VALID_RUNTIMES = new Set(["claude", "hermes"]);

export const definition = {
  type: "function",
  name: "spawn_agent_task",
  description:
    "Spawn a NEW agent for a fresh, independent task. Two engines: 'claude' (Claude Code — default; for code, edits, refactors, tests, anything touching files) and 'hermes' (research, prose, quick lookups). Returns immediately with agent_id + task_id; narrate the handoff now and wait for later task_progress/task_complete events before claiming results. " +
    "**For follow-ups to an agent that's already on stage — 'tell her also do X', 'now fix Y', 'add a test', '再加一个', '接着改', or any reply that continues the same line of work — DO NOT call this. Call `continue_agent_task` instead.** " +
    "Server-side guard: if you call this without `name`/`session_id` while an idle agent is already on stage, we auto-route the call into that agent (same identity, same chat) and return `continued_existing: true` — narrate it as a continuation, not a new spawn. " +
    "**The guard auto-DISABLES when**: (a) `force_new: true`, (b) the `task` text contains explicit 'spawn-fresh' wording — 'another agent / another hermes / launch another / 再来一个 / 另一个', (c) you pass a `runtime` that doesn't match the on-stage candidate. So if the user said 'launch another hermes', 'spawn a new agent', 'fire up another one', or '再开一个 X' — you should ALSO set `force_new: true` (belt and suspenders), but even without it the guard usually does the right thing now. Freshness window is 3 minutes; older idle agents are treated as 'moved on' and never auto-continued.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "One clear self-contained instruction for the worker. Include repo/path context and the success condition, like telling a capable teammate exactly what to do.",
      },
      runtime: {
        type: "string",
        description:
          "Which engine should do the work. 'claude' = Claude Code (default; coding, edits, multi-file refactors, tests). 'hermes' = the local Hermes CLI (research, quick lookups, non-code prose). Omit to default to claude; revived agents stick to whichever engine they were last seen on.",
        enum: ["claude", "hermes"],
      },
      name: {
        type: "string",
        description:
          "Optional callsign for the worker. Pass an existing agent's name to revive that same agent (it remembers it was you). If omitted, a fresh name is auto-picked from a pool.",
      },
      session_id: {
        type: "string",
        description:
          "Optional session id to resume an earlier chat (Claude or Hermes — the coordinator routes by runtime). If we recognise the session we'll bring the same agent back; otherwise we mint a new one bound to this session.",
      },
      label: {
        type: "string",
        description:
          "Short optional label for the mission shown on the squad page. Auto-derived from task if omitted.",
      },
      repo: {
        type: "string",
        description:
          "Optional working repo path. When provided, the worker spawns with that cwd, its git HEAD is snapshotted before the run, and a diff/changed-files/branch artifact is captured at completion.",
      },
      force_new: {
        type: "boolean",
        description:
          "Set true to bypass the auto-redirect that continues an existing on-stage agent when you call this without name/session_id. Use only when the user explicitly wants a brand-new agent in parallel ('spawn another', 'send a second one').",
      },
      // ── Per-call adapter dials ────────────────────────────────────
      model: {
        type: "string",
        description:
          "Optional model override for THIS task only. Claude: 'opus' / 'sonnet' / 'haiku' or full id. Hermes: e.g. 'anthropic/claude-sonnet-4'. Voice: 'spawn Cinder on opus', 'use haiku for this'.",
      },
      effort: {
        type: "string",
        description:
          "Optional Claude effort level. Voice: 'really think about this' → xhigh / max.",
        enum: ["low", "medium", "high", "xhigh", "max"],
      },
      permission_mode: {
        type: "string",
        description:
          "Optional Claude permission mode. bypassPermissions = auto / yolo (default — runs unattended). acceptEdits = auto-accept Edit/Write only. 'default' = native y/n prompts (answer via voice). 'plan' = plan-mode (read-only).",
        enum: ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"],
      },
      extra_dirs: {
        type: "array",
        items: { type: "string" },
        description: "Optional extra dirs for the Claude agent (--add-dir). Cross-repo context.",
      },
      provider: {
        type: "string",
        description:
          "Hermes-only: inference provider override (--provider). Built-in or a name from providers: in config.yaml. Voice: 'use openrouter for this'.",
      },
      toolsets: {
        type: "array",
        items: { type: "string" },
        description: "Hermes-only: which toolsets to enable for this task (-t csv). Voice: 'with the github and recall toolsets'.",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description: "Hermes-only: pre-load skills for this task (-s csv). Voice: 'with the stripe-helper skill', 'load the kanban skill'.",
      },
      max_turns: {
        type: "integer",
        description: "Hermes-only: max tool-calling iterations per turn (--max-turns). Default 90. Voice: 'cap at 30 turns'.",
        minimum: 1,
        maximum: 500,
      },
      checkpoints: {
        type: "boolean",
        description: "Hermes-only: enable filesystem checkpoints before destructive ops (--checkpoints). Recommended ON for any task that may write/delete. Voice: 'with checkpoints on'.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  },
};

export async function run(args) {
  const task = String(args?.task || "").trim();
  if (!task) return { error: "task is required" };
  const label = args?.label ? String(args.label).slice(0, 64) : deriveLabel(task);

  // Normalise the runtime arg — anything we don't recognise we drop so
  // the coordinator's defaulting + revival continuity logic takes over.
  const runtimeArg = args?.runtime ? String(args.runtime).toLowerCase() : null;
  let runtime = runtimeArg && VALID_RUNTIMES.has(runtimeArg) ? runtimeArg : null;

  // ── Auto-routing classifier ─────────────────────────────────────────
  // If the caller didn't specify a runtime AND they're not pinning an
  // existing identity (name / session_id), peek at the task text and
  // route by intent:
  //   • coding signals (file extensions, "refactor", "test", repo nouns) → claude
  //   • non-coding signals (research, prose, summarize, "draft email") → hermes
  //   • no signals → fall through (coordinator picks via identity continuity
  //     or DEFAULT_RUNTIME, currently 'claude')
  // The caller can always override by passing runtime explicitly.
  let routedBy = null;
  if (!runtime && !args?.name && !args?.session_id) {
    const verdict = classifyTask(task);
    if (verdict) {
      runtime = verdict.runtime;
      routedBy = verdict; // surfaced in the response so omo can narrate the choice
    }
  }

  // Anti-fresh-spawn guard. The model often forgets to use
  // continue_agent_task for follow-ups, which would mint a brand-new
  // identity even though there's an idle agent already on stage waiting
  // for the next message. If the caller didn't pin a target (no name, no
  // session_id, no force_new), and the MOST RECENTLY active idle agent
  // had activity within the freshness window, route the call into that
  // agent's chat thread instead.
  //
  // Several escape hatches let the user get a NEW agent without having to
  // say "force_new" out loud:
  //   1) `force_new: true` — explicit
  //   2) Task text contains explicit "spawn-fresh" intent in EN or ZH
  //      ("launch another", "spawn another", "再来一个 hermes", "another agent")
  //   3) The user named a runtime that doesn't match the candidate (e.g.
  //      "spawn a hermes researcher" while the lone idle agent is claude)
  //
  // Freshness was 10 minutes — way too long. After ~3 minutes the user
  // has almost certainly moved on to a new topic and the auto-continue
  // creates the surprise we're trying to avoid. Override with
  // OMO_AUTOCONTINUE_FRESHNESS_MS.
  const AUTOCONTINUE_FRESHNESS_MS = Number(process.env.OMO_AUTOCONTINUE_FRESHNESS_MS || 3 * 60 * 1000);
  // Phrasing the user uses when they want a brand-new agent next to the
  // existing one. The model usually strips the verb out of the `task`
  // field, but not always — when it leaks through, we honour it.
  const FRESH_SPAWN_RE = /\b(?:another|new|fresh|second|parallel|spin(?:ning)?\s+up|fire\s+up|spawn|launch|send\s+another)\s+(?:a\s+|an\s+)?(?:hermes|claude|agent|worker|researcher|coder|one)\b/i;
  const FRESH_SPAWN_ZH = /(?:再来一个|另一个|再开一个|新派|新开|新建一个|另派一个|新的(?:agent|代理|人|worker|hermes|claude))/;
  const taskWantsFresh = FRESH_SPAWN_RE.test(task) || FRESH_SPAWN_ZH.test(task);

  let autoContinuedFrom = null;
  let resolvedName = args?.name ? String(args.name) : null;
  let resolvedSessionId = args?.session_id ? String(args.session_id) : null;

  const canAutoContinue =
    !resolvedName &&
    !resolvedSessionId &&
    !args?.force_new &&
    !taskWantsFresh;

  if (canAutoContinue) {
    try {
      const now = Date.now();
      const idle = hermes
        .listAgents()
        .filter((a) => !a.current_task)
        .sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
      const candidate = idle[0];
      const recent = candidate && (now - (candidate.last_activity_at || 0) <= AUTOCONTINUE_FRESHNESS_MS);
      // Runtime-mismatch guard: if the user explicitly asked for a
      // runtime (or the auto-classifier already picked one) and the
      // candidate is a different runtime, auto-continuing would silently
      // demote the user's choice. Skip.
      const runtimeMatch = !runtime || !candidate?.runtime || candidate.runtime === runtime;
      if (candidate && recent && runtimeMatch) {
        autoContinuedFrom = {
          agent_id: candidate.agent_id,
          name: candidate.name,
          last_activity_at: candidate.last_activity_at,
          other_idle: idle.length - 1,
        };
        resolvedName = candidate.name;
      }
    } catch {}
  }

  let dispatched;
  try {
    dispatched = hermes.dispatchTask({
      name: resolvedName,
      sessionId: resolvedSessionId,
      prompt: task,
      repoPath: args?.repo ? String(args.repo) : null,
      runtime,
      // Per-call adapter dials — each adapter takes the ones it knows.
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
    const code = err?.code;
    if (code === "AGENT_BUSY") {
      return {
        error: `${err.message || "agent already busy"}`,
        current_task: err.currentTask || null,
        note: "Tell the user that agent is mid-task; offer to wait or spawn a new one (omit `name` to pick a fresh callsign).",
      };
    }
    if (code === "NO_SEAT") {
      return {
        error: err.message,
        note: "Tell the user the office is full and suggest waiting for one to wrap up — agent_status will show who.",
      };
    }
    if (code === "NOT_INSTALLED") {
      const which = err?.runtime || "the requested";
      const other = which === "claude" ? "hermes" : "claude";
      return {
        error: `${which} is not installed on this machine`,
        runtime: err?.runtime || null,
        note: `Tell the user that ${which} isn't available — offer to retry with runtime:"${other}" if the task allows it.`,
      };
    }
    if (code === "WORKTREE_FAILED") {
      return {
        error: "couldn't set up an isolated workspace for this agent",
        parent_repo: err?.parentRepo || null,
        note:
          "Tell the user we couldn't isolate the workspace (so we won't risk editing their real checkout). Offer to retry, or to run unsafely in their actual repo if they accept that (env: OMO_WORKTREE_MODE=optional). Don't claim the task started.",
      };
    }
    return {
      error: String(err?.message || err),
      note: "Tell the user the worker could not be started and quote the error plainly.",
    };
  }

  const continuedExisting =
    !!autoContinuedFrom && autoContinuedFrom.agent_id === dispatched.agent_id;

  // Broadcast a redirect signal so /squad can show a subtle toast
  // ("auto-continued Reed") and the user has a system-level signal
  // alongside Momo's narration. Failure here is non-fatal — the dispatch
  // already succeeded, this is just UI sugar.
  if (continuedExisting) {
    try {
      hermes.broadcast({
        type: "auto_continued",
        agent_id: dispatched.agent_id,
        agent_name: dispatched.agent_name,
        task_id: dispatched.task_id,
        other_idle: autoContinuedFrom.other_idle || 0,
        reason: "spawn_called_without_target_idle_agent_recent",
        ts: Date.now(),
      });
    } catch {}
  }

  return {
    task_id: dispatched.task_id,
    agent_id: dispatched.agent_id,
    agent_name: dispatched.agent_name,
    color: dispatched.color,
    sigil: dispatched.sigil,
    seat: dispatched.seat,
    session_id: dispatched.session_id,
    runtime: dispatched.runtime,
    label,
    status: "running",
    continued_existing: continuedExisting || undefined,
    auto_continued_from: continuedExisting ? autoContinuedFrom : undefined,
    // When the auto-router picked the runtime (user didn't specify one),
    // surface why so Momo can narrate the choice naturally ("I sent this
    // to Hermes — felt more like research than coding").
    auto_routed: routedBy || undefined,
    note: continuedExisting
      ? `Auto-continued the existing on-stage agent (${dispatched.agent_name}) instead of spawning a new one — narrate this as her picking up the next message in the same chat ("好嘞~ ${dispatched.agent_name} 接着改~" / "on it — ${dispatched.agent_name} keeps going"), NOT as a new agent.` +
        (autoContinuedFrom?.other_idle > 0
          ? ` Note: ${autoContinuedFrom.other_idle} other idle agent(s) were also on stage but stale (>10min) — picked the most recent. If the user meant one of THEM, ask which.`
          : "") +
        " If they actually wanted a brand-new parallel agent, retry with force_new:true."
      : "Say one short handoff sentence in the SAME language the user just used, naming the worker by `agent_name` and hinting that progress is visible on the squad page. Do not wait for results and do not invent results; narrate the later task_complete event when it arrives. If you (Momo) want to call this same agent back later, use continue_agent_task with her `agent_name`.",
  };
}

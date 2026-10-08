// src/hermes/index.js — Agent runtime coordinator (multi-runtime).
//
// Historically this module wrapped only the local `hermes` CLI. It still
// owns all the office state — seats, identities, reaper, /hermes/ws —
// but the spawn + parse path now lives in src/runtimes/{claude,hermes}.js.
// dispatchTask({ runtime }) picks an adapter, hands it a prompt, and the
// adapter pumps canonical events back here for broadcast.
//
// Default runtime: claude. Hermes stays for non-coding (research /
// quick lookups). The squad page is runtime-agnostic — it just renders
// canonical events.
//
// Hard rules (see CLAUDE.md):
//   • never block boot — start() is non-blocking and swallows errors
//   • never throw at module load
//   • do not modify the /tool contract
//   • use bus.emit() as the single seam to dataCore + /omo/ws

import { spawnSync, spawn as spawnCmd } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath, isAbsolute, relative as relativisePath } from "node:path";
import { WebSocketServer } from "ws";
import express from "express";
import { randomUUID } from "node:crypto";

import * as bus from "../agents/bus.js";
import * as identity from "../agents/identity.js";
import * as claudeRuntime from "../runtimes/claude.js";
import * as claudePtyAdapter from "../runtimes/claude_pty_adapter.js";
import * as claudePty from "../runtimes/claude_pty.js";
import * as hermesRuntime from "../runtimes/hermes.js";
import * as hermesAcpRuntime from "../runtimes/hermes_acp.js";
import * as hermesPtyAdapter from "../runtimes/hermes_pty_adapter.js";
import * as hermesPty from "../runtimes/hermes_pty.js";

// Voice-dispatched claude tasks default to running INSIDE the agent's
// interactive PTY so the user sees the prompt + response stream in the
// terminal popup. Set OMO_CLAUDE_DISPATCH=headless to fall back to the
// old `claude -p` one-shot adapter (useful when you want structured
// stream-json events and don't care about the live TUI view).
const CLAUDE_DISPATCH_MODE = String(process.env.OMO_CLAUDE_DISPATCH || "pty").toLowerCase();
import {
  setupWorktree,
  readWorktreeIdentity,
  isGitRepo,
  isHealthyWorktree,
  sweepStaleWorktrees,
  listWorktreeDirs,
  parentRepoForWorktree,
  pruneWorktreeMetadata,
  removeWorktreeByKey,
} from "../runtimes/worktree.js";
import {
  inspectWorktree,
  getDiffText,
  applyWorktreeChanges,
  discardWorktreeChanges,
  syncUserEditsToWorktree,
  markWorktreeBaseline,
} from "../runtimes/worktree_diff.js";

// ─── Config ─────────────────────────────────────────────────────────────

// Office capacity. /feather supports a 4×3 mosaic of live PTYs, so the
// default is 12. Override via `OMO_MAX_SEATS` if you want fewer (e.g. 4
// for the legacy /squad chairs) or more.
const MAX_SEATS = Math.max(1, Number(process.env.OMO_MAX_SEATS) || 12);
const LINGER_MS = 5 * 60 * 1000;      // keep an idle agent on stage for 5min
const REVIEW_LINGER_MS = 30 * 60 * 1000; // grace window when worktree has uncommitted changes
const REAPER_INTERVAL_MS = 30 * 1000; // sweep every 30s
const MAX_TASK_EVENTS = 1000;         // per-task WS event ring (replayed on reconnect)

// Worktree failure policy. Three modes:
//   "off"      (default) — skip worktrees entirely; agents `cd` directly
//                          into the user's main checkout. Edits land in
//                          the working tree in real time, no ship/accept
//                          flow. Matches the solo-dev workflow ("just
//                          code into my omo folder").
//   "required"           — create an isolated worktree per agent at
//                          ~/.omo/worktrees/<agent_id>/ and error out if
//                          setup fails. Needed for concurrent / multi-
//                          agent work and for the preview-first loop
//                          (accept_agent_work / discard_agent_work).
//   "optional"           — try a worktree, fall back to the parent repo
//                          if setup fails.
const WORKTREE_MODE = (process.env.OMO_WORKTREE_MODE || "off").toLowerCase();
const VALID_WORKTREE_MODES = new Set(["required", "optional", "off"]);
if (!VALID_WORKTREE_MODES.has(WORKTREE_MODE)) {
  console.warn(`[hermes] unknown OMO_WORKTREE_MODE=${WORKTREE_MODE}, defaulting to "required"`);
}
function effectiveWorktreeMode() {
  return VALID_WORKTREE_MODES.has(WORKTREE_MODE) ? WORKTREE_MODE : "required";
}

// Default runtime for code-y dispatches. Override per-task by passing
// runtime='hermes' to dispatchTask, or globally via OMO_DEFAULT_RUNTIME.
const DEFAULT_RUNTIME = (process.env.OMO_DEFAULT_RUNTIME || "claude").toLowerCase();

// Preview-first toggle — only relevant when WORKTREE_MODE !== "off".
// When a worktree exists, agent work waits in it until the user
// explicitly ships it (accept_agent_work) or scraps it
// (discard_agent_work); the agent_review_card auto-projects onto the
// hologram on task_complete with PREVIEW / SHIP IT / scrap buttons, and
// Momo voice-narrates the same three options. Set
// OMO_AUTO_ACCEPT_AGENT_WORK=1 to apply on success instead. With the
// default WORKTREE_MODE=off there is no separate worktree, so this flag
// has no effect — edits already land in the user's checkout in real time.
const AUTO_ACCEPT_AGENT_WORK = (process.env.OMO_AUTO_ACCEPT_AGENT_WORK ?? "0") !== "0";
const VALID_RUNTIMES = new Set(["claude", "hermes"]);

// Sprite "station" hint — the squad layer uses this to route a worker
// to the right desk based on which tool just fired. We map both runtimes'
// tool vocabularies into the same two buckets.
const TOOL_NAME_HINTS = {
  web_search: "web_search",
  web_extract: "web_search",
  search: "web_search",
  read: "hq_query",
  read_file: "hq_query",
  edit: "hq_query",
  write: "hq_query",
  bash: "hq_query",
  terminal: "hq_query",
};

// ─── State ──────────────────────────────────────────────────────────────

// agent_id → AgentRuntime
const activeAgents = new Map();
// seat index (0..MAX_SEATS-1) → agent_id (or null when empty)
const seats = new Array(MAX_SEATS).fill(null);

const wsClients = new Set();
let reaperTimer = null;
let dataCoreRef = null;

// ─── Public API ─────────────────────────────────────────────────────────

export function attach(dataCore) {
  dataCoreRef = dataCore || null;
}

export async function start() {
  try {
    identity.init();
    // Warm both runtimes' detection caches in parallel. Either failing
    // is non-fatal — the coordinator only needs one installed to be
    // useful, and dispatchTask surfaces NOT_INSTALLED errors per-call.
    try { claudeRuntime.detect(); } catch (err) { console.warn("[runtime/claude] detect failed:", err?.message || err); }
    try { hermesRuntime.detect(); } catch (err) { console.warn("[runtime/hermes] detect failed:", err?.message || err); }
    if (!reaperTimer) {
      reaperTimer = setInterval(reaperSweep, REAPER_INTERVAL_MS);
      reaperTimer.unref?.();
    }
    // Do not delete ~/.omo/worktrees on boot. Those dirs may contain
    // unaccepted agent work from a dev-server restart; the squad UI can
    // show them as orphaned workspaces and let the user preview, accept,
    // discard, or reap them explicitly. Keep the old destructive sweep
    // behind an env flag for local cleanup sessions.
    try {
      const parent = process.cwd();
      if (process.env.OMO_SWEEP_STALE_WORKTREES === "1") {
        const removed = sweepStaleWorktrees(parent, []);
        if (removed > 0) console.log(`[hermes] swept ${removed} stale worktree(s) from ~/.omo/worktrees`);
      } else {
        pruneWorktreeMetadata(parent);
      }
    } catch (err) {
      console.warn("[hermes] startup worktree maintenance failed:", err?.message || err);
    }
  } catch (err) {
    console.warn("[hermes] start failed:", err?.message || err);
  }
}

// Best-effort synchronous shutdown. Called from server.js's signal
// handler so a Ctrl-C / SIGTERM / `node --watch` reload stops child
// processes but preserves reviewable worktrees for the next boot.
//
// Returns { stopped, preserved }.
export function shutdown() {
  let stopped = 0;
  let preserved = 0;
  for (const agent of activeAgents.values()) {
    if (agent?.currentTask?.handle) {
      try { agent.currentTask.handle.kill?.("SIGTERM"); stopped++; } catch {}
    }
    if (!agent?.worktree) continue;
    // Preserve worktrees across restarts. Deleting here loses exactly
    // the reviewable patch the user is trying to inspect or approve.
    preserved++;
  }
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  // Tear down any live PTYs from either runtime. Worktrees stay; only
  // the child terminal processes are killed.
  try { claudePty.shutdown(); } catch {}
  try { hermesPty.shutdown(); } catch {}
  return { stopped, preserved };
}

// Pick the runtime adapter for a given runtime key. Returns null if the
// key isn't recognised; callers should throw NOT_INSTALLED-ish errors.
// Claude defaults to the PTY adapter (live TUI execution); the legacy
// headless `-p` adapter is opt-in via OMO_CLAUDE_DISPATCH=headless.
//
// Hermes defaults to the PTY adapter so runtime:'hermes' dispatches stream
// into /feather like Claude. The PTY adapter seeds prompts through Hermes'
// HERMES_TUI_QUERY startup hook instead of synthesizing Enter, avoiding the
// composer submit race documented in docs/hermes-pty-submit-bug.md.
//
// Overrides:
//   OMO_HERMES_DISPATCH=oneshot/headless → legacy `hermes chat -q`
//   OMO_HERMES_DISPATCH=acp              → structured ACP adapter
const HERMES_DISPATCH_MODE = (process.env.OMO_HERMES_DISPATCH || "pty").toLowerCase();
function adapterFor(runtimeKey) {
  if (runtimeKey === "claude") {
    return CLAUDE_DISPATCH_MODE === "headless" ? claudeRuntime : claudePtyAdapter;
  }
  if (runtimeKey === "hermes") {
    if (HERMES_DISPATCH_MODE === "acp") return hermesAcpRuntime;
    if (HERMES_DISPATCH_MODE === "oneshot" || HERMES_DISPATCH_MODE === "headless") return hermesRuntime;
    return hermesPtyAdapter;
  }
  return null;
}

// Resolve the runtime to use for this dispatch. Priority order:
//   1. explicit arg
//   2. identity's lastRuntime (revival continuity)
//   3. server default
// Returns a key in VALID_RUNTIMES; never throws.
function pickRuntime(explicit, ident) {
  if (explicit && VALID_RUNTIMES.has(explicit)) return explicit;
  if (ident?.lastRuntime && VALID_RUNTIMES.has(ident.lastRuntime)) return ident.lastRuntime;
  return DEFAULT_RUNTIME;
}

// Dispatch a new task to an agent. Resolves an identity (existing one if
// `name`, `sessionId`, or `agentId` matches; otherwise mints a fresh one),
// allocates a seat if the agent isn't already on stage, and spawns Hermes.
//
// Returns: { task_id, agent_id, agent_name, color, seat, session_id,
//            runtime, started_at }
// Throws: NOT_INSTALLED, NO_SEAT, AGENT_BUSY, MISSING_PROMPT, SPAWN_FAILED
export function dispatchTask({
  name = null,
  sessionId = null,
  agentId = null,
  prompt,
  repoPath = null,
  runtime: runtimeArg = null,
  worktree: worktreeOverride = null,   // 'required'|'optional'|'off' or null = use env default
  // Per-call adapter dials — forwarded to whichever adapter handles this
  // task. Each adapter accepts what it knows and silently ignores the rest.
  model = null,
  effort = null,                       // claude-only (low/medium/high/xhigh/max)
  permissionMode = null,               // claude-only
  addDirs = null,                      // claude-only — --add-dir list
  mcpConfig = null,                    // claude-only — --mcp-config path
  settingsPath = null,                 // claude-only — --settings path
  provider = null,                     // hermes-only — --provider <name>
  toolsets = null,                     // hermes-only — -t csv
  skills = null,                       // hermes-only — -s csv
  maxTurns = null,                     // hermes-only — --max-turns N
  checkpoints = null,                  // hermes-only — --checkpoints
} = {}) {
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    const err = new Error("missing prompt");
    err.code = "MISSING_PROMPT";
    throw err;
  }

  // Resolve / mint identity. Pass the requested runtime so a freshly-
  // minted identity remembers which engine to revive under.
  const requestedRuntime = pickRuntime(runtimeArg?.toLowerCase(), null);
  const ident = identity.resolveOrMint({ id: agentId, sessionId, name, runtime: requestedRuntime });
  if (!ident) {
    const err = new Error("failed to mint identity");
    err.code = "IDENTITY_FAIL";
    throw err;
  }
  // Re-pick now that we know the identity's history — explicit arg still
  // wins, but a known-good prior runtime beats the global default.
  const runtimeKey = pickRuntime(runtimeArg?.toLowerCase(), ident);
  const adapter = adapterFor(runtimeKey);
  if (!adapter) {
    const err = new Error(`unknown runtime: ${runtimeKey}`);
    err.code = "UNKNOWN_RUNTIME";
    throw err;
  }
  const adapterStatus = adapter.status();
  if (!adapterStatus.installed) {
    const err = new Error(`${runtimeKey} is not installed`);
    err.code = "NOT_INSTALLED";
    err.runtime = runtimeKey;
    throw err;
  }

  // Reuse existing agent if it's idle (within linger), otherwise allocate a seat.
  let agent = activeAgents.get(ident.id);
  if (agent && agent.currentTask) {
    const err = new Error(`${ident.name} is already busy`);
    err.code = "AGENT_BUSY";
    err.agentId = ident.id;
    err.currentTask = publicTask(agent.currentTask);
    throw err;
  }

  let wasFreshlyCreated = false;
  if (!agent) {
    const seat = pickOpenSeat();
    if (seat == null) {
      const err = new Error(`all ${MAX_SEATS} office seats are taken — wait for one to free up`);
      err.code = "NO_SEAT";
      throw err;
    }
    agent = createRuntime(ident, seat);
    activeAgents.set(ident.id, agent);
    seats[seat] = ident.id;
    wasFreshlyCreated = true;
    emitAgentAppear(agent);
  } else {
    if (agent.reapTimer) {
      clearTimeout(agent.reapTimer);
      agent.reapTimer = null;
    }
    Object.assign(agent.identity, ident);
  }

  // Pick the right session id for the requested runtime — never cross
  // the streams (a hermes session id is meaningless to claude).
  const resumeSession = sessionId
    || (runtimeKey === "claude" ? ident.claudeSessionId : ident.hermesSessionId)
    || null;
  let task;
  try {
    task = startTask(agent, trimmed, resumeSession, repoPath, runtimeKey, adapter, worktreeOverride, {
      model, effort, permissionMode, addDirs, mcpConfig, settingsPath,
      provider, toolsets, skills, maxTurns, checkpoints,
    });
  } catch (err) {
    // startTask can throw WORKTREE_FAILED (mode=required, setup failed)
    // or surface adapter spawn errors. Roll back the seat we just
    // allocated so the caller can retry cleanly; existing agents stay
    // on stage (they were just being re-used).
    if (wasFreshlyCreated) {
      reapAgent(agent, err?.code === "WORKTREE_FAILED" ? "worktree-failed" : "spawn-failed");
    }
    throw err;
  }

  return {
    task_id: task.id,
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
    color: agent.identity.color,
    sigil: agent.identity.sigil,
    seat: agent.seat,
    session_id: resumeSession,
    runtime: runtimeKey,
    started_at: task.startedAt,
  };
}

// Snapshot of all active agents — for /agent_status tool and the squad page.
export function listAgents() {
  return [...activeAgents.values()].map(stateOf);
}

// ─── PTY launch / lookup API ────────────────────────────────────────────
// Used by voice tools (claude_send_text, claude_relaunch_session, …),
// the squad page's live-terminal tab, and /claude-deck. Allocates a seat
// + identity + worktree just like dispatchTask, then hands the cwd off
// to the requested runtime's PTY adapter instead of running a one-shot
// `-p` / `-q` task.

// ensureAgentForPty — get or create an active agent and spawn (or reuse)
// its interactive PTY session. Idempotent: calling twice with the same
// ref/runtime returns the existing live PTY.
//
// opts:
//   ref                  agent name / id (null → mint a fresh identity)
//   runtime              'claude' (default) | 'hermes'
//   model, provider      adapter-specific config
//   permissionMode       claude only; hermes accepts but ignores
//   effort               claude only; hermes ignores
//   mcpConfig            claude only; hermes ignores
//   settingsPath         claude only; hermes ignores
//   addDirs              claude only; hermes ignores
//   toolsets, skills     hermes only; claude ignores
//   maxTurns             hermes only
//   checkpoints          hermes only
//   resumeSessionId      explicit --resume target
//   continueLast         bare --continue
//   continueName         hermes only: --continue <name>
//   repoPath             parent repo; falls back to cwd
//
// Returns: { ok, agent_id, name, cwd, worktree_path, runtime, alive }
// Throws: NO_SEAT, NOT_INSTALLED, WORKTREE_FAILED
export async function ensureAgentForPty(ref = null, opts = {}) {
  const requestedRuntime = String(opts?.runtime || "claude").toLowerCase();
  if (!VALID_RUNTIMES.has(requestedRuntime)) {
    const err = new Error(`unknown runtime: ${requestedRuntime}`);
    err.code = "UNKNOWN_RUNTIME";
    throw err;
  }
  const ptyMod = requestedRuntime === "hermes" ? hermesPty : claudePty;
  const adapterDetect = ptyMod.detect();
  if (!adapterDetect.installed) {
    const err = new Error(`${requestedRuntime} is not installed`);
    err.code = "NOT_INSTALLED";
    err.runtime = requestedRuntime;
    throw err;
  }

  // Resolve / mint identity. If a ref looks like an existing agent_id
  // or name, reuse it; otherwise mint fresh.
  let ident = null;
  if (ref) {
    const matches = resolveActiveAgents(String(ref));
    if (matches.length === 1) {
      ident = identity.findById(matches[0].agent_id) || null;
    }
    if (!ident) {
      ident = identity.findById(String(ref)) || identity.findByName(String(ref)) || null;
    }
  }
  if (!ident) {
    ident = identity.resolveOrMint({
      id: typeof ref === "string" && ref.startsWith("agt_") ? ref : null,
      name: typeof ref === "string" && !ref.startsWith("agt_") ? ref : null,
      runtime: requestedRuntime,
    });
  }
  if (!ident) {
    const err = new Error("failed to mint identity");
    err.code = "IDENTITY_FAIL";
    throw err;
  }

  // Reuse or allocate seat.
  let agent = activeAgents.get(ident.id);
  let wasFreshlyCreated = false;
  if (!agent) {
    const seat = pickOpenSeat();
    if (seat == null) {
      const err = new Error(`all ${MAX_SEATS} office seats are taken — wait for one to free up`);
      err.code = "NO_SEAT";
      throw err;
    }
    agent = createRuntime(ident, seat);
    activeAgents.set(ident.id, agent);
    seats[seat] = ident.id;
    wasFreshlyCreated = true;
    emitAgentAppear(agent);
  } else {
    if (agent.reapTimer) {
      clearTimeout(agent.reapTimer);
      agent.reapTimer = null;
    }
    Object.assign(agent.identity, ident);
  }

  // Set up (or reuse) the per-agent worktree. Mirrors the logic in
  // startTask but without the task-level state.
  try {
    const resolvedParent = resolveRepoPath(opts?.repoPath);
    const mode = effectiveWorktreeMode();
    if (!agent.worktree && mode !== "off" && resolvedParent && isGitRepo(resolvedParent)) {
      const nameSlug = String(agent.identity.name || "agent")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "agent";
      const shortId = String(agent.identity.id || "").replace(/^agt_/, "").slice(0, 6);
      const worktreeKey = `${nameSlug}__${shortId}`;
      const wt = setupWorktree(resolvedParent, worktreeKey, {
        identity: {
          agent_id: agent.identity.id,
          name: agent.identity.name,
          parent_repo: resolvedParent,
        },
      });
      if (wt) {
        agent.worktree = wt;
      } else if (mode === "required") {
        const err = new Error(
          `worktree setup failed for ${agent.identity.name} (parent=${resolvedParent}). ` +
          `Set OMO_WORKTREE_MODE=optional to fall back to the parent repo, or =off to disable isolation.`,
        );
        err.code = "WORKTREE_FAILED";
        err.parentRepo = resolvedParent;
        throw err;
      }
    }
  } catch (err) {
    if (wasFreshlyCreated) {
      reapAgent(agent, err?.code === "WORKTREE_FAILED" ? "worktree-failed" : "spawn-failed");
    }
    throw err;
  }

  const cwd = agent.worktree?.path || resolveRepoPath(opts?.repoPath) || process.cwd();

  // Pick the right session id for the requested runtime — never cross
  // streams (a hermes session id is meaningless to claude).
  const inheritedSession =
    opts?.resumeSessionId ||
    (requestedRuntime === "claude" ? agent.identity.claudeSessionId : agent.identity.hermesSessionId) ||
    null;
  const shouldContinueLast =
    !!opts?.continueLast ||
    (!inheritedSession && !!(agent.lastTask || (!wasFreshlyCreated && agent.identity?.lastRuntime === requestedRuntime)));

  const ptyOpts = {
    cwd,
    model:           opts?.model || null,
    permissionMode:  opts?.permissionMode || (requestedRuntime === "claude" ? "bypassPermissions" : "yolo"),
    resumeSessionId: inheritedSession,
    continueLast:    shouldContinueLast,
    // claude-only — hermesPty.Session accepts + ignores these silently
    addDirs:         Array.isArray(opts?.addDirs) ? opts.addDirs : [],
    mcpConfig:       opts?.mcpConfig || null,
    settingsPath:    opts?.settingsPath || null,
    effort:          opts?.effort || null,
    // hermes-only — claudePty.Session accepts + ignores these
    provider:        opts?.provider || null,
    toolsets:        Array.isArray(opts?.toolsets) ? opts.toolsets : [],
    skills:          Array.isArray(opts?.skills) ? opts.skills : [],
    maxTurns:        Number.isFinite(opts?.maxTurns) ? Number(opts.maxTurns) : null,
    checkpoints:     !!opts?.checkpoints,
    continueName:    opts?.continueName || null,
  };

  let session;
  try {
    session = await ptyMod.sessionFor(agent.identity.id, ptyOpts);
    rememberPtySession(agent, requestedRuntime, session);
    schedulePtySessionRemember(agent, requestedRuntime, session);
  } catch (err) {
    // Spawn failed AFTER seat + worktree allocation. If the agent was
    // freshly minted just for this PTY, reap it so the seat isn't held
    // by a ghost; existing agents stay (they were being reused).
    if (wasFreshlyCreated) {
      reapAgent(agent, "spawn-failed");
    }
    throw err;
  }

  agent.status = "running";
  agent.lastActivityAt = Date.now();
  // Remember which runtime this agent is currently driving so the squad
  // page can pick the right tab label + WS path on first render.
  if (agent.identity) agent.identity.lastRuntime = requestedRuntime;
  emitAgentState(agent);

  return {
    ok: true,
    agent_id: agent.identity.id,
    name: agent.identity.name,
    runtime: requestedRuntime,
    cwd,
    worktree_path: agent.worktree?.path || null,
    alive: !!session?.alive,
    cols: session?.cols || null,
    rows: session?.rows || null,
  };
}

// getPtyForAgent — return the live PTY session (claude or hermes) for an
// agent reference. Checks both runtimes; if both are somehow alive,
// prefer the most recent one (hermes wins as the newer/intentional pick).
// Returns null when no live PTY exists.
export function getPtyForAgent(ref) {
  if (!ref) return null;
  const refStr = String(ref);
  // Try direct id first.
  const directH = hermesPty.getSession(refStr);
  const directC = claudePty.getSession(refStr);
  if (directH?.alive) return directH;
  if (directC?.alive) return directC;
  // Fall back to active-agent resolution (name / prefix).
  const matches = resolveActiveAgents(refStr);
  if (matches.length !== 1) return null;
  const id = matches[0].agent_id;
  const h = hermesPty.getSession(id);
  const c = claudePty.getSession(id);
  if (h?.alive) return h;
  if (c?.alive) return c;
  // Return whichever exists (even if not alive) so callers can inspect
  // the exit state. Prefer hermes for the same reason.
  return h || c || null;
}

// ─── Worktree diff / accept / discard / sync API ────────────────────────
// Thin wrappers around src/runtimes/worktree_diff.js that resolve an
// agent reference to a worktree path before calling the git helpers.
// Used by peek_agent_diff / accept_agent_work / discard_agent_work /
// sync_user_edits voice tools and the /preview-diff page.

function identityForWorktreeKey(key) {
  if (!key) return null;
  // Prefer the sidecar — it was written at worktree-creation time with
  // the exact agent_id, so no guessing. Falls back to short-id prefix
  // matching for legacy worktrees created before the sidecar existed.
  try {
    const sidecar = readWorktreeIdentity(key);
    if (sidecar?.agent_id) {
      const direct = identity.findById(sidecar.agent_id);
      if (direct) return direct;
    }
  } catch {}
  const short = String(key).split("__").pop();
  if (!short) return null;
  try {
    return (identity.list() || []).find((rec) =>
      String(rec.id || "").replace(/^agt_/, "").startsWith(short),
    ) || null;
  } catch {
    return null;
  }
}

function resolveOrphanWorktree(ref) {
  const key = String(ref || "").trim();
  if (!key) return null;
  const activeKeys = new Set(
    [...activeAgents.values()]
      .map((a) => a.worktree?.key)
      .filter(Boolean),
  );
  const dirs = listWorktreeDirs().filter((d) => !activeKeys.has(d.name));
  const exact = dirs.filter((d) => d.name === key);
  const prefix = exact.length ? exact : dirs.filter((d) => d.name.startsWith(key));
  if (prefix.length === 0) return null;
  if (prefix.length > 1) {
    return {
      error: `ambiguous workspace "${ref}" matches ${prefix.length} worktrees`,
      code: "AMBIGUOUS",
      candidates: prefix.map((d) => ({ name: d.name, path: d.path })),
    };
  }
  const dir = prefix[0];
  if (!isHealthyWorktree(dir.path)) {
    return { error: `workspace "${dir.name}" is not a healthy git worktree`, code: "NO_WORKTREE" };
  }
  const remembered = identityForWorktreeKey(dir.name);
  const parentRepo = parentRepoForWorktree(dir.path) || (isGitRepo(process.cwd()) ? process.cwd() : null);
  const pseudoId = remembered?.id || `orphan:${dir.name}`;
  return {
    orphan: true,
    agent: {
      identity: {
        id: pseudoId,
        name: remembered?.name || dir.name,
        color: remembered?.color || "#A09C92",
        sigil: remembered?.sigil || "?",
      },
      seat: null,
      status: "orphan",
      currentTask: null,
      lastTask: null,
      lastActivityAt: dir.modifiedAt || Date.now(),
      worktree: {
        path: dir.path,
        parentRepo,
        headBefore: gitHeadSync(dir.path) || "HEAD",
        key: dir.name,
        orphan: true,
      },
    },
  };
}

// Find an agent's worktree (live, lingering, or orphaned on disk after a
// restart). Returns the runtime record on success, or { error, code } on
// miss/no-worktree. Callers should treat the error shape as their failure
// response.
function resolveAgentWithWorktree(ref) {
  const match = resolveActiveAgents(ref);
  if (!match || match.length === 0) {
    const orphan = resolveOrphanWorktree(ref);
    if (orphan) return orphan;
    return { error: `no active agent or workspace matches "${ref}"`, code: "NO_AGENT" };
  }
  if (match.length > 1) {
    return {
      error: `ambiguous: "${ref}" matches ${match.length} agents`,
      code: "AMBIGUOUS",
      candidates: match.map((m) => ({ name: m.name, agent_id: m.agent_id })),
    };
  }
  const agent = activeAgents.get(match[0].agent_id);
  if (!agent) return { error: "agent gone", code: "NO_AGENT" };
  if (!agent.worktree || !isHealthyWorktree(agent.worktree.path)) {
    return {
      error: `${agent.identity.name} has no isolated workspace (already reaped or running in OMO_WORKTREE_MODE=off)`,
      code: "NO_WORKTREE",
      agent_id: agent.identity.id,
      name: agent.identity.name,
    };
  }
  return { agent };
}

// Inspect an agent's worktree — returns the file list + stat for voice
// narration / UI rendering.
export function peekAgentDiff(ref) {
  const r = resolveAgentWithWorktree(ref);
  if (r.error) return { ok: false, ...r };
  const { agent } = r;
  const inspection = inspectWorktree(agent.worktree.path, agent.worktree.headBefore);
  if (!inspection.ok) return { ok: false, error: inspection.error, code: inspection.code };
  const interrupted = agent.lastTask?.interrupted || null;
  return {
    ok: true,
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
    worktree_path: agent.worktree.path,
    parent_repo: agent.worktree.parentRepo,
    is_busy: !!agent.currentTask,
    interrupted: interrupted
      ? {
          ts: interrupted.ts,
          suspect_tools: interrupted.suspectTools || [],
          suspect_paths: interrupted.suspectPaths || [],
        }
      : null,
    ...inspection,
  };
}

// Resolve an agent reference to just the on-disk worktree path. Used by
// the /preview-agent/:id static mount so we can serve files directly out
// of the worktree without pulling a full diff. Returns null on miss so
// the caller can 404 cleanly.
export function getAgentWorktreePath(ref) {
  const r = resolveAgentWithWorktree(ref);
  if (r.error) return null;
  return r.agent.worktree?.path || null;
}

// Get the unified diff text — used by the /preview-diff page and
// returned (truncated) by the peek_agent_diff voice tool when verbose.
export function getAgentDiffText(ref) {
  const r = resolveAgentWithWorktree(ref);
  if (r.error) return { ok: false, ...r };
  const { agent } = r;
  const diff = getDiffText(agent.worktree.path, agent.worktree.headBefore);
  return {
    ...diff,
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
  };
}

// Accept — apply the agent's diff to the parent repo (or a branch).
// mode ∈ "apply" | "stage" | "commit" | "dry_run".
// Refuses to run while the agent is still mid-task — half-baked changes
// could land in main. The caller (voice tool) should narrate this.
export async function acceptAgentWork(ref, { mode = "apply", branch = null, commitMessage = null, force = false } = {}) {
  const r = resolveAgentWithWorktree(ref);
  if (r.error) return { ok: false, ...r };
  const { agent } = r;
  if (agent.currentTask && !force) {
    return {
      ok: false,
      code: "AGENT_BUSY",
      error: `${agent.identity.name} is still working — wait for the task to finish, or pass force:true to accept partial work`,
    };
  }
  // Refuse to ship work that was interrupted mid-write. The user can
  // override with force:true after eyeballing the diff. Only blocks
  // when there were file-touching tools in flight at SIGTERM time —
  // a clean stop (no Write/Edit pending) flows through normally.
  const interrupted = agent.lastTask?.interrupted;
  if (interrupted && !force && (interrupted.suspectTools?.length || 0) > 0) {
    return {
      ok: false,
      code: "INTERRUPTED",
      error:
        `${agent.identity.name}'s last task was stopped while a ${interrupted.suspectTools.join("/")} was in flight — ` +
        `the affected file(s) may be half-written. Preview the diff first, then re-call with force:true if it looks intact.`,
      interrupted_at: interrupted.ts,
      suspect_tools: interrupted.suspectTools,
      suspect_paths: interrupted.suspectPaths || [],
      agent_id: agent.identity.id,
      agent_name: agent.identity.name,
    };
  }
  const result = await applyWorktreeChanges(
    agent.worktree.path,
    agent.worktree.parentRepo,
    { baseSha: agent.worktree.headBefore, mode, branch, commitMessage },
  );
  if (result.ok && mode !== "dry_run" && !result.partial && (result.files?.length || 0) > 0) {
    const baseline = markWorktreeBaseline(agent.worktree.path, {
      message: `omo: accepted ${agent.identity.name} workspace baseline`,
    });
    if (baseline.ok && baseline.head) {
      agent.worktree.headBefore = baseline.head;
    } else if (!baseline.ok) {
      return {
        ...result,
        ok: false,
        code: baseline.code || "BASELINE_FAILED",
        error:
          "changes were applied to the target checkout, but the agent workspace could not be marked clean: " +
          (baseline.error || "baseline failed"),
        applied: true,
      };
    }
  }
  return {
    ...result,
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
  };
}

// Discard — reset the agent's worktree to its baseline.
export function discardAgentWork(ref) {
  const r = resolveAgentWithWorktree(ref);
  if (r.error) return { ok: false, ...r };
  const { agent } = r;
  if (agent.currentTask) {
    return {
      ok: false,
      code: "AGENT_BUSY",
      error: `${agent.identity.name} is still working — stop the task first with stop_agent`,
    };
  }
  const result = discardWorktreeChanges(agent.worktree.path);
  if (result.ok) {
    agent.worktree.headBefore = gitHeadSync(agent.worktree.path) || agent.worktree.headBefore;
  }
  return {
    ...result,
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
  };
}

// Sync — copy the user's dirty edits from the parent repo INTO the
// agent's worktree, so the agent can continue from where the user
// stopped instead of from HEAD.
export async function syncUserEdits(ref) {
  const r = resolveAgentWithWorktree(ref);
  if (r.error) return { ok: false, ...r };
  const { agent } = r;
  if (agent.currentTask) {
    return {
      ok: false,
      code: "AGENT_BUSY",
      error: `${agent.identity.name} is busy — sync your edits before dispatching the next task`,
    };
  }
  const result = await syncUserEditsToWorktree(agent.worktree.parentRepo, agent.worktree.path);
  if (result.ok && (result.files?.length || 0) > 0) {
    const baseline = markWorktreeBaseline(agent.worktree.path, {
      message: `omo: synced user edits baseline for ${agent.identity.name}`,
    });
    if (baseline.ok && baseline.head) {
      agent.worktree.headBefore = baseline.head;
    } else if (!baseline.ok) {
      return {
        ok: false,
        code: baseline.code || "BASELINE_FAILED",
        error:
          "user edits synced, but the agent workspace could not be marked as the new baseline: " +
          (baseline.error || "baseline failed"),
        files: result.files,
        stat: result.stat,
      };
    }
  }
  return {
    ...result,
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
  };
}

// Read-only export for the `describe_changes` voice tool. Walks every
// active agent (live + lingering) and pulls the file_change events from
// their per-task event buffers. Returns a flat list sorted newest-first,
// capped so the tool reply stays small. Hunks are dropped for brevity —
// callers that want them go through /hermes/ws directly.
export function listRecentFileChanges({ limit = 20 } = {}) {
  const out = [];
  for (const agent of activeAgents.values()) {
    for (const task of [agent.currentTask, agent.lastTask]) {
      if (!task || !Array.isArray(task.eventBuffer)) continue;
      for (const ev of task.eventBuffer) {
        if (ev.type !== 'file_change' || ev.stage !== 'resolved') continue;
        out.push({
          task_id: task.id,
          agent_id: agent.identity.id,
          agent_name: agent.identity.name,
          color: agent.identity.color,
          runtime: task.runtime,
          path: ev.path,
          relPath: ev.relPath || ev.path,
          added: ev.stat?.added || 0,
          removed: ev.stat?.removed || 0,
          ts: ev.ts,
        });
      }
    }
  }
  // Newest first. Dedupe by (task_id, path) so the pending+resolved
  // pair collapses into the resolved one.
  const seen = new Set();
  const unique = [];
  for (const x of out.sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    const k = x.task_id + '::' + x.path;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(x);
    if (unique.length >= limit) break;
  }
  return unique;
}

// Resolve an agent reference (id, name, or partial) to an active agent.
// Used by show_agent_screen and other voice tools. Returns null on miss.
// Return EVERY active agent matching a free-form ref. Tiered:
//   1. Exact agent_id (deterministic — short-circuits)
//   2. All exact name matches (case-insensitive)
//   3. All prefix matches on name (case-insensitive)
// Voice tools use this to detect ambiguity (e.g. two "Cinder-N" agents)
// so they can ask the user to clarify instead of silently picking one.
export function resolveActiveAgents(ref) {
  if (!ref) return [];
  const key = String(ref).trim();
  if (!key) return [];
  // Exact id wins outright — never ambiguous.
  if (activeAgents.has(key)) return [stateOf(activeAgents.get(key))];
  const lower = key.toLowerCase();
  const exact = [];
  const prefix = [];
  for (const r of activeAgents.values()) {
    const n = r.identity.name?.toLowerCase();
    if (!n) continue;
    if (n === lower) exact.push(stateOf(r));
    else if (n.startsWith(lower)) prefix.push(stateOf(r));
  }
  if (exact.length > 0) return exact;
  return prefix;
}

// Single-agent resolver — kept for back-compat. Returns null when there
// are no matches; returns the single match unchanged. Callers that want
// to detect ambiguity should use resolveActiveAgents() directly.
export function resolveActiveAgent(ref) {
  const all = resolveActiveAgents(ref);
  return all[0] || null;
}

// Look up an agent (active or remembered) — falls back to the identity
// store so the user can ask about an agent that already left.
export function resolveAgent(ref) {
  const active = resolveActiveAgent(ref);
  if (active) return { ...active, active: true };
  if (!ref) return null;
  const idMatch = identity.findById(ref);
  if (idMatch) return { ...idMatch, active: false };
  const nameMatch = identity.findByName(ref);
  if (nameMatch) return { ...nameMatch, active: false };
  return null;
}

// File-touching tools (canonical lowercase names from runtimes/claude.js's
// TOOL_NAME_MAP). If any of these is in flight when we SIGTERM the agent
// child, the file on disk may be half-written — we tag the task so the
// downstream peek/accept flow can warn the user and require force:true.
const FILE_TOUCHING_TOOL_NAMES = new Set(["edit", "write"]);

export function interruptAgent(agentId) {
  const agent = activeAgents.get(agentId);
  if (!agent || !agent.currentTask) return false;
  const task = agent.currentTask;
  const handle = task.handle;
  // Snapshot any file-touching tools that were mid-flight when we sent
  // SIGTERM. The agent typically flushes on signal, but Write/Edit can
  // leave a half-written file if the kill landed between open() and
  // close(). Surfaced later via accept_agent_work so the user can opt
  // into reviewing or pass force:true.
  const suspectTools = [];
  const suspectPaths = [];
  for (const [name, info] of task.activeTools.entries()) {
    if (!FILE_TOUCHING_TOOL_NAMES.has(name)) continue;
    suspectTools.push(name);
    const arg = String(info?.args || "").trim();
    if (arg) suspectPaths.push(arg);
  }
  task.interrupted = {
    ts: Date.now(),
    suspectTools,
    suspectPaths,
    hadActiveTools: task.activeTools.size > 0,
  };
  try { handle?.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try {
      if (agent.currentTask === task) handle?.kill("SIGKILL");
    } catch {}
  }, 1000).unref?.();
  return true;
}

// Iterate active runtimes and SIGTERM every one with a current task.
// Returns the list of agents that received the signal (so the caller can
// narrate "stopped Cinder, Nimbus, Ember").
export function interruptAllAgents() {
  const out = [];
  for (const [agent_id, agent] of activeAgents.entries()) {
    if (!agent.currentTask) continue;
    const ok = interruptAgent(agent_id);
    out.push({ agent_id, name: agent.identity?.name || agent_id, ok });
  }
  return out;
}

// Snapshot of what's currently on one agent's "screen" — the data omo
// needs to actually narrate specifics ("she's editing avatar.js, just
// added a smoothing coefficient on line 18"). Reads the per-agent ring
// (filled by recordEventForRing) plus the runtime's current task.
//
// Heuristic mirrors the /squad page's deriveView: events are bucketed
// by which tool last fired, output chunks attribute to the most recent
// tool's panel, and a separate "thoughts" array collects natural-prose
// chunks (the agent's reasoning between tool calls).
export function getScreenContext(ref) {
  const match = resolveActiveAgent(ref);
  if (!match) return { error: `no active agent matches "${ref}"` };
  const agent = activeAgents.get(match.agent_id);
  const ring  = eventRings.get(match.agent_id) || [];
  const task  = agent?.currentTask || null;

  // Bucket recent events into per-resource "panels" + a thoughts list.
  const panels = new Map(); // id -> { kind, label, output: '', tools: [], lastTs }
  const thoughts = [];      // [{ text, ts }]
  const tools = [];         // [{ tool, args, ok, ts }]
  let curId = null;

  function ensure(id, kind, label, ts) {
    let p = panels.get(id);
    if (!p) { p = { id, kind, label, output: '', tools: [], lastTs: ts }; panels.set(id, p); }
    if (ts > p.lastTs) p.lastTs = ts;
    return p;
  }
  function panelKey(tool, args) {
    const k = String(tool || '').toLowerCase();
    const a = String(args || '').trim();
    if (['read_file','read','view','open','cat','edit_file','write_file','write','edit','patch'].includes(k))
      return { id: 'file:' + (a || '?'), kind: 'file', label: a || '(unknown)' };
    if (['web_search','search','google'].includes(k))
      return { id: 'search:' + (a || '?'), kind: 'search', label: a || '(empty)' };
    if (['web_extract','fetch','curl','http'].includes(k))
      return { id: 'url:' + (a || '?'), kind: 'url', label: a || '(unknown url)' };
    if (['terminal','bash','shell','exec','run','grep','glob','find','ls'].includes(k))
      return { id: 'terminal', kind: 'terminal', label: 'terminal' };
    return { id: 'misc:' + k, kind: 'misc', label: k || 'misc' };
  }
  function looksLikeProse(text) {
    const raw = String(text || '');
    const t = raw.replace(/^\s+/, '');
    if (!t) return false;
    if (/^┊/.test(t) || /^\s*┊/.test(raw)) return false;
    if (/^[+\-@<>{}/\\]/.test(t)) return false;
    if (/^[a-z_$][a-z0-9_$]*\s*[(=:]/i.test(t)) return false;
    if (/^https?:\/\//i.test(t)) return false;
    if (/^[a-z0-9_\-./]+\.[a-z]{1,5}:?\d*$/i.test(t)) return false;
    if (/^(function|const|let|var|import|export|class|if|else|return|for|while|do|switch|case|try|catch|finally|throw|new|interface|type|enum|public|private|protected|static|async|await|def|fn|impl|use|mod|pub|struct)\b/i.test(t)) return false;
    const codey = (t.match(/[{};]/g) || []).length;
    const words = t.match(/\b\w{2,}\b/g) || [];
    if (codey >= 1 && words.length < codey * 4) return false;
    if (words.length < 3) return false;
    const alpha = (t.match(/[a-zA-Z一-鿿]/g) || []).length;
    if (alpha < t.length * 0.4) return false;
    return true;
  }

  let lastError = null;
  for (const e of ring) {
    if (e.type === 'tool_start') {
      const spec = panelKey(e.tool, e.args);
      const p = ensure(spec.id, spec.kind, spec.label, e.ts || 0);
      p.tools.push({ tool: e.tool, args: e.args, ts: e.ts });
      tools.push({ tool: e.tool, args: e.args, ts: e.ts, ok: true });
      curId = spec.id;
    } else if (e.type === 'tool_end') {
      // back-annotate the matching tool
      for (let i = tools.length - 1; i >= 0; i--) {
        if (tools[i].tool === e.tool) { tools[i].ok = e.ok !== false; break; }
      }
    } else if (e.type === 'chunk' || e.type === 'stderr') {
      const text = e.text || '';
      if (!text) continue;
      if (e.type === 'chunk' && looksLikeProse(text)) {
        thoughts.push({ text: text.trim(), ts: e.ts || 0 });
      }
      if (curId) {
        const p = panels.get(curId);
        if (p) p.output += text;
      }
    } else if (e.type === 'task_error') {
      lastError = e.error || 'unknown error';
    }
  }

  // Live panel = the most recent tool's panel (what the user would see
  // on the active tab if their monitor were open).
  const livePanel = curId ? panels.get(curId) : null;
  const livePanelView = livePanel ? {
    kind: livePanel.kind,
    label: livePanel.label,
    // tail of the output so omo gets recent context, not the whole file
    tail: (livePanel.output || '').split('\n').slice(-20).join('\n').trim(),
  } : null;

  // Files touched (anything the agent read or edited)
  const files = [...panels.values()]
    .filter((p) => p.kind === 'file')
    .map((p) => ({ path: p.label, edited: p.tools.some((tt) => /^(edit|write|patch)/i.test(tt.tool || '')) }));

  // Recent search queries
  const searches = [...panels.values()].filter((p) => p.kind === 'search').map((p) => p.label);

  return {
    agent_id: match.agent_id,
    name: match.name,
    status: agent?.currentTask ? 'running' : (agent ? 'idle' : 'gone'),
    prompt: task?.prompt || null,
    started_at: task?.startedAt || null,
    elapsed_ms: task?.startedAt ? Date.now() - task.startedAt : null,
    tools_used: tools.length,
    tools_recent: tools.slice(-6).map((tt) => ({ tool: tt.tool, args: String(tt.args || '').slice(0, 120), ok: tt.ok })),
    files_touched: files,
    searches,
    thoughts_recent: thoughts.slice(-4).map((th) => th.text),
    live_panel: livePanelView,
    last_error: lastError,
  };
}

// Public re-export so other modules (show_agent_screen, etc.) can fan UI
// events out to any open /squad page over the same socket.
export function broadcast(msg) { wsBroadcast(msg); }

// ─── HTTP routes ────────────────────────────────────────────────────────

export function mountRoutes(app) {
  const json = express.json({ limit: "256kb" });

  app.get("/omo/api/hermes/status", (_req, res) => {
    try { res.json(buildStatus()); }
    catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
  });

  app.get("/omo/api/hermes/agents", (_req, res) => {
    try { res.json(listAgents()); }
    catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
  });

  app.get("/omo/api/hermes/agents/:id", (req, res) => {
    const id = String(req.params.id || "");
    const runtime = activeAgents.get(id);
    if (!runtime) {
      const remembered = identity.findById(id);
      if (remembered) return res.json({ ...remembered, active: false, status: "left" });
      return res.status(404).json({ error: "unknown agent" });
    }
    res.json(stateOf(runtime));
  });

  app.post("/omo/api/hermes/agents/:id/run", json, (req, res) => {
    handleRun(req, res, { agentId: String(req.params.id || "") });
  });

  app.post("/omo/api/hermes/agents/:id/interrupt", json, (req, res) => {
    try {
      const ok = interruptAgent(String(req.params.id || ""));
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.get("/omo/api/hermes/agents/:id/memory", (_req, res) => {
    try { res.json(readMemoryShared()); }
    catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
  });

  app.get("/omo/api/hermes/agents/:id/skills", (_req, res) => {
    try { res.json(listSkillsShared()); }
    catch (err) { res.json({ error: String(err?.message || err), skills: [] }); }
  });

  app.get("/omo/api/hermes/agents/:id/sessions", async (_req, res) => {
    if (!hermesRuntime.status().installed) return res.json([]);
    try { res.json(await listSessions()); }
    catch (err) { res.json({ error: String(err?.message || err), sessions: [] }); }
  });

  app.get("/omo/api/hermes/agents/:id/last-artifacts", (req, res) => {
    const runtime = activeAgents.get(String(req.params.id || ""));
    const artifacts = runtime?.lastArtifacts || null;
    res.json({ agent_id: String(req.params.id || ""), artifacts });
  });

  // Default-dispatch alias: mints an anonymous agent.
  app.post("/omo/api/hermes/run", json, (req, res) => handleRun(req, res, {}));

  app.get("/omo/api/hermes/sessions", async (_req, res) => {
    if (!hermesRuntime.status().installed) return res.json([]);
    try { res.json(await listSessions()); }
    catch (err) { res.json({ error: String(err?.message || err), sessions: [] }); }
  });

  app.get("/omo/api/hermes/memory", (_req, res) => {
    try { res.json(readMemoryShared()); }
    catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
  });

  app.get("/omo/api/hermes/skills", (_req, res) => {
    try { res.json(listSkillsShared()); }
    catch (err) { res.json({ error: String(err?.message || err), skills: [] }); }
  });

  app.get("/omo/api/hermes/skills/:name", (req, res) => {
    try {
      const out = readSkill(String(req.params.name || ""));
      if (!out) return res.status(404).json({ error: "skill not found" });
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/omo/api/hermes/interrupt", json, (req, res) => {
    try {
      const taskId = req.body?.task_id ? String(req.body.task_id) : null;
      const agentId = req.body?.agent_id ? String(req.body.agent_id) : null;
      let ok = false;
      if (agentId) {
        ok = interruptAgent(agentId);
      } else if (taskId) {
        for (const runtime of activeAgents.values()) {
          if (runtime.currentTask && runtime.currentTask.id === taskId) {
            ok = interruptAgent(runtime.identity.id);
            break;
          }
        }
      }
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
}

function handleRun(req, res, { agentId }) {
  try {
    const prompt = req.body?.prompt;
    const sessionId = req.body?.sessionId || req.body?.session_id || null;
    const name = req.body?.name || null;
    const rawRuntime = req.body?.runtime;
    let runtime = null;
    if (rawRuntime != null) {
      const norm = String(rawRuntime).toLowerCase();
      if (!VALID_RUNTIMES.has(norm)) {
        return res.status(400).json({
          error: `unknown runtime: ${rawRuntime}`,
          valid: [...VALID_RUNTIMES],
        });
      }
      runtime = norm;
    }
    const repoPath = req.body?.repo || req.body?.repoPath || null;
    const worktree = req.body?.worktree || null;
    const out = dispatchTask({ agentId, sessionId, name, prompt, runtime, repoPath, worktree });
    res.json(out);
  } catch (err) {
    const code = err?.code;
    if (code === "AGENT_BUSY") return res.status(409).json({ error: "agent busy", currentTask: err.currentTask });
    if (code === "NO_SEAT") return res.status(503).json({ error: err.message });
    if (code === "MISSING_PROMPT") return res.status(400).json({ error: "missing prompt" });
    if (code === "NOT_INSTALLED") return res.status(503).json({ error: "hermes not installed" });
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// ─── WebSocket ──────────────────────────────────────────────────────────

export function mountWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    wsClients.add(socket);
    try {
      socket.send(JSON.stringify({
        type: "hello",
        status: buildStatus(),
        agents: listAgents(),
      }));
    } catch {}
    // Replay agent_appear + task lifecycle for everyone currently on
    // stage so a fresh client gets a populated office AND catches up on
    // events that streamed while it was disconnected.
    for (const runtime of activeAgents.values()) {
      try {
        const rt = runtime.currentTask?.runtime
          || runtime.identity?.lastRuntime
          || runtime.lastTask?.runtime
          || DEFAULT_RUNTIME;
        socket.send(JSON.stringify({
          type: "agent_appear",
          agent_id: runtime.identity.id,
          name: runtime.identity.name,
          color: runtime.identity.color,
          sigil: runtime.identity.sigil,
          seat: runtime.seat,
          status: runtime.status,
          runtime: rt,
          appeared_at: runtime.appearedAt,
          resumed: true,
        }));
        // Pick whichever task has the events we want to replay. A live
        // task always wins; otherwise the most recently finished task
        // (still in linger) brings the client back to "done" state.
        const replayTask = runtime.currentTask || runtime.lastTask;
        if (replayTask) {
          socket.send(JSON.stringify({
            type: "task_start",
            agent_id: runtime.identity.id,
            task_id: replayTask.id,
            session_id: replayTask.sessionId,
            prompt: replayTask.prompt,
            runtime: replayTask.runtime || null,
            worktree: replayTask.worktree?.path || null,
            parent_repo: replayTask.parentRepo || null,
            ts: replayTask.startedAt,
            resumed: true,
          }));
          for (const ev of replayTask.eventBuffer || []) {
            try { socket.send(JSON.stringify(ev)); } catch {}
          }
        }
      } catch {}
    }
    socket.on("close", () => wsClients.delete(socket));
    socket.on("error", () => wsClients.delete(socket));
  });
  httpServer.on("upgrade", (req, sock, head) => {
    const path = (req.url || "").split("?")[0];
    if (path !== "/hermes/ws") return;
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
  });
  return wss;
}

function wsBroadcast(msg) {
  const text = JSON.stringify(msg);
  for (const sock of wsClients) {
    try { if (sock.readyState === 1) sock.send(text); } catch {}
  }
  // Also tap into a small per-agent ring buffer so getScreenContext can
  // answer "what is X doing right now?" without needing the squad page
  // to be open. Only retain the events relevant to that view.
  recordEventForRing(msg);
}

// ── per-agent event ring (server-side mirror of /squad's view) ──────
// Bounded to RING_MAX events per agent; older events fall off the front.
// Cleared on agent_leave to avoid leaking memory.
const RING_MAX = 100;
const eventRings = new Map(); // agent_id -> Array<event>
function recordEventForRing(msg) {
  if (!msg || typeof msg !== 'object') return;
  const aid = msg.agent_id;
  if (!aid) return;
  // Skip pure UI fan-out events — they don't reflect agent activity.
  if (msg.type === 'ui_open_screen' || msg.type === 'ui_select_tab' ||
      msg.type === 'ui_close_screen' || msg.type === 'ui_stop_agent') return;
  if (msg.type === 'agent_leave') { eventRings.delete(aid); return; }
  let r = eventRings.get(aid);
  if (!r) { r = []; eventRings.set(aid, r); }
  r.push(msg);
  if (r.length > RING_MAX) r.splice(0, r.length - RING_MAX);
}

// Push a task-scoped WS event into the task's replay buffer AND broadcast
// it live. The buffer is the only thing the reconnect path uses to bring
// disconnected clients back up to date.
function bufferAndBroadcast(task, msg) {
  if (task) {
    if (!task.eventBuffer) task.eventBuffer = [];
    task.eventBuffer.push(msg);
    if (task.eventBuffer.length > MAX_TASK_EVENTS) {
      task.eventBuffer.splice(0, task.eventBuffer.length - MAX_TASK_EVENTS);
    }
  }
  wsBroadcast(msg);
}

// ─── Runtime helpers ────────────────────────────────────────────────────

function ptySessionForRuntime(agentId, runtimeKey) {
  if (!agentId) return null;
  try {
    return runtimeKey === "hermes"
      ? hermesPty.getSession(agentId)
      : claudePty.getSession(agentId);
  } catch {
    return null;
  }
}

function readPtySessionId(session) {
  if (!session) return null;
  try {
    const direct = session.readActiveSessionId?.();
    if (direct) return String(direct);
  } catch {}
  try {
    const st = session.status?.();
    if (st?.session_id) return String(st.session_id);
  } catch {}
  return null;
}

function rememberPtySession(agent, runtimeKey, session) {
  if (!agent?.identity || !VALID_RUNTIMES.has(runtimeKey)) return false;
  const sessionId = readPtySessionId(session);
  if (!sessionId) return false;
  const field = runtimeKey === "claude" ? "claudeSessionId" : "hermesSessionId";
  const changed = agent.identity[field] !== sessionId || agent.identity.lastRuntime !== runtimeKey;
  const touched = identity.touch(agent.identity.id, {
    sessionId,
    runtime: runtimeKey,
    lastRuntime: runtimeKey,
  });
  if (touched) Object.assign(agent.identity, touched);
  else {
    agent.identity[field] = sessionId;
    agent.identity.lastRuntime = runtimeKey;
  }
  return changed;
}

function schedulePtySessionRemember(agent, runtimeKey, session) {
  for (const delay of [1000, 3000, 8000, 15000]) {
    const timer = setTimeout(() => {
      if (!activeAgents.has(agent.identity.id)) return;
      rememberPtySession(agent, runtimeKey, session);
    }, delay);
    timer.unref?.();
  }
}

function createRuntime(ident, seat) {
  return {
    identity: { ...ident },
    seat,
    status: "dispatching",
    currentTask: null,
    lastTask: null,
    lastArtifacts: null,
    appearedAt: Date.now(),
    lastActivityAt: Date.now(),
    reapTimer: null,
    // Persistent per-agent git worktree (set on first task, cleaned in
    // reapAgent). Required so consecutive `claude --resume` calls find
    // the prior session — Claude Code stores history per-cwd.
    worktree: null,
  };
}

function pickOpenSeat() {
  for (let i = 0; i < seats.length; i++) {
    if (seats[i] == null) return i;
  }
  return null;
}

function emitAgentAppear(runtime) {
  // Surface the agent's runtime in the appear event so the page knows
  // which PTY endpoint to attach. Without this, /feather defaulted to
  // /claude-tty/ws/ for every new agent and missed Hermes terminals.
  // Same resolution as stateOf(): currentTask wins (an actively-running
  // task is the most authoritative signal), then identity.lastRuntime,
  // then the most recent completed task, then the server default.
  const rt = runtime.currentTask?.runtime
    || runtime.identity?.lastRuntime
    || runtime.lastTask?.runtime
    || DEFAULT_RUNTIME;
  wsBroadcast({
    type: "agent_appear",
    agent_id: runtime.identity.id,
    name: runtime.identity.name,
    color: runtime.identity.color,
    sigil: runtime.identity.sigil,
    seat: runtime.seat,
    status: runtime.status,
    runtime: rt,
    appeared_at: runtime.appearedAt,
  });
  try {
    bus.emit({
      kind: "agent:appear",
      agent_id: runtime.identity.id,
      title: `agent ${runtime.identity.name} on seat ${runtime.seat}`,
      summary: `${runtime.identity.name} arrived`,
      data: stateOf(runtime),
    });
  } catch {}
}

function emitAgentLeave(runtime, reason) {
  wsBroadcast({
    type: "agent_leave",
    agent_id: runtime.identity.id,
    name: runtime.identity.name,
    seat: runtime.seat,
    reason: reason || "reaped",
    ts: Date.now(),
  });
  try {
    bus.emit({
      kind: "agent:leave",
      agent_id: runtime.identity.id,
      title: `agent ${runtime.identity.name} left`,
      summary: reason || "reaped",
      data: { agent_id: runtime.identity.id, seat: runtime.seat, reason },
    });
  } catch {}
}

function emitAgentState(runtime) {
  runtime.lastActivityAt = Date.now();
  wsBroadcast({
    type: "agent_state",
    agent_id: runtime.identity.id,
    state: stateOf(runtime),
  });
}

function publicTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    prompt: t.prompt,
    sessionId: t.sessionId,
    runtime: t.runtime,
    worktree: t.worktree?.path || null,
    parentRepo: t.parentRepo || null,
    startedAt: t.startedAt,
  };
}

function stateOf(runtime) {
  // Linger countdown: when an idle agent is on the reap timer, surface
  // *when* it'll be reaped so the UI can show "reaps in 24m" and offer
  // a Keep button. Active agents have no countdown (currentTask !== null).
  let lingerExpiresAt = null;
  let lingerExtended = false;
  if (!runtime.currentTask) {
    const last = runtime.lastActivityAt || runtime.appearedAt;
    const ttl = lingerTtlFor(runtime);
    lingerExpiresAt = last + ttl;
    lingerExtended = ttl > LINGER_MS;
  }
  // currentTask wins — an actively-running task is the most authoritative
  // signal of which engine is currently doing work. Match emitAgentAppear's
  // priority so the snapshot endpoint and the WS event agree.
  const lastRuntime = runtime.currentTask?.runtime
    || runtime.identity.lastRuntime
    || runtime.lastTask?.runtime
    || DEFAULT_RUNTIME;
  const primaryPty = ptySessionForRuntime(runtime.identity.id, lastRuntime);
  const fallbackPty = lastRuntime === "claude"
    ? ptySessionForRuntime(runtime.identity.id, "hermes")
    : ptySessionForRuntime(runtime.identity.id, "claude");
  const primaryLiveSessionId = readPtySessionId(primaryPty);
  const fallbackLiveSessionId = readPtySessionId(fallbackPty);
  const sessionId = lastRuntime === "claude"
    ? (primaryLiveSessionId || runtime.identity.claudeSessionId || fallbackLiveSessionId || runtime.identity.hermesSessionId || null)
    : (primaryLiveSessionId || runtime.identity.hermesSessionId || fallbackLiveSessionId || runtime.identity.claudeSessionId || null);
  return {
    agent_id: runtime.identity.id,
    name: runtime.identity.name,
    color: runtime.identity.color,
    sigil: runtime.identity.sigil,
    seat: runtime.seat,
    status: runtime.status,
    alive: !!(primaryPty?.alive || fallbackPty?.alive),
    session_id: sessionId,
    runtime: lastRuntime,
    current_task: runtime.currentTask ? publicTask(runtime.currentTask) : null,
    last_task: runtime.lastTask ? publicTask(runtime.lastTask) : null,
    appeared_at: runtime.appearedAt,
    last_activity_at: runtime.lastActivityAt,
    linger_expires_at: lingerExpiresAt,
    linger_extended: lingerExtended,
    has_worktree: !!runtime.worktree,
  };
}

// Snapshot of every worktree on disk. Zips ~/.omo/worktrees/* directory
// listings with the running coordinator state — so the squad UI knows
// "this dir belongs to Reed who's still seated" vs "this dir is an
// orphan from a server crash, click Reap to nuke." Returns:
//   [{ key, path, name?, agent_id?, sizeBytes, modifiedAt, status,
//      changes, busy, linger_expires_at }]
// where status ∈ "active" | "orphan", changes = inspectWorktree summary.
export function listWorktrees() {
  const byKey = new Map();
  // Disk-first pass
  for (const d of listWorktreeDirs()) {
    let changes = null;
    try {
      if (isHealthyWorktree(d.path)) {
        const r = inspectWorktree(d.path, gitHeadSync(d.path) || "HEAD");
        if (r.ok) changes = { hasChanges: r.hasChanges, ...r.stat };
      }
    } catch {}
    byKey.set(d.name, {
      key: d.name,
      path: d.path,
      sizeBytes: d.sizeBytes,
      modifiedAt: d.modifiedAt,
      status: "orphan",
      agent_id: null,
      name: null,
      busy: false,
      linger_expires_at: null,
      changes,
    });
  }
  // Overlay live agent info
  for (const agent of activeAgents.values()) {
    if (!agent.worktree?.path) continue;
    const key = agent.worktree.key || agent.identity.id;
    const entry = byKey.get(key) || {
      key, path: agent.worktree.path,
      sizeBytes: 0, modifiedAt: 0,
    };
    entry.status = "active";
    entry.agent_id = agent.identity.id;
    entry.name = agent.identity.name;
    entry.busy = !!agent.currentTask;
    entry.linger_expires_at = agent.currentTask
      ? null
      : (agent.lastActivityAt || agent.appearedAt) + lingerTtlFor(agent);
    // Cheap diff inspection — skip if busy (worktree is mid-write).
    if (!entry.busy) {
      try {
        const r = inspectWorktree(agent.worktree.path, agent.worktree.headBefore);
        if (r.ok) entry.changes = { hasChanges: r.hasChanges, ...r.stat };
      } catch {}
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
}

// Manual reap: force the agent off-stage NOW (not at linger expiry).
// Used by the squad worktrees panel's "Reap" button. Aborts if busy
// unless force=true (which is essentially stop_agent + reap).
export function reapAgentNow(agentRef, { force = false } = {}) {
  const matches = resolveActiveAgents(agentRef);
  if (matches.length === 0) {
    const orphan = resolveOrphanWorktree(agentRef);
    if (orphan?.error) return { ok: false, ...orphan };
    if (orphan?.agent?.worktree?.key) {
      const removed = removeWorktreeByKey(orphan.agent.worktree.parentRepo || process.cwd(), orphan.agent.worktree.key);
      return removed.ok
        ? { ok: true, agent_id: orphan.agent.identity.id, name: orphan.agent.identity.name, workspace_key: orphan.agent.worktree.key, orphan: true }
        : removed;
    }
    return { ok: false, error: "no such active agent or workspace", code: "NO_AGENT" };
  }
  if (matches.length > 1) return { ok: false, error: "ambiguous", candidates: matches };
  const agent = activeAgents.get(matches[0].agent_id);
  if (!agent) return { ok: false, error: "agent gone", code: "NO_AGENT" };
  if (agent.currentTask && !force) {
    return { ok: false, error: `${agent.identity.name} is still working — pass force:true to interrupt + reap`, code: "AGENT_BUSY" };
  }
  if (agent.currentTask && force) {
    try { agent.currentTask.handle?.kill?.("SIGTERM"); } catch {}
  }
  reapAgent(agent, "manual");
  return { ok: true, agent_id: agent.identity.id, name: agent.identity.name };
}

// Extend the agent's linger window by bumping lastActivityAt to "now"
// and rescheduling. Called from /omo/api/hermes/agents/:id/keep when
// the user clicks "Keep" on the squad UI — the agent stays seated
// through another full review window even though no task is running.
export function keepAgent(agentId) {
  const runtime = activeAgents.get(agentId);
  if (!runtime) return { ok: false, error: "no such active agent", code: "NO_AGENT" };
  runtime.lastActivityAt = Date.now();
  scheduleReap(runtime);
  emitAgentState(runtime);
  return {
    ok: true,
    agent_id: agentId,
    name: runtime.identity.name,
    linger_expires_at: runtime.lastActivityAt + lingerTtlFor(runtime),
  };
}

// ─── Reaper ─────────────────────────────────────────────────────────────

function reaperSweep() {
  const now = Date.now();
  for (const runtime of [...activeAgents.values()]) {
    if (runtime.currentTask) continue;          // never reap a busy agent
    if (runtime.reapTimer) continue;            // scheduled already
    const idleFor = now - (runtime.lastActivityAt || runtime.appearedAt);
    const ttl = lingerTtlFor(runtime);
    if (idleFor >= ttl) {
      if (runtimeHasPendingChanges(runtime)) {
        runtime.lastActivityAt = now;
        scheduleReap(runtime);
        emitAgentState(runtime);
        continue;
      }
      reapAgent(runtime, "idle-timeout");
    }
  }
}

// Pick the appropriate linger TTL for this runtime. Default is 5 min,
// but agents with uncommitted changes in their worktree get 30 min so
// the user has time to review + accept/discard before the workspace
// (and Claude Code's per-cwd session history) gets reaped.
function lingerTtlFor(runtime) {
  if (!runtime?.worktree?.path) return LINGER_MS;
  return runtimeHasPendingChanges(runtime) ? REVIEW_LINGER_MS : LINGER_MS;
}

function runtimeHasPendingChanges(runtime) {
  if (!runtime?.worktree?.path) return false;
  try {
    const r = inspectWorktree(runtime.worktree.path, runtime.worktree.headBefore);
    return !!(r.ok && r.hasChanges);
  } catch {}
  return false;
}

function scheduleReap(runtime) {
  if (runtime.reapTimer) clearTimeout(runtime.reapTimer);
  const ttl = lingerTtlFor(runtime);
  runtime.reapTimer = setTimeout(() => {
    runtime.reapTimer = null;
    // Re-check — a new task may have arrived during linger.
    if (runtime.currentTask) return;
    // Pending code is never auto-deleted. Keep pushing the review timer
    // out until the user accepts, discards, or explicitly reaps it.
    if (runtimeHasPendingChanges(runtime)) {
      runtime.lastActivityAt = Date.now();
      scheduleReap(runtime);
      emitAgentState(runtime);
      return;
    }
    reapAgent(runtime, "linger-expired");
  }, ttl);
  runtime.reapTimer.unref?.();
}

function reapAgent(runtime, reason) {
  const id = runtime.identity.id;
  if (!activeAgents.has(id)) return;
  if (runtime.reapTimer) { clearTimeout(runtime.reapTimer); runtime.reapTimer = null; }
  activeAgents.delete(id);
  if (runtime.seat != null && seats[runtime.seat] === id) {
    seats[runtime.seat] = null;
  }
  // Tear down any live PTY for this agent before the worktree goes away
  // — leaving the child process behind would orphan it and pin a stale
  // cwd open. Both runtimes are checked; only the one that was spawned
  // will actually have a session.
  try { claudePty.removeSession(id); } catch {}
  try { hermesPty.removeSession(id); } catch {}
  // Worktree lives for the agent's lifetime — tear it down now that the
  // agent has left the office. Errors are non-fatal (best-effort cleanup
  // already runs `git worktree prune` on next setup either way).
  if (runtime.worktree) {
    try { runtime.worktree.cleanup(); } catch {}
    runtime.worktree = null;
  }
  emitAgentLeave(runtime, reason);
}

// ─── Detection / status ─────────────────────────────────────────────────

function buildStatus() {
  const agents = listAgents();
  const anyRunning = agents.some((a) => a.status === "running");
  const claude = claudeRuntime.status();
  const hermes = hermesRuntime.status();
  // Backwards-compatible top-level fields mirror hermes (existing
  // clients of /omo/api/hermes/status read these). The new `runtimes`
  // block exposes both adapters; the squad page can prefer that going
  // forward without breaking older consumers.
  return {
    installed: claude.installed || hermes.installed,
    defaultRuntime: DEFAULT_RUNTIME,
    runtimes: {
      claude: { installed: claude.installed, version: claude.version, bin: claude.bin },
      hermes: { installed: hermes.installed, version: hermes.version, bin: hermes.bin, modelHint: hermes.modelHint, providerHint: hermes.providerHint, hermesHome: hermes.hermesHome },
    },
    // Legacy keys — kept until callers migrate.
    version: hermes.version,
    modelHint: hermes.modelHint,
    providerHint: hermes.providerHint,
    hermesHome: hermes.hermesHome,
    agents,
    activeCount: agents.length,
    busyCount: agents.filter((a) => a.status === "running" || a.status === "dispatching").length,
    seats: seats.slice(),
    maxSeats: MAX_SEATS,
    anyRunning,
  };
}

// ─── Shared memory / skills / sessions (delegated to hermes runtime) ────
// These endpoints still serve hermes-specific data (the hermes CLI owns
// the SKILL.md / MEMORY.md layout). The runtime adapter is the source
// of truth; coordinator just forwards.

function readMemoryShared() { return hermesRuntime.readMemoryShared(); }
function listSkillsShared() { return hermesRuntime.listSkillsShared(); }
function readSkill(name)    { return hermesRuntime.readSkill(name); }
async function listSessions() {
  const sessions = await hermesRuntime.listSessions();
  if (!Array.isArray(sessions)) return [];
  return sessions.length ? sessions.slice(0, 30) : (function () {
    // (legacy shape used to walk hermes' table — runtime now does it)
    return [];
  })();
}

// ─── Task execution (runtime-agnostic) ──────────────────────────────────
// The coordinator owns: identity binding, seat allocation, WS broadcast,
// per-task event ring, artifact capture, bus.emit fan-out. The adapter
// (runtimes/claude.js | runtimes/hermes.js) owns: spawning the child and
// translating its native output into canonical events from events.js.

function startTask(agent, prompt, sessionId, repoPath, runtimeKey, adapter, worktreeOverride = null, adapterOpts = {}) {
  const id = `${runtimeKey === "claude" ? "ctsk" : "htsk"}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const startedAt = Date.now();
  const resolvedParent = resolveRepoPath(repoPath);

  // Per-AGENT git worktree isolation. The worktree lives at
  // ~/.omo/worktrees/<agent_id>/ and persists across tasks for the same
  // agent — required so consecutive `claude --resume <session_id>` calls
  // find the prior conversation (Claude Code stores session history
  // per-cwd). Concurrent agents on the same parent repo each get their
  // own private working tree, staging area, and HEAD. Cleanup happens in
  // reapAgent (5-min linger) and on process shutdown.
  //
  // Failure policy is controlled by OMO_WORKTREE_MODE:
  //   "off" (default)      — skip worktrees entirely; the agent edits the
  //                          user's real checkout. Single-user dev path:
  //                          changes land in the working tree directly.
  //   "required"           — throw WORKTREE_FAILED if setup fails. Safer
  //                          for concurrent agents on the same repo.
  //   "optional"           — try a worktree, fall back to parentRepo on
  //                          setup failure (legacy behaviour).
  // Per-call override wins over the env default. Useful for tools that
  // have the user's explicit go-ahead to edit the real repo directly
  // (e.g. add_preview_bridge — the user just said "yes install it"),
  // where forcing them through accept_agent_work afterwards is friction
  // with no safety benefit.
  const mode = (worktreeOverride && VALID_WORKTREE_MODES.has(worktreeOverride))
    ? worktreeOverride
    : effectiveWorktreeMode();
  let worktree = agent.worktree || null;
  // Self-healing: an existing handle may point to a dir the user deleted
  // between tasks. Probe before reuse; drop if dead.
  if (worktree && !isHealthyWorktree(worktree.path)) {
    if (process.env.OMO_WORKTREE_DEBUG) {
      console.warn(`[worktree] dropping unhealthy handle for ${agent.identity.name}: ${worktree.path}`);
    }
    try { worktree.cleanup(); } catch {}
    agent.worktree = null;
    worktree = null;
  }
  // Parent-repo mismatch: rare, but if the caller passes a different
  // `repo` from last time, tear down and rebuild so cwd matches.
  if (worktree && resolvedParent && worktree.parentRepo !== resolvedParent) {
    try { worktree.cleanup(); } catch {}
    agent.worktree = null;
    worktree = null;
  }
  if (!worktree && mode !== "off" && resolvedParent && isGitRepo(resolvedParent)) {
    // Worktree dir name: human-readable "<name-slug>__<short-id>" so
    // `ls ~/.omo/worktrees` is glanceable ("sage__a79062" instead of
    // "agt_a79062878"). Slug strips non-alphanumerics, lowercases, and
    // caps length so weird unicode names ("✨Nimbus") still produce a
    // safe path. The short-id suffix keeps the key unique even if two
    // agents pick the same name across resets.
    const nameSlug = String(agent.identity.name || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent';
    const shortId = String(agent.identity.id || '').replace(/^agt_/, '').slice(0, 6);
    const worktreeKey = `${nameSlug}__${shortId}`;
    worktree = setupWorktree(resolvedParent, worktreeKey, {
      identity: {
        agent_id: agent.identity.id,
        name: agent.identity.name,
        parent_repo: resolvedParent,
      },
    });
    if (worktree) {
      agent.worktree = worktree;
    } else if (mode === "required") {
      // Fail loud. Without isolation we'd be editing the user's real
      // checkout, which is the opposite of what they asked for.
      const err = new Error(
        `worktree setup failed for ${agent.identity.name} (parent=${resolvedParent}). ` +
        `Set OMO_WORKTREE_MODE=optional to fall back to the parent repo, or =off to disable isolation.`,
      );
      err.code = "WORKTREE_FAILED";
      err.parentRepo = resolvedParent;
      throw err;
    }
    // mode === "optional": setup failed but we accept the fallback.
  }
  const adapterCwd = worktree?.path || resolvedParent || undefined;
  // Diffs target the worktree when we have one. headBefore is captured
  // NOW (not when the worktree was created) so each task diffs against
  // the state it actually started from — the previous task may have
  // moved HEAD inside the shared worktree.
  const diffRepo = worktree?.path || resolvedParent;
  const headBefore = diffRepo
    ? (gitHeadSync(diffRepo) || worktree?.headBefore || null)
    : null;

  const task = {
    id,
    agentId: agent.identity.id,
    runtime: runtimeKey,
    sessionId: sessionId || null,
    prompt,
    startedAt,
    handle: null,            // populated below; .kill() honours interrupt
    finalOut: "",
    stderrTail: "",
    progressSteps: 0,
    activeTools: new Map(),  // tool name → { startedAt } (for emergency unwind)
    repoPath: diffRepo,      // where git diffs run (worktree when isolated)
    parentRepo: resolvedParent || null,  // original repo, for post-mortem
    worktree,                // { path, cleanup() } or null
    headBefore,
    branchBefore: resolvedParent ? gitBranchSync(resolvedParent) : null,
    capturedSessionId: null,
    totalCostUsd: null,
    eventBuffer: [],         // replayed on /hermes/ws reconnect
    finished: false,
  };
  agent.currentTask = task;
  agent.status = "running";
  agent.lastActivityAt = Date.now();
  emitAgentState(agent);

  wsBroadcast({
    type: "task_start",
    agent_id: agent.identity.id,
    task_id: id,
    session_id: sessionId,
    prompt,
    runtime: runtimeKey,
    worktree: worktree?.path || null,
    parent_repo: resolvedParent || null,
    ts: startedAt,
  });
  emitTaskEvent("task_spawn", agent, task, { status: "running", progressSummary: prompt, progressSteps: 0 });
  try {
    bus.emit({
      kind: "agent:started",
      agent_id: id,
      agent_name: agent.identity.name,
      title: `${runtimeKey}/${agent.identity.name} ${id}`,
      summary: prompt.slice(0, 140),
      task: prompt,
      data: { source: runtimeKey, agent_id: agent.identity.id, session_id: sessionId, prompt },
    });
  } catch {}

  // Spawn via the adapter. Canonical events come back through onEvent.
  let handle;
  try {
    handle = adapter.spawn({
      prompt,
      // agentId — required by the claude PTY adapter so it knows which
      // long-lived PTY session to write the prompt into. Other adapters
      // (headless claude, hermes) ignore it.
      agentId: agent.identity.id,
      sessionId: sessionId || null,
      cwd: adapterCwd,
      // Per-call adapter dials — each adapter takes what it knows and
      // silently ignores the rest. Lets a single shared opts object
      // address both claude (-p) and hermes (-q) cleanly.
      model:          adapterOpts.model          || null,
      effort:         adapterOpts.effort         || null,
      permissionMode: adapterOpts.permissionMode || null,
      addDirs:        Array.isArray(adapterOpts.addDirs) ? adapterOpts.addDirs : null,
      mcpConfig:      adapterOpts.mcpConfig      || null,
      settingsPath:   adapterOpts.settingsPath   || null,
      continueLast:    !sessionId && !!agent.lastTask,
      provider:       adapterOpts.provider       || null,
      toolsets:       Array.isArray(adapterOpts.toolsets) ? adapterOpts.toolsets : null,
      skills:         Array.isArray(adapterOpts.skills)   ? adapterOpts.skills   : null,
      maxTurns:       adapterOpts.maxTurns       || null,
      checkpoints:    adapterOpts.checkpoints    || null,
      onEvent: (evt) => handleAdapterEvent(agent, task, runtimeKey, evt),
      onError: (err) => {
        if (task.finished) return;
        finishTask(agent, task, { error: err?.message || String(err) });
      },
      // onClose is handled implicitly via the `result` event the adapter
      // synthesises if the child exits without emitting one.
    });
  } catch (err) {
    // Synthesise an immediate failure so the agent / seat clears.
    setImmediate(() => finishTask(agent, task, { error: err?.message || String(err) }));
    return task;
  }
  task.handle = handle;
  return task;
}

// Fan a single canonical event onto the WS + bus, updating task state.
function handleAdapterEvent(agent, task, runtimeKey, evt) {
  if (!evt || task.finished) return;
  agent.lastActivityAt = Date.now();

  switch (evt.kind) {
    case "session_init": {
      // Bind the captured session id to the identity under the right
      // bucket so future revivals resume the same conversation.
      if (evt.sessionId && !task.capturedSessionId) {
        task.capturedSessionId = evt.sessionId;
        task.sessionId = task.sessionId || evt.sessionId;
        identity.touch(agent.identity.id, { sessionId: evt.sessionId, runtime: runtimeKey, lastRuntime: runtimeKey });
        if (runtimeKey === "claude") agent.identity.claudeSessionId = evt.sessionId;
        else agent.identity.hermesSessionId = evt.sessionId;
        agent.identity.lastRuntime = runtimeKey;
      }
      return;
    }
    case "tool_start": {
      task.activeTools.set(evt.tool, { startedAt: evt.ts, args: String(evt.args || "") });
      bufferAndBroadcast(task, {
        type: "tool_start",
        agent_id: agent.identity.id,
        task_id: task.id,
        tool: evt.tool,
        args: String(evt.args || "").slice(0, 400),
        summary: String(evt.summary || `${evt.tool} ${evt.args}`).slice(0, 200),
        ts: evt.ts,
      });
      const station = TOOL_NAME_HINTS[evt.tool] || evt.tool;
      try {
        bus.emit({
          kind: "agent:tool_start",
          agent_id: task.id,
          agent_name: agent.identity.name,
          tool_name: station,
          title: `${runtimeKey}/${agent.identity.name}/${evt.tool}`,
          summary: String(evt.summary || evt.args || "").slice(0, 140),
        });
      } catch {}
      emitTaskEvent("task_progress", agent, task, {
        status: "running",
        progressSummary: `tool:${evt.tool}`,
        progressSteps: ++task.progressSteps,
        turn: { kind: "tool_use", toolName: evt.tool, toolInput: String(evt.args || "").slice(0, 1200) },
      });
      return;
    }
    case "tool_end": {
      task.activeTools.delete(evt.tool);
      bufferAndBroadcast(task, {
        type: "tool_end",
        agent_id: agent.identity.id,
        task_id: task.id,
        tool: evt.tool,
        ok: evt.ok !== false,
        ts: evt.ts,
      });
      const station = TOOL_NAME_HINTS[evt.tool] || evt.tool;
      try {
        bus.emit({
          kind: "agent:tool_end",
          agent_id: task.id,
          agent_name: agent.identity.name,
          tool_name: station,
          ok: evt.ok !== false,
        });
      } catch {}
      return;
    }
    case "chunk": {
      const text = String(evt.text || "");
      if (!text) return;
      task.finalOut += text;
      if (evt.isStderr) task.stderrTail = (task.stderrTail + text).slice(-4000);
      bufferAndBroadcast(task, {
        type: evt.isStderr ? "stderr" : "chunk",
        agent_id: agent.identity.id,
        task_id: task.id,
        text,
        role: evt.role || "assistant",
        ts: evt.ts || Date.now(),
      });
      if (text.trim()) {
        emitTaskEvent("task_progress", agent, task, {
          status: "running",
          progressSummary: text.trim().slice(0, 200),
          progressSteps: ++task.progressSteps,
          turn: evt.isStderr
            ? { kind: "tool_result", isError: true, snippet: text.slice(0, 2000), snippetRaw: text.slice(0, 12000) }
            : { kind: "text", role: evt.role || "assistant", text: text.trim() },
        });
      }
      return;
    }
    case "file_change": {
      // Resolve the absolute path the adapter handed us against the
      // task's repo (or the server cwd as a last resort), then kick
      // an async git diff. The unenriched event goes out immediately
      // (squad UI can mark the panel as "live"); the same event is
      // re-broadcast with hunks attached when git returns.
      const absPath = absolutisePath(evt.path, task.repoPath || process.cwd());
      bufferAndBroadcast(task, {
        type: "file_change",
        agent_id: agent.identity.id,
        task_id: task.id,
        path: absPath,
        relPath: relativiseForDisplay(absPath, task.repoPath),
        hunks: null,
        ts: evt.ts,
        stage: "pending",
      });
      computeAndBroadcastDiff(agent, task, absPath, evt.ts).catch((err) => {
        console.warn("[runtime] diff failed:", err?.message || err);
      });
      return;
    }
    case "result": {
      task.totalCostUsd = evt.costUsd ?? null;
      finishTask(agent, task, {
        error: evt.error || null,
        exitCode: evt.exitCode,
        durationMs: evt.durationMs,
        final: evt.final,
      });
      return;
    }
  }
}

// Build the "look at the screen" diagnostic bundle attached to error
// broadcasts. Mirrors what get_agent_screen_context returns, but trimmed
// hard so it fits comfortably inside one WS message and one model turn.
// Mirrors the /hq pattern where every error carries enough context that
// Momo can narrate the cause without a second tool call.
function buildErrorDiagnostic(agentId, { stdoutTail, stderrTail, errorMessage } = {}) {
  let ctx = null;
  try { ctx = getScreenContext(agentId); } catch { ctx = null; }
  if (!ctx || ctx.error) {
    return {
      last_error: errorMessage || null,
      stdout_tail: (stdoutTail || "").slice(-1200),
      stderr_tail: (stderrTail || "").slice(-1200),
    };
  }
  const livePanel = ctx.live_panel
    ? {
        kind: ctx.live_panel.kind,
        label: String(ctx.live_panel.label || "").slice(0, 160),
        tail: String(ctx.live_panel.tail || "").split("\n").slice(-10).join("\n").slice(0, 1800),
      }
    : null;
  return {
    last_error: ctx.last_error || errorMessage || null,
    live_panel: livePanel,
    tools_recent: (ctx.tools_recent || []).slice(-3).map((t) => ({
      tool: t.tool,
      args: String(t.args || "").slice(0, 120),
      ok: t.ok,
    })),
    files_touched: (ctx.files_touched || []).slice(-8).map((f) => ({ path: f.path, edited: !!f.edited })),
    thoughts_recent: (ctx.thoughts_recent || []).slice(-2).map((s) => String(s).slice(0, 220)),
    stdout_tail: (stdoutTail || "").slice(-1200),
    stderr_tail: (stderrTail || "").slice(-1200),
  };
}

function finishTask(agent, task, { error = null, exitCode = null, durationMs = null, final = null } = {}) {
  if (agent.currentTask !== task) return;
  if (task.finished) return;
  task.finished = true;

  // Emergency unwind: any tool that started but never ended (rare —
  // happens if the runtime crashes mid-call).
  for (const raw of task.activeTools.keys()) {
    const station = TOOL_NAME_HINTS[raw] || raw;
    try {
      bus.emit({
        kind: "agent:tool_end",
        agent_id: task.id,
        agent_name: agent.identity.name,
        tool_name: station,
        ok: false,
      });
    } catch {}
  }
  task.activeTools.clear();

  const elapsed = durationMs ?? (Date.now() - task.startedAt);
  const stdoutTail = (final != null ? String(final) : task.finalOut).trim().slice(-8000);
  const stderrTail = task.stderrTail || "";

  if (error) {
    const diagnostic = buildErrorDiagnostic(agent.identity.id, {
      stdoutTail, stderrTail, errorMessage: String(error),
    });
    bufferAndBroadcast(task, {
      type: "task_error",
      agent_id: agent.identity.id,
      task_id: task.id,
      session_id: task.sessionId || null,
      runtime: task.runtime,
      error,
      durationMs: elapsed,
      diagnostic,
      ts: Date.now(),
    });
    emitTaskEvent("task_complete", agent, task, {
      status: "error",
      durationMs: elapsed,
      endedAt: Date.now(),
      error,
      diagnostic,
      result: null,
    });
    try {
      bus.emit({
        kind: "agent:error",
        agent_id: task.id,
        agent_name: agent.identity.name,
        title: `${task.runtime}/${agent.identity.name} ${task.id} error`,
        summary: String(error).slice(0, 140),
        data: { error, durationMs: elapsed, runtime: task.runtime, diagnostic },
      });
    } catch {}
    agent.status = "error";
  } else {
    const ok = exitCode == null ? true : exitCode === 0;
    const failureText = stderrTail.trim() || stdoutTail || `${task.runtime} exited ${exitCode}`;
    const diagnostic = ok
      ? null
      : buildErrorDiagnostic(agent.identity.id, {
          stdoutTail, stderrTail, errorMessage: failureText,
        });
    bufferAndBroadcast(task, {
      type: "task_complete",
      agent_id: agent.identity.id,
      task_id: task.id,
      session_id: task.sessionId || null,
      runtime: task.runtime,
      final: stdoutTail,
      durationMs: elapsed,
      exitCode,
      costUsd: task.totalCostUsd,
      diagnostic,
      ts: Date.now(),
    });
    emitTaskEvent("task_complete", agent, task, {
      status: ok ? "done" : "error",
      durationMs: elapsed,
      endedAt: Date.now(),
      exitCode,
      result: ok ? stdoutTail : null,
      error: ok ? null : failureText,
      final: stdoutTail,
      costUsd: task.totalCostUsd,
      diagnostic,
    });
    try {
      bus.emit({
        kind: "agent:complete",
        agent_id: task.id,
        agent_name: agent.identity.name,
        title: `${task.runtime}/${agent.identity.name} ${task.id} complete`,
        summary: `exit ${exitCode} · ${elapsed}ms${task.totalCostUsd != null ? ` · $${task.totalCostUsd.toFixed(4)}` : ""}`,
        data: { exitCode, durationMs: elapsed, costUsd: task.totalCostUsd, runtime: task.runtime, final_preview: stdoutTail.slice(0, 500), diagnostic: diagnostic || undefined },
      });
    } catch {}
    agent.status = ok ? "done" : "error";
  }

  agent.lastTask = task;
  agent.currentTask = null;
  agent.lastActivityAt = Date.now();
  emitAgentState(agent);

  // Artifact capture reads `git diff` from task.repoPath (the worktree
  // when isolated). The worktree is now owned by the agent (not the
  // task) and persists across follow-up tasks so Claude Code's per-cwd
  // session history can resolve --resume; cleanup runs in reapAgent
  // when the agent leaves the office.
  if (task.repoPath) {
    captureArtifacts(agent, task).catch(() => {});
  }

  if (AUTO_ACCEPT_AGENT_WORK && agent.status === "done" && agent.worktree) {
    autoAcceptAgentWork(agent, task).catch((err) => {
      console.warn("[hermes] auto-accept failed:", err?.message || err);
    });
  }

  scheduleReap(agent);
}

// Fire-and-forget: ship the agent's worktree changes onto the parent
// checkout the moment a task completes. Skips silently when there's no
// diff. On CONFLICT/INTERRUPTED, broadcasts a `task_auto_accept_failed`
// so the squad UI keeps the Accept button hot for manual recovery.
async function autoAcceptAgentWork(agent, task) {
  const accepted = await acceptAgentWork(agent.identity.id, { mode: "apply" });
  if (accepted.ok) {
    const fileCount = accepted.files?.length || 0;
    if (fileCount === 0) return;
    const stat = accepted.stat || { fileCount, added: 0, removed: 0 };
    const summary = `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"} (+${stat.added || 0} −${stat.removed || 0})`;
    bufferAndBroadcast(task, {
      type: "task_auto_accepted",
      agent_id: agent.identity.id,
      agent_name: agent.identity.name,
      task_id: task.id,
      files: accepted.files,
      stat: accepted.stat,
      summary,
      ts: Date.now(),
    });
    return;
  }
  if (accepted.code === "AGENT_BUSY") return; // benign race; skip
  bufferAndBroadcast(task, {
    type: "task_auto_accept_failed",
    agent_id: agent.identity.id,
    agent_name: agent.identity.name,
    task_id: task.id,
    code: accepted.code,
    error: accepted.error,
    conflicting_paths: accepted.conflicting_paths || null,
    suspect_tools: accepted.suspect_tools || null,
    suspect_paths: accepted.suspect_paths || null,
    ts: Date.now(),
  });
}

function serialiseTask(task, agent, extra = {}) {
  return {
    id: task.id,
    agentId: agent.identity.id,
    agentName: agent.identity.name,
    label: agent.identity.name,
    task: task.prompt,
    origin: "momo",
    runtime: task.runtime,
    status: extra.status || "running",
    sessionId: task.sessionId || null,
    startedAt: task.startedAt,
    endedAt: extra.endedAt || null,
    durationMs: extra.durationMs ?? null,
    result: extra.result || null,
    error: extra.error || null,
    costUsd: task.totalCostUsd ?? extra.costUsd ?? null,
    progressSummary: extra.progressSummary || null,
    progressSteps: extra.progressSteps ?? null,
  };
}

function emitTaskEvent(kind, agent, task, extra = {}) {
  bus.emit({
    kind,
    title: `${kind} · ${agent.identity.name}`,
    summary:
      kind === "task_complete"
        ? (extra.status === "done"
            ? String(extra.result || extra.final || task.prompt).slice(0, 140)
            : `error: ${String(extra.error || "unknown").slice(0, 140)}`)
        : String(extra.progressSummary || task.prompt).slice(0, 200),
    data: { ...serialiseTask(task, agent, extra), ...extra },
  });
}

// ─── Artifact capture (git diff stat, changed files, branch) ────────────

function resolveRepoPath(input) {
  let p = (input && String(input).trim()) || process.cwd();
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  try {
    if (!existsSync(p)) return null;
    if (!existsSync(join(p, ".git"))) {
      let cur = p;
      for (let i = 0; i < 5; i++) {
        const parent = join(cur, "..");
        if (parent === cur) break;
        cur = parent;
        if (existsSync(join(cur, ".git"))) return cur;
      }
      return null;
    }
    return p;
  } catch { return null; }
}

function gitRunSync(repo, args, { maxBytes = 64 * 1024 } = {}) {
  try {
    const r = spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: maxBytes,
      timeout: 3000,
    });
    if (r.status !== 0) return null;
    return r.stdout || "";
  } catch { return null; }
}

function gitHeadSync(repo) {
  const out = gitRunSync(repo, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

function gitBranchSync(repo) {
  const out = gitRunSync(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out ? out.trim() : null;
}

// ─── Live file-diff helpers (driven by file_change events) ──────────────

function absolutisePath(p, cwd) {
  if (!p) return null;
  return isAbsolute(p) ? p : resolvePath(cwd || process.cwd(), p);
}

function relativiseForDisplay(absPath, repoPath) {
  if (!absPath) return null;
  if (!repoPath) return absPath;
  const rel = relativisePath(repoPath, absPath);
  // If the path escapes the repo (starts with "..") just show the
  // absolute form — it's not "inside the project" anyway.
  return rel.startsWith("..") ? absPath : rel;
}

// Run `git diff` async against the task's snapshot. Falls back to
// `git diff HEAD` if no headBefore was captured. Returns a string or
// null. Capped at 256 KB.
function gitDiffAsync(repo, baseSha, filePath) {
  return new Promise((resolve) => {
    if (!repo || !filePath) return resolve(null);
    const args = ["-C", repo, "diff", "--unified=3", "--no-color"];
    if (baseSha) args.push(baseSha);
    args.push("--", filePath);
    let buf = "";
    let done = false;
    let bytes = 0;
    const MAX = 256 * 1024;
    let child;
    try {
      child = spawnCmd("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve(buf || null);
    }, 4000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX) {
        // Truncate hard at the cap. The hunk parser tolerates this.
        if (!done) { done = true; try { child.kill("SIGTERM"); } catch {} clearTimeout(timer); resolve(buf); }
        return;
      }
      buf += chunk.toString("utf8");
    });
    child.on("error", () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
    child.on("close", () => { if (!done) { done = true; clearTimeout(timer); resolve(buf); } });
  });
}

// Parse a single-file unified diff into structured hunks. Returns an
// array of { header, lines: [{kind: 'context'|'add'|'del', text, oldLn, newLn}] }
// plus an aggregate { added, removed } stat. Tolerant of truncated input.
function parseUnifiedDiff(text) {
  if (!text) return { hunks: [], stat: { added: 0, removed: 0 } };
  const hunks = [];
  let added = 0;
  let removed = 0;
  let current = null;
  let oldLn = 0;
  let newLn = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("@@")) {
      // @@ -OLD_START,OLD_LEN +NEW_START,NEW_LEN @@ optional-fn
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) continue;
      oldLn = Number(m[1]);
      newLn = Number(m[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    // Drop diff metadata (diff --git, ---/+++, index ...).
    if (!current) continue;
    if (raw.startsWith("\\ ")) continue; // "\ No newline at end of file"
    const ch = raw[0];
    const body = raw.slice(1);
    if (ch === "+") {
      current.lines.push({ kind: "add", text: body, oldLn: null, newLn });
      newLn++;
      added++;
    } else if (ch === "-") {
      current.lines.push({ kind: "del", text: body, oldLn, newLn: null });
      oldLn++;
      removed++;
    } else if (ch === " " || ch === undefined) {
      // Context (a blank line in the file shows as a single " ").
      current.lines.push({ kind: "context", text: body, oldLn, newLn });
      oldLn++;
      newLn++;
    }
    // Anything else (diff --git headers etc.) is ignored.
  }
  return { hunks, stat: { added, removed } };
}

async function computeAndBroadcastDiff(agent, task, absPath, ts) {
  if (!absPath) return;
  // Prefer the task's repo; fall back to the omo cwd so dispatches that
  // didn't pass `repo` still get a usable diff for files inside this tree.
  const repo = task.repoPath || resolveRepoPath(null);
  if (!repo) return;
  // Diff against the task's pre-spawn sha when we have it. This catches
  // edits the agent made and nothing else (no unrelated uncommitted work
  // from before the task). Without it, fall back to HEAD.
  const baseSha = task.headBefore || "HEAD";
  const raw = await gitDiffAsync(repo, baseSha, absPath);
  if (raw == null) return;
  const { hunks, stat } = parseUnifiedDiff(raw);
  if (task.finished) return;            // task ended while we waited
  bufferAndBroadcast(task, {
    type: "file_change",
    agent_id: agent.identity.id,
    task_id: task.id,
    path: absPath,
    relPath: relativiseForDisplay(absPath, repo),
    hunks,
    stat,
    ts: ts || Date.now(),
    stage: "resolved",
  });
}

async function captureArtifacts(runtime, task) {
  const repo = task.repoPath;
  if (!repo) return;
  const headBefore = task.headBefore;
  const headAfter = gitHeadSync(repo);
  const branch = gitBranchSync(repo) || task.branchBefore;
  const wtStatus = (gitRunSync(repo, ["status", "--short"]) || "").trim();
  const wtFiles = wtStatus.split("\n").filter(Boolean).map((line) => {
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    return { code, path };
  });
  const wtDiffStat = (gitRunSync(repo, ["diff", "--stat", "HEAD"]) || "").trim();
  let committedDiffStat = "";
  let committedFiles = [];
  let commits = [];
  if (headBefore && headAfter && headBefore !== headAfter) {
    const range = `${headBefore}..${headAfter}`;
    committedDiffStat = (gitRunSync(repo, ["diff", "--stat", range]) || "").trim();
    const ns = (gitRunSync(repo, ["diff", "--name-status", range]) || "").trim();
    committedFiles = ns.split("\n").filter(Boolean).map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
    const log = (gitRunSync(repo, ["log", "--pretty=format:%h\t%s", range]) || "").trim();
    commits = log.split("\n").filter(Boolean).map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha, subject: rest.join("\t") };
    });
  }
  const total = wtFiles.length + committedFiles.length;
  const artifact = {
    task_id: task.id,
    agent_id: runtime.identity.id,
    repoPath: repo,
    branchBefore: task.branchBefore || null,
    branch: branch || null,
    headBefore,
    headAfter,
    headMoved: !!(headBefore && headAfter && headBefore !== headAfter),
    workingTree: { diffStat: wtDiffStat, files: wtFiles },
    committed: { diffStat: committedDiffStat, files: committedFiles, commits },
    totalFilesTouched: total,
    capturedAt: Date.now(),
  };
  runtime.lastArtifacts = artifact;
  bufferAndBroadcast(task, {
    type: "artifacts",
    agent_id: runtime.identity.id,
    task_id: task.id,
    artifacts: artifact,
  });
  try {
    bus.emit({
      kind: "agent:artifacts",
      agent_id: task.id,
      agent_name: runtime.identity.name,
      title: `hermes/${runtime.identity.name} artifacts`,
      summary: `${total} file(s) touched on ${branch || "?"}`,
      data: { agent_id: runtime.identity.id, branch, totalFilesTouched: total, headMoved: artifact.headMoved },
    });
  } catch {}
}

// Subprocess helper removed — the hermes runtime adapter now owns all
// CLI invocations (hermesRuntime.listSessions, etc).

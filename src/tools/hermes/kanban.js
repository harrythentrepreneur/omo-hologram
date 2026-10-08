// src/tools/hermes_kanban.js — voice tools for the Hermes Kanban board.
//
// Wraps `hermes kanban <subcommand>` — a durable SQLite-backed task board
// shared across Hermes profiles. The board has statuses (triage/todo/ready/
// running/blocked/done/archived) rather than free-form columns; tasks
// progress between them via dedicated subcommands (no single "move").
//
// CLI surface (v0.13+):
//   init / boards / create / list (ls) / show / assign / reclaim / reassign
//   diagnostics / link / unlink / claim / comment / complete / edit / block
//   unblock / archive / tail / dispatch / watch / stats / notify-* / log
//   runs / heartbeat / assignees / context / specify / gc
//
// What we expose for voice (read-heavy + a few common writes):
//   list / show / create / comment / complete / block / unblock / archive
//   assign / assignees / stats / boards_list
//
// We deliberately skip: claim/reclaim/reassign (worker-internal),
// tail/watch (streaming — no good for one-shot voice calls),
// notify-* (gateway plumbing), log/runs/context (verbose dumps best
// surfaced via show), heartbeat/dispatch/gc/specify (operator/scheduler ops).

import { runHermes, stripAnsi, tryJson } from "./_hermes_cli.js";

const STATUSES = ["triage", "todo", "ready", "running", "blocked", "done", "archived"];

// ─── hermes_kanban_list ───────────────────────────────────────────────

export const listDefinition = {
  type: "function",
  name: "hermes_kanban_list",
  description:
    "BROWSE / OVERVIEW the Hermes kanban board — returns a LIST of tasks. Use when the user wants a roll-up ('what's on the board', 'what's in progress', 'list my tasks'). " +
    "Voice: 'show me the kanban', 'what's on the board', '看看 kanban', 'what's in progress', 'what's todo', 'browse the kanban'. " +
    "Filter by status (triage/todo/ready/running/blocked/done/archived) or assignee. " +
    "**NOT for a SINGLE task's details — that's hermes_kanban_show. This one gives the bird's-eye.**",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: STATUSES, description: "Filter by status." },
      assignee: { type: "string", description: "Filter by profile name." },
      mine: { type: "boolean", description: "Filter by $HERMES_PROFILE as assignee." },
      archived: { type: "boolean", description: "Include archived tasks. Default false." },
      board: { type: "string", description: "Board slug to query (default: current board)." },
    },
    additionalProperties: false,
  },
};

export async function runHermesKanbanList(args) {
  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "list", "--json");
  if (args?.status && STATUSES.includes(args.status)) cli.push("--status", args.status);
  if (args?.assignee) cli.push("--assignee", String(args.assignee));
  if (args?.mine) cli.push("--mine");
  if (args?.archived) cli.push("--archived");

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const json = tryJson(r.stdout);
  const stdout = stripAnsi(r.stdout).slice(0, 4000);
  const count = Array.isArray(json) ? json.length : null;
  return {
    ok: r.exitCode === 0,
    tasks: Array.isArray(json) ? json : null,
    count,
    stdout,
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? (count === 0
          ? "Tell the user the board is empty (or empty for that filter). Offer to create a task."
          : "Read the top 3-5 task titles + assignee/status; offer to show details on any.")
      : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_show ───────────────────────────────────────────────

export const showDefinition = {
  type: "function",
  name: "hermes_kanban_show",
  description:
    "DRILL into ONE SPECIFIC kanban task with full comments and event history. Requires task_id. " +
    "Use when the user wants the DETAIL on a single named task ('show me task 42', 'what's the detail on the X task'). " +
    "Voice: 'show me task 42', 'detail on that task', '看看那个 task', 'open task X'. " +
    "**NOT for a roll-up of all tasks — that's hermes_kanban_list. This one zooms into one row.**",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id (from hermes_kanban_list)." },
      board: { type: "string", description: "Board slug (default: current)." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanShow(args) {
  const task_id = String(args?.task_id || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task — hermes_kanban_list reads the ids." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "show", task_id, "--json");

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id };
  const json = tryJson(r.stdout);
  return {
    ok: r.exitCode === 0,
    task_id,
    task: json,
    stdout: stripAnsi(r.stdout).slice(0, 4000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Read the title, status, assignee, and the most recent comment. Offer to complete/block/comment."
      : "Quote the error — maybe the task_id was wrong.",
  };
}

// ─── hermes_kanban_create ─────────────────────────────────────────────

export const createDefinition = {
  type: "function",
  name: "hermes_kanban_create",
  description:
    "Create a new kanban task. ⚠️ WRITE — request_approval first if the user hasn't already greenlit it. " +
    "Voice: 'add a task to do X', 'create a kanban for the auth refactor', '加个 task'. " +
    "Park in triage with `triage:true` if the spec needs an LLM to flesh it out; otherwise it lands in todo.",
  parameters: {
    type: "object",
    properties: {
      title:     { type: "string", description: "Task title (short — body holds detail)." },
      body:      { type: "string", description: "Optional opening post / spec body." },
      assignee:  { type: "string", description: "Profile name to assign (omit to leave unassigned)." },
      priority:  { type: "number", description: "Priority tiebreaker (higher = sooner)." },
      triage:    { type: "boolean", description: "Park in triage column; a specifier LLM will flesh it out and promote." },
      workspace: { type: "string", description: "scratch | worktree | dir:<path> (default scratch)." },
      skills:    { type: "array", items: { type: "string" }, description: "Skills to force-load into the worker (repeatable)." },
      parent:    { type: "string", description: "Parent task id for dependency linking." },
      board:     { type: "string", description: "Board slug (default: current)." },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanCreate(args) {
  const title = String(args?.title || "").trim();
  if (!title) return { error: "missing title", note: "Ask the user what the task is." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "create", title, "--json");
  if (args?.body)      cli.push("--body", String(args.body));
  if (args?.assignee)  cli.push("--assignee", String(args.assignee));
  if (args?.priority != null) cli.push("--priority", String(args.priority));
  if (args?.triage)    cli.push("--triage");
  if (args?.workspace) cli.push("--workspace", String(args.workspace));
  if (args?.parent)    cli.push("--parent", String(args.parent));
  if (Array.isArray(args?.skills)) {
    for (const s of args.skills) { if (s) cli.push("--skill", String(s)); }
  }

  const r = runHermes(cli, { timeoutMs: 15000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, title };
  const json = tryJson(r.stdout);
  const ok = r.exitCode === 0;
  return {
    ok,
    title,
    task: json,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: ok
      ? `Confirm task created — read the task_id back briefly. If triage:true, mention the spec will get fleshed out automatically.`
      : "Create failed — quote the stderr plainly.",
  };
}

// ─── hermes_kanban_comment ────────────────────────────────────────────

export const commentDefinition = {
  type: "function",
  name: "hermes_kanban_comment",
  description:
    "Add a comment to a kanban task. Voice: 'add a comment on task 42 saying done with auth', " +
    "'comment on that one', '在那个 task 上加条评论'. " +
    "Multiple text fragments are joined with spaces.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id." },
      text:    { type: "string", description: "Comment body." },
      author:  { type: "string", description: "Author name (default $HERMES_PROFILE or 'user')." },
      board:   { type: "string", description: "Board slug." },
    },
    required: ["task_id", "text"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanComment(args) {
  const task_id = String(args?.task_id || "").trim();
  const text = String(args?.text || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task." };
  if (!text)    return { error: "missing text", note: "Ask what the comment should say." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "comment", task_id);
  if (args?.author) cli.push("--author", String(args.author));
  cli.push(text);

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id };
  return {
    ok: r.exitCode === 0,
    task_id,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0 ? `Confirm comment posted on ${task_id}.` : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_complete ───────────────────────────────────────────

export const completeDefinition = {
  type: "function",
  name: "hermes_kanban_complete",
  description:
    "Mark a kanban task done. Voice: 'mark task 42 done', 'finish that one', '把那个 task 标记完成', " +
    "'move that to done'. Optional `result` records a short summary on the closing run.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id to complete." },
      result:  { type: "string", description: "Optional result summary." },
      summary: { type: "string", description: "Optional structured handoff summary for downstream tasks." },
      board:   { type: "string", description: "Board slug." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanComplete(args) {
  const task_id = String(args?.task_id || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task to mark done." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "complete", task_id);
  if (args?.result)  cli.push("--result", String(args.result));
  if (args?.summary) cli.push("--summary", String(args.summary));

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id };
  return {
    ok: r.exitCode === 0,
    task_id,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `Confirm ${task_id} is done — quick + cheerful. Don't dump the full result back.`
      : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_block / unblock ────────────────────────────────────

export const blockDefinition = {
  type: "function",
  name: "hermes_kanban_block",
  description:
    "Mark a kanban task blocked (with a reason that becomes a comment). Voice: 'block task 42 — waiting on stripe', " +
    "'mark that as blocked', '把那个标记为 blocked'.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id." },
      reason:  { type: "string", description: "Why it's blocked (also appended as a comment)." },
      board:   { type: "string", description: "Board slug." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanBlock(args) {
  const task_id = String(args?.task_id || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task to block." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "block", task_id);
  if (args?.reason) cli.push(String(args.reason));

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id };
  return {
    ok: r.exitCode === 0,
    task_id,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0 ? `Confirm ${task_id} is blocked, mention the reason briefly.` : "Quote the error plainly.",
  };
}

export const unblockDefinition = {
  type: "function",
  name: "hermes_kanban_unblock",
  description:
    "Move a blocked kanban task back to ready. Voice: 'unblock task 42', 'that one's unblocked now', '解锁那个 task'.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id." },
      board:   { type: "string", description: "Board slug." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanUnblock(args) {
  const task_id = String(args?.task_id || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task to unblock." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "unblock", task_id);

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id };
  return {
    ok: r.exitCode === 0,
    task_id,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0 ? `Confirm ${task_id} is ready again.` : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_archive ────────────────────────────────────────────

export const archiveDefinition = {
  type: "function",
  name: "hermes_kanban_archive",
  description:
    "Archive a kanban task (soft-delete; reversible by re-creating). ⚠️ DESTRUCTIVE — request_approval first. " +
    "Voice: 'archive task 42', '归档那个 task', 'get rid of that one'.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id." },
      board:   { type: "string", description: "Board slug." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanArchive(args) {
  const task_id = String(args?.task_id || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task to archive." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "archive", task_id);

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id };
  return {
    ok: r.exitCode === 0,
    task_id,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? `⚠️ DESTRUCTIVE done — ${task_id} archived. Quick + cheerful.`
      : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_assign ─────────────────────────────────────────────

export const assignDefinition = {
  type: "function",
  name: "hermes_kanban_assign",
  description:
    "Assign (or unassign) a kanban task to a profile. Voice: 'assign task 42 to atlas', " +
    "'reassign that one to cinder', 'give that to nobody', '把那个交给 atlas'. " +
    "Pass profile='none' to unassign.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id." },
      profile: { type: "string", description: "Profile name to assign, or 'none' to unassign." },
      board:   { type: "string", description: "Board slug." },
    },
    required: ["task_id", "profile"],
    additionalProperties: false,
  },
};

export async function runHermesKanbanAssign(args) {
  const task_id = String(args?.task_id || "").trim();
  const profile = String(args?.profile || "").trim();
  if (!task_id) return { error: "missing task_id", note: "Ask which task to assign." };
  if (!profile) return { error: "missing profile", note: "Ask which profile (or 'none' to unassign)." };

  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "assign", task_id, profile);

  const r = runHermes(cli, { timeoutMs: 10000 });
  if (r.error) return { ok: false, error: r.error, code: r.code, task_id, profile };
  return {
    ok: r.exitCode === 0,
    task_id,
    profile,
    stdout: stripAnsi(r.stdout).slice(0, 2000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? (profile === "none"
          ? `Confirm ${task_id} is unassigned.`
          : `Confirm ${task_id} → ${profile}.`)
      : "Quote the error — maybe the profile name was wrong; offer hermes_kanban_assignees.",
  };
}

// ─── hermes_kanban_assignees ──────────────────────────────────────────

export const assigneesDefinition = {
  type: "function",
  name: "hermes_kanban_assignees",
  description:
    "List known kanban profiles + per-profile task counts. Voice: 'who's on the kanban', " +
    "'list the profiles', 'show me assignees'.",
  parameters: {
    type: "object",
    properties: { board: { type: "string", description: "Board slug." } },
    additionalProperties: false,
  },
};

export async function runHermesKanbanAssignees(args) {
  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "assignees", "--json");

  const r = runHermes(cli, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const json = tryJson(r.stdout);
  return {
    ok: r.exitCode === 0,
    assignees: json,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Read 3-5 profile names with their task counts."
      : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_stats ──────────────────────────────────────────────

export const statsDefinition = {
  type: "function",
  name: "hermes_kanban_stats",
  description:
    "Per-status + per-assignee counts and the age of the oldest ready task on the kanban board. " +
    "Voice: 'kanban stats', 'how's the board looking', 'what's the backlog'.",
  parameters: {
    type: "object",
    properties: { board: { type: "string", description: "Board slug." } },
    additionalProperties: false,
  },
};

export async function runHermesKanbanStats(args) {
  const cli = [];
  if (args?.board) cli.push("--board", String(args.board));
  cli.push("kanban", "stats", "--json");

  const r = runHermes(cli, { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  const json = tryJson(r.stdout);
  return {
    ok: r.exitCode === 0,
    stats: json,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Summarize the counts in one sentence — e.g. '3 in progress, 5 ready, 1 blocked'. Mention oldest-ready age if it's >1 day."
      : "Quote the error plainly.",
  };
}

// ─── hermes_kanban_boards_list ────────────────────────────────────────

export const boardsListDefinition = {
  type: "function",
  name: "hermes_kanban_boards_list",
  description:
    "List all kanban boards (one per project/workstream). Voice: 'what kanban boards do I have', " +
    "'list boards', '都有哪些 kanban board'. The first board is always 'default'.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export async function runHermesKanbanBoardsList() {
  const r = runHermes(["kanban", "boards", "list"], { timeoutMs: 8000 });
  if (r.error) return { ok: false, error: r.error, code: r.code };
  return {
    ok: r.exitCode === 0,
    stdout: stripAnsi(r.stdout).slice(0, 3000),
    stderr: r.stderr ? stripAnsi(r.stderr).slice(0, 1500) : null,
    exit_code: r.exitCode,
    note: r.exitCode === 0
      ? "Read 2-3 board names + task counts; mention the current active board."
      : "Quote the error plainly.",
  };
}

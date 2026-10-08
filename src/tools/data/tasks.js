// tasks tools — on-demand to-do access for Momo.
// Backed by a module-scoped array (not persisted across restarts).
// Starts empty — tasks come from the user via add_task.
//
// Every tool stores the full dataset in the id-keyed store and returns
// { id, ...short_summary }. Dataset kinds route through pickChartType:
//   - kind includes "task"      → task_card
//   - kind includes "checklist" → checklist_card

import * as store from '../../store/datasets.js';

let TASKS = [];

let NEXT_ID = 100;
function mintTaskId() {
  NEXT_ID += 1;
  return `t_${String(NEXT_ID).padStart(3, '0')}`;
}

// ─── Shaping helpers ──────────────────────────────────────────────────

function toIso(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// Normalise internal task row → the shape task_card expects.
function toTaskCardShape(t) {
  return {
    title: t.title,
    done: !!t.done,
    due: toIso(t.due_ms),
    priority: t.priority || null,
    notes: t.notes || '',
    tags: Array.isArray(t.tags) ? t.tags : [],
    // internal id surfaced so the model / future tools can reference it
    _task_id: t.id,
  };
}

// Normalise internal task row → an item inside checklist_card.
function toChecklistItem(t) {
  return { label: t.title, done: !!t.done };
}

function priorityRank(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'p0' || s === 'high') return 0;
  if (s === 'p1' || s === 'med' || s === 'medium') return 1;
  if (s === 'p2' || s === 'low') return 2;
  if (s === 'p3') return 3;
  return 4;
}

// Sort open tasks: by priority rank, then by due date ascending, then age.
function sortOpenTasks(list) {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const da = a.due_ms ?? Infinity;
    const db = b.due_ms ?? Infinity;
    if (da !== db) return da - db;
    return (a.created_ms ?? 0) - (b.created_ms ?? 0);
  });
}

// ─── get_tasks ────────────────────────────────────────────────────────

export const getTasksDefinition = {
  type: 'function',
  name: 'get_tasks',
  description:
    "List the user's current tasks. Pass `status` to filter ('open' (default), 'done', or 'all'). Pass `limit` to cap the list (default 8, max 20). Returns a dataset id that routes to a checklist card with each task as a line item (or a task card when only one matches). Call this for 'what's on my list', 'my to-dos', 'what do I still owe'.",
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['open', 'done', 'all'],
        description: "Filter by task status. Defaults to 'open'.",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Max tasks to return (default 8).',
      },
    },
    additionalProperties: false,
  },
};

export async function runGetTasks(args) {
  const status = (args?.status || 'open').toLowerCase();
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 8));

  let filtered;
  if (status === 'done')      filtered = TASKS.filter((t) => t.done);
  else if (status === 'all')  filtered = [...TASKS];
  else                        filtered = TASKS.filter((t) => !t.done);

  const sorted = sortOpenTasks(filtered).slice(0, limit);

  // Single-task result → task_card. Multi → checklist_card.
  if (sorted.length === 1) {
    const shaped = toTaskCardShape(sorted[0]);
    const id = store.put('task', shaped);
    return {
      id,
      summary: `One ${status === 'done' ? 'completed' : 'open'} task: ${shaped.title}.`,
      count: 1,
      status,
    };
  }

  const openCount = TASKS.filter((t) => !t.done).length;
  const doneCount = TASKS.filter((t) =>  t.done).length;
  const dataset = {
    title: status === 'done' ? 'COMPLETED' : status === 'all' ? 'ALL TASKS' : 'TO-DO',
    items: sorted.map(toChecklistItem),
    note: status === 'open'
      ? `${openCount} open · ${doneCount} done`
      : status === 'done'
        ? `${doneCount} completed`
        : `${TASKS.length} total`,
  };
  const id = store.put('checklist', dataset);

  if (sorted.length === 0) {
    return {
      id,
      summary: status === 'done'
        ? 'No completed tasks yet.'
        : status === 'open'
          ? 'All clear — no open tasks right now.'
          : 'No tasks in the list.',
      count: 0,
      status,
    };
  }

  const topTitle = sorted[0].title;
  const summary = status === 'open'
    ? `${sorted.length} open tasks. Top priority: ${topTitle}.`
    : status === 'done'
      ? `${sorted.length} completed tasks, most recent: ${topTitle}.`
      : `${sorted.length} tasks total. First on the list: ${topTitle}.`;

  return {
    id,
    summary,
    count: sorted.length,
    status,
    top_title: topTitle,
    open_total: openCount,
    done_total: doneCount,
  };
}

// ─── add_task ─────────────────────────────────────────────────────────

export const addTaskDefinition = {
  type: 'function',
  name: 'add_task',
  description:
    "Add a new task to the user's to-do list. Provide a short `title` (required). Optional `priority` ('p0'|'p1'|'p2'|'p3' or 'high'|'med'|'low'), `due` (ISO datetime string), `notes` (short context, <80 chars ideal), and `tags` (array of short labels). Returns a dataset id that routes to a task card showing the newly-created task. Call this when the user says 'add a task', 'remind me to…', 'put this on my list'.",
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short task title. Keep it one line.',
      },
      priority: {
        type: 'string',
        enum: ['p0', 'p1', 'p2', 'p3', 'high', 'med', 'medium', 'low'],
        description: "Priority. 'p0'/'high' = urgent, 'p2'/'low' = whenever. Defaults to 'p2'.",
      },
      due: {
        type: 'string',
        description: 'Optional ISO datetime for when the task is due.',
      },
      notes: {
        type: 'string',
        description: 'Optional short note for context. Keep under ~80 chars.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional short labels.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export async function runAddTask(args) {
  const title = String(args?.title || '').trim();
  if (!title) {
    return { error: 'Need a task title.' };
  }
  const priority = args?.priority || 'p2';
  const tags = Array.isArray(args?.tags) ? args.tags.map(String).filter(Boolean) : [];
  const notes = String(args?.notes || '').trim().slice(0, 160);

  let dueMs = null;
  if (args?.due) {
    const parsed = new Date(args.due).getTime();
    if (Number.isFinite(parsed)) dueMs = parsed;
  }

  const row = {
    id: mintTaskId(),
    title,
    done: false,
    due_ms: dueMs,
    priority,
    tags,
    notes,
    created_ms: Date.now(),
  };
  TASKS.push(row);

  const shaped = toTaskCardShape(row);
  const id = store.put('task', shaped);

  return {
    id,
    summary: `Added: ${title}${dueMs ? ` (due ${new Date(dueMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : ''}.`,
    task_id: row.id,
    title,
    priority,
    due: toIso(dueMs),
    open_total: TASKS.filter((t) => !t.done).length,
  };
}

// ─── complete_task ────────────────────────────────────────────────────

export const completeTaskDefinition = {
  type: 'function',
  name: 'complete_task',
  description:
    "Mark a task as done. Provide either `task_id` (the id returned by add_task / get_tasks) OR a `title_match` (case-insensitive substring of the task title — use when the model only knows the name). Returns a dataset id routing to a task card with the done state styled. Call this when the user says 'done', 'mark X complete', 'finished that'.",
  parameters: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'Exact internal task id (e.g. "t_101"). Preferred when known.',
      },
      title_match: {
        type: 'string',
        description: 'Case-insensitive substring match of the title. Used only if task_id is omitted.',
      },
    },
    additionalProperties: false,
  },
};

export async function runCompleteTask(args) {
  const id = args?.task_id ? String(args.task_id).trim() : '';
  const match = args?.title_match ? String(args.title_match).trim().toLowerCase() : '';

  let target = null;
  if (id) {
    target = TASKS.find((t) => t.id === id) || null;
  } else if (match) {
    // Prefer open tasks first, then fall back to any match.
    target = TASKS.find((t) => !t.done && t.title.toLowerCase().includes(match))
         || TASKS.find((t) =>         t.title.toLowerCase().includes(match))
         || null;
  }

  if (!target) {
    return { error: id || match
      ? `No task matched (${id || match}).`
      : 'Need a task_id or title_match.' };
  }

  if (!target.done) {
    target.done = true;
    target.completed_ms = Date.now();
  }

  const shaped = toTaskCardShape(target);
  const datasetId = store.put('task', shaped);

  return {
    id: datasetId,
    summary: `Marked done: ${target.title}.`,
    task_id: target.id,
    title: target.title,
    done: true,
    open_total: TASKS.filter((t) => !t.done).length,
    done_total: TASKS.filter((t) =>  t.done).length,
  };
}

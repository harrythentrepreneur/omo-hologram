// src/tools/describe_changes.js — voice tool for "what did you just change?"
//
// Pulls the recent file_change events from the runtime coordinator and
// formats them for omo to narrate. Optional filters by agent (name/id)
// or task. The reply is a compact list plus a pre-rendered summary
// string omo can read out, AND a `note` instructing her to summarise
// rather than recite.

import * as hermes from '../../hermes/index.js';

export const definition = {
  type: 'function',
  name: 'describe_changes',
  description:
    "Report which files the agent(s) just changed in their recent tasks. Use when the user asks \"what did you change?\", \"what just changed?\", \"what did Nimbus do?\", \"show me the diff in words\", \"刚刚改了什么\". Returns a compact list (newest first) with file paths, line counts, and the agent who did it. Paired with the visual diff drawer on /preview — the user can ask in voice OR open the drawer; same data underneath.",
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Filter to one agent (name like "Nimbus" or agent_id). Omit for all recent agents.',
      },
      limit: {
        type: 'integer',
        description: 'Max number of file changes to return. Default 12; keep small so the spoken summary stays digestible.',
        minimum: 1,
        maximum: 50,
      },
    },
    additionalProperties: false,
  },
};

function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ago';
}

function shortPath(p) {
  if (!p) return '';
  const segs = String(p).split('/').filter(Boolean);
  if (segs.length <= 2) return segs.join('/');
  return segs.slice(-2).join('/');
}

export async function run(args = {}) {
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 12));
  let changes;
  try {
    changes = hermes.listRecentFileChanges({ limit: limit * 2 }) || [];
  } catch (err) {
    return {
      error: 'changes unavailable',
      detail: String(err?.message || err),
      note: 'Tell the user the agent runtime is unreachable; offer to retry.',
    };
  }

  const ref = args.agent ? String(args.agent).trim().toLowerCase() : null;
  if (ref) {
    changes = changes.filter((c) =>
      c.agent_id === ref ||
      (c.agent_name || '').toLowerCase() === ref ||
      (c.agent_name || '').toLowerCase().startsWith(ref),
    );
  }
  changes = changes.slice(0, limit);

  if (changes.length === 0) {
    return {
      changes: [],
      count: 0,
      summary: ref
        ? `${args.agent} hasn't touched any files yet.`
        : "Nothing's been changed in this session yet.",
      note: ref
        ? 'Tell the user that agent has not edited any files (yet); offer to dispatch one with spawn_agent_task.'
        : 'Tell the user no files have been changed yet. If they expected something, they may need to dispatch a task first.',
    };
  }

  // Group by agent for the spoken summary (omo doesn't want to read 12
  // separate lines aloud; she wants "Reed changed 2 files, Nimbus 3").
  const byAgent = new Map();
  for (const c of changes) {
    const key = c.agent_name || c.agent_id;
    if (!byAgent.has(key)) byAgent.set(key, { name: c.agent_name, color: c.color, files: [], totalAdd: 0, totalDel: 0, latestTs: 0 });
    const slot = byAgent.get(key);
    slot.files.push(c);
    slot.totalAdd += c.added;
    slot.totalDel += c.removed;
    if (c.ts > slot.latestTs) slot.latestTs = c.ts;
  }

  // Sentence-shaped per-agent line, e.g.
  // "Reed touched 3 files just now: home.html (+1/-1), onboarding.css (+24)."
  const lines = [];
  for (const slot of byAgent.values()) {
    const ago = fmtAgo(slot.latestTs);
    const fileList = slot.files.slice(0, 4).map((f) => {
      const stat = (f.added ? `+${f.added}` : '') + (f.added && f.removed ? '/' : '') + (f.removed ? `-${f.removed}` : '');
      return `${shortPath(f.relPath || f.path)}${stat ? ' (' + stat + ')' : ''}`;
    }).join(', ');
    const trailing = slot.files.length > 4 ? `, +${slot.files.length - 4} more` : '';
    lines.push(`${slot.name} touched ${slot.files.length} file${slot.files.length === 1 ? '' : 's'} ${ago}: ${fileList}${trailing}.`);
  }

  return {
    changes,
    count: changes.length,
    agents: [...byAgent.keys()],
    summary: lines.join('\n'),
    note:
      "Don't read the bullet list verbatim — paraphrase in one or two cute sentences (\"Reed just bumped the tagline in home.html and dropped 24 lines into onboarding.css~\"). If the user wants to see specifics, tell them to glance at the preview pane — there's a changes drawer at the bottom they can pop open (or you can say 'open the changes drawer' yourself if there's a way; otherwise just point them there).",
  };
}

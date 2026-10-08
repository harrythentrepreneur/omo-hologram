// src/tools/list_workspaces.js — inventory every agent workspace on disk.
//
// Voice equivalent of the /squad sidebar "worktrees" panel. Reads
// ~/.omo/worktrees/, cross-references active agents, and returns a
// summary including disk usage + pending-change counts + status
// (active vs orphan). Use for questions like "what's still on disk?",
// "any leftover workspaces?", "who's still here?".

import * as hermes from "../../hermes/index.js";

export const definition = {
  type: "function",
  name: "list_workspaces",
  description:
    "List every agent workspace currently on disk under ~/.omo/worktrees/. Returns name + status (active/orphan/busy) + disk size + pending change counts + linger expiry. Use when the user wants the big picture: 'what workspaces do I have?', 'who's still around?', 'any leftovers I should clean up?', '都谁还在？', '看看磁盘上还有啥'. Distinct from agent_status (which only shows who's actively seated). Read-only — nothing changes.",
  parameters: {
    type: "object",
    properties: {
      include_orphans: {
        type: "boolean",
        description: "Include workspaces that aren't owned by a seated agent (leftovers from a crash). Default true.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export async function run(args) {
  const includeOrphans = args?.include_orphans !== false;
  const all = hermes.listWorktrees() || [];
  const filtered = includeOrphans ? all : all.filter((w) => w.status === "active");

  if (filtered.length === 0) {
    return {
      ok: true,
      count: 0,
      workspaces: [],
      summary: "No workspaces on disk.",
      note: "Tell the user the disk is clean — no agent has work parked anywhere.",
    };
  }

  // Compact shape for Momo to narrate.
  const workspaces = filtered.map((w) => ({
    agent_id: w.agent_id || null,
    name: w.name || w.key,
    status: w.status,
    busy: !!w.busy,
    size: formatBytes(w.sizeBytes || 0),
    size_bytes: w.sizeBytes || 0,
    modified_at: w.modifiedAt || null,
    changes: w.changes && w.changes.hasChanges
      ? { files: w.changes.fileCount, added: w.changes.added, removed: w.changes.removed }
      : null,
    has_pending_changes: !!(w.changes && w.changes.hasChanges),
    linger_expires_at: w.linger_expires_at || null,
  }));

  const activeCount  = workspaces.filter((w) => w.status === "active").length;
  const orphanCount  = workspaces.filter((w) => w.status === "orphan").length;
  const pendingCount = workspaces.filter((w) => w.has_pending_changes).length;
  const totalBytes   = workspaces.reduce((sum, w) => sum + w.size_bytes, 0);

  return {
    ok: true,
    count: workspaces.length,
    workspaces,
    summary: `${activeCount} active + ${orphanCount} orphan, ${pendingCount} with pending changes, ${formatBytes(totalBytes)} total`,
    note:
      "Describe the inventory at a high level — who's seated with pending work, how much disk is used. " +
      "If there are orphans, mention them gently and offer to reap them (reap_agent_now). " +
      "If anyone has pending changes, name them and offer to preview/ship before they expire.",
  };
}

// src/runtimes/claude_watch.js — filesystem watcher for PTY-mode agents.
//
// In `claude -p` mode (src/runtimes/claude.js), every Edit/Write/MultiEdit
// produces a `tool_use` event in the JSON stream — the coordinator parses
// it and emits a canonical `file_change` event so the squad page's "files
// changed" chip and the AI coding loop's peek/accept flow see what moved.
//
// In PTY mode (src/runtimes/claude_pty.js) we have no JSON stream — the
// agent is just typing into a TUI. To keep the coding loop working, we
// watch the agent's worktree directory for filesystem changes and emit
// the same canonical events.
//
// Lifecycle:
//   • startWatch(agent_id, worktreePath, { onChange })
//       → returns a handle with .stop()
//   • Debounced per-file: rapid edits coalesce into one event.
//   • Ignores .git, node_modules, .DS_Store, and .swp files.
//
// Hard rules:
//   • never throw at module load
//   • a missing/dead worktree path → returns a no-op handle (callers
//     don't need to special-case)

import { existsSync } from "node:fs";
import { join, relative } from "node:path";

let chokidarPromise = null;
function loadChokidar() {
  if (!chokidarPromise) chokidarPromise = import("chokidar");
  return chokidarPromise;
}

// Per-file debounce window. Multiple writes within this window collapse
// into one emit. 250ms is generous enough that a "save → tool re-render"
// burst becomes a single change event.
const DEBOUNCE_MS = 250;

const IGNORED_REGEX = /(^|[/\\])(\.git|node_modules|\.DS_Store|\.next|\.cache|dist|build)([/\\]|$)|\.swp$|~$/;

// agent_id → handle so we can avoid duplicate watchers if the coordinator
// double-calls (shouldn't happen, but cheap insurance).
const watchers = new Map();

export async function startWatch(agent_id, worktreePath, { onChange } = {}) {
  if (!agent_id || !worktreePath) return noopHandle();
  if (!existsSync(worktreePath)) return noopHandle();

  // Reuse an existing watcher for the same agent so we don't double-emit.
  const existing = watchers.get(agent_id);
  if (existing) return existing.handle;

  let chokidar;
  try { chokidar = await loadChokidar(); }
  catch (err) {
    console.warn("[claude_watch] chokidar load failed:", err?.message || err);
    return noopHandle();
  }

  const debounce = new Map(); // absPath → setTimeout id

  const watcher = chokidar.watch(worktreePath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 25 },
    ignored: (p) => IGNORED_REGEX.test(p),
    // Don't follow symlinks to avoid loops (e.g. node_modules .bin).
    followSymlinks: false,
    // Use polling fallback only if native FSEvents/inotify isn't available.
    // Default behaviour is fine on macOS.
  });

  function emit(absPath, kind) {
    if (!onChange) return;
    try {
      onChange({
        agent_id,
        path: absPath,
        relPath: relative(worktreePath, absPath),
        kind, // 'add' | 'change' | 'unlink'
        ts: Date.now(),
      });
    } catch {}
  }

  function schedule(absPath, kind) {
    const prev = debounce.get(absPath);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      debounce.delete(absPath);
      emit(absPath, kind);
    }, DEBOUNCE_MS);
    debounce.set(absPath, t);
    if (typeof t.unref === "function") t.unref();
  }

  watcher.on("add",    (p) => schedule(p, "add"));
  watcher.on("change", (p) => schedule(p, "change"));
  watcher.on("unlink", (p) => schedule(p, "unlink"));
  watcher.on("error",  (err) => {
    if (process.env.OMO_WATCH_DEBUG) console.warn(`[claude_watch] ${agent_id} error:`, err?.message || err);
  });

  const handle = {
    agent_id,
    worktreePath,
    stop() {
      try { watcher.close(); } catch {}
      for (const t of debounce.values()) clearTimeout(t);
      debounce.clear();
      watchers.delete(agent_id);
    },
  };
  watchers.set(agent_id, { handle, watcher });
  return handle;
}

export function stopWatch(agent_id) {
  const w = watchers.get(agent_id);
  if (!w) return false;
  try { w.handle.stop(); } catch {}
  return true;
}

export function listWatchers() {
  return [...watchers.values()].map((w) => ({
    agent_id: w.handle.agent_id,
    worktree: w.handle.worktreePath,
  }));
}

export function shutdown() {
  for (const w of watchers.values()) {
    try { w.handle.stop(); } catch {}
  }
  watchers.clear();
}

function noopHandle() {
  return { agent_id: null, worktreePath: null, stop() {} };
}

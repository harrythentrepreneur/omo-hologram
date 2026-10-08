// src/runtimes/worktree.js — per-agent git worktree isolation.
//
// Each active agent gets a private worktree at ~/.omo/worktrees/<agent_id>/.
// The adapter runs with that path as cwd, so concurrent agents can edit the
// same repo without stomping each other's working tree, staging area, or
// HEAD. The path is keyed on the agent (not the task) so consecutive
// `claude --resume <session_id>` calls find the prior conversation —
// Claude Code stores session history per-cwd.
//
// Why ~/.omo/worktrees instead of /tmp:
//   • macOS auto-purges /var/folders/.../T after ~3 days idle → session loss
//   • /tmp paths are long and cluttered; ~/.omo is owned + inspectable
//   • persists across reboots → revived agents can be retargeted to the
//     same cwd in the future (Tier-2 work)
//
// Hard rules (CLAUDE.md):
//   • never throw at module load
//   • setup/cleanup must be idempotent — failed cleanup is annoying but
//     never fatal
//   • cleanup must run even if the task crashed mid-spawn

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// How long git operations get before we give up. Worktree add can be slow
// the first time on a big repo (it copies the index); 30s is generous.
const GIT_TIMEOUT_MS = 30_000;
const GIT_CLEANUP_TIMEOUT_MS = 10_000;

// Persistent worktree root. ~/.omo/worktrees/<agent_id>/. Created lazily
// on first setup so a server that never spawns agents leaves no trace.
export const WORKTREE_ROOT = join(homedir(), ".omo", "worktrees");

// Sidecar identity store. Sibling dir (not under WORKTREE_ROOT) so it
// doesn't pollute listWorktreeDirs. One JSON file per worktree key holds
// the agent_id + name + parent_repo that owns it, letting orphan
// resolution after a server restart deterministically match a directory
// back to its identity without guessing from a short-id prefix.
export const WORKTREE_IDENTITY_ROOT = join(homedir(), ".omo", "worktree-identities");

function ensureRoot() {
  try {
    if (!existsSync(WORKTREE_ROOT)) mkdirSync(WORKTREE_ROOT, { recursive: true });
    return true;
  } catch (err) {
    if (process.env.OMO_WORKTREE_DEBUG) {
      console.warn("[worktree] root mkdir failed:", err?.message || err);
    }
    return false;
  }
}

function ensureIdentityRoot() {
  try {
    if (!existsSync(WORKTREE_IDENTITY_ROOT)) mkdirSync(WORKTREE_IDENTITY_ROOT, { recursive: true });
    return true;
  } catch { return false; }
}

function sidecarPathFor(key) {
  const safe = String(key || "").replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safe) return null;
  return join(WORKTREE_IDENTITY_ROOT, `${safe}.json`);
}

// Write the identity sidecar for a worktree key. Best-effort — never
// throws, never blocks worktree creation if it fails. `identity` is
// shaped as { agent_id, name, parent_repo }.
export function writeWorktreeIdentity(key, identity) {
  if (!key || !identity || !ensureIdentityRoot()) return false;
  const p = sidecarPathFor(key);
  if (!p) return false;
  try {
    const body = {
      version: 1,
      key: String(key),
      agent_id: identity.agent_id || identity.id || null,
      name: identity.name || null,
      parent_repo: identity.parent_repo || identity.parentRepo || null,
      updatedAt: Date.now(),
    };
    writeFileSync(p, JSON.stringify(body, null, 2));
    return true;
  } catch { return false; }
}

// Read the identity sidecar for a worktree key. Returns null on miss or
// parse failure — callers should fall back to their old heuristic.
export function readWorktreeIdentity(key) {
  if (!key) return null;
  const p = sidecarPathFor(key);
  if (!p || !existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return {
      key: data.key || String(key),
      agent_id: data.agent_id || null,
      name: data.name || null,
      parent_repo: data.parent_repo || null,
      updatedAt: Number(data.updatedAt) || null,
    };
  } catch { return null; }
}

function removeWorktreeIdentity(key) {
  if (!key) return;
  const p = sidecarPathFor(key);
  if (!p || !existsSync(p)) return;
  try { rmSync(p, { force: true }); } catch {}
}

// Build the canonical path for a given key. Exported so callers can find
// an existing worktree without going through setupWorktree.
export function worktreePathFor(key) {
  const safe = String(key || "").replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safe) return null;
  return join(WORKTREE_ROOT, safe);
}

// Is this path a git repo we can safely worktree from? Cheap probe.
export function isGitRepo(repoPath) {
  if (!repoPath || !existsSync(repoPath)) return false;
  const r = spawnSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 3000,
  });
  return r.status === 0 && (r.stdout || "").trim() === "true";
}

// Cheap health check for an existing worktree. Returns true only if the
// dir exists, has a .git pointer file (worktree marker), and `git status`
// runs cleanly. Used by the coordinator before reusing agent.worktree —
// if the user manually deleted the dir between tasks, this returns false
// and the coordinator recreates instead of crashing the spawn.
export function isHealthyWorktree(wtPath) {
  if (!wtPath || !existsSync(wtPath)) return false;
  // A worktree dir has `.git` as a FILE (a pointer) — distinct from a
  // regular repo where `.git` is a directory. Either is acceptable here;
  // we just want to know git recognises it.
  try {
    const r = spawnSync("git", ["-C", wtPath, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 3000,
    });
    return r.status === 0 && (r.stdout || "").trim() === "true";
  } catch { return false; }
}

// Create an isolated detached-HEAD worktree of `parentRepo` at the
// canonical path for `key`. Returns { path, parentRepo, headBefore,
// cleanup, key } on success, or null on failure. Callers handle null
// according to their failure policy (the coordinator now respects
// OMO_WORKTREE_MODE rather than silently falling back to parentRepo).
//
// If a worktree for this key already exists AND is healthy, this REUSES
// it instead of recreating — important so a server restart doesn't blow
// away the cwd Claude Code's session history is anchored to.
//
// Detached HEAD on purpose: agents aren't expected to commit; we just
// want a private working tree to diff against later. No branch clutter
// in `git branch --list` after cleanup.
export function setupWorktree(parentRepo, key, { identity = null } = {}) {
  if (!parentRepo) return null;
  if (!isGitRepo(parentRepo)) return null;
  if (!key) return null;
  if (!ensureRoot()) return null;

  const wtPath = worktreePathFor(key);
  if (!wtPath) return null;

  // Reuse path: if a healthy worktree is already at this path and is
  // registered against the right parent, just rehydrate the handle.
  // This survives server restarts — the cwd stays put.
  if (isHealthyWorktree(wtPath) && isLinkedToParent(parentRepo, wtPath)) {
    const headBefore = capture(
      spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 }),
    );
    // Refresh the sidecar on reuse too — picks up renames, identity
    // updates, or fills in a sidecar that was missing from a worktree
    // created before this feature existed.
    if (identity) writeWorktreeIdentity(key, { ...identity, parent_repo: parentRepo });
    return makeHandle({ wtPath, parentRepo, headBefore, key, reused: true });
  }

  // Otherwise force-purge any stale worktree at the same path (post-crash
  // leftover, mismatched parent, or git metadata orphaned by a manual rm).
  forceRemove(parentRepo, wtPath);

  const add = spawnSync(
    "git",
    ["-C", parentRepo, "worktree", "add", "--detach", wtPath, "HEAD"],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
  );
  if (add.status !== 0) {
    // worktree add can fail if HEAD is unborn (fresh repo, no commits
    // yet) or the parent is in a weird state. Cleanly bail.
    if (process.env.OMO_WORKTREE_DEBUG) {
      console.warn(`[worktree] add failed for ${parentRepo}: ${add.stderr || add.stdout || "?"}`);
    }
    return null;
  }

  const headBefore = capture(
    spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000 }),
  );
  if (identity) writeWorktreeIdentity(key, { ...identity, parent_repo: parentRepo });
  return makeHandle({ wtPath, parentRepo, headBefore, key, reused: false });
}

function makeHandle({ wtPath, parentRepo, headBefore, key, reused }) {
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    forceRemove(parentRepo, wtPath);
    removeWorktreeIdentity(key);
  }
  return { path: wtPath, parentRepo, headBefore, key, reused, cleanup };
}

// Does parentRepo's worktree table include wtPath? Defends against the
// case where the directory exists with valid .git pointer but actually
// links to a DIFFERENT parent repo (e.g. you moved the omo checkout).
function isLinkedToParent(parentRepo, wtPath) {
  const r = spawnSync("git", ["-C", parentRepo, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.status !== 0) return false;
  // Output blocks separated by blank lines, each starts with "worktree <path>".
  for (const line of (r.stdout || "").split("\n")) {
    if (line.startsWith("worktree ") && line.slice(9).trim() === wtPath) return true;
  }
  return false;
}

// List every dir under ~/.omo/worktrees with its disk usage + mtime.
// Cheap (one statSync + one walk per dir). Used by /omo/api/hermes/
// worktrees so the squad UI can show "this is what's on disk."
//
// Returns: [{ name, path, sizeBytes, modifiedAt, exists }]. Does NOT
// cross-reference active agents — that's the caller's job (the hermes
// coordinator zips this with stateOf so the UI knows which are "live").
export function listWorktreeDirs() {
  if (!ensureRoot()) return [];
  let entries;
  try { entries = readdirSync(WORKTREE_ROOT); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const path = join(WORKTREE_ROOT, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isDirectory()) continue;
    let sizeBytes = 0;
    try { sizeBytes = walkSize(path, 4); } catch {}
    out.push({
      name,
      path,
      sizeBytes,
      modifiedAt: st.mtimeMs,
      exists: true,
    });
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// Best-effort parent lookup for a linked worktree. Running
// `git worktree list --porcelain` from inside a worktree prints the main
// checkout first, then the linked worktrees. We use that to let orphaned
// ~/.omo/worktrees entries remain reviewable after a server restart.
export function parentRepoForWorktree(wtPath) {
  if (!wtPath || !isHealthyWorktree(wtPath)) return null;
  const r = spawnSync("git", ["-C", wtPath, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.status !== 0) return null;
  const paths = [];
  for (const line of (r.stdout || "").split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice(9).trim());
  }
  return paths.find((p) => p && p !== wtPath) || null;
}

export function pruneWorktreeMetadata(parentRepo) {
  if (!parentRepo || !isGitRepo(parentRepo)) return false;
  try {
    spawnSync("git", ["-C", parentRepo, "worktree", "prune"], {
      stdio: "ignore",
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export function removeWorktreeByKey(parentRepo, key) {
  const wtPath = worktreePathFor(key);
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "workspace not found", code: "NO_WORKTREE" };
  }
  const parent = parentRepo || parentRepoForWorktree(wtPath);
  try {
    forceRemove(parent, wtPath);
    removeWorktreeIdentity(key);
    return { ok: true, key: String(key), path: wtPath };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), code: "REMOVE_FAILED" };
  }
}

// Bounded directory size walker. Capped at ~5k entries / 4 levels deep
// so this stays cheap even on big repos. Approximate — node_modules
// included — which is what we want for "disk usage on this machine".
function walkSize(root, maxDepth, _depth = 0, _count = { n: 0 }) {
  if (_depth > maxDepth || _count.n > 5000) return 0;
  let total = 0;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const dirent of entries) {
    _count.n++;
    if (_count.n > 5000) return total;
    const child = join(root, dirent.name);
    try {
      if (dirent.isDirectory()) {
        // skip git internal — large and not "user content"
        if (dirent.name === ".git") continue;
        total += walkSize(child, maxDepth, _depth + 1, _count);
      } else if (dirent.isFile()) {
        total += statSync(child).size;
      }
    } catch { /* keep walking */ }
  }
  return total;
}

// Sweep ~/.omo/worktrees for entries that aren't in `keepKeys`. Used at
// boot (no agents yet → keepKeys is empty → everything is pruned). Also
// runs `git worktree prune` against the parent so its bookkeeping is
// resynced. Returns the count removed.
export function sweepStaleWorktrees(parentRepo, keepKeys = []) {
  if (!ensureRoot()) return 0;
  const keep = new Set((keepKeys || []).map((k) => String(k).replace(/[^A-Za-z0-9_-]/g, "_")));
  let removed = 0;
  let entries;
  try { entries = readdirSync(WORKTREE_ROOT); }
  catch { entries = []; }
  for (const name of entries) {
    if (keep.has(name)) continue;
    const path = join(WORKTREE_ROOT, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory()) continue;
    } catch { continue; }
    try { forceRemove(parentRepo || null, path); removeWorktreeIdentity(name); removed++; }
    catch { /* ignore */ }
  }
  // Always prune parent's bookkeeping — there may be metadata for paths
  // we already removed in a prior run.
  if (parentRepo && isGitRepo(parentRepo)) {
    try {
      spawnSync("git", ["-C", parentRepo, "worktree", "prune"], {
        stdio: "ignore",
        timeout: GIT_CLEANUP_TIMEOUT_MS,
      });
    } catch {}
  }
  return removed;
}

// Best-effort removal. Tries `git worktree remove --force` first (which
// also detaches the worktree from the repo's metadata), then nukes the
// directory if anything's left. Both are safe no-ops when the worktree
// is already gone. `parentRepo` is optional — if absent we still rm the
// dir, just can't update the parent's bookkeeping (a later `prune` on
// the parent picks up the orphan record).
function forceRemove(parentRepo, wtPath) {
  if (parentRepo) {
    try {
      spawnSync("git", ["-C", parentRepo, "worktree", "remove", "--force", wtPath], {
        stdio: "ignore",
        timeout: GIT_CLEANUP_TIMEOUT_MS,
      });
    } catch {}
  }
  // The worktree metadata might be gone but the dir could still exist
  // (e.g. user copied files in). Force-rm to be safe.
  if (existsSync(wtPath)) {
    try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
  }
  if (parentRepo) {
    try {
      spawnSync("git", ["-C", parentRepo, "worktree", "prune"], {
        stdio: "ignore",
        timeout: GIT_CLEANUP_TIMEOUT_MS,
      });
    } catch {}
  }
}

function capture(r) {
  if (!r || r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

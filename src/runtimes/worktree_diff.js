// src/runtimes/worktree_diff.js — diff / apply / reset helpers.
//
// These are the building blocks for the "voice-controlled AI coding loop":
// after an agent finishes a task, the user can ship its work back into
// their main checkout, scrap it, or sync their own uncommitted edits into
// the agent's worktree before dispatch. All git, no smart merging — fail
// loud on conflicts and let the human decide.
//
// Every function returns a structured { ok, ... } object — never throws.
// Errors are categorised so callers (voice tools, UI buttons) can render
// them.
//
// Hard rules (CLAUDE.md):
//   • never throw at module load
//   • all spawns timeout
//   • status === 0 only on full success; partial wins are explicit

import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const APPLY_TIMEOUT_MS = 30_000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;   // 4 MB — fits even big refactors

// ─── Diff inspection ───────────────────────────────────────────────────

// Snapshot of "what would land if we accepted this worktree". Compares
// worktree's working tree (incl. untracked) against the agent's
// headBefore (or HEAD as a fallback). Returns:
//   { ok, files: [{ path, status, additions, deletions }], stat, hasChanges }
// where status ∈ M | A | D | R | C | U | ? (added/modified/deleted/etc).
export function inspectWorktree(wtPath, baseSha = null) {
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "worktree path missing", code: "NO_WORKTREE" };
  }

  // Tracked changes (modified/deleted/renamed/copied/unmerged) vs the
  // baseline. --diff-filter to keep this list focused; numstat for
  // per-file +/− counts.
  const base = baseSha || "HEAD";
  const numstat = spawnSync(
    "git",
    ["-C", wtPath, "diff", "--numstat", `${base}`],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
  );
  if (numstat.status !== 0) {
    return { ok: false, error: numstat.stderr?.trim() || "git diff failed", code: "GIT_FAILED" };
  }
  const nameStatus = spawnSync(
    "git",
    ["-C", wtPath, "diff", "--name-status", `${base}`],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
  );

  // Untracked files (new files the agent created — `git diff` ignores
  // these until they're staged).
  const untracked = spawnSync(
    "git",
    ["-C", wtPath, "ls-files", "--others", "--exclude-standard"],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
  );

  const files = new Map(); // path → { path, status, additions, deletions }

  for (const line of (numstat.stdout || "").split("\n")) {
    if (!line) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const [, addStr, delStr, path] = m;
    files.set(path, {
      path,
      status: "M",
      additions: addStr === "-" ? null : Number(addStr),
      deletions: delStr === "-" ? null : Number(delStr),
    });
  }
  for (const line of (nameStatus.stdout || "").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0]?.[0] || "M";
    const path = parts[parts.length - 1];
    const rec = files.get(path);
    if (rec) rec.status = status;
    else files.set(path, { path, status, additions: 0, deletions: 0 });
  }
  for (const line of (untracked.stdout || "").split("\n")) {
    if (!line) continue;
    if (!files.has(line)) {
      files.set(line, { path: line, status: "?", additions: null, deletions: null });
    }
  }

  let added = 0, removed = 0;
  for (const f of files.values()) {
    if (typeof f.additions === "number") added += f.additions;
    if (typeof f.deletions === "number") removed += f.deletions;
  }

  return {
    ok: true,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    stat: { added, removed, fileCount: files.size },
    hasChanges: files.size > 0,
  };
}

// Full unified diff text — used by /preview-diff and apply. Includes
// untracked files (via --no-index) so new files show as additions.
//
// Capped at MAX_DIFF_BYTES; if exceeded we still return what we got plus
// `truncated: true` so the caller can render a warning.
//
// When `targetRepo` is provided (apply path), untracked files that
// ALREADY exist at the target with byte-identical content are skipped
// from the patch — applying them would otherwise error with "already
// exists in working directory" even though the result is a no-op. The
// display path leaves `targetRepo` undefined and shows everything.
export function getDiffText(wtPath, baseSha = null, { targetRepo = null } = {}) {
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "worktree path missing", code: "NO_WORKTREE" };
  }
  const base = baseSha || "HEAD";
  // For tracked changes
  const tracked = spawnSync(
    "git",
    ["-C", wtPath, "diff", "--unified=3", "--no-color", base],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES },
  );
  if (tracked.status !== 0) {
    return { ok: false, error: tracked.stderr?.trim() || "git diff failed", code: "GIT_FAILED" };
  }
  let text = tracked.stdout || "";
  let truncated = false;
  const skippedNoops = [];

  // Untracked files: each shown as a synthetic diff against /dev/null so
  // `git apply` can re-create them on the target side.
  const untracked = spawnSync(
    "git",
    ["-C", wtPath, "ls-files", "--others", "--exclude-standard"],
    { encoding: "utf8", timeout: GIT_TIMEOUT_MS },
  );
  for (const path of (untracked.stdout || "").split("\n").filter(Boolean)) {
    // Apply-side optimisation: if the target already has this file with
    // identical content, skip it — adding it would fail with "already
    // exists". This commonly happens when the user manually copied the
    // agent's output, or when an earlier accept landed it and the
    // worktree's baseline didn't catch up.
    if (targetRepo) {
      const targetFile = join(targetRepo, path);
      const wtFile = join(wtPath, path);
      try {
        if (existsSync(targetFile) && existsSync(wtFile)) {
          const a = readFileSync(targetFile);
          const b = readFileSync(wtFile);
          if (a.length === b.length && a.equals(b)) {
            skippedNoops.push(path);
            continue;
          }
        }
      } catch { /* fall through and include in patch */ }
    }
    const dn = spawnSync(
      "git",
      ["-C", wtPath, "diff", "--no-color", "--no-index", "--unified=3", "/dev/null", path],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES },
    );
    // --no-index sets exit 1 when files differ — that's success here.
    if (dn.status === 0 || dn.status === 1) {
      if (text.length + (dn.stdout?.length || 0) > MAX_DIFF_BYTES) { truncated = true; break; }
      text += dn.stdout || "";
    }
  }

  return { ok: true, text, truncated, bytes: text.length, skippedNoops };
}

// ─── Apply / accept ────────────────────────────────────────────────────

// Apply the worktree's diff onto `targetRepo` (the user's main checkout).
//
// mode:
//   "apply"   — `git apply` (unstaged; lands as dirty changes in target)
//   "stage"   — `git apply --cached` (lands staged, ready to commit)
//   "commit"  — apply, stage, commit on a branch (auto-named or `branch`)
//   "dry_run" — `git apply --check`; no changes made; returns conflicts list
//
// Conflict policy: fail loud. We do NOT 3-way merge or stash. If the
// target has overlapping edits, return CONFLICT with the rejecting paths.
export async function applyWorktreeChanges(wtPath, targetRepo, {
  baseSha = null,
  mode = "apply",
  branch = null,
  commitMessage = null,
} = {}) {
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "agent worktree is gone", code: "NO_WORKTREE" };
  }
  if (!targetRepo || !existsSync(targetRepo)) {
    return { ok: false, error: "target repo missing", code: "NO_TARGET" };
  }

  const inspection = inspectWorktree(wtPath, baseSha);
  if (!inspection.ok) return inspection;
  if (!inspection.hasChanges) {
    return { ok: true, mode, files: [], stat: inspection.stat, note: "nothing to apply" };
  }

  // Pass targetRepo so getDiffText can filter no-op "new file already
  // exists with identical content" cases. Without this, accept would
  // error on patches whose new-file hunks happen to match what's
  // already on disk (common: user manually copied the file, or a prior
  // accept already landed it and the worktree's baseline didn't move).
  const diff = getDiffText(wtPath, baseSha, { targetRepo });
  if (!diff.ok) return diff;
  if (diff.truncated) {
    return { ok: false, error: "diff exceeds 4 MB; refuse to apply partial patch", code: "DIFF_TOO_LARGE" };
  }
  // Patch may be empty if every change was a no-op (e.g. agent
  // re-created files identical to what's already in main).
  if (!diff.text.trim()) {
    return {
      ok: true,
      mode,
      files: [],
      stat: { added: 0, removed: 0, fileCount: 0 },
      skipped_noops: diff.skippedNoops || [],
      note: "every change was already present in the target; nothing to apply",
    };
  }

  // Dry-run check first regardless of mode — catches conflicts before we
  // mutate anything. Strict mode (no 3-way) is fastest; only if that
  // refuses do we try a 3-way check.
  //
  // BUT: `apply --check --3way` is over-strict — it requires the
  // patch's "before" blob to match the target's index, even though
  // `apply --3way` (no --check) would happily reconstruct the
  // merge from the patch's blob hashes and leave conflict markers
  // we can surface as CONFLICT. So when both checks fail and mode
  // permits, we ATTEMPT the actual --3way apply and only escalate
  // to CONFLICT if that also blows up cleanly. This rescues the
  // common case of "agent's baseline is N commits behind main."
  const strictCheck = await runGitWithStdin(
    targetRepo,
    ["apply", "--check", "-p1", "--whitespace=nowarn", "-"],
    diff.text,
    APPLY_TIMEOUT_MS,
  );
  let useThreeWay = false;
  if (!strictCheck.ok) {
    const threeWayCheck = await runGitWithStdin(
      targetRepo,
      ["apply", "--check", "--3way", "-p1", "--whitespace=nowarn", "-"],
      diff.text,
      APPLY_TIMEOUT_MS,
    );
    if (!threeWayCheck.ok) {
      // --check rejected both strict and 3-way — but --check is more
      // pessimistic than the real apply. For non-mutating modes (dry_run)
      // we accept its verdict; for stash_and_apply we hand off to the
      // stash path. For real apply/stage we'll let the actual --3way
      // apply attempt run below (it can succeed-with-markers, which the
      // post-apply marker scan will surface as CONFLICT cleanly).
      if (mode === "dry_run") {
        return {
          ok: false,
          code: "CONFLICT",
          error: "dry-run: patch wouldn't apply cleanly — target has overlapping edits",
          conflicting_paths: parseConflictingPaths(strictCheck.stderr || threeWayCheck.stderr || ""),
          stderr: threeWayCheck.stderr || strictCheck.stderr,
        };
      }
      if (mode === "stash_and_apply") {
        return await stashApplyReapply({
          targetRepo,
          diffText: diff.text,
          inspection,
        });
      }
      // Fall through: useThreeWay=true so the apply branch below
      // attempts the optimistic --3way apply.
    }
    useThreeWay = true;
  }
  if (mode === "dry_run") {
    return {
      ok: true, mode, files: inspection.files, stat: inspection.stat,
      note: useThreeWay
        ? "dry-run only; would apply via 3-way merge (parent moved forward but no overlap)"
        : "dry-run only; no changes applied",
    };
  }
  if (mode === "stash_and_apply") {
    // No conflict — degrade to plain apply.
    mode = "apply";
  }

  if (mode === "apply" || mode === "stage") {
    // --3way is incompatible with --cached. When we silently upgrade to
    // 3-way (parent moved forward), --3way implies --index so changes
    // do get staged — they also land in the working tree, which is
    // a slight upgrade over pure --cached for stage mode (the user sees
    // the merged result on disk too). Acceptable trade-off; the
    // alternative would be to fail the stage and ask the user to pull.
    // Snapshot the current state of every file the patch will touch so
    // we can roll back cleanly if --3way leaves conflict markers. The
    // snapshot preserves the user's uncommitted edits — restoring from
    // HEAD would clobber them. Files that don't exist yet (new files
    // we're adding) are tracked with sentinel = null so rollback knows
    // to delete them.
    const touchedPaths = inspection.files.map((f) => f.path).filter(Boolean);
    const preApplySnapshots = new Map();
    if (useThreeWay) {
      for (const p of touchedPaths) {
        const full = join(targetRepo, p);
        try {
          preApplySnapshots.set(p, existsSync(full) ? readFileSync(full) : null);
        } catch {
          preApplySnapshots.set(p, null);
        }
      }
    }

    const args = useThreeWay
      ? ["apply", "--3way", "--whitespace=nowarn", "-p1", "-"]
      : ["apply", "--whitespace=nowarn", "-p1", ...(mode === "stage" ? ["--cached", "--index"] : []), "-"];
    const r = await runGitWithStdin(targetRepo, args, diff.text, APPLY_TIMEOUT_MS);
    // `git apply --3way` exits 1 when it leaves conflict markers (still
    // a partial success — the clean hunks landed). Strict apply exits 1
    // only on full failure. Decide based on whether ANY of the patched
    // files now have markers OR look modified vs HEAD.
    if (!r.ok && !useThreeWay) {
      return { ok: false, code: "APPLY_FAILED", error: r.stderr || "git apply failed" };
    }
    if (useThreeWay) {
      // Marker scan: if --3way left conflict markers in any patched
      // file, the user's main is now polluted with `<<<<<<<` markers
      // mid-file. That breaks the preview-first guarantee ("nothing
      // changes in main unless ship fully succeeds"), so we ROLL BACK
      // all touched files to their pre-apply state and surface CONFLICT
      // cleanly. The user gets the recovery menu without any cleanup
      // homework.
      const markers = findFilesWithConflictMarkers(targetRepo, inspection.files.map((f) => f.path));
      if (markers.length > 0) {
        // Restore each touched file from the pre-apply snapshot — this
        // preserves whatever the user had on disk (including dirty
        // edits) before they hit Accept. Also unstage anything --3way
        // may have indexed.
        let rollbackError = null;
        try {
          for (const [p, snap] of preApplySnapshots.entries()) {
            const full = join(targetRepo, p);
            if (snap === null) {
              // File didn't exist before — apply may have created it; remove.
              try { if (existsSync(full)) rmSync(full, { force: true }); } catch {}
            } else {
              try { writeFileSync(full, snap); } catch (err) {
                rollbackError = (rollbackError ? rollbackError + " | " : "") + String(err?.message || err);
              }
            }
          }
          if (touchedPaths.length > 0) {
            spawnSync("git", ["-C", targetRepo, "reset", "HEAD", "--", ...touchedPaths], {
              encoding: "utf8", timeout: GIT_TIMEOUT_MS,
            });
          }
        } catch (err) {
          rollbackError = String(err?.message || err);
        }
        return {
          ok: false,
          code: "CONFLICT",
          error: rollbackError
            ? `3-way merge couldn't resolve every hunk; rollback partial (${rollbackError}) — your checkout may have conflict markers in: ${markers.join(", ")}`
            : `3-way merge couldn't resolve every hunk in ${markers.length} file(s); your checkout is back to its pre-accept state`,
          conflicting_paths: markers,
          stderr: r.stderr,
          rolled_back: !rollbackError,
        };
      }
      // Exit-1 with no markers AND no modifications means nothing landed
      // at all — the patch was truly unmergeable. Distinguish from the
      // happy "applied with no conflicts" case by checking whether the
      // target actually has changes now.
      if (!r.ok) {
        const status = spawnSync("git", ["-C", targetRepo, "status", "--porcelain"], {
          encoding: "utf8",
          timeout: GIT_TIMEOUT_MS,
        });
        const touched = (status.stdout || "").trim();
        if (!touched) {
          return {
            ok: false,
            code: "CONFLICT",
            error: "patch wouldn't apply cleanly — target has overlapping edits",
            conflicting_paths: parseConflictingPaths(r.stderr || ""),
            stderr: r.stderr,
          };
        }
      }
      if (mode === "apply") {
        const paths = inspection.files.map((f) => f.path).filter(Boolean);
        if (paths.length > 0) {
          const reset = spawnSync("git", ["-C", targetRepo, "reset", "--", ...paths], {
            encoding: "utf8",
            timeout: GIT_TIMEOUT_MS,
          });
          if (reset.status !== 0) {
            return { ok: false, code: "UNSTAGE_FAILED", error: reset.stderr?.trim() || "git reset failed after 3-way apply" };
          }
        }
      }
    }
    return {
      ok: true, mode, files: inspection.files, stat: inspection.stat,
      ...(useThreeWay ? { three_way: true, note: "applied via 3-way merge — parent moved forward without overlap" } : {}),
      ...(diff.skippedNoops?.length ? { skipped_noops: diff.skippedNoops } : {}),
    };
  }

  if (mode === "three_way") {
    // Git's built-in 3-way merge — uses the common ancestor (the blob
    // referenced in the patch header) to merge against. Handles the
    // common case where user edited different lines of the same file.
    // If it CAN'T resolve a hunk cleanly, it leaves conflict markers
    // (<<<<<<< ... ======= ... >>>>>>>) and reports the affected paths;
    // we surface those so the caller can decide (have an agent resolve
    // them, or fix manually).
    const r = await runGitWithStdin(
      targetRepo,
      ["apply", "--3way", "--whitespace=nowarn", "-p1", "-"],
      diff.text,
      APPLY_TIMEOUT_MS,
    );
    if (!r.ok) {
      // 3way bailed entirely (e.g. blob ancestor missing). Surface like
      // CONFLICT so the caller can route to the agent-resolver path.
      return {
        ok: false,
        code: "CONFLICT",
        error: "3-way merge couldn't reconstruct the common ancestor",
        conflicting_paths: parseConflictingPaths(r.stderr || ""),
        stderr: r.stderr,
      };
    }
    // Even when --3way returns 0, individual hunks may have fallen back
    // to leaving conflict markers in the file. Detect by scanning for
    // the marker lines in stderr ("Applied patch ... cleanly." vs
    // "Falling back to three-way merge..."). The authoritative signal
    // is to look at the working tree itself.
    const markers = findFilesWithConflictMarkers(targetRepo, inspection.files.map((f) => f.path));
    if (markers.length > 0) {
      return {
        ok: true,
        partial: true,
        mode,
        files: inspection.files,
        stat: inspection.stat,
        files_with_markers: markers,
        note: "3-way merged what it could; these files still have conflict markers and need a human or AI pass",
      };
    }
    return { ok: true, mode, files: inspection.files, stat: inspection.stat };
  }

  if (mode === "commit") {
    // Capture the user's current checkout state so we can put them back
    // on it after committing onto the agent's branch. CLAUDE.md's
    // contract for 'commit' mode is "the agent's work lands as a clean
    // commit on a new branch; the user's branch stays untouched and
    // they stay where they were". To keep that promise we need to:
    //   1. remember what HEAD points at (branch name OR detached SHA)
    //   2. create + commit on the new branch
    //   3. checkout back to the original ref
    // If step 3 fails we leave the user on the new branch but tell them.
    const originalRef = captureHeadRef(targetRepo);

    // Mirror the apply/stage fallback: --3way silently rescues
    // parent-moved-forward situations. --3way implies --index so the
    // changes land staged (and in the working tree); `checkout -B`
    // preserves both, so the commit on the new branch picks them up
    // unchanged.
    const stageArgs = useThreeWay
      ? ["apply", "--3way", "--whitespace=nowarn", "-p1", "-"]
      : ["apply", "--cached", "--index", "--whitespace=nowarn", "-p1", "-"];
    const stage = await runGitWithStdin(targetRepo, stageArgs, diff.text, APPLY_TIMEOUT_MS);
    if (!stage.ok) return { ok: false, code: "APPLY_FAILED", error: stage.stderr || "git apply failed" };
    if (useThreeWay) {
      const markers = findFilesWithConflictMarkers(targetRepo, inspection.files.map((f) => f.path));
      if (markers.length > 0) {
        return {
          ok: false,
          code: "CONFLICT",
          error: "3-way apply left conflict markers",
          conflicting_paths: markers,
          stderr: stage.stderr,
        };
      }
    }
    const branchName = branch || autoBranchName();
    const co = spawnSync("git", ["-C", targetRepo, "checkout", "-B", branchName], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (co.status !== 0) {
      // Roll back the staged changes so the target's index is clean.
      spawnSync("git", ["-C", targetRepo, "reset"], { stdio: "ignore", timeout: GIT_TIMEOUT_MS });
      return { ok: false, code: "BRANCH_FAILED", error: co.stderr?.trim() || "git checkout failed" };
    }
    const msg = commitMessage || `omo: accept agent work · ${new Date().toISOString().slice(0, 19)}`;
    const commit = spawnSync("git", ["-C", targetRepo, "commit", "-m", msg], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    if (commit.status !== 0) {
      return { ok: false, code: "COMMIT_FAILED", error: commit.stderr?.trim() || "git commit failed" };
    }
    const sha = spawnSync("git", ["-C", targetRepo, "rev-parse", "HEAD"], {
      encoding: "utf8", timeout: 3000,
    });

    // Put the user back where they were. If they were on a branch,
    // checkout that branch by name; if they were on detached HEAD,
    // checkout the SHA. Failure here is non-fatal — the agent's commit
    // is already on disk, we just leave the user on the new branch and
    // tell them.
    let restoredRef = null;
    let restoreFailed = null;
    if (originalRef?.ref) {
      const back = spawnSync("git", ["-C", targetRepo, "checkout", originalRef.ref], {
        encoding: "utf8", timeout: GIT_TIMEOUT_MS,
      });
      if (back.status === 0) restoredRef = originalRef.ref;
      else restoreFailed = back.stderr?.trim() || "git checkout (restore) failed";
    }

    return {
      ok: true,
      mode,
      branch: branchName,
      sha: (sha.stdout || "").trim() || null,
      files: inspection.files,
      stat: inspection.stat,
      restored_ref: restoredRef,
      ...(restoreFailed ? { restore_failed: restoreFailed } : {}),
      ...(useThreeWay ? { three_way: true } : {}),
    };
  }

  return { ok: false, code: "BAD_MODE", error: `unknown mode: ${mode}` };
}

// ─── Discard ───────────────────────────────────────────────────────────

// `git reset --hard HEAD && git clean -fdx` in the worktree. Returns
// the list of paths that were nuked (best-effort).
export function discardWorktreeChanges(wtPath) {
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "worktree path missing", code: "NO_WORKTREE" };
  }
  const before = inspectWorktree(wtPath);
  const reset = spawnSync("git", ["-C", wtPath, "reset", "--hard", "HEAD"], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS,
  });
  if (reset.status !== 0) {
    return { ok: false, code: "GIT_FAILED", error: reset.stderr?.trim() || "git reset failed" };
  }
  // -fdx: also remove ignored files (e.g. node_modules the agent wrote).
  // Safer than -fd alone because gitignored agent artifacts can otherwise
  // linger and pollute future tasks' inspect output.
  const clean = spawnSync("git", ["-C", wtPath, "clean", "-fdx"], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS,
  });
  if (clean.status !== 0) {
    return { ok: false, code: "GIT_FAILED", error: clean.stderr?.trim() || "git clean failed" };
  }
  return {
    ok: true,
    files_cleared: before.ok ? before.files : [],
    stat: before.ok ? before.stat : null,
  };
}

// Mark the worktree's current contents as the new review baseline.
//
// We intentionally make a tiny detached-HEAD commit inside the agent
// worktree. That keeps the agent's files exactly as-is for follow-up
// conversation, while future previews/accepts only show new work done
// after this point. The commit lives in the same local object database
// as the parent repo but is not on the user's branch.
export function markWorktreeBaseline(wtPath, { message = null } = {}) {
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "worktree path missing", code: "NO_WORKTREE" };
  }
  const before = inspectWorktree(wtPath);
  if (!before.ok) return before;
  const headBefore = gitHead(wtPath);
  if (!before.hasChanges) {
    return { ok: true, changed: false, head: headBefore, files: [], stat: before.stat };
  }

  const add = spawnSync("git", ["-C", wtPath, "add", "-A"], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (add.status !== 0) {
    return { ok: false, code: "BASELINE_FAILED", error: add.stderr?.trim() || "git add failed" };
  }

  const msg = message || `omo: agent workspace baseline ${new Date().toISOString().slice(0, 19)}`;
  const commit = spawnSync("git", ["-C", wtPath, "commit", "--no-verify", "-m", msg], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "omo",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "omo-agent@example.invalid",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "omo",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "omo-agent@example.invalid",
    },
  });
  if (commit.status !== 0) {
    const text = `${commit.stdout || ""}\n${commit.stderr || ""}`;
    if (/nothing to commit|no changes added/i.test(text)) {
      return { ok: true, changed: false, head: gitHead(wtPath), files: [], stat: before.stat };
    }
    // Restore the worktree to its pre-baseline shape so a follow-up
    // peek/accept doesn't surface files as "still staged from a failed
    // baseline". We left files staged via `git add -A`; unstage them.
    spawnSync("git", ["-C", wtPath, "reset"], { stdio: "ignore", timeout: GIT_TIMEOUT_MS });
    return { ok: false, code: "BASELINE_FAILED", error: commit.stderr?.trim() || commit.stdout?.trim() || "git commit failed" };
  }

  return {
    ok: true,
    changed: true,
    head: gitHead(wtPath),
    headBefore,
    files: before.files,
    stat: before.stat,
  };
}

// ─── Sync user edits → worktree ────────────────────────────────────────

// Copy the user's uncommitted edits (in `sourceRepo`, typically the main
// checkout) into the agent's worktree before dispatch — so the agent can
// "finish what I started" without me committing first.
//
// Same conflict policy as applyWorktreeChanges: fail loud. The worktree
// should be clean (`git status -s` empty) before sync, otherwise the
// patch may not apply.
export async function syncUserEditsToWorktree(sourceRepo, wtPath) {
  if (!sourceRepo || !existsSync(sourceRepo)) {
    return { ok: false, error: "source repo missing", code: "NO_SOURCE" };
  }
  if (!wtPath || !existsSync(wtPath)) {
    return { ok: false, error: "worktree path missing", code: "NO_WORKTREE" };
  }
  // Inspect source's dirty state — if there's nothing to sync, no-op.
  const inspection = inspectWorktree(sourceRepo);
  if (!inspection.ok) return inspection;
  if (!inspection.hasChanges) {
    return { ok: true, files: [], note: "source repo has no uncommitted edits" };
  }
  const diff = getDiffText(sourceRepo);
  if (!diff.ok) return diff;
  if (diff.truncated) {
    return { ok: false, error: "diff exceeds 4 MB", code: "DIFF_TOO_LARGE" };
  }
  const check = await runGitWithStdin(
    wtPath,
    ["apply", "--check", "-p1", "--whitespace=nowarn", "-"],
    diff.text,
    APPLY_TIMEOUT_MS,
  );
  if (!check.ok) {
    return { ok: false, code: "CONFLICT", error: "worktree isn't clean enough to take the patch", stderr: check.stderr };
  }
  const r = await runGitWithStdin(
    wtPath,
    ["apply", "--whitespace=nowarn", "-p1", "-"],
    diff.text,
    APPLY_TIMEOUT_MS,
  );
  if (!r.ok) return { ok: false, code: "APPLY_FAILED", error: r.stderr || "git apply failed" };
  return { ok: true, files: inspection.files, stat: inspection.stat };
}

// ─── Helpers ───────────────────────────────────────────────────────────

// Scan the listed files for git conflict markers left by --3way fallback.
// Returns the paths that still need resolution. Reads at most 1 MB per
// file — conflict markers always appear at column 0 so we can scan
// cheaply line by line.
function findFilesWithConflictMarkers(repo, paths) {
  const hits = [];
  for (const rel of paths || []) {
    try {
      const abs = join(repo, rel);
      const buf = readFileSync(abs, { encoding: "utf8" }).slice(0, 1024 * 1024);
      if (/^<<<<<<< /m.test(buf) && /^=======$/m.test(buf) && /^>>>>>>> /m.test(buf)) {
        hits.push(rel);
      }
    } catch { /* file may have been deleted by the patch — that's fine */ }
  }
  return hits;
}

function gitHead(repo) {
  try {
    const r = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
    });
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
  } catch {
    return null;
  }
}

function autoBranchName() {
  // Timestamp + short random suffix. Timestamp alone (second resolution)
  // collides when two accepts fire in the same second, and `git checkout
  // -B` silently RESETS the colliding branch — so we tack on 6 hex chars
  // to make collisions effectively impossible. Both pieces are kept so
  // the branch is still chronologically sortable in `git branch --list`.
  const ts = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const tag = randomBytes(3).toString("hex");
  return `omo/agent-${ts}-${tag}`;
}

// Snapshot the user's current HEAD so we can put them back on it after a
// `mode: 'commit'` accept. Prefers the branch name (so reflog reads
// nicely); falls back to the SHA when they're on detached HEAD.
function captureHeadRef(repo) {
  try {
    const sym = spawnSync("git", ["-C", repo, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8", timeout: 3000,
    });
    if (sym.status === 0) {
      const ref = (sym.stdout || "").trim();
      if (ref) return { ref, detached: false };
    }
    const sha = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8", timeout: 3000,
    });
    if (sha.status === 0) {
      const v = (sha.stdout || "").trim();
      if (v) return { ref: v, detached: true };
    }
  } catch {}
  return null;
}

// Parse the file paths git mentioned in apply --check stderr. Lines
// look like:
//   error: patch failed: path/to/file.js:42
//   error: path/to/file.js: patch does not apply
// We pull the unique path prefixes out so the UI can show them.
function parseConflictingPaths(stderr) {
  const paths = new Set();
  for (const line of String(stderr || "").split("\n")) {
    let m = line.match(/^error: patch failed: (.+?):\d+/);
    if (m) { paths.add(m[1]); continue; }
    m = line.match(/^error: (.+?): patch does not apply/);
    if (m) { paths.add(m[1]); continue; }
  }
  return [...paths];
}

// Stash user's edits in target, apply agent's diff, re-apply user's edits.
// Three failure modes worth being explicit about:
//   • stash fails (e.g. nothing to stash and target was already clean —
//     then plain apply should have worked; we surface the original error)
//   • agent's diff fails to apply onto stashed-clean state — true CONFLICT
//     with HEAD; we restore the stash and bail
//   • user's stash fails to pop onto the new state — user's edits AND
//     agent's edits overlap. We leave the stash in place so user can
//     resolve manually and tell them where it lives.
async function stashApplyReapply({ targetRepo, diffText, inspection }) {
  const stashLabel = `omo: stash-and-apply ${new Date().toISOString().slice(0, 19)}`;
  const stash = spawnSync("git", ["-C", targetRepo, "stash", "push", "-u", "-m", stashLabel], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS,
  });
  if (stash.status !== 0) {
    return {
      ok: false,
      code: "STASH_FAILED",
      error: stash.stderr?.trim() || "git stash failed (nothing to stash?)",
    };
  }
  // Some git versions emit "No local changes to save" on stderr instead
  // of stdout, so check both streams. Otherwise we'd later try to `stash
  // pop` something that never existed.
  const stashSignals = `${stash.stdout || ""}\n${stash.stderr || ""}`;
  const stashedAnything = !/No local changes to save/.test(stashSignals);

  // Now try the agent's diff onto the clean target.
  const apply = await runGitWithStdin(
    targetRepo,
    ["apply", "--whitespace=nowarn", "-p1", "-"],
    diffText,
    APPLY_TIMEOUT_MS,
  );
  if (!apply.ok) {
    // Restore user's edits so we don't leave them in stash limbo. If the
    // rollback ITSELF fails (rare — stash got corrupted, or the agent's
    // partially-applied diff is now sitting on top of clean HEAD), we
    // must surface that loudly so the user knows where to find their
    // work. Silently swallowing the pop status (as we did before) hid
    // the failure and the user thought their edits were rolled back.
    let rollbackPartial = null;
    if (stashedAnything) {
      const pop = spawnSync("git", ["-C", targetRepo, "stash", "pop"], {
        encoding: "utf8", timeout: GIT_TIMEOUT_MS,
      });
      if (pop.status !== 0) {
        rollbackPartial = {
          stash_ref: "stash@{0}",
          stderr: pop.stderr?.trim() || "git stash pop failed during rollback",
        };
      }
    }
    if (rollbackPartial) {
      return {
        ok: false,
        code: "ROLLBACK_PARTIAL",
        error:
          "agent's diff couldn't be applied AND your stashed edits couldn't be re-applied automatically — they're safe in " +
          rollbackPartial.stash_ref +
          ", but you'll need `git stash pop` to recover them by hand.",
        conflicting_paths: parseConflictingPaths(apply.stderr || ""),
        stderr: apply.stderr,
        stash_ref: rollbackPartial.stash_ref,
        rollback_stderr: rollbackPartial.stderr,
      };
    }
    return {
      ok: false,
      code: "CONFLICT",
      error: "agent's diff conflicts with HEAD itself — not just your edits",
      conflicting_paths: parseConflictingPaths(apply.stderr || ""),
      stderr: apply.stderr,
    };
  }

  // Re-apply user's edits on top of agent's.
  if (stashedAnything) {
    const pop = spawnSync("git", ["-C", targetRepo, "stash", "pop"], {
      encoding: "utf8", timeout: GIT_TIMEOUT_MS,
    });
    if (pop.status !== 0) {
      // The stash is still there as stash@{0}. Tell the user.
      return {
        ok: false,
        code: "REAPPLY_CONFLICT",
        error: "agent's changes applied, but your stashed edits collide with them. Resolve with `git stash pop` (your work is in stash@{0}).",
        stderr: pop.stderr,
      };
    }
  }
  return {
    ok: true,
    mode: "stash_and_apply",
    files: inspection.files,
    stat: inspection.stat,
    stash_used: stashedAnything,
    note: stashedAnything
      ? "stashed your edits, applied agent's diff, re-applied yours on top"
      : "no user edits to stash; applied agent's diff directly",
  };
}

// Spawn git with stdin (the patch text) and a hard timeout. Returns
// { ok, stdout, stderr }. We can't use spawnSync with a piped buffer
// reliably for big payloads on darwin — the buffer gets clipped — so
// async spawn + write-then-end is the safer path.
function runGitWithStdin(cwd, args, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, stderr: String(err?.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false, stderr: stderr + "\n(timed out)" });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (b) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, stderr: stderr + "\n" + (err?.message || err) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    try {
      child.stdin.write(stdin);
      child.stdin.end();
    } catch (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false, stderr: stderr + "\n" + (err?.message || err) });
    }
  });
}

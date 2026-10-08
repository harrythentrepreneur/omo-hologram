// src/tools/accept_agent_work.js — ship an agent's changes into the
// user's main checkout.
//
// Three modes (the model picks based on what the user said):
//   apply  — git apply onto the parent repo, UNSTAGED. Default; matches
//            "Reed gave me a patch to review" — user reviews then commits
//            normally.
//   stage  — git apply --cached. Same edits, but pre-staged. Matches
//            "stage Reed's work so I can commit it myself."
//   commit — apply + checkout new branch + commit. Matches "ship it on
//            a branch" / "make a PR" — keeps main untouched.
//
// Conflict policy: fail loud. If the user has overlapping edits in their
// own checkout we refuse and surface the rejecting paths. The user can
// then commit/stash their work and retry.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "../agents/agent_context.js";

const VALID_MODES = new Set(["apply", "stage", "commit", "dry_run", "stash_and_apply", "three_way"]);

export const definition = {
  type: "function",
  name: "accept_agent_work",
  description:
    "Ship an agent's changes into the user's main repo. Use ONLY when the user explicitly approves: \"ship it\", \"merge Reed's changes\", \"accept Wren's work\", \"把 Reed 的合进来\", \"send it\". If the user says \"ship it\" while looking at /feather, omit `agent` and the focused tile is used. For ambiguous cases — \"what about Reed's diff?\" — call peek_agent_diff first instead. The agent MUST be idle (force:true bypasses). Modes: 'apply' (default — lands as dirty changes in their checkout, they review + commit), 'stage' (lands staged, ready to commit), 'commit' (creates a branch and commits, main stays untouched — use when the user says 'on a branch' / 'as a PR'), 'dry_run' (no changes; returns the would-apply summary). Fails loud on conflicts — user must resolve manually.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent callsign or agent_id.",
      },
      mode: {
        type: "string",
        description:
          "'apply' (default) lands changes unstaged in the user's checkout — they review + commit. 'stage' pre-stages them. 'commit' creates a branch and commits. 'dry_run' shows what would happen without applying. 'three_way' uses git's built-in 3-way merge — handles most conflicts automatically when the user edited different lines of the same files; falls back to leaving conflict markers (returned in `files_with_markers`) when truly overlapping. 'stash_and_apply' is the heavy-handed recovery mode: stashes the user's own edits, applies the agent's, then re-applies the user's on top.",
        enum: ["apply", "stage", "commit", "dry_run", "stash_and_apply", "three_way"],
      },
      branch: {
        type: "string",
        description: "Branch name for mode='commit'. Default: omo/agent-<timestamp>.",
      },
      commit_message: {
        type: "string",
        description: "Commit message for mode='commit'. Default: 'omo: accept agent work · <iso>'.",
      },
      force: {
        type: "boolean",
        description: "Apply even if the agent is still mid-task. Default false — agent must be idle.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) return { error: "missing agent reference", note: "Ask the user which agent to ship, or have them focus a /feather tile first." };

  const requestedMode = args?.mode ? String(args.mode).toLowerCase() : "apply";
  if (!VALID_MODES.has(requestedMode)) {
    return { error: `unknown mode: ${requestedMode}`, note: `Use one of: ${[...VALID_MODES].join(", ")}.` };
  }

  let result = await hermes.acceptAgentWork(ref, {
    mode: requestedMode,
    branch: args?.branch ? String(args.branch).trim() : null,
    commitMessage: args?.commit_message ? String(args.commit_message) : null,
    force: !!args?.force,
  });

  // Auto-three-way fallback: when the default `apply` hits CONFLICT,
  // silently try the cheap 3-way merge before surfacing the recovery
  // menu. Most conflicts (different lines of the same file) resolve
  // cleanly here, so the user never sees the conflict at all. Only
  // engaged when the caller didn't pick a mode explicitly — if they
  // already asked for three_way and it failed, don't loop.
  let autoRecovered = false;
  if (!result.ok && result.code === "CONFLICT" && requestedMode === "apply") {
    const retry = await hermes.acceptAgentWork(ref, {
      mode: "three_way",
      force: !!args?.force,
    });
    if (retry.ok && !retry.partial) {
      result = retry;
      autoRecovered = true;
    } else if (retry.ok && retry.partial) {
      // three_way left conflict markers — surface that path's existing
      // narrower recovery (ai_resolve | branch). Fall through to the
      // partial-three_way handler below.
      result = retry;
    }
    // If retry itself returned CONFLICT (truly unmergeable), keep the
    // original CONFLICT result so the user sees the full menu.
  }

  if (!result.ok) {
    const code = result.code;
    if (code === "AGENT_BUSY") {
      return {
        error: result.error,
        code,
        note: "Tell the user the agent isn't done yet. Offer to wait, or pass force:true if they really want to ship partial work.",
      };
    }
    if (code === "INTERRUPTED") {
      // Last task was stopped mid-write. Files may be half-written. We
      // require an explicit force:true (the user can pass it after
      // eyeballing the diff). Keep the response narration-friendly.
      const tools = result.suspect_tools || [];
      const paths = result.suspect_paths || [];
      return {
        error: result.error,
        code,
        agent_id: result.agent_id,
        agent_name: result.agent_name,
        suspect_tools: tools,
        suspect_paths: paths,
        interrupted_at: result.interrupted_at,
        note:
          `Tell the user ${result.agent_name || "the agent"}'s last task was interrupted while a ${tools.join("/") || "write"} was in flight, so ` +
          (paths.length
            ? `${paths.length === 1 ? "this file" : "these files"} (${paths.slice(0, 3).join(", ")}) may be half-written. `
            : "the file may be half-written. ") +
          "Offer two options: (1) PREVIEW the diff first (peek_agent_diff or show_pane preview-diff) before accepting, or (2) accept anyway with force:true if the user has already eyeballed it. Do NOT silently retry without asking.",
      };
    }
    if (code === "NO_WORKTREE") {
      return {
        error: result.error,
        code,
        note: "Tell the user that agent has no isolated workspace to ship from (already reaped, or ran with OMO_WORKTREE_MODE=off).",
      };
    }
    if (code === "CONFLICT") {
      const paths = result.conflicting_paths || [];
      // By the time we reach here, the `run()` wrapper has already
      // silently retried `apply` → `three_way`. CONFLICT now means the
      // 3-way also failed — the agent and the user edited the **same
      // lines** of the same file. Only two non-destructive paths
      // remain: have the agent rewrite their changes against the user's
      // current state, or ship on a new branch.
      const recovery_options = [
        {
          id: "ai_resolve",
          label: "have the agent fix it",
          description: "Call `resolve_agent_conflict` — re-dispatches the agent with the conflict context and lets them adapt their changes.",
          retry: { tool: "resolve_agent_conflict", args: { agent: ref, conflicting_paths: paths } },
        },
        {
          id: "branch_instead",
          label: "ship on a new branch",
          description: "Call `accept_agent_work` again with `mode:'commit'` — main/current branch untouched; agent's work lands as a clean commit on a new branch.",
          retry: { tool: "accept_agent_work", args: { agent: ref, mode: "commit" } },
        },
      ];
      return {
        error: result.error,
        code,
        conflicting_paths: paths,
        recovery_options,
        stderr: result.stderr,
        note:
          "Tell the user the agent and they edited the SAME lines of the same file(s)" +
          (paths.length ? ` (${paths.slice(0, 3).join(", ")})` : "") +
          " — git's 3-way merge already tried and couldn't resolve it. " +
          "Offer the TWO options in `recovery_options`. Default to recommending option 1 (ai_resolve). " +
          "Wait for the user to pick — do NOT auto-retry. " +
          "If they'd rather handle it manually, tell them to `git commit -a` or `git stash` their conflicting edits first, then re-invoke accept — the agent's work stays put in the workspace.",
      };
    }
    if (code === "REAPPLY_CONFLICT") {
      return {
        error: result.error,
        code,
        stderr: result.stderr,
        note:
          "Tell the user: agent's changes DID land, but their own stashed edits now collide. Their work is safe in stash@{0} and they need to `git stash pop` and resolve manually. Don't claim full success.",
      };
    }
    if (code === "ROLLBACK_PARTIAL") {
      // stash_and_apply path: agent's diff conflicted with HEAD AND the
      // automatic rollback of the user's stash also failed. Nothing has
      // landed in the user's checkout, but their pre-accept work is now
      // sitting in stash@{0} instead of their working tree.
      return {
        error: result.error,
        code,
        stash_ref: result.stash_ref || "stash@{0}",
        rollback_stderr: result.rollback_stderr,
        stderr: result.stderr,
        note:
          "Tell the user: nothing landed in their checkout, BUT their pre-accept edits got moved into stash@{0} during the attempted rollback and the auto-restore failed. They need to `git stash pop` themselves and resolve any conflicts by hand. Don't claim success.",
      };
    }
    if (code === "STASH_FAILED") {
      return {
        error: result.error,
        code,
        note: "Tell the user the stash step couldn't run — maybe their checkout was already clean (in which case a plain apply should have worked, surface the original error).",
      };
    }
    if (code === "DIFF_TOO_LARGE") {
      return {
        error: result.error,
        code,
        note: "Tell the user the agent's diff is too big to auto-apply — they'll need to merge it manually.",
      };
    }
    if (code === "BASELINE_FAILED") {
      return {
        error: result.error,
        code,
        applied: !!result.applied,
        note:
          result.applied
            ? "Tell the user the changes landed in their checkout, but the agent workspace still could not be marked clean. Suggest previewing status before reusing that agent."
            : "Tell the user the workspace baseline could not be updated; don't claim the ship fully completed.",
      };
    }
    if (code === "NO_AGENT" || code === "AMBIGUOUS") {
      return {
        error: result.error,
        candidates: result.candidates || null,
        note: code === "AMBIGUOUS" ? "Ask WHICH agent." : "Tell the user that agent isn't around.",
      };
    }
    return {
      error: result.error || "accept failed",
      code,
      note: "Quote the error plainly. Don't claim the merge happened.",
    };
  }

  const stat = result.stat || { fileCount: 0, added: 0, removed: 0 };
  const fileSummary = `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"} (+${stat.added} −${stat.removed})`;
  const base = {
    ok: true,
    agent_id: result.agent_id,
    agent_name: result.agent_name,
    mode: result.mode,
    files: result.files,
    stat: result.stat,
    ...(result.skipped_noops?.length ? { skipped_noops: result.skipped_noops } : {}),
    ...(result.three_way ? { three_way: true } : {}),
  };

  // Pure no-op case: every "new file" the agent created already existed
  // identical in main. Nothing landed because nothing had to. Tell the
  // user with confidence — don't pretend a ship happened.
  if (stat.fileCount === 0 && result.skipped_noops?.length) {
    return {
      ...base,
      summary: `nothing to apply — ${result.skipped_noops.length} file(s) already match what's in main`,
      note:
        "Tell the user the agent's changes were already present in main (identical content). " +
        "Nothing was applied because nothing had to be. " +
        "Common after a previous manual copy or a re-run of the same task — totally fine.",
    };
  }

  if (result.mode === "dry_run") {
    return {
      ...base,
      summary: `would apply ${fileSummary}`,
      note: "Tell the user what WOULD land if they confirm. Then offer to ship for real (call accept_agent_work without dry_run).",
    };
  }
  if (result.mode === "three_way" && result.partial) {
    const markerPaths = result.files_with_markers || [];
    const recovery_options = [
      {
        id: "ai_resolve",
        label: "have the agent finish the merge",
        description: "Call `resolve_agent_conflict` — the agent reads the conflict markers and rewrites the affected hunks.",
        retry: { tool: "resolve_agent_conflict", args: { agent: ref, conflicting_paths: markerPaths } },
      },
      {
        id: "user_resolves",
        label: "user resolves the markers by hand",
        description: "Conflict markers are already in the working tree — user edits, removes markers, commits when ready.",
        retry: null,
      },
    ];
    return {
      ...base,
      partial: true,
      files_with_markers: markerPaths,
      recovery_options,
      summary: `3-way merged most of ${fileSummary}; ${markerPaths.length} file(s) still have conflict markers`,
      note:
        "Tell the user 3-way merged most of it cleanly but couldn't resolve every hunk — name the files. " +
        "Then offer the TWO options in `recovery_options`. Wait for the user to pick.",
    };
  }
  if (result.mode === "commit") {
    return {
      ...base,
      branch: result.branch,
      sha: result.sha,
      summary: `committed ${fileSummary} on branch ${result.branch}`,
      note:
        "Confirm in one cute sentence: name the branch and the file count. The user can switch to that branch to see the commit.",
    };
  }
  return {
    ...base,
    auto_recovered: autoRecovered || undefined,
    summary: `applied ${fileSummary}${autoRecovered ? " (auto-merged 3-way)" : ""} ${result.mode === "stage" ? "(staged, ready to commit)" : "(unstaged — review and commit)"}`,
    note:
      autoRecovered
        ? "Confirm in one cute sentence — and MENTION the patch needed a 3-way merge to land cleanly. The user's parallel edits and the agent's edits were on different lines of the same file(s), so git auto-merged them. No action needed from the user, but they should know it wasn't a clean apply."
        : result.mode === "stage"
        ? "Confirm in one cute sentence: changes are staged, user just needs to commit."
        : "Confirm in one cute sentence: changes are in the user's checkout, ready to review.",
  };
}

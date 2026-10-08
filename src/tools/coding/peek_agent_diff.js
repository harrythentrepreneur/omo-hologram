// src/tools/peek_agent_diff.js — preview what an agent changed.
//
// Voice-side counterpart to the squad-monitor "Preview" button. Reads the
// agent's worktree diff (vs the snapshot at task start) and returns a
// structured summary so Momo can describe it aloud, plus a URL pointing
// to the /preview-diff page if the user wants the visual view.

import * as hermes from "../../hermes/index.js";
import { refOrFocused } from "../agents/agent_context.js";

export const definition = {
  type: "function",
  name: "peek_agent_diff",
  description:
    "Read what an agent has changed in their workspace without applying any of it. Use when the user asks what someone did or wants to review before shipping — \"what did Reed change?\", \"show me her diff\", \"看看 Reed 改了啥\", \"preview Wren's work\". If the user says \"preview this/her\" while looking at /feather, omit `agent` and the focused tile is used. Returns a file list with +/− counts and a `preview_url` you can open via show_pane(page='preview-diff', agent=…) for the visual side-by-side. NOT for live activity (the squad UI already shows that) — this is for the final diff after a task. Cheap and idempotent.",
  parameters: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent callsign (e.g. 'Reed') or agent_id. Case-insensitive; prefix match works.",
      },
      verbose: {
        type: "boolean",
        description: "When true, include the unified diff text (up to ~64 KB). Default false — Momo describes by file list only and offers to open the preview.",
      },
    },
    additionalProperties: false,
  },
};

const MAX_INLINE_DIFF = 64 * 1024;

export async function run(args) {
  const ref = refOrFocused(args?.agent);
  if (!ref) return { error: "missing agent reference", note: "Ask the user which agent, or have them focus a /feather tile first." };
  const verbose = !!args?.verbose;

  const result = hermes.peekAgentDiff(ref);
  if (!result.ok) {
    return {
      error: result.error,
      code: result.code,
      candidates: result.candidates || null,
      note:
        result.code === "NO_WORKTREE"
          ? "Tell the user that agent has no preview workspace — they were reaped or running without isolation. Nothing to preview."
          : result.code === "AMBIGUOUS"
            ? "Ask the user WHICH agent — read the candidate names."
            : "Quote the error plainly.",
    };
  }

  if (!result.hasChanges) {
    return {
      ok: true,
      agent_id: result.agent_id,
      agent_name: result.agent_name,
      summary: `${result.agent_name} hasn't changed anything yet.`,
      files: [],
      stat: result.stat,
      preview_url: null,
      note: "Tell the user the workspace is clean — there's nothing to preview.",
    };
  }

  const preview_url = `/preview-diff?agent=${encodeURIComponent(result.agent_id)}`;
  const interrupted = result.interrupted || null;
  const interruptedNote = interrupted && (interrupted.suspect_tools?.length || 0) > 0
    ? ` ⚠️ Last task was INTERRUPTED while a ${interrupted.suspect_tools.join("/")} was in flight` +
      ((interrupted.suspect_paths?.length || 0)
        ? ` (possibly half-written: ${interrupted.suspect_paths.slice(0, 3).join(", ")}). `
        : " — files may be half-written. ") +
      "Open the visual preview before any accept; accept_agent_work will refuse without force:true."
    : "";
  const out = {
    ok: true,
    agent_id: result.agent_id,
    agent_name: result.agent_name,
    is_busy: result.is_busy,
    interrupted,
    files: result.files,
    stat: result.stat,
    summary: `${result.agent_name} changed ${result.stat.fileCount} file(s) (+${result.stat.added} −${result.stat.removed}).`,
    preview_url,
    note:
      "Describe the change at a high level: file count, +/− totals, and the most-touched 1–3 files. " +
      "Then offer to either open the visual preview (call show_pane with page='preview-diff' for that agent), " +
      "ship it (accept_agent_work), or scrap it (discard_agent_work). " +
      (result.is_busy ? "The agent is STILL WORKING — preview is a snapshot mid-task." : "") +
      interruptedNote,
  };

  if (verbose) {
    const diff = hermes.getAgentDiffText(ref);
    if (diff.ok && diff.text) {
      out.diff_text = diff.text.length > MAX_INLINE_DIFF
        ? diff.text.slice(0, MAX_INLINE_DIFF) + "\n…(truncated; use the preview URL for the rest)"
        : diff.text;
    }
  }

  return out;
}

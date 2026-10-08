// src/runtimes/events.js — canonical event shapes.
//
// Every runtime adapter (claude.js, hermes.js, …) translates its native
// output into the events documented here. The coordinator in
// src/hermes/index.js then fans them onto /hermes/ws and bus.emit() — so
// the squad page never needs to know which runtime is doing the typing.
//
// This file is documentation-as-code. The factories below are tiny
// helpers, not validators — keeps allocations cheap on hot paths.
//
// ── Event vocabulary ─────────────────────────────────────────────────
//
// session_init     { session_id, model?, cwd? }                       (once, near top)
// tool_start       { tool, args, summary?, ts }                       (every tool call)
// tool_end         { tool, ok, ts }                                   (paired with tool_start)
// chunk            { text, role: 'assistant'|'tool_result', isStderr? } (free-form prose / output)
// file_change      { path, hunks?, headBefore?, headAfter? }          (post-edit, optional)
// result           { status: 'done'|'error', exitCode?, durationMs?,  (terminal — exactly once)
//                    costUsd?, error?, final? }
//
// `tool` is always lowercased (read, edit, write, bash, grep, glob,
// web_search, web_extract, terminal, …). The squad UI's TOOL_KIND map
// keys on these names; new tools without a mapping render as 'misc'.

export function sessionInit({ sessionId, model = null, cwd = null }) {
  return { kind: 'session_init', sessionId, model, cwd };
}

export function toolStart({ tool, args = '', summary = '', ts = Date.now() }) {
  return { kind: 'tool_start', tool, args, summary, ts };
}

export function toolEnd({ tool, ok = true, ts = Date.now() }) {
  return { kind: 'tool_end', tool, ok, ts };
}

export function chunk({ text, role = 'assistant', isStderr = false, ts = Date.now() }) {
  return { kind: 'chunk', text, role, isStderr, ts };
}

export function fileChange({ path, hunks = null, headBefore = null, headAfter = null, ts = Date.now() }) {
  return { kind: 'file_change', path, hunks, headBefore, headAfter, ts };
}

export function result({ status, exitCode = null, durationMs = null, costUsd = null, error = null, final = null }) {
  return { kind: 'result', status, exitCode, durationMs, costUsd, error, final };
}

// src/tools/_hermes_cli.js — shared CLI helpers for the hermes_* voice tools.
//
// Every hermes_* voice tool (skills / sessions / memory / checkpoints) shells
// out to the local `hermes` binary. This module is the single seam that:
//   • discovers the hermes binary (env override → ~/.local/bin → npm-global → /usr/local → homebrew)
//   • runs it synchronously with a timeout
//   • tries to parse JSON output, falls back to plain text
//
// Tools must never throw — they return { error, code, ... } shapes the voice
// layer can narrate. Same contract as the rest of src/tools/.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BIN_CANDIDATES = [
  process.env.HERMES_BIN,
  join(homedir(), ".local", "bin", "hermes"),
  join(homedir(), ".npm-global", "bin", "hermes"),
  "/usr/local/bin/hermes",
  "/opt/homebrew/bin/hermes",
].filter(Boolean);

export function findHermes() {
  for (const p of BIN_CANDIDATES) {
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {}
  }
  return null;
}

export function runHermes(args, { timeoutMs = 15000, input = null } = {}) {
  const bin = findHermes();
  if (!bin) {
    return {
      error: "hermes not installed",
      code: "NOT_INSTALLED",
      note: "Tell the user Hermes isn't installed on this machine — suggest installing it from hermes.sh or via `pipx install hermes-agent`.",
    };
  }
  const opts = {
    encoding: "utf8",
    timeout: timeoutMs,
    // Hermes CLI sometimes prompts on stdin — feed an empty buffer so it
    // doesn't hang waiting for input. Caller can override with `input`.
    input: input ?? "",
  };
  let r;
  try {
    r = spawnSync(bin, args, opts);
  } catch (err) {
    return { error: String(err?.message || err), code: "SPAWN_FAILED" };
  }
  if (r.error) {
    const code = r.error.code === "ETIMEDOUT" ? "TIMEOUT" : (r.error.code || "SPAWN_FAILED");
    return { error: String(r.error.message || r.error), code };
  }
  return {
    exitCode: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}

export function tryJson(text) {
  if (!text || typeof text !== "string") return null;
  try { return JSON.parse(text); } catch {}
  // Sometimes hermes prints a banner line before the JSON payload.
  const start = text.indexOf("{");
  const startArr = text.indexOf("[");
  const idx =
    start === -1 ? startArr :
    startArr === -1 ? start :
    Math.min(start, startArr);
  if (idx > 0) {
    try { return JSON.parse(text.slice(idx)); } catch {}
  }
  return null;
}

// Convenience: strip ANSI colour codes from CLI output so voice narration
// doesn't echo escape sequences if the model decides to read raw text.
export function stripAnsi(text) {
  if (!text) return text;
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

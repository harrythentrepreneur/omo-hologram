// src/runtimes/hermes.js — Hermes runtime adapter.
//
// Wraps the existing local `hermes` CLI. The historical parsing logic
// (regex-scanning the decorated stdout for tool calls) lives here now;
// the coordinator in src/hermes/index.js no longer cares about hermes'
// output format — it only consumes the canonical events from ./events.js.
//
// Hard rules (CLAUDE.md):
//   • never throw at module load
//   • detect() is sync + cheap
//   • spawn() returns immediately with a handle

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as events from "./events.js";

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), ".hermes");
const BIN_CANDIDATES = [
  process.env.HERMES_BIN,
  join(homedir(), ".local", "bin", "hermes"),
  join(homedir(), ".npm-global", "bin", "hermes"),
  "/usr/local/bin/hermes",
  "/opt/homebrew/bin/hermes",
].filter(Boolean);

// Hermes prints tool activity as decorated lines like:
//   "  ┊ 🔍 recall    \"some query\"  0.0s"
// One regex pulls out the tool name + args, dropping trailing duration.
const TOOL_LINE_RE =
  /^\s*┊\s+\S+\s+([a-z_][a-z0-9_]{1,30})\s+(.+?)(?:\s+\d+(?:\.\d+)?s)?(?:\s+\[[a-z]+\])?\s*$/i;
const TOOL_LINE_ERR_RE = /\s+\[(?:error|fail|failed)\]\s*$/i;

// Pull a hermes-issued session id from stdout — the format depends on
// the hermes version, so we cast a wide net. The coordinator falls back
// to identity-level continuity if this never matches.
const SESSION_ID_RE = /session(?:\s*[:=]\s*|\s+id\s*[:=]\s*|\s+)([A-Za-z0-9_-]{6,})/i;

let cache = {
  installed: false,
  bin: null,
  version: null,
  modelHint: null,
  providerHint: null,
  hermesHome: HERMES_HOME,
  warmedAt: 0,
};

export function detect() {
  const bin = BIN_CANDIDATES.find((p) => p && existsSync(p) && isExecutable(p));
  if (!bin) {
    cache = { installed: false, bin: null, version: null, modelHint: null, providerHint: null, hermesHome: HERMES_HOME, warmedAt: Date.now() };
    return cache;
  }
  let version = null;
  try { version = readVersionShim(); } catch {}
  let modelHint = null;
  let providerHint = null;
  try {
    const cfgPath = join(HERMES_HOME, "config.yaml");
    if (existsSync(cfgPath)) {
      const text = readFileSync(cfgPath, "utf8");
      const modelBlock = text.match(/^model\s*:\s*\n((?:[ \t]+.*\n?)+)/m);
      if (modelBlock) {
        const block = modelBlock[1];
        const d = block.match(/^[ \t]+default\s*:\s*([^\s#]+)/m);
        const p = block.match(/^[ \t]+provider\s*:\s*([^\s#]+)/m);
        if (d) modelHint = d[1].replace(/["']/g, "").trim();
        if (p) providerHint = p[1].replace(/["']/g, "").trim();
      }
      if (!modelHint) {
        const m = text.match(/^\s*default_model\s*:\s*([^\s#]+)/m);
        if (m) modelHint = m[1].replace(/["']/g, "").trim();
      }
      if (!providerHint) {
        const m = text.match(/^\s*default_provider\s*:\s*([^\s#]+)/m);
        if (m) providerHint = m[1].replace(/["']/g, "").trim();
      }
    }
    if (!modelHint || !providerHint) {
      const envPath = join(HERMES_HOME, ".env");
      if (existsSync(envPath)) {
        const text = readFileSync(envPath, "utf8");
        if (!modelHint) {
          const m = text.match(/^\s*HERMES_MODEL\s*=\s*(.+)$/m);
          if (m) modelHint = m[1].trim().replace(/["']/g, "");
        }
        if (!providerHint) {
          const m = text.match(/^\s*HERMES_PROVIDER\s*=\s*(.+)$/m);
          if (m) providerHint = m[1].trim().replace(/["']/g, "");
        }
      }
    }
  } catch {}
  cache = { installed: true, bin, version, modelHint, providerHint, hermesHome: HERMES_HOME, warmedAt: Date.now() };
  return cache;
}

export function status() {
  if (!cache.warmedAt) detect();
  return { ...cache };
}

function isExecutable(p) {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

function readVersionShim() {
  try {
    const distDir = join(HERMES_HOME, "hermes-agent");
    if (existsSync(distDir)) {
      const versionFile = join(distDir, "version.py");
      if (existsSync(versionFile)) {
        const text = readFileSync(versionFile, "utf8");
        const m = text.match(/__version__\s*=\s*["']([^"']+)["']/);
        if (m) return m[1];
      }
    }
  } catch {}
  return null;
}

// Spawn a hermes child. Same interface as claude.js::spawn so the
// coordinator can wire either one identically. Per-call dials forwarded
// to the CLI: model/provider/toolsets/skills/max_turns/checkpoints are
// hermes-specific; claude-specific opts (addDirs/mcpConfig/settingsPath/
// effort/permissionMode) are accepted and ignored so the coordinator can
// pass a single shared opts object to either adapter.
export function spawn_({
  prompt,
  sessionId = null,
  cwd = null,
  // Hermes-specific dials
  model = null,
  provider = null,
  toolsets = null,
  skills = null,
  maxTurns = null,
  checkpoints = null,
  // Accepted-but-ignored (claude-only)
  effort = null,            // eslint-disable-line no-unused-vars
  permissionMode = null,    // eslint-disable-line no-unused-vars
  addDirs = null,           // eslint-disable-line no-unused-vars
  mcpConfig = null,         // eslint-disable-line no-unused-vars
  settingsPath = null,      // eslint-disable-line no-unused-vars
  onEvent, onError, onClose,
} = {}) {
  if (!cache.warmedAt) detect();
  if (!cache.installed) {
    const err = new Error("hermes is not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const trimmed = String(prompt || "").trim();
  if (!trimmed) {
    const err = new Error("missing prompt");
    err.code = "MISSING_PROMPT";
    throw err;
  }

  const args = ["chat", "-q", trimmed, "--yolo", "--source", "tool"];
  if (sessionId) args.push("--resume", sessionId);
  if (model)    args.push("-m", String(model));
  if (provider) args.push("--provider", String(provider));
  if (Array.isArray(toolsets) && toolsets.length) args.push("-t", toolsets.join(","));
  if (Array.isArray(skills)   && skills.length)   args.push("-s", skills.join(","));
  if (maxTurns)               args.push("--max-turns", String(maxTurns));
  if (checkpoints)            args.push("--checkpoints");
  const env = { ...process.env, NO_COLOR: process.env.NO_COLOR || "1" };

  let child;
  try {
    child = spawn(cache.bin, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = new Error(`failed to spawn hermes: ${err?.message || err}`);
    e.code = "SPAWN_FAILED";
    throw e;
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let finalOut = "";
  let capturedSessionId = sessionId || null;
  let resultEmitted = false;
  let exitCode = null;
  const startedAt = Date.now();

  function safeEmit(evt) {
    try { onEvent?.(evt); } catch (err) { onError?.(err); }
  }

  // Tools whose first arg is the file they just wrote. When we see one
  // succeed, emit a file_change event so the coordinator can diff.
  const FILE_TOUCHING_TOOLS = new Set(["write", "write_file", "edit", "edit_file", "patch", "multiedit"]);

  function detectToolLine(line) {
    const m = line.match(TOOL_LINE_RE);
    if (!m) return;
    const raw = m[1].toLowerCase();
    if (raw.length < 2) return;
    const args = (m[2] || "").replace(/[)\s]+$/, "").trim();
    const ok = !TOOL_LINE_ERR_RE.test(line);
    const ts = Date.now();
    safeEmit(events.toolStart({
      tool: raw,
      args: args.slice(0, 400),
      summary: line.trim().slice(0, 200),
      ts,
    }));
    safeEmit(events.toolEnd({ tool: raw, ok, ts: ts + 1 }));
    // Hermes prints tool calls inline (tool_start + result on one line),
    // so success is already known by the time we see this. If it looks
    // like a file write and we can pull a path out of the args, signal
    // the coordinator. Heuristic: pluck the first token that resembles a
    // path (contains a slash OR ends in a familiar extension).
    if (ok && FILE_TOUCHING_TOOLS.has(raw)) {
      const filePath = extractFilePath(args);
      if (filePath) safeEmit(events.fileChange({ path: filePath }));
    }
  }

  function extractFilePath(args) {
    if (!args) return null;
    // Trim surrounding quotes that hermes often prints.
    const stripped = args.replace(/^["']|["']$/g, "");
    // Take the first whitespace-separated token (most write-style tools
    // print "path/to/file maybe with extra context").
    const first = stripped.split(/\s+/)[0] || "";
    if (!first) return null;
    if (first.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(first)) return first;
    return null;
  }

  child.stdout.on("data", (buf) => {
    const text = buf.toString("utf8");
    stdoutBuf += text;
    finalOut += text;

    // Best-effort session capture for resume continuity.
    if (!capturedSessionId) {
      const m = text.match(SESSION_ID_RE);
      if (m && m[1]) {
        capturedSessionId = m[1];
        safeEmit(events.sessionInit({ sessionId: capturedSessionId }));
      }
    }

    safeEmit(events.chunk({ text, role: "assistant" }));

    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      detectToolLine(line);
    }
  });

  child.stderr.on("data", (buf) => {
    const text = buf.toString("utf8");
    stderrBuf += text;
    if (text) safeEmit(events.chunk({ text, role: "assistant", isStderr: true }));
  });

  child.on("error", (err) => {
    onError?.(err);
  });

  child.on("close", (code) => {
    exitCode = code;
    if (!resultEmitted) {
      resultEmitted = true;
      const ok = code === 0;
      safeEmit(events.result({
        status: ok ? "done" : "error",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        error: ok ? null : (stderrBuf.trim().slice(-4000) || finalOut.trim().slice(-4000) || `hermes exited ${code}`),
        final: finalOut.trim().slice(-8000),
      }));
    }
    onClose?.(code);
  });

  return {
    child,
    kill(signal = "SIGTERM") {
      try { child.kill(signal); } catch {}
    },
  };
}

export { spawn_ as spawn };

// Read shared memory / skills — used by hermes-specific HTTP routes. Kept
// here so the coordinator stays runtime-agnostic.

const MEMORY_CAP = 200 * 1024;
const SKILL_BODY_CAP = 100 * 1024;
const SKILL_DESC_CAP = 200;

export function readMemoryShared() {
  const memPath = pickFirstExisting([
    join(HERMES_HOME, "MEMORY.md"),
    join(HERMES_HOME, "memories", "MEMORY.md"),
  ]);
  const userPath = pickFirstExisting([
    join(HERMES_HOME, "USER.md"),
    join(HERMES_HOME, "memories", "USER.md"),
  ]);
  const readCapped = (p) => {
    if (!p || !existsSync(p)) return { content: null, mtime: 0 };
    try {
      const st = statSync(p);
      const buf = readFileSync(p);
      const slice = buf.length > MEMORY_CAP ? buf.subarray(0, MEMORY_CAP) : buf;
      return {
        content: slice.toString("utf8"),
        mtime: st.mtimeMs,
        truncated: buf.length > MEMORY_CAP,
        bytes: buf.length,
      };
    } catch { return { content: null, mtime: 0 }; }
  };
  const mem = readCapped(memPath);
  const usr = readCapped(userPath);
  return {
    memory: mem.content,
    user: usr.content,
    memoryMtime: mem.mtime,
    userMtime: usr.mtime,
    memoryPath: memPath,
    userPath: userPath,
  };
}

function pickFirstExisting(paths) {
  return paths.find((p) => p && existsSync(p)) || null;
}

export function listSkillsShared() {
  return listSkillsFromRoot(join(HERMES_HOME, "skills"));
}

function listSkillsFromRoot(root) {
  if (!root || !existsSync(root)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(root, entry.name);
    const flatSkill = join(dirPath, "SKILL.md");
    if (existsSync(flatSkill)) {
      out.push(makeSkillEntry(entry.name, dirPath, flatSkill));
      continue;
    }
    let subs;
    try { subs = readdirSync(dirPath, { withFileTypes: true }); }
    catch { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const subSkill = join(dirPath, sub.name, "SKILL.md");
      if (existsSync(subSkill)) {
        out.push(makeSkillEntry(`${entry.name}/${sub.name}`, join(dirPath, sub.name), subSkill));
      }
    }
  }
  return out;
}

function makeSkillEntry(name, path, skillFile) {
  let description = "";
  try { description = extractDescription(readFileSync(skillFile, "utf8")); } catch {}
  return { name, path, description };
}

function extractDescription(text) {
  const fm = text.match(/^---\s*\n([\s\S]+?)\n---/);
  if (fm) {
    const desc = fm[1].match(/^\s*description\s*:\s*(.+)$/m);
    if (desc) return desc[1].replace(/^["']|["']$/g, "").trim().slice(0, SKILL_DESC_CAP);
  }
  const body = fm ? text.slice(fm[0].length) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    return line.slice(0, SKILL_DESC_CAP);
  }
  return "";
}

export function readSkill(name) {
  if (!name || /\.\./.test(name)) return null;
  const root = join(HERMES_HOME, "skills");
  const flat = join(root, name, "SKILL.md");
  if (!existsSync(flat)) return null;
  try {
    const buf = readFileSync(flat);
    const slice = buf.length > SKILL_BODY_CAP ? buf.subarray(0, SKILL_BODY_CAP) : buf;
    return {
      name,
      path: join(root, name),
      body: slice.toString("utf8"),
      truncated: buf.length > SKILL_BODY_CAP,
      bytes: buf.length,
    };
  } catch { return null; }
}

export function listSessions() {
  return new Promise((resolve) => {
    if (!cache.installed) return resolve([]);
    let stdout = "";
    let done = false;
    const child = spawn(cache.bin, ["sessions", "list", "--limit", "30"], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve([]);
    }, 8000);
    timer.unref?.();
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.on("error", () => {
      if (done) return; done = true; clearTimeout(timer); resolve([]);
    });
    child.on("close", (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code !== 0) return resolve([]);
      const sessions = [];
      let inBody = false;
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) continue;
        if (/^[─-]+$/.test(line.trim())) { inBody = true; continue; }
        if (!inBody) continue;
        const idMatch = line.match(/(\S+)\s*$/);
        if (!idMatch) continue;
        const id = idMatch[1];
        const titleMatch = line.match(/^(.{1,32}?)\s{2,}/);
        const title = titleMatch ? titleMatch[1].trim() : "";
        sessions.push({ id, title, started: null, messageCount: null });
        if (sessions.length >= 30) break;
      }
      resolve(sessions);
    });
  });
}

// src/agents/identity.js — persistent agent identity store.
//
// Replaces the old fixed atlas/cinder/prism/quill registry. Agents are now
// ephemeral: they spawn when work arrives, linger for a few minutes after
// they finish, then leave. But their *identity* (id, name, colour, sigil,
// optional hermes session binding) is durable — re-dispatching with the
// same name or session_id revives the same agent with the same look.
//
// State lives in memory + ~/.omo/agents.json so identities survive a
// server restart. Hermes session continuation is supported by remembering
// the last hermes session_id we observed for each agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const STORE_DIR = join(homedir(), ".omo");
const STORE_PATH = join(STORE_DIR, "agents.json");

// Cute, evocative single-word callsigns — picked round-robin so new agents
// feel like distinct characters rather than serial numbers. Once the pool
// rolls over, names repeat (with a numeric suffix avoided — collisions are
// fine because the underlying id is unique).
const NAME_POOL = [
  "Nimbus", "Ember", "Wisp", "Vega", "Clove", "Onyx", "Mira", "Sora",
  "Reed", "Lark", "Wren", "Echo", "Sage", "Indigo", "Quartz", "Marlow",
  "Kestrel", "Linden", "Juno", "Hollis", "Briar", "Pippin", "Tilly",
  "Cove", "Fern", "Hazel", "Tinsel", "Bramble", "Pax", "Sable",
];

// Reflector-friendly palette. Pulled from the existing /squad CSS so
// dynamic agents drop in without clashing with the warm-cream room.
const COLOR_POOL = [
  "#6FA8B0", // periwinkle
  "#B85040", // coral
  "#B97942", // tan / amber
  "#3E7B5A", // mint
  "#C9A24F", // gold
  "#C66F8E", // rose
  "#7A6FB9", // violet
  "#6FB0A8", // cyan
];

// ─── State ─────────────────────────────────────────────────────────────

// agent_id → identity record
const agentsById = new Map();
// lowercased name → agent_id (most recent assignment wins)
const idByName = new Map();
// session_id → agent_id  (covers both hermes + claude sessions; keys
// are opaque uuids so collision risk is negligible)
const idBySession = new Map();

let nameCursor = 0;
let colorCursor = 0;
let dirty = false;
let flushTimer = null;
let loaded = false;

// ─── Load / save ───────────────────────────────────────────────────────

function ensureStoreDir() {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  } catch {}
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(STORE_PATH)) return;
    const raw = readFileSync(STORE_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data?.agents && typeof data.agents === "object") {
      for (const [id, rec] of Object.entries(data.agents)) {
        if (!id || !rec || typeof rec !== "object") continue;
        const normalised = {
          id,
          name: String(rec.name || "Agent"),
          color: String(rec.color || COLOR_POOL[0]),
          sigil: String(rec.sigil || rec.name?.[0] || "?").slice(0, 1).toUpperCase(),
          role: rec.role || null,
          createdAt: Number(rec.createdAt) || Date.now(),
          lastSeenAt: Number(rec.lastSeenAt) || Date.now(),
          hermesSessionId: rec.hermesSessionId || null,
          claudeSessionId: rec.claudeSessionId || null,
          // Most-recent runtime used for this identity. Helps the
          // coordinator pick a sensible default on revival when the
          // caller doesn't specify one.
          lastRuntime: rec.lastRuntime || null,
        };
        agentsById.set(id, normalised);
        idByName.set(normalised.name.toLowerCase(), id);
        if (normalised.hermesSessionId) idBySession.set(normalised.hermesSessionId, id);
        if (normalised.claudeSessionId) idBySession.set(normalised.claudeSessionId, id);
      }
    }
    if (Number.isInteger(data?.nameCursor)) nameCursor = data.nameCursor;
    if (Number.isInteger(data?.colorCursor)) colorCursor = data.colorCursor;
  } catch (err) {
    console.warn("[identity] load failed:", err?.message || err);
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      ensureStoreDir();
      const data = {
        version: 1,
        nameCursor,
        colorCursor,
        agents: Object.fromEntries(agentsById),
      };
      writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn("[identity] save failed:", err?.message || err);
    }
  }, 250);
  flushTimer.unref?.();
}

// ─── Helpers ───────────────────────────────────────────────────────────

function makeId() {
  return `agt_${randomUUID().replace(/-/g, "").slice(0, 9)}`;
}

function nextName() {
  // Walk the pool linearly; skip names already in use by a CURRENT identity
  // (so a repeat only happens once the pool is exhausted).
  for (let i = 0; i < NAME_POOL.length; i++) {
    const candidate = NAME_POOL[(nameCursor + i) % NAME_POOL.length];
    if (!idByName.has(candidate.toLowerCase())) {
      nameCursor = (nameCursor + i + 1) % NAME_POOL.length;
      return candidate;
    }
  }
  // Pool exhausted — append a short suffix so we don't clobber the existing
  // mapping. (The mapping is "most recent wins", but a unique label is nicer
  // to look at than a duplicate.)
  const base = NAME_POOL[nameCursor % NAME_POOL.length];
  nameCursor = (nameCursor + 1) % NAME_POOL.length;
  return `${base}-${Math.floor(Math.random() * 99) + 2}`;
}

function nextColor() {
  const c = COLOR_POOL[colorCursor % COLOR_POOL.length];
  colorCursor = (colorCursor + 1) % COLOR_POOL.length;
  return c;
}

function sigilFor(name) {
  return String(name || "?").trim().charAt(0).toUpperCase() || "?";
}

function publicView(rec) {
  if (!rec) return null;
  return { ...rec };
}

// ─── Public API ────────────────────────────────────────────────────────

export function init() {
  load();
}

export function findById(id) {
  load();
  return publicView(agentsById.get(id));
}

export function findByName(name) {
  load();
  if (!name) return null;
  const id = idByName.get(String(name).toLowerCase());
  return id ? publicView(agentsById.get(id)) : null;
}

export function findBySessionId(sessionId) {
  load();
  if (!sessionId) return null;
  const id = idBySession.get(String(sessionId));
  return id ? publicView(agentsById.get(id)) : null;
}

// Resolve an existing identity, or mint a new one. The "resolve" path is
// tried in priority order: explicit id → session id → name. If nothing
// matches, a new agent is created.
//
// `hint` accepts { id?, sessionId?, name?, role?, runtime? }. The
// runtime hint tells us which session bucket (hermes / claude) a freshly
// captured session id should land in. When minting, `name` takes
// precedence over the auto-pool.
export function resolveOrMint(hint = {}) {
  load();
  const { id, sessionId, name, role, runtime } = hint || {};

  if (id && agentsById.has(id)) {
    const rec = agentsById.get(id);
    rec.lastSeenAt = Date.now();
    if (role && !rec.role) rec.role = role;
    if (runtime) rec.lastRuntime = runtime;
    scheduleFlush();
    return publicView(rec);
  }

  if (sessionId) {
    const matchedId = idBySession.get(String(sessionId));
    if (matchedId && agentsById.has(matchedId)) {
      const rec = agentsById.get(matchedId);
      rec.lastSeenAt = Date.now();
      if (role && !rec.role) rec.role = role;
      if (runtime) rec.lastRuntime = runtime;
      scheduleFlush();
      return publicView(rec);
    }
  }

  if (name) {
    const key = String(name).toLowerCase();
    const matchedId = idByName.get(key);
    if (matchedId && agentsById.has(matchedId)) {
      const rec = agentsById.get(matchedId);
      rec.lastSeenAt = Date.now();
      if (role && !rec.role) rec.role = role;
      if (runtime) rec.lastRuntime = runtime;
      if (sessionId) bindSession(rec, String(sessionId), runtime);
      scheduleFlush();
      return publicView(rec);
    }
  }

  // Mint a new identity.
  const finalName = name ? String(name).slice(0, 32) : nextName();
  const rec = {
    id: makeId(),
    name: finalName,
    color: nextColor(),
    sigil: sigilFor(finalName),
    role: role || null,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    hermesSessionId: null,
    claudeSessionId: null,
    lastRuntime: runtime || null,
  };
  agentsById.set(rec.id, rec);
  idByName.set(rec.name.toLowerCase(), rec.id);
  if (sessionId) bindSession(rec, String(sessionId), runtime);
  scheduleFlush();
  return publicView(rec);
}

// Internal: bind a session id to an identity record, in the right bucket.
// Defaults to hermes for back-compat when runtime is unspecified.
function bindSession(rec, sessionId, runtime) {
  const bucket = runtime === "claude" ? "claudeSessionId" : "hermesSessionId";
  if (rec[bucket] === sessionId) return;
  if (rec[bucket]) idBySession.delete(rec[bucket]);
  rec[bucket] = sessionId;
  idBySession.set(sessionId, rec.id);
}

// Record that we just saw activity from this agent. Optionally bind a
// freshly-captured session id to the matching runtime bucket. Either
// hermesSessionId, claudeSessionId, or the generic { sessionId, runtime }
// pair may be passed — whichever shape the caller has handy.
export function touch(id, { hermesSessionId, claudeSessionId, sessionId, runtime, lastRuntime } = {}) {
  load();
  const rec = agentsById.get(id);
  if (!rec) return null;
  rec.lastSeenAt = Date.now();
  if (hermesSessionId) bindSession(rec, String(hermesSessionId), "hermes");
  if (claudeSessionId) bindSession(rec, String(claudeSessionId), "claude");
  if (sessionId && runtime) bindSession(rec, String(sessionId), runtime);
  if (lastRuntime || runtime) rec.lastRuntime = lastRuntime || runtime;
  scheduleFlush();
  return publicView(rec);
}

// Drop an agent from the durable store (e.g. user asked to forget).
// Active runtime cleanup is the caller's responsibility.
export function forget(id) {
  load();
  const rec = agentsById.get(id);
  if (!rec) return false;
  agentsById.delete(id);
  if (rec.name) idByName.delete(rec.name.toLowerCase());
  if (rec.hermesSessionId) idBySession.delete(rec.hermesSessionId);
  if (rec.claudeSessionId) idBySession.delete(rec.claudeSessionId);
  scheduleFlush();
  return true;
}

export function list() {
  load();
  return [...agentsById.values()].map(publicView);
}

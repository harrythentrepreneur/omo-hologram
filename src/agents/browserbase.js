// src/agents/browserbase.js — thin wrapper around @browserbasehq/sdk.
//
// The user's .env uses BROWSER_API_KEY / BROWSER_PROJECT_ID (not the
// canonical BROWSERBASE_* names), so this module reads both and picks
// whichever is present. Everything downstream treats a Browserbase
// session as { id, connectUrl, debugUrl } — that's all we need to:
//   1. drive the browser via Playwright over CDP (connectUrl)
//   2. show it live inside an iframe on /agents-grid (debugUrl)

import { Browserbase } from "@browserbasehq/sdk";

const API_KEY = process.env.BROWSER_API_KEY || process.env.BROWSERBASE_API_KEY || "";
const PROJECT_ID = process.env.BROWSER_PROJECT_ID || process.env.BROWSERBASE_PROJECT_ID || "";

let client = null;

function getClient() {
  if (!API_KEY) throw new Error("BROWSER_API_KEY (or BROWSERBASE_API_KEY) is not set");
  if (!client) client = new Browserbase({ apiKey: API_KEY });
  return client;
}

export function isConfigured() {
  return Boolean(API_KEY && PROJECT_ID);
}

export function missingConfigReason() {
  if (!API_KEY) return "BROWSER_API_KEY not set in .env";
  if (!PROJECT_ID) return "BROWSER_PROJECT_ID not set in .env";
  return null;
}

// Exposed for Stagehand, which takes apiKey + projectId directly on its
// constructor and manages session creation internally.
export function apiKey() { return API_KEY; }
export function projectId() { return PROJECT_ID; }

// Default region resolution. Per Browserbase's regions doc the four valid
// values are us-west-2 (Oregon, default), us-east-1 (Virginia),
// eu-central-1 (Frankfurt), ap-southeast-1 (Singapore). Picking the
// region closest to wherever omo runs cuts CDP round-trip latency, which
// translates directly into faster step execution for Stagehand. Override
// via env without code changes.
const DEFAULT_REGION = process.env.BROWSERBASE_REGION || "us-west-2";

// Default session timeout. Browserbase accepts 60–21600 (max 6 hours);
// our agent loop has its own 5-min total timeout in browser_runner.js,
// so 900s (15 min) gives a comfortable buffer with headroom for captcha
// solves. Override per-environment via env.
const DEFAULT_TIMEOUT_SEC = Number(process.env.BROWSERBASE_SESSION_TIMEOUT_SEC || 900);

// userMetadata is a 512-char JSON object Browserbase stores on the session
// and exposes via the List Sessions endpoint. Tagging every session with
// the omo task id + label means the dashboard at browserbase.com/sessions
// shows context-rich rows ("btsk_abc · go_to_example") instead of an
// opaque UUID — and the JSONL persistence we wrote earlier can correlate
// to the live dashboard via the same id.
//
// IMPORTANT: Browserbase validates metadata values and rejects strings
// with whitespace or non-alphanumeric chars (verified by a 400 "Value is
// not a valid metadata value" response). The safe alphabet is roughly
// [A-Za-z0-9_-]. We sanitize keys+values aggressively so /tool never
// blows up because someone dispatched "go to example.com" (per the
// "tool calls have #1 priority — never break them" rule).
const META_VALUE_RE = /[^A-Za-z0-9._-]+/g;

function sanitizeMetaValue(v) {
  if (v == null) return "";
  return String(v).replace(META_VALUE_RE, "_").replace(/^_+|_+$/g, "").slice(0, 100);
}
function sanitizeMetaKey(k) {
  return String(k).replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 40);
}

function buildUserMetadata(metadata = {}) {
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v == null) continue;
    const sk = sanitizeMetaKey(k);
    const sv = sanitizeMetaValue(v);
    if (sk && sv) out[sk] = sv;
  }
  // Always stamp the omo origin so we can filter "sessions started by omo"
  // in the dashboard later.
  out.app = "omo";
  // Hard-cap the serialised size at the Browserbase 512-char limit. If
  // the caller stuffed too much, we drop the lowest-priority keys until
  // it fits — never throw, never block the /tool dispatch.
  let json = JSON.stringify(out);
  const PRIO = ["taskId", "label", "agent", "origin", "app"];
  while (json.length > 512) {
    const k = Object.keys(out).find((x) => !PRIO.includes(x));
    if (!k) break;
    delete out[k];
    json = JSON.stringify(out);
  }
  return out;
}

// Returns the exact browserbaseSessionCreateParams object Stagehand will
// pass through to the Browserbase SDK when it spins up the session. Keeps
// the stealth/captcha/proxies config living in one place.
//
// The `withProxies` override exists so browser_runner.js can retry without
// proxies if the initial Stagehand.init() fails with a plan-gate error
// (e.g. account not on Developer plan).
export function sessionCreateParams({
  viewport = { width: 1280, height: 720 },
  region = DEFAULT_REGION,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
  withProxies = true,
  metadata = null,
} = {}) {
  const params = {
    projectId: PROJECT_ID,
    region,
    timeout: timeoutSec,
    browserSettings: {
      viewport,
      blockAds: true,
      solveCaptchas: SOLVE_CAPTCHAS,
    },
  };
  // advancedStealth is Enterprise-only on this account (verified via a
  // prior 403 response). Keep it off by default unless the env explicitly
  // asks for it — Stagehand doesn't retry automatically like our custom
  // fallback did, so passing a gated flag would hard-fail session init.
  if (ADV_STEALTH && process.env.BROWSERBASE_ADVANCED_STEALTH === "1") {
    params.browserSettings.advancedStealth = true;
  }
  if (withProxies) {
    const cfg = buildProxiesConfig();
    if (cfg !== null) params.proxies = cfg;
  }
  if (metadata) {
    params.userMetadata = buildUserMetadata(metadata);
  }
  return params;
}

// Regex used by the runner's init fallback to decide whether an error is
// a proxies-plan-gate vs. something unrelated (auth, network, etc.).
export function isProxiesPlanError(err) {
  const msg = (err?.message || err?.error || String(err || "")).toLowerCase();
  return /prox(y|ies).*(plan|developer|upgrade|unavailable|not available)|developer plan/i.test(msg);
}

// Concurrency rate-limit detection. Browserbase enforces both a max
// concurrent-session count AND a creation rate (e.g. Developer plan: 25
// concurrent / 25 per 60s window). Hitting either returns HTTP 429 with
// `x-ratelimit-*` and `retry-after` headers per their concurrency docs.
// We surface this distinctly so the runner can produce a friendlier
// "you're at the concurrency limit" error instead of a raw stack trace.
export function isRateLimitError(err) {
  if (err?.status === 429 || err?.statusCode === 429) return true;
  const msg = (err?.message || err?.error || String(err || "")).toLowerCase();
  return /\b429\b|too many requests|rate ?limit|concurrent session|max(imum)? concurrent/i.test(msg);
}

// Pull retry-after / x-ratelimit-reset hints out of an error object so we
// can give the user a useful "wait N seconds" hint. Returns seconds, or
// null if the error didn't carry the header.
export function rateLimitRetryAfterSec(err) {
  const headers = err?.headers || err?.response?.headers || {};
  const v = headers["retry-after"] ?? headers["x-ratelimit-reset"];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Anti-bot toggles — per Browserbase docs (https://docs.browserbase.com):
//   · solveCaptchas is ENABLED BY DEFAULT (reCAPTCHA, hCaptcha, Turnstile,
//     etc.). Solving takes 5–30s; the iframe pages will freeze during that
//     window, which is why the runner has captcha-aware waits.
//   · advancedStealth masks bot fingerprints and matters for Reddit,
//     Cloudflare-fronted sites, and anything using bot.detect.
//   · proxies: true routes through Browserbase-managed residential IPs.
//     Gated to Developer plan+; billed by data transferred (1 MB session
//     minimum). Huge success-rate lift on Reddit/Instagram/Twitter but
//     costs real money, so it's opt-in via env. Pairing with captcha
//     solving is what Browserbase recommends for blocked sites.
const ADV_STEALTH = process.env.BROWSERBASE_ADVANCED_STEALTH !== "0";
const SOLVE_CAPTCHAS = process.env.BROWSERBASE_SOLVE_CAPTCHAS !== "0";

// ─── Proxy mode resolution ──────────────────────────────────────────────
// Three modes the Browserbase API supports (per their /features/proxies
// docs):
//
//   builtin   — `proxies: true`  → managed rotating residential pool.
//   geo       — `[{ type:"browserbase", geolocation:{country,state?,city?} }]`
//   external  — `[{ type:"external", server, username?, password?,
//                   domainPattern? }]`  → bring-your-own (e.g. a tunneled
//               hotspot, or any 3rd-party residential/mobile provider).
//
// Resolution rules — in priority order, so `.env` setups stay drop-in:
//
//   1. BROWSERBASE_PROXIES=external  → external (requires _SERVER set)
//   2. BROWSERBASE_PROXIES=geo       → geo      (requires _COUNTRY set)
//   3. BROWSERBASE_PROXIES=1|on|true → builtin
//   4. BROWSERBASE_PROXY_SERVER set  → external (auto-detect)
//   5. BROWSERBASE_PROXY_COUNTRY set → geo      (auto-detect)
//   6. BROWSERBASE_PROXIES=0         → off
//   7. otherwise                     → builtin (default — same behaviour
//                                      we had before this refactor)
//
// Auto-detect is what makes the hotspot-tunnel case "just set 3 envs and
// go" — drop BROWSERBASE_PROXY_SERVER/USERNAME/PASSWORD into .env and
// the wrapper picks external mode automatically.
function resolveProxyMode() {
  const flag = String(process.env.BROWSERBASE_PROXIES || "").trim().toLowerCase();
  const hasExternal = !!(process.env.BROWSERBASE_PROXY_SERVER || "").trim();
  const hasGeo = !!(process.env.BROWSERBASE_PROXY_COUNTRY || "").trim();
  if (flag === "external") return "external";
  if (flag === "geo") return "geo";
  if (flag === "1" || flag === "on" || flag === "true") return "builtin";
  if (flag === "0" || flag === "off" || flag === "false") return "off";
  if (hasExternal) return "external";
  if (hasGeo) return "geo";
  return "builtin";
}

// Build the actual `proxies` field. Returns `true` for builtin, an array
// for geo/external, or `null` if proxies are off / misconfigured. We
// degrade to `null` (not throw) on bad config so the runner stays alive.
export function buildProxiesConfig() {
  const mode = resolveProxyMode();
  if (mode === "off") return null;
  if (mode === "builtin") return true;
  if (mode === "geo") {
    const country = String(process.env.BROWSERBASE_PROXY_COUNTRY || "").trim().toUpperCase();
    if (!country) {
      console.warn("[browserbase] geo proxy mode selected but BROWSERBASE_PROXY_COUNTRY is empty — falling back to builtin rotation");
      return true;
    }
    const geolocation = { country };
    const state = String(process.env.BROWSERBASE_PROXY_STATE || "").trim().toUpperCase();
    const city = String(process.env.BROWSERBASE_PROXY_CITY || "").trim().toUpperCase();
    if (state) geolocation.state = state;
    if (city) geolocation.city = city;
    return [{ type: "browserbase", geolocation }];
  }
  if (mode === "external") {
    // The boot-time DNS probe (probeExternalProxy) flips this flag if
    // the configured server doesn't resolve. Silently downgrade to
    // builtin instead of doomed connect attempts every session.
    if (externalProxyDead) return true;
    const server = String(process.env.BROWSERBASE_PROXY_SERVER || "").trim();
    if (!server) {
      console.warn("[browserbase] external proxy mode selected but BROWSERBASE_PROXY_SERVER is empty — disabling proxies for this session");
      return null;
    }
    const entry = { type: "external", server };
    const username = process.env.BROWSERBASE_PROXY_USERNAME;
    const password = process.env.BROWSERBASE_PROXY_PASSWORD;
    const domainPattern = process.env.BROWSERBASE_PROXY_DOMAIN_PATTERN;
    if (username) entry.username = username;
    if (password) entry.password = password;
    if (domainPattern) entry.domainPattern = domainPattern;
    return [entry];
  }
  return null;
}

// One-line summary of the resolved proxy config — used for the per-session
// boot log so it's obvious which mode actually took effect.
export function describeProxyConfig(cfg) {
  if (cfg === true) return "builtin (rotating)";
  if (cfg === null || cfg === undefined) return "off";
  if (Array.isArray(cfg) && cfg.length) {
    const e = cfg[0];
    if (e?.type === "browserbase" && e.geolocation) {
      const g = e.geolocation;
      return `geo ${[g.country, g.state, g.city].filter(Boolean).join("/")}`;
    }
    if (e?.type === "external") {
      let host = "external";
      try { host = new URL(e.server).host; } catch { /* leave default */ }
      return `external ${host}`;
    }
  }
  return "off";
}

// Back-compat: a few callers still want to know "is any proxy turned on?"
// without inspecting the full config. Lazily evaluated so changes to env
// at boot time still apply.
export const USE_PROXIES = resolveProxyMode() !== "off";

// Ordered fallback chain for session-create payloads. The Stagehand /
// direct-SDK paths iterate through this on init failure so the runner
// stays alive even when the configured proxy mode rejects:
//
//   tier 1 — exact configured mode (external / geo / builtin / off)
//   tier 2 — Browserbase builtin rotation        (only if tier 1 was external/geo)
//   tier 3 — no proxies at all                   (only if any earlier tier had proxies)
//
// Non-proxy fields (browserSettings, region, timeout) are preserved across
// tiers so stealth / captcha behaviour stays consistent.
export function sessionCreateParamsAttempts(opts = {}) {
  const primary = sessionCreateParams(opts);
  const attempts = [primary];
  const isCustom = Array.isArray(primary.proxies); // external or geo
  const hasAnyProxy = primary.proxies !== undefined;
  if (isCustom) {
    const builtin = { ...primary, proxies: true };
    attempts.push(builtin);
  }
  if (hasAnyProxy) {
    const noProxy = { ...primary };
    delete noProxy.proxies;
    attempts.push(noProxy);
  }
  return attempts;
}

// Create a fresh browser session. Returns the essentials needed by the
// runner (connectUrl) and by the grid UI (debugUrl / debuggerFullscreenUrl).
export async function createSession({ viewport = { width: 1280, height: 720 }, region = "us-west-2", timeoutSec = 900 } = {}) {
  const bb = getClient();
  const payload = {
    projectId: PROJECT_ID,
    region,
    timeout: timeoutSec,
    browserSettings: {
      viewport,
      blockAds: true,
      solveCaptchas: SOLVE_CAPTCHAS,
      advancedStealth: ADV_STEALTH,
    },
  };
  const proxiesCfg = buildProxiesConfig();
  if (proxiesCfg !== null) payload.proxies = proxiesCfg;

  console.log(
    `[browserbase] creating session · stealth=${ADV_STEALTH ? "on" : "off"} ` +
    `captchas=${SOLVE_CAPTCHAS ? "on" : "off"} proxies=${describeProxyConfig(proxiesCfg)}`,
  );
  const session = await createSessionWithFallback(bb, payload);
  console.log(`[browserbase] session created · id=${session.id} status=${session.status} expires=${session.expiresAt}`);

  // debug() returns per-page live-view links. For a brand-new session with
  // a single blank tab this is the one we want to embed.
  let debugUrl = null, debuggerFullscreenUrl = null;
  try {
    const debug = await bb.sessions.debug(session.id);
    debugUrl = debug.debuggerUrl || null;
    debuggerFullscreenUrl = debug.debuggerFullscreenUrl || null;
    console.log(`[browserbase] session ${String(session.id).slice(0, 8)} debug() ok · live=${debugUrl ? "yes" : "no"}`);
  } catch (err) {
    console.warn(`[browserbase] debug() failed for ${session.id}: ${err.message}`);
  }

  return {
    id: session.id,
    connectUrl: session.connectUrl,
    debugUrl,
    debuggerFullscreenUrl,
    status: session.status,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

// Some Browserbase settings (advancedStealth, proxies, verified) are
// gated to paid plans. If the account is on the free tier, the session
// create call fails with a descriptive error. Rather than die, peel off
// the gated fields one at a time and retry — so the runner stays
// functional on any plan.
async function createSessionWithFallback(bb, payload) {
  const attempts = [];
  attempts.push(payload);
  // External / geo proxies can fail for reasons unrelated to the rest of
  // the config — a tunneled hotspot might be offline, the upstream
  // provider might rate-limit, the geo combination might be unavailable.
  // Try Browserbase's builtin rotating pool as an intermediate fallback
  // before giving up on proxies entirely.
  if (Array.isArray(payload.proxies)) {
    const builtin = structuredClone(payload);
    builtin.proxies = true;
    attempts.push(builtin);
  }
  if (payload.browserSettings?.advancedStealth || payload.proxies) {
    const stripped = structuredClone(payload);
    delete stripped.proxies;
    if (stripped.browserSettings) delete stripped.browserSettings.advancedStealth;
    attempts.push(stripped);
  }
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const session = await bb.sessions.create(attempts[i]);
      if (i > 0) {
        console.warn(
          `[browserbase] proxy fallback succeeded at tier ${i + 1} (proxies=${describeProxyConfig(attempts[i].proxies)})`,
        );
      }
      return session;
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      console.warn(`[browserbase] session create attempt ${i + 1} (proxies=${describeProxyConfig(attempts[i].proxies)}) failed: ${msg.slice(0, 200)}`);
      // Only retry on plan/config errors (400-class); propagate auth/network.
      if (err?.status && err.status !== 400 && err.status !== 403 && err.status !== 422) break;
    }
  }
  throw lastErr;
}

// Refresh debug URLs mid-session (e.g. after a new tab opens, the live
// view URL changes).
export async function refreshDebug(sessionId) {
  const bb = getClient();
  const debug = await bb.sessions.debug(sessionId);
  return {
    debugUrl: debug.debuggerUrl || null,
    debuggerFullscreenUrl: debug.debuggerFullscreenUrl || null,
    pages: debug.pages || [],
  };
}

// ─── Search + Fetch (proxy-free preflight helpers) ──────────────────────
// These hit Browserbase's REST APIs directly — no browser session, no
// proxy chain, no Stagehand. Used by browser_runner.js as a preflight
// for search-type tasks so the agent doesn't have to drive Google/Baidu
// (which is the most common cause of "navigation failures — proxy
// unreachable" aborts). Single API key, same docs used by the
// browser-agent-demo template.
//
// Both helpers swallow errors (return null / []) on purpose. A failed
// preflight should NEVER block the dispatch — the runner will fall back
// to launching a browser. Per the "tool calls have #1 priority" rule.

export async function searchWeb(query, numResults = 5) {
  if (!isConfigured()) return [];
  const q = String(query || "").trim();
  if (!q) return [];
  const t0 = Date.now();
  try {
    const res = await getClient().search.web({
      query: q,
      numResults: Math.max(1, Math.min(25, numResults | 0)),
    });
    const results = res?.results || [];
    console.log(`[browserbase] search.web "${q.slice(0, 60)}" → ${results.length} result(s) in ${Date.now() - t0}ms`);
    return results;
  } catch (err) {
    console.warn(`[browserbase] search.web failed for "${q.slice(0, 60)}": ${err?.message || err}`);
    return [];
  }
}

export async function fetchPage(url, { allowRedirects = true, useProxy = false } = {}) {
  if (!isConfigured()) return null;
  const u = String(url || "").trim();
  if (!u) return null;
  const t0 = Date.now();
  try {
    const res = await getClient().fetchAPI.create({
      url: u,
      allowRedirects,
      proxies: useProxy,
    });
    if (!res) return null;
    const len = (res.content || "").length;
    console.log(`[browserbase] fetchAPI ${res.statusCode} ${u.slice(0, 80)} · ${len}B · ${Date.now() - t0}ms`);
    return {
      statusCode: res.statusCode,
      contentType: res.contentType,
      content: res.content,
      length: len,
    };
  } catch (err) {
    console.warn(`[browserbase] fetchAPI failed for ${u.slice(0, 80)}: ${err?.message || err}`);
    return null;
  }
}

// ─── Dead external-proxy detection ───────────────────────────────────────
// The user's .env can point BROWSERBASE_PROXY_SERVER at e.g. a Cloudflare
// tunnel that's been torn down (`getaddrinfo ENOTFOUND ...`). Stagehand's
// init then wastes ~1s on the doomed connect before falling back to
// builtin. Worse, on the rare retry where DNS does resolve briefly, the
// session uses a half-broken proxy and loses navigations downstream.
//
// Once at module load we resolve the host. If it fails with ENOTFOUND
// (or stays unresolvable for ~2s), we set a flag that buildProxiesConfig
// honours — external mode silently downgrades to builtin for this
// process lifetime. A loud one-time warning makes the swap visible.

import { lookup as dnsLookup } from "node:dns/promises";

let externalProxyDead = false;

async function probeExternalProxy() {
  if (resolveProxyMode() !== "external") return;
  const server = String(process.env.BROWSERBASE_PROXY_SERVER || "").trim();
  if (!server) return;
  let host;
  try {
    host = new URL(server).hostname;
  } catch {
    console.warn(`[browserbase] BROWSERBASE_PROXY_SERVER is not a valid URL: ${server}`);
    externalProxyDead = true;
    return;
  }
  try {
    await Promise.race([
      dnsLookup(host),
      new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 2000)),
    ]);
  } catch (err) {
    externalProxyDead = true;
    console.warn(
      `[browserbase] external proxy host ${host} did not resolve (${err.message}) — ` +
      "permanently downgrading to builtin rotating pool for this process. " +
      "Update BROWSERBASE_PROXY_SERVER in .env to silence this warning.",
    );
  }
}

export function isExternalProxyDead() {
  return externalProxyDead;
}

// Probe at module load. We don't await — module init must stay sync so
// /tool dispatch isn't blocked behind a DNS lookup. The probe finishes
// well before the first session is created.
probeExternalProxy().catch(() => { /* swallow — flag stays false */ });

// Ask Browserbase to release the session early. Best-effort; if the
// session already expired or was closed this is a no-op.
export async function releaseSession(sessionId) {
  if (!sessionId) return;
  try {
    const bb = getClient();
    await bb.sessions.update(sessionId, {
      projectId: PROJECT_ID,
      status: "REQUEST_RELEASE",
    });
  } catch (err) {
    console.warn(`[browserbase] release failed for ${sessionId}: ${err.message}`);
  }
}

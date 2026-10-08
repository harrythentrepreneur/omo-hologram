// src/agents/browser_runner.js — the inner browser-agent loop, powered by
// Stagehand (Browserbase's official AI-native automation framework).
//
// Stagehand replaces the hand-rolled Playwright+Gemini vision loop we had
// before. Key wins:
//   · self-healing natural-language act() — no pixel coordinate guessing,
//     handles element moves across re-renders.
//   · waitForCaptchaSolves: Stagehand blocks automatically while
//     Browserbase auto-solves reCAPTCHA / hCaptcha / Cloudflare Turnstile.
//   · hybrid agent mode combines DOM-tree actions with screenshot vision
//     so Reddit/Twitter-style heavy SPAs work.
//   · LLM calls are routed through Browserbase's Model Gateway — we don't
//     burn our own Gemini quota on browsing, and the model is picked from
//     Stagehand's validated list (gemini-3-flash-preview is the default).
//   · streaming execute() gives us per-step callbacks, which we translate
//     into task_progress events so Momo narrates in her voice as the
//     agent works.
//
// Everything downstream (terminals.js, narration hook
// on the avatar) stays the same because the events we emit still ride
// the task_spawn / task_progress / task_complete shape.

import { Stagehand } from "@browserbasehq/stagehand";
import * as bb from "./browserbase.js";

// Model used for both the agent planner and inner act/extract tool calls.
// Stagehand routes these through Browserbase Model Gateway by default, so
// no additional API key is needed. Override via env if you want your own
// Gemini key (requires modelClientOptions wiring — not done yet).
const MODEL = process.env.BROWSER_AGENT_MODEL || "google/gemini-3-flash-preview";
// Tool mode: "dom" (default) is fast and deterministic for most sites;
// "hybrid" adds coordinate-based vision tools for heavy SPAs (Reddit,
// Twitter, Instagram) at a small latency/cost tradeoff. "cua" uses a
// pure-vision Computer Use Agent model, needed when the DOM is opaque.
const AGENT_MODE = process.env.BROWSER_AGENT_MODE || "hybrid";
const MAX_STEPS = Number(process.env.BROWSER_AGENT_MAX_STEPS || 20);
// Wall-clock cap for the whole agent run. Generous on purpose — the user
// would rather a slow agent finish than be killed mid-thought; the real
// "is this stuck forever" guard is the no-UI-presence abort in
// browser_tasks.js (no client connected for ~1 hour ⇒ cancel). A truly
// runaway run still hits this 1 h ceiling regardless of UI state.
const TOTAL_TIMEOUT_MS = Number(process.env.BROWSER_AGENT_TIMEOUT_MS || 60 * 60 * 1000);
// Per-tool cap inside Stagehand (default 45s, see DEFAULT_AGENT_TOOL_TIMEOUT_MS
// in the Stagehand source). 45s was killing healthy `type()`/`screenshot()`
// calls on slow pages and the agent would burn its step budget retrying.
// Bumped to 1 h so a single slow tool call doesn't tank the run; the
// no-UI-presence watchdog still aborts dangling sessions.
const TOOL_TIMEOUT_MS = Number(process.env.BROWSER_AGENT_TOOL_TIMEOUT_MS || 60 * 60 * 1000);
// Navigation behaviour for Stagehand's understudy Page. Two problems
// with Stagehand's defaults for autonomous browsing:
//   1. The agent's gotoTool calls page.goto(url, { waitUntil: "load" })
//      — `load` only fires once every subresource (ads, analytics,
//      tracking iframes) finishes. On ad-heavy sites it routinely takes
//      30–60s or never fires at all. Best practice for agent frameworks
//      is "domcontentloaded": DOM is ready and the agent can interact;
//      subsequent act()/extract() calls have their own waiters.
//   2. The hardcoded 15000ms timeoutMs in page.js is too short for slow
//      proxies / large pages. We default to 60s.
//   3. A nav timeout is rarely a real failure — the page usually
//      committed and is partly interactive. Best practice is to swallow
//      the timeout and let the agent's next action find out whether the
//      page is usable, rather than reporting "navigation failed" and
//      triggering a pointless pivot.
// All three are configurable so a real network failure isn't masked.
const NAV_TIMEOUT_MS = Number(process.env.BROWSER_AGENT_NAV_TIMEOUT_MS || 60_000);
const NAV_WAIT_UNTIL = process.env.BROWSER_AGENT_NAV_WAIT_UNTIL || "domcontentloaded";
const NAV_SOFT_TIMEOUT = process.env.BROWSER_AGENT_NAV_SOFT_TIMEOUT !== "0";
// When the upstream proxy is broken (dead Cloudflare tunnel, blocked
// builtin pool, etc.) every Stagehand goto times out at its own 45s
// internal cap and the agent loops uselessly until the global 5-min
// timeout. Abort once we see enough navigation tool errors in a row —
// but only if they're failing on the SAME URL twice (genuine block /
// dead proxy), not just because the agent is hopping between sites
// looking for the right one. Default streak raised from 2 → 4 because
// the prior 2-strike limit killed otherwise-healthy runs after one
// transient hiccup.
const NAV_FAIL_STREAK_LIMIT = Number(process.env.BROWSER_AGENT_NAV_FAIL_STREAK || 4);
// Stagehand v3 hybrid-mode navigation tools. Other tools (act/extract/click/
// type/scroll/wait/screenshot/think) don't count as "tried to load a URL"
// — only failures of these two indicate a broken proxy / network path.
const NAV_TOOLS = new Set(["goto", "navback"]);

// ─── Search-preflight detection ────────────────────────────────────────
// Search/research-type tasks are the #1 source of "navigation failures"
// — driving Google or Baidu through a residential proxy is exactly what
// those sites' bot detection is tuned to catch. Browserbase's Search
// API hits structured results without a browser at all, so we use it
// as a preflight: detect the task is search-shaped, fetch top results,
// inject them into the agent's instruction so it can navigate STRAIGHT
// to the relevant page (or answer from snippets without navigating at
// all).
const SEARCH_HINTS_EN = [
  "search for", "find", "research", "look up", "compare", "best",
  "what is", "what are", "who is", "when did", "where is", "which",
  "recent", "latest", "news about", "list of", "top ",
];
const SEARCH_HINTS_ZH = [
  "查找", "搜索", "搜一下", "查询", "找一下", "找找", "搜",
  "有什么", "有哪些", "最新的", "最近的", "哪个", "哪些",
  "是什么", "是谁", "新闻", "列出", "推荐",
];

function looksLikeSearchTask(task) {
  const t = String(task || "").toLowerCase();
  if (!t) return false;
  for (const h of SEARCH_HINTS_EN) if (t.includes(h)) return true;
  for (const h of SEARCH_HINTS_ZH) if (task.includes(h)) return true;
  return false;
}

// Detect whether the task came in as Chinese vs English (or other Latin
// language). Used to mirror the user's language in the agent's final
// answer and in the runner's own decoration lines that ride the
// narration channel up to Momo. CJK Unified Ideographs block is the
// reliable tell — Chinese tasks always contain them, English tasks never.
function detectLang(task) {
  return /[㐀-鿿]/.test(String(task || "")) ? "zh" : "en";
}

// Tiny localiser. `lang` is "zh" | "en"; falls back to en for anything else.
function t(lang, zh, en) {
  return lang === "zh" ? zh : en;
}

// Strip command verbs / framing from the task to derive a cleaner search
// query. "search for recent events in Shenzhen, summarize them" →
// "recent events in Shenzhen". Keeps it short (Browserbase Search API
// caps around 25 results so the query stays focused).
function deriveSearchQuery(task) {
  let q = String(task || "").replace(/\s+/g, " ").trim();
  // Strip leading verbs in EN + ZH.
  q = q.replace(/^(please\s+)?(go\s+(?:to\s+|and\s+)?|search\s+(?:for\s+|the\s+web\s+for\s+)?|find\s+(?:me\s+)?|research\s+|look\s+up\s+|compare\s+)/i, "");
  q = q.replace(/^(请|帮我|去|搜索|搜一下|查找|查询|找一下|找找|看看|帮忙)/, "");
  // Drop trailing instruction tails ("..., summarize them, and email me").
  const cut = q.search(/[,，。;；]\s*(then|and then|summari[sz]e|tell me|email|send|put|save|然后|总结|发给我)/i);
  if (cut > 12) q = q.slice(0, cut);
  return q.trim().slice(0, 200);
}

function systemPrompt(task) {
  return `You are a careful, decisive web-browsing agent. Their original request (verbatim):

${task}

Operating rules:
- Think one concrete, visible step at a time. Don't chain multiple actions in one tool call.
- If you see a CAPTCHA, Cloudflare challenge ("Verify you are human"), or a "please wait" interstitial, the session has captcha-solving on — it will clear automatically. Do nothing for a few seconds and try your next action. Don't abandon the task.
- A hard 2FA or password-login wall IS blocking — stop and report it plainly.
- LANGUAGE: write your final answer AND any narration/reasoning in the SAME language the user wrote the request in above. If the request is in English, reply in English. If the request is in Simplified Chinese, reply in Simplified Chinese. Never switch languages on the user.

FINAL ANSWER FORMAT (mandatory — TWO clearly-labeled sections; the voice assistant uses TLDR, the user's Google Doc archive uses DETAILS):

TLDR: <one short sentence with the headline answer. Quote the most important number/name/title. This will be spoken aloud — make it natural to say.>

DETAILS:
<the full substantive findings. Include EVERY concrete fact you collected: names, dates, prizes, URLs, prices, locations, quotes, deadlines, eligibility, etc. Use one bullet or short paragraph per item. Do NOT write meta-summaries like "I successfully identified X" — write the actual data itself. If the user asked for N items, give all N in full detail. The DETAILS section can be long; the user reads it later.>

If you cannot complete the task, write only:
TLDR: <one sentence stating what blocked you>
DETAILS:
<what you tried, in 2–4 short lines, plus any partial findings worth keeping.>`;
}

/**
 * Run a browser task end-to-end.
 *
 * @param {object} opts
 * @param {string}   opts.task  task description from Momo
 * @param {(ev: object) => void} opts.onSessionReady  called once with { sessionId, liveViewUrl, fullscreenLiveViewUrl } the moment the Browserbase session is up
 * @param {(ev: object) => void} opts.emit  progress callback; shape matches browser_tasks.js
 * @param {AbortSignal} [opts.signal]  optional external cancel
 * @param {object} [opts.metadata]  free-form key/values stored on the Browserbase session as userMetadata. Tag with taskId/label so the dashboard at browserbase.com/sessions shows context-rich rows. Capped at 512 chars total.
 * @returns {Promise<{ ok: boolean, answer?: string, error?: string, steps: number }>}
 */
export async function run({ task, onSessionReady, emit, signal, metadata = null }) {
  const t0 = Date.now();
  const missing = bb.missingConfigReason();
  if (missing) return { ok: false, error: missing, steps: 0 };

  // Mirror the user's language in every decoration line we emit. Detected
  // from the task string (CJK ideograph presence is the reliable tell).
  const lang = detectLang(task);

  emit({ phase: "text", role: "assistant", text: t(lang, "· 准备远端浏览器…", "· spinning up remote browser…") });

  // ─── Preflight: bb.search.web for search-type tasks ──────────────────
  // The Browserbase Search API returns structured results without
  // launching a browser — no proxy, no Cloudflare wall, no Google bot
  // detection. Seed the agent's instruction with the top results so it
  // can navigate STRAIGHT to the relevant page (or in some cases just
  // answer from snippets without ever opening a tab).
  let preflightContext = "";
  if (looksLikeSearchTask(task)) {
    const query = deriveSearchQuery(task);
    emit({
      phase: "text",
      role: "assistant",
      text: t(lang, `· 先用 Search API 查一下 "${query.slice(0, 60)}"`, `· searching first via Search API for "${query.slice(0, 60)}"`),
    });
    const results = await bb.searchWeb(query, 5);
    if (results.length) {
      const top = results.slice(0, 5);
      const lines = top.map((r, i) => {
        const date = r.publishedDate ? ` (${r.publishedDate})` : "";
        return `  ${i + 1}. ${r.title}${date}\n     ${r.url}`;
      });
      preflightContext =
        "\n\n── Preflight Search Results ──\n" +
        `(retrieved via Browserbase Search API for query: "${query}")\n` +
        lines.join("\n") +
        "\n\nUse these as your starting context. Prefer navigating directly to one of these URLs " +
        "instead of going through Google/Baidu — those search pages frequently block automated browsers " +
        "and will fail. If the snippets above already answer the question, you can answer immediately " +
        "without launching the browser at all (just summarise from the result titles).";
      emit({
        phase: "text",
        role: "assistant",
        text: t(
          lang,
          `· 找到 ${results.length} 条候选，第一条：${(results[0].title || "").slice(0, 80)}`,
          `· got ${results.length} candidates; top one: ${(results[0].title || "").slice(0, 80)}`,
        ),
      });
    } else {
      emit({
        phase: "text",
        role: "assistant",
        text: t(lang, "· Search API 没结果，照常派浏览器", "· Search API returned nothing — falling back to live browser"),
      });
    }
  }
  // Append the output-format reminder directly to the instruction (not
  // just the system prompt). Models follow user-side instructions much
  // more strictly than system prompts for output shape — without this,
  // the agent's `done` tool tends to write meta-summaries like "I have
  // researched and compiled..." instead of the actual data the user
  // asked for. The reminder is short, language-aware, and at the END so
  // it's the last thing in context before the agent produces its answer.
  const formatReminder = t(
    lang,
    "\n\n— 输出格式（必须遵守，否则用户拿不到数据） —\n" +
      "完成后调用 `done`，message 字段必须按以下两段写：\n" +
      "TLDR: 一句话答案，包含最重要的数字/名字/标题。\n" +
      "DETAILS:\n" +
      "把你收集到的所有具体事实写出来——名字、日期、奖金、URL、价格、地点、报价、截止日期等。每条一行或一段。" +
      "**绝对不要写 \"我成功研究了…\"、\"我已经访问了…\" 这种描述自己做了什么的句子，要写实际数据本身。**" +
      "如果用户要 N 项，DETAILS 里就要给齐 N 项的完整信息。这段会存进 Google Doc，用户会读。",
    "\n\n— OUTPUT FORMAT (mandatory; the user otherwise gets no data) —\n" +
      "When you call the `done` tool, the message MUST follow this two-part shape:\n" +
      "TLDR: one short sentence with the headline answer (most important number/name/title).\n" +
      "DETAILS:\n" +
      "List every concrete fact you collected — names, dates, prizes, URLs, prices, locations, quotes, deadlines, eligibility. " +
      "One bullet or short paragraph per item. **NEVER write meta sentences like \"I successfully researched…\" or \"I have compiled…\" — write the actual data itself.** " +
      "If the user asked for N items, give all N in full detail. The DETAILS section will be archived to a Google Doc the user reads later, so be thorough.",
  );
  const framedTask = task + preflightContext + formatReminder;

  // Construct Stagehand against an explicit session-create payload. We
  // build a fresh instance per attempt because Stagehand caches state
  // from init() that we don't want to mix between tiers.
  function buildStagehand(params) {
    return new Stagehand({
      env: "BROWSERBASE",
      apiKey: bb.apiKey(),
      projectId: bb.projectId(),
      browserbaseSessionCreateParams: params,
      model: MODEL,
      systemPrompt: systemPrompt(framedTask),
      waitForCaptchaSolves: true,
      selfHeal: true,
      experimental: true,
      disableAPI: true,
      verbose: 1,
      logger: makeLoggerBridge(emit),
    });
  }

  // Init with proxy fallback chain. If the configured external/geo proxy
  // (e.g. tunneled hotspot, 3rd-party residential) can't be reached, or
  // the account isn't on a plan that accepts the requested mode, we
  // degrade through tiers built by sessionCreateParamsAttempts():
  //   external/geo → Browserbase builtin → no proxies.
  // Network-y errors (ECONNREFUSED/ENOTFOUND/timeout/auth-407) and
  // explicit plan-gate errors trigger the next tier; anything else
  // bubbles up immediately so genuine bugs don't get masked.
  const proxyAttempts = bb.sessionCreateParamsAttempts({ metadata });
  let stagehand = null;
  let lastInitErr = null;
  for (let i = 0; i < proxyAttempts.length; i++) {
    const params = proxyAttempts[i];
    const desc = bb.describeProxyConfig(params.proxies);
    const candidate = buildStagehand(params);
    try {
      await candidate.init();
      stagehand = candidate;
      if (i === 0) {
        emit({ phase: "text", role: "assistant", text: `· proxy → ${desc}` });
      } else {
        console.warn(`[browser_runner] proxy fallback → ${desc} (tier ${i + 1})`);
        emit({
          phase: "text",
          role: "assistant",
          text: t(lang, `· proxy 回退 → ${desc}`, `· proxy fallback → ${desc}`),
        });
      }
      break;
    } catch (err) {
      lastInitErr = err;
      try { await candidate.close(); } catch { /* ignore */ }
      const isLast = i === proxyAttempts.length - 1;
      const looksProxyRelated =
        bb.isProxiesPlanError(err) ||
        /prox(y|ies)|tunnel|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|\b407\b/i.test(err?.message || "");
      // 429 / concurrency-limit is its own bucket — no point retrying with
      // a different proxy tier, it's the account hitting a hard cap. Break
      // out and surface a friendly message in the catch below.
      if (bb.isRateLimitError(err)) {
        console.warn(`[browser_runner] init tier ${i + 1} hit rate limit / concurrency cap`);
        break;
      }
      console.warn(
        `[browser_runner] init tier ${i + 1} (${desc}) failed: ${(err?.message || "").slice(0, 200)}`,
      );
      if (isLast || !looksProxyRelated) break;
    }
  }
  if (!stagehand) {
    console.error(`[browser_runner] all init attempts failed: ${lastInitErr?.message || lastInitErr}`);
    return { ok: false, error: lastInitErr?.message || "stagehand init failed", steps: 0 };
  }

  // Tune Stagehand's navigation defaults for autonomous browsing.
  // Three things this patch does, all best-practice for agent-driven
  // browsers (see comment on NAV_TIMEOUT_MS / NAV_WAIT_UNTIL above):
  //   · timeoutMs: 15000 → NAV_TIMEOUT_MS (60s default)
  //   · waitUntil: "load" → "domcontentloaded" (DOM-ready, not full
  //     subresource load — survives ad-heavy sites)
  //   · timeout becomes soft: if the wait expires we resolve with the
  //     URL anyway so the agent can attempt to interact, instead of
  //     gotoTool's catch reporting "navigation failed" and provoking
  //     a pivot. A genuine net failure (DNS, TCP, cert) still throws
  //     synchronously inside the CDP send and surfaces normally.
  // Idempotent — marker on the prototype guards against re-patching.
  try {
    const page = stagehand.page;
    const proto = page && Object.getPrototypeOf(page);
    if (proto && !proto.__omoNavPatched) {
      for (const method of ["goto", "reload", "goBack"]) {
        const orig = proto[method];
        if (typeof orig !== "function") continue;
        const optsIdx = method === "goto" ? 1 : 0;
        proto[method] = async function patchedNav(...args) {
          const opts = { ...(args[optsIdx] || {}) };
          if (opts.timeoutMs == null) opts.timeoutMs = NAV_TIMEOUT_MS;
          if (opts.waitUntil == null || opts.waitUntil === "load") {
            opts.waitUntil = NAV_WAIT_UNTIL;
          }
          args[optsIdx] = opts;
          try {
            return await orig.apply(this, args);
          } catch (err) {
            const msg = String(err?.message || "");
            const isTimeout = /timed out|waitForMainLoadState|waitForLoadState/i.test(msg);
            if (NAV_SOFT_TIMEOUT && isTimeout) {
              console.warn(`[browser_runner] ${method} soft-timeout absorbed: ${msg.slice(0, 200)}`);
              return null;
            }
            throw err;
          }
        };
      }
      proto.__omoNavPatched = true;
      console.log(`[browser_runner] patched understudy nav: waitUntil=${NAV_WAIT_UNTIL}, timeout=${NAV_TIMEOUT_MS}ms, soft=${NAV_SOFT_TIMEOUT}`);
    }
  } catch (err) {
    console.warn(`[browser_runner] nav-timeout patch failed: ${err.message}`);
  }

  // Combined abort: external caller signal OR our own internal trip when
  // the agent is clearly stuck on a broken proxy. Stagehand's agent.execute
  // honours `signal` to break out of its inner loop.
  const internalAbort = new AbortController();
  const onExternalAbort = () => internalAbort.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) internalAbort.abort(signal.reason);
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  // Wall-clock timeout. The onStepFinish path also checks elapsed time, but
  // that only fires between steps — if a single Stagehand tool hangs (e.g.
  // a goto stuck behind a frozen proxy past Stagehand's own 45s tool cap)
  // the per-step check never runs. This setTimeout guarantees the agent
  // bails after TOTAL_TIMEOUT_MS regardless of step cadence.
  const totalTimeoutHandle = setTimeout(() => {
    if (!internalAbort.signal.aborted) {
      console.warn(`[browser_runner] total timeout fired after ${TOTAL_TIMEOUT_MS}ms — aborting`);
      internalAbort.abort(new Error("total timeout"));
    }
  }, TOTAL_TIMEOUT_MS);
  totalTimeoutHandle.unref?.();
  const navState = { failStreak: 0, aborted: false };

  let result = null;
  let stepCount = 0;
  try {
    const sessionId = stagehand.browserbaseSessionID;

    // Fetch the Live View URL so the grid iframe can mount. bb.refreshDebug
    // wraps the SDK's sessions.debug() call and returns { debugUrl, ... }.
    let debugUrl = null, fullscreenLiveViewUrl = null;
    try {
      const debug = await bb.refreshDebug(sessionId);
      debugUrl = debug.debugUrl;
      fullscreenLiveViewUrl = debug.debuggerFullscreenUrl;
    } catch (err) {
      console.warn(`[browser_runner] debug url fetch failed for ${sessionId}: ${err.message}`);
    }
    if (onSessionReady) {
      onSessionReady({ sessionId, liveViewUrl: debugUrl, fullscreenLiveViewUrl });
    }
    emit({
      phase: "text",
      role: "assistant",
      text: t(
        lang,
        `· session ${String(sessionId).slice(0, 8)} — 浏览器已上线`,
        `· session ${String(sessionId).slice(0, 8)} — browser online`,
      ),
    });

    // Build the autonomous agent. Hybrid mode gives it both DOM-navigation
    // tools (act, fillForm) and coordinate tools (click, type) so it
    // gracefully falls back to vision when selectors fail.
    const agent = stagehand.agent({
      mode: AGENT_MODE,
      model: MODEL,
    });

    // Non-streaming execute with an onStepFinish callback — we get a
    // structured per-step record we can translate into task_progress
    // narration lines. Stagehand marks streaming mode as experimental so
    // we stick to non-streaming for stability.
    result = await agent.execute({
      instruction: framedTask,
      maxSteps: MAX_STEPS,
      signal: internalAbort.signal,
      toolTimeout: TOOL_TIMEOUT_MS,
      callbacks: {
        onStepFinish: (step) => {
          stepCount += 1;
          try {
            forwardStep(step, emit, stepCount, navState);
          } catch (err) {
            console.warn(`[browser_runner] forwardStep failed: ${err.message}`);
          }
          if (navState.failStreak >= NAV_FAIL_STREAK_LIMIT && !navState.aborted) {
            navState.aborted = true;
            console.warn(`[browser_runner] aborting: ${navState.failStreak} consecutive navigation failures (likely proxy down)`);
            emit({
              phase: "text",
              role: "assistant",
              text: t(
                lang,
                "· 浏览器代理无法访问目标，提前结束。",
                "· browser proxy can't reach the target — bailing out early.",
              ),
            });
            internalAbort.abort(new Error("navigation failures — proxy unreachable"));
          }
          if (Date.now() - t0 > TOTAL_TIMEOUT_MS && !navState.aborted) {
            navState.aborted = true;
            console.warn(`[browser_runner] total timeout hit after ${stepCount} steps`);
            internalAbort.abort(new Error("total timeout"));
          }
        },
      },
    });

    const answer = (result?.message || "").trim();
    return {
      ok: !!result?.success,
      answer: answer || t(
        lang,
        result?.success ? "完成。" : "未能完成任务。",
        result?.success ? "Done." : "Couldn't complete the task.",
      ),
      error: result?.success ? undefined : (answer || "agent did not succeed"),
      steps: stepCount,
    };
  } catch (err) {
    // Loud log — this is the only place that captures the Stagehand
    // stack trace, and without it a failed task is invisible.
    console.error(`[browser_runner] error after ${stepCount} step(s): ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    return {
      ok: false,
      error: err?.message || String(err),
      steps: stepCount,
    };
  } finally {
    clearTimeout(totalTimeoutHandle);
    if (signal) {
      try { signal.removeEventListener("abort", onExternalAbort); } catch { /* ignore */ }
    }
    try { await stagehand.close(); } catch (err) {
      console.warn(`[browser_runner] stagehand.close failed: ${err.message}`);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

// Translate one Stagehand agent step into the same `{ phase, ... }` shape
// our browser_tasks.js / terminals.js pipeline already understands. The
// AI SDK step object carries both assistant text (reasoning/final answer)
// and toolCalls / toolResults arrays.
function forwardStep(step, emit, stepIndex, navState) {
  if (!step) return;

  // 1) Any reasoning/text the model emitted this step → narrate line.
  // Cap is generous (4000 chars) because this is the SUBSTANTIVE per-step
  // reasoning — every fact the agent observed/extracted while browsing.
  // The Google Doc archive uses these as fallback content when the
  // agent's final `done` message is just a meta-summary instead of the
  // actual data. Truncating here was the single biggest reason docs
  // ended up empty.
  const text = (step.text || "").trim();
  if (text) {
    emit({ phase: "text", role: "assistant", text: text.slice(0, 4000) });
  }

  // 2) Tool calls made this step (act, goto, extract, click, type, …).
  const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
  const callNames = [];
  for (const call of calls) {
    const name = call.toolName || call.name || "tool";
    callNames.push(name);
    const args = call.args ?? call.input ?? {};
    const input = summariseArgs(args);
    emit({ phase: "tool_use", toolName: name, toolInput: input });
  }

  // 3) Tool results. Stagehand returns results on `toolResults`; each
  //    entry has `.result` with a shape that varies by tool. We flatten
  //    it into a short snippet so the grid doesn't dump JSON blobs.
  const results = Array.isArray(step.toolResults) ? step.toolResults : [];
  let stepHadNavCall = false;
  let stepNavSucceeded = false;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const out = r.result ?? r.output ?? r;
    const isError = !!out?.error || out?.success === false;
    const snippet = summariseResult(out);
    emit({ phase: "tool_result", isError, snippet });

    // Pair result back to its call for nav-failure tracking.
    const pairedName = callNames[i] || "";
    if (NAV_TOOLS.has(pairedName)) {
      stepHadNavCall = true;
      if (!isError) stepNavSucceeded = true;
    }
  }

  // Track consecutive navigation failures so the runner can abort early
  // when the proxy is dead. Only counts steps that actually attempted a
  // navigation — non-nav steps don't reset the streak.
  if (navState && stepHadNavCall) {
    if (stepNavSucceeded) navState.failStreak = 0;
    else navState.failStreak += 1;
  }
}

function summariseArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args.slice(0, 140);
  try {
    const obj = typeof args === "object" ? args : {};
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}=${s.slice(0, 80)}`);
      if (parts.join(", ").length > 140) break;
    }
    return parts.join(", ").slice(0, 140);
  } catch {
    return String(args).slice(0, 140);
  }
}

function summariseResult(out) {
  if (out == null) return "ok";
  if (typeof out === "string") return out.slice(0, 160);
  if (out.error) return String(out.error).slice(0, 200);
  if (out.message) return String(out.message).slice(0, 160);
  if (out.actionDescription) return String(out.actionDescription).slice(0, 160);
  if (out.success === true) return "ok";
  if (out.success === false) return "failed";
  try { return JSON.stringify(out).slice(0, 160); } catch { return "ok"; }
}

// Stagehand emits rich pino-style log lines. We only forward the ones
// worth surfacing so terminal chatter stays readable.
function makeLoggerBridge(emit) {
  return (line) => {
    if (!line) return;
    // Pino lines have { level, category, message, auxiliary }.
    // Category examples: "browserbase", "llm", "act", "extract", "agent".
    // level: 0 = error, 1 = warn/info, 2 = debug (Stagehand convention).
    const category = String(line.category || "browserbase");
    const msg = String(line.message || "").trim();
    if (!msg) return;
    const lv = line.level === 0 ? "error" : line.level === 1 ? "info" : "debug";

    // ─── Console: log everything ────────────────────────────────────────
    // Errors → console.error, everything else → console.log. Used to be
    // gated behind STAGEHAND_LOG=1 (i.e. invisible by default). The
    // Browserbase Skill explicitly recommends surfacing every update so
    // the user can post-mortem any session against the server log.
    const auxStr = formatAuxiliary(line.auxiliary);
    const tail = auxStr ? ` · ${auxStr}` : "";
    const fn = line.level === 0 ? console.error : console.log;
    fn(`[stagehand:${category}/${lv}] ${msg.slice(0, 600)}${tail}`);

    // ─── Grid: surface notable Browserbase events as "·" lines ──────────
    // Categories worth showing inline on the grid: "browserbase" (session
    // lifecycle, captcha, proxy), "agent" (high-level planner output).
    // Skip "act"/"extract"/"llm" inner chatter — those would flood the
    // 120-line ring with mechanical noise. Captcha-style messages are
    // always bubbled regardless of category since they explain stalls.
    if (/captcha|browserbase-solving/i.test(msg)) {
      emit({ phase: "text", role: "assistant", text: `· ${msg.slice(0, 220)}` });
    } else if (category === "browserbase" || category === "agent") {
      emit({ phase: "text", role: "assistant", text: `· [${category}] ${msg.slice(0, 220)}` });
    } else if (line.level === 0) {
      // Errors from any category make it onto the grid too — silent
      // failures are the worst-case UX.
      emit({ phase: "text", role: "assistant", text: `· [${category}!] ${msg.slice(0, 220)}` });
    }
  };
}

// Stagehand pino auxiliary fields are { key: { value, type } } objects.
// Flatten the most useful ones onto a single line for the console — full
// JSON dumps are too noisy and bury the actual signal.
function formatAuxiliary(aux) {
  if (!aux || typeof aux !== "object") return "";
  const out = [];
  for (const [k, v] of Object.entries(aux)) {
    if (v == null) continue;
    let val = v?.value !== undefined ? v.value : v;
    if (typeof val === "object") {
      try { val = JSON.stringify(val).slice(0, 200); } catch { val = String(val).slice(0, 200); }
    } else {
      val = String(val).slice(0, 200);
    }
    out.push(`${k}=${val}`);
    if (out.join(" ").length > 400) break;
  }
  return out.join(" ");
}

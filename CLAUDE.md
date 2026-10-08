# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision

"Momo" is a conversational, holographic AI command center for running a business. The intended experience:

- **Cute, personable voice** — the user talks to Momo; Momo talks back via Gemini Live speech-to-speech, defaulting to Simplified Chinese.
- **Live business data** — Momo reads real Stripe, Meta Ads, Gmail, Google Drive/Docs, and Google Calendar state (connectors are already wired; some still fall back to mocks when creds are absent).
- **Always-on mic (aspiration)** — beyond the interactive turn-taking, Momo should passively listen to the environment and continuously update what it knows about the user and the business. Today this is scaffolded but not complete (see "Ambient listening" below).
- **On-demand holographic charts** — the model never speaks numbers into chart arguments; it hands Momo a `viz_id` which mounts a sandboxed iframe inside the hologram stage.
- **Delegatable autonomous agents** — when Momo needs research or browser work, it spawns agents (Gemini in-process for quick research, Browserbase Chromium for live browser jobs). The UI visualises this as tiny sprite "scouts" peeling off the avatar, running to a tool station, and returning with findings.

The implementation is architected around this vision — treat new work as filling in whichever pillar is thinnest rather than inventing new surfaces.

## Commands

```
npm install       # first-time setup (Node 20+)
npm start         # run the server at http://localhost:8080
npm run dev       # same but with `node --watch` for auto-restart
```

No build step, no linter, no test suite. Server entry point is `server.js` at the repo root.

`.env` must contain `GEMINI_API_KEY`; see `.env.example` for the full optional set. Common ones:
- Gemini tuning: `GEMINI_MODEL`, `GEMINI_VOICE`, `GEMINI_LANGUAGE`, `VIZ_GEN_MODEL` (chart-HTML fallback, defaults to `gemini-3.1-flash-lite-preview`).
- Data: `NEON_DB_DATABASE` (Postgres; data tools degrade gracefully without it).
- Stripe: `STRIPE_SECRET_KEY` (restricted read-only key), `STRIPE_LIVE=1`.
- Google: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `GOOGLE_REFRESH_TOKEN`, `GMAIL_LIVE=1`, `GMAIL_POLL_MS`.
- Meta Ads (not in `.env.example` yet, but honored by `src/connectors/meta.js`): `FB_ACCESS_TOKEN`, `FB_AD_ACCOUNT_ID`.
- Web search: `TAVILY_API_KEY` (without it `web_search` returns a clean "not configured" response).
- Server: `PORT`, `NO_OPEN=1` to suppress browser auto-open.

No OpenAI key is needed anywhere — despite the README still referencing the pre-port OpenAI Realtime API and an old local path, both are obsolete. Ignore the README when it conflicts with this file.

## Architecture

Voice-first 3D hologram avatar driven by **Google Gemini Live** (speech-to-speech over WebSocket). The browser talks directly to Gemini using an ephemeral token; the Node server is a shell around five responsibilities: token minting, tool fulfilment, chart HTML delivery, connector proxying, and the agents/event bus.

### Request flow

1. Browser loads `public/holo_cylinder.html` (default, `/` → `/holo`) — or alternatives served by `/reflector`, `/avatar`, `/pyramid` — imports `@google/genai` from esm.sh, and hits `POST /session`.
2. `src/session.js` mints a short-lived token via `ai.authTokens.create` pre-bound with Momo's persona, tool schemas, voice, and response modalities. The browser uses `setupConfig` verbatim in `ai.live.connect()`. The real `GEMINI_API_KEY` never leaves the server.
3. Mic PCM (16 kHz, AudioWorklet in `public/pcm-worklet.js`) streams to Gemini; model audio (24 kHz PCM) streams back, runs through a "cute voice" WebAudio chain, and drives the avatar's mouth via an `AnalyserNode`.
4. When the model emits a `function_call`, the browser POSTs it to `/tool`, which dispatches via `src/tools/index.js`.
5. Chart/card tool calls return a `viz_id`; the browser mounts `<iframe src="/viz/:id">`, and the server replies with the pre-assembled HTML document.
6. Voice transcripts are batched client-side (`public/momo-ingest.js`) and POSTed to `/omo/ingest/momo`; the server turns them into `user_said` / `momo_said` events on the `/omo/ws` bus (`src/momo/ingest.js`).

### Tools (`src/tools/`)

Single registry in `index.js` maps tool name → `{ definition, run }`. `GEMINI_FUNCTION_DECLARATIONS` strips the OpenAI-style `type: 'function'` wrapper (Gemini's Live API doesn't use it); otherwise the `{name, description, parameters}` shape is shared.

Tool categories:
- **Data pull** — `orders`, `customers`, `products`, `ads`, `profile`, `snapshot` (daily CEO brief), `gmail_read`, `calendar` (next/agenda/upcoming), `tasks` (get/add/complete).
- **Actions** — `gmail_send`, `approve` (request approval dial).
- **Rendering** — `viz` (the main chart renderer), plus thin-wrapper card tools: `notify`, `qr`, `map`, `timer`, `now_playing`, `status`, `media`.
- **Research & delegation** — `hq_query` (queries the live event bus / HQ state), `web_search` (Tavily), `spawn_research_agent`, `spawn_agent_task`, `list_agent_tasks`, `agent` (control).

**Invariant: data tools return both a short summary AND a dataset `id`.** Full data goes into the server-side store; the model only ever references data by id. This is the single most important rule for avoiding chart hallucination. Enforced server-side too: `src/tools/viz.js` rejects intents with >8 numeric tokens.

### Dataset store (`src/store/datasets.js`)

In-memory Map with TTL (30 min) and LRU cap (200). IDs look like `orde_ab12cd`. When the model later calls `render_viz({ data_refs: [id] })`, the kitchen pulls the full dataset back out. **Never let a tool return raw numbers without also storing them here** — it breaks the id-referencing contract.

### The kitchen (`src/kitchen/`)

Converts `{ intent, data_refs, size, chart_type }` into a sandboxed HTML iframe document. Template-first, Gemini-fallback:

1. `index.js` resolves data_refs and picks a deterministic template from `templates/` or falls back to the generator. Cache key: `(chart_type, data_refs, size, intent-slug)` via `cache.js`.
2. `templates/` (see `templates/index.js` for the full re-export) covers far more than charts:
   - **Charts**: line, bar, donut, funnel, gauge, heatmap, waterfall, scatter, stacked_area, hbar_rank, comparison, kpi_grid, kpi_card.
   - **Stat / status**: stat, status_ring, notification_card, timeline.
   - **Mail / message cards**: email_card, email_thread, message_card.
   - **Finance cards**: payout_card, invoice_card, receipt_card.
   - **Planning cards**: event_card, agenda_card, task_card, checklist_card, daily_brief.
   - **Long-form**: report_card, memo_card, meeting_notes, changelog_card, pros_cons_card, swot_card, comparison_table, faq_card, bio_card, case_study_card, how_to_card, glossary_card, article_card, quote_card, profile_card.
3. On template miss or explicit fallback, `generator.js` calls Gemini (`VIZ_GEN_MODEL`) for a **body fragment only** — no `<html>/<head>/<body>`.
4. `sanitiser.js` rejects (doesn't strip) forbidden patterns on the fallback path: `fetch`, `eval`, `localStorage`, `window.parent`, inline event handlers, nested iframes, off-allowlist `<script src>`. Rejection triggers retry with error feedback (max 2).
5. `validator.js` does shape + reflector-safety checks (off-palette colours would show as haze on a real hologram).
6. `index.js::assembleDocument` owns the document shell: CSP header, base CSS, ECharts CDN `<script>`, `window.__DATA` injection, the `__READY`/`__FAIL` postMessage bridge, **and** the `holoVizCmd` listener that powers `highlight_viz`/`dismiss_viz`. **Templates and the generator never write this shell.** It's the security boundary.

The iframe has both a CSP meta (no `connect-src`, only allowlisted script hosts) and a parent-side `sandbox` attribute. Two fences, not one.

### Agents subsystem (`src/agents/` + `public/agent-sprites.js` + `public/agent-squads.js`)

Two delegation pathways, both funneling through a single event bus so the client sprite layer stays decoupled from the runtime.

**A. Quick research — `spawn_research_agent` (in-process Gemini)**
- File: `src/tools/spawn_agent.js`. IDs: `ra_xxxxxx`.
- Synchronous Gemini loop, 30s budget, 3 iterations max. Exposes `hq_query` + `web_search` sub-tools to the inner model.
- Model: `GEMINI_MODEL_AGENT` (defaults to a Flash tier).
- Broadcasts `agent:started` → `agent:tool_start` / `agent:tool_end` (per sub-tool call) → `agent:complete` (with findings + dataset_refs) or `agent:error`.

**B. Live browser work — `spawn_browser_agent` (Browserbase + Gemini)**
- File: `src/tools/spawn_browser_agent.js`. IDs: `btsk_xxxxxxxxxx`.
- Spins up a remote Chromium in Browserbase driven by a Stagehand + Gemini loop. Returns a `task_id` plus `live_view_url` immediately; the iframe streams onto `/agents-grid` so the user watches in real time.
- Agent display roster in `src/agents/registry.js`: **Aurora** (orchestrator), **Atlas** (research/web), **Cinder** (code/refactor), **Prism** (data/analysis), **Quill** (writing/comms). These are UX labels — the actual runtime is Browserbase.
- Broadcasts `task_spawn` → `task_progress` → `task_complete` (`result`, `findingId`, `durationMs`) or `task_error`.

**Bus plumbing.** `src/agents/bus.js::emit()` is the single seam — it calls `dataCore.emit()`, which fans events onto `/omo/ws` and into the 1000-deep event ring. Agent demo mode (the mock orchestrator heartbeat) also emits `message`, `agent_update`, `orch_update`, `budget_update` through this same seam. If you add a new agent event, add it here; do not open a new channel.

**Sprite rendering.** `public/agent-sprites.js` defines a `SpriteLayer` of THREE.js sprites (canvas texture, 256×256) with a `spawn / pop-in / runOff / loiter / returnWith / fail / bounce / shake / fading / dead` state machine. `installSpriteLayer()` subscribes to `/omo/ws` and **also wraps `window.fetch('/tool')`** so every tool call gets a sprite even if the server doesn't emit agent events. Tool → sprite colour mapping lives around lines 39–52.

**Squad rendering.** `public/agent-squads.js` adds a second layer that composes multiple sprites into a V-formation (captain + 3 scouts) per research agent. `SquadLayer.handleMessage()` routes `agent:tool_start/end` to individual scouts and `agent:complete` back to the captain. Station geometry maps `hq_query` → left desk, `web_search` → right desk. Six round-robin anchor formations space consecutive squads around the avatar; cap 3 concurrent, 40 s leak timeout.

**HQ / second screen.** `public/agents_grid.html` (served at `/agents-grid`) is a terminal-style 4-slot agent roster driven by a separate `/agents/ws` WebSocket (`src/agents/terminals.js`). Intended as a second physical display alongside the hologram.

### External integrations (`src/connectors/` + `src/projection/`)

Real APIs, not mocks (the `dataCore` mock producers are fallbacks):

- **Stripe** — `src/connectors/stripe.js`. Restricted read key. Routes under `/omo/api/integrations/stripe/*`. Live charges, MRR, subs, payouts.
- **Meta Ads** — `src/connectors/meta.js`. Graph API v19.0. `/omo/api/integrations/meta/*`. Env: `FB_ACCESS_TOKEN`, `FB_AD_ACCOUNT_ID`.
- **Gmail** — `src/connectors/gmail.js`. OAuth via `src/connectors/google.js`. Scopes: `gmail.modify`, `gmail.send`. Polls history every `GMAIL_POLL_MS`.
- **Google Drive / Docs** — `src/connectors/google_drive.js`, `google_docs.js`. Shares the Gmail OAuth flow. Activity feed at `/omo/api/google/docs/:fileId/activity`.
- **Neon Postgres** — `src/connectors/neon.js`. Mounted at boot as a data source for the data tools.

**OAuth flow (Google):** `/auth/google/start` → Google consent → `/auth/google/callback` prints the refresh token into the server log; paste it into `.env` as `GOOGLE_REFRESH_TOKEN`, restart. The callback also persists to `~/.omo/google-token.json`.

**Live projections (`src/projection/`):** bypass the voice round-trip for high-signal events. `stripe_live.js` and `gmail_live.js` watch connector streams and directly emit viz cards (invoice_card, email_card, etc.) onto the hologram — so a new Stripe payment can pop up as a card without Momo having to call a tool. `broadcast.js` is the shared helper.

### Data Core (`src/dataCore.js`)

In-memory event ring (1000-deep), pub/sub bus, and mock producers (Gmail / Stripe / Meta Ads / transcript) consumed by `/hq` and the agents backend. The module owns its own Express routes and WebSocket:
- `mountRoutes(app)` registers `/omo/api/events`, `/omo/api/stats`, `/omo/api/mock/trigger`.
- `mountWebSocket(httpServer)` sets up `/omo/ws`: 100-event snapshot on connect, live broadcast, **and inbound `audio_chunk` + `ambient_transcript` message types** — the hooks for always-on listening.
- `startMocks()` seeds history and runs the loops. `markSourceLive(key)` is how connectors tell the mocks to stand down.

### Ambient listening (stubbed — intentional)

The 24/7-mic pillar of the vision is currently a stub. What exists:

- **Client → server channel** is wired: `public/pcm-worklet.js` can stream PCM, and `/omo/ws` accepts `audio_chunk` (routed to `handleAudioChunk()` in `dataCore.js`) and `ambient_transcript` (routed to `src/momo/ambient.js`).
- **Transcription and persistence** are not wired. `src/momo/ambient.js` is an explicit stub — its comment notes the full pipeline was *"deliberately NOT ported from 1fbf99b (it regresses the voice/chart flow). Remove the stub once the real ambient pipeline is reintroduced."*
- Prior commit (`1fbf99b`) had Web Speech API bilingual recognizers (zh-CN + en-US) running continuously, writing utterances to `data/transcripts/YYYY-MM-DD.jsonl` and to Neon via `integrationDb` under `source:"transcript"`, plus a `/omo/api/integrations/transcript/plaintext` dump that fed Momo's system prompt with recent context.
- The HQ `transcript` panel is still mock-fed from `dataCore.js` lines ~318–353; it does not reflect real ambient state.

The conversational-mic path (`momo-ingest.js` → `/omo/ingest/momo` → `src/momo/ingest.js`) is unrelated to ambient and works fine — it only fires during an active Gemini Live turn.

### Persona & tool contract

`src/session.js::MOMO_INSTRUCTIONS` defines Momo's voice and, critically, the **data → viz → narrate** workflow the model must follow. The rule "never put numeric values into render_viz arguments" is enforced server-side in `src/tools/viz.js`. If you change the tool set, update both the registry and the instruction block — token minting bakes the tool schemas into the ephemeral session config at `/session` time, so changes need a server restart to take effect.

### Client pages

- `public/holo_cylinder.html` — default (`/` → `/holo`). Cylindrical holo-projector layout.
- `public/holo_reflector.html` — `/reflector`. Minimal-chrome black-background for tilted-glass reflectors.
- `public/holo_avatar.html` — `/avatar`. Full UI + Looking Glass WebXR entry button.
- `public/holo_pyramid.html` — `/pyramid`. 4-view Pepper's Ghost layout.
- `public/hq.html` — `/hq`. Terminal-aesthetic command center. Five panels (stripe / meta / gmail / drive / transcript) start blurred behind `[ NOT CONNECTED ]` until unlocked via the connect modal. **Stripe/Meta use a "fake OAuth" path** (paste a key → stored in `localStorage` under `momo.hq.integrations`, POSTed to `/omo/api/integrations/{key}/connect`). **Gmail/Drive use real Google OAuth** via `/auth/google/start`. Double-click the topbar `integ n/5` counter to reset local state.
- `public/agents_grid.html` — `/agents-grid`. 4-slot agent terminal grid; subscribes to `/agents/ws`.
- `public/squad.html` — `/squad`. The main agent control surface (hologram + sprites + chat + single-agent monitor). Topbar **grid** button (or `G` key) summons a full-page multi-terminal overlay (see "Squad grid overlay" below). `/grid` and `/feather` both redirect to `/squad?grid=1` for back-compat.

**Squad grid overlay (`public/squad-grid.js`)** — the multi-terminal view that used to live at `/feather` is now an on-demand overlay inside /squad. Same lifecycle as /feather did: PeekStream byte-ring per agent, ANSI-scrubbed peek tiles for unmounted agents, full xterm on the stage tiles, four layout modes (`mosaic` / `zoom1` / `zoom2` / `zoom4`), permission-menu detection + chime + top banner, voice bridge that accepts `source: 'feather' | 'squad_grid'` focus events. The module is self-contained (its own DOM appended to `body`, scoped CSS via `.sg-root`), owns its own WSs (independent of /squad's monitor session pool — the server-side PTY supports multiple attachments). Mount once via `import { mountSquadGrid } from '/squad-grid.js'` then call `.open() / .close() / .toggle() / .focusAgent(id)`. URL params: `?grid=1` opens on load, `&focus=<agent>` zooms a tile.

`avatar.js` is the shared Three.js avatar + scene module. `chart-layer.js` handles mounting viz iframes on the 3D stage. HTML/JS are served with `Cache-Control: no-store` so edits show up on refresh without a hard reload.

### /automation — Holo3 vision agent (optional · `src/holo3/`)

Self-contained sidecar. Lets the user type a goal ("open Spotify and play Lorde") and watch H Company's Holo3 VLM drive a screen step by step. Nothing else in omo depends on it; gated entirely on `HAI_API_KEY`. Modules live in **`src/holo3/`**:

- `index.js` — proxies `https://api.hcompany.ai/v1/chat/completions`. Owns the system prompt + JSON-schema per **profile** (`mac` | `browser` | `desktop`) and exposes `POST /omo/api/holo3/step → {note, thought, tool_call, pixel_xy}`. Body limit is bumped to 12 MB just for this route (in `server.js`) because every step ships up to 3 screenshots. The `mountRoutes(app)` export wires this route **plus** both bodies in one call.
- `browser.js` — Browserbase Chromium "body". Reuses `src/agents/browserbase.js::createSession` so all Browserbase config (region, proxies, advanced stealth) is inherited. Endpoints under `/omo/api/holo3-browser/*`. Uses Playwright over CDP; supports `click_mouse / type / scroll / press_keys / navigate / screenshot`.
- `mac.js` — Local macOS "body". Spawns **one** long-running Python child per session (`bin/holo3_mac.py` + pyautogui). NDJSON over stdin/stdout — pays the ~600 ms pyautogui import once at `/launch`, so per-action latency drops from ~800 ms to ~50 ms. Endpoints under `/omo/api/holo3-mac/*`. Falls back to a clean 503 with install instructions if pyautogui isn't installed.

Front-end is one file: **`public/automation.html`**. Top-right dropdown picks "your mac (local)" or "remote browser (browserbase)"; the JS swaps the API base URL and the `profile` field sent to `/step`. When there's no live stream (mac mode), the latest screenshot is rendered into the canvas after each step. A red crosshair pulses on every click target.

Python venv: defaults to `~/holo3-trial/.venv` or `~/.omo/holo3-venv`. Override with `HOLO3_MAC_PYTHON=…`. macOS will block clicks until that interpreter has Accessibility (System Settings → Privacy & Security → Accessibility). Slamming the mouse into the top-left corner triggers pyautogui's FAILSAFE.

If you delete this feature: the only references are the import + `app.get('/automation', …)` block in `server.js`, `public/automation.html`, `src/holo3/`, and `bin/holo3_mac.py`.

### The AI coding loop (worktrees + the four review tools)

When `spawn_agent_task` dispatches a coding agent (Claude or Hermes), the coordinator runs it inside a **per-agent git worktree** at `~/.omo/worktrees/<agent_id>/`. The worktree is the linchpin of the loop — it keeps the agent's edits separated from the user's main checkout AND from other concurrent agents.

**Why a worktree per agent (not per task):** Claude Code stores session history per-cwd at `~/.claude/projects/<encoded-cwd>/`. If the cwd changes between tasks, `claude --resume <session_id>` can't find the prior conversation. Worktree is keyed on `agent.identity.id` so consecutive replies / follow-ups land in the same cwd and the resume succeeds.

**Lifecycle (src/runtimes/worktree.js + src/hermes/index.js):**
1. **Create** — `setupWorktree(parentRepo, agent_id)` on first dispatch. Detached HEAD; reuses the existing dir if healthy (survives server restart).
2. **Reuse** — subsequent tasks for the same agent reuse `agent.worktree`. Self-heals if the dir was deleted (drops handle, recreates).
3. **Linger** — when the agent goes idle, the reaper waits `LINGER_MS` (5 min) before tearing down. If the worktree has uncommitted changes, the window extends to `REVIEW_LINGER_MS` (30 min) so the user has time to review/accept/discard. The squad workspace row shows the countdown chip + a Keep button that bumps `lastActivityAt` to "now".
4. **Reap** — on `reapAgent()`, `worktree.cleanup()` runs `git worktree remove --force` + `rm -rf`. Also runs on process exit (SIGTERM/SIGINT) via `hermes.shutdown()` from `server.js`'s shutdown handler.
5. **Startup sweep** — on `hermes.start()`, `sweepStaleWorktrees(parentRepo, [])` prunes any dir under `~/.omo/worktrees/` that no live agent owns. Cleans up after a server crash.

**Failure policy — `OMO_WORKTREE_MODE` env:**
- `off` (**default**) — skip worktrees entirely; the agent operates directly on `parentRepo` (the user's checkout). Single-user dev with no concurrent agents — the current shape of the product. `src/hermes/index.js:87`.
- `optional` — try to set up a worktree; fall back to `parentRepo` on setup failure. Surfaces as a one-time degraded run.
- `required` — if setup fails, throw `WORKTREE_FAILED` from `dispatchTask` and roll back the agent's seat. Never accidentally edits the user's real checkout.

When the default (`off`) is in use, the rest of this section (lifecycle, sweep, reap, linger, sync_user_edits) is dormant — but the code paths still exist for the day worktrees come back. The four review tools below operate on the parent repo when worktrees are off.

**The four loop tools (src/tools/{peek,accept,discard,sync}_agent_*):** thin wrappers around `src/runtimes/worktree_diff.js`.
- `peek_agent_diff({ agent, verbose? })` — read-only inspection. Returns file list, +/− stat, and `preview_url`. Voice asks; Momo can also `show_pane({ page: 'preview-diff', agent })` to project the visual diff on the hologram.
- `accept_agent_work({ agent, mode })` — `mode` ∈ `apply` (default — `git apply` onto parent, unstaged), `stage` (`--cached`), `commit` (auto-branch + commit), `dry_run`, or `stash_and_apply` (conflict-recovery: stashes user's edits → applies agent's → reapplies user's). On `CONFLICT`, returns `conflicting_paths`. The voice tool note teaches Momo to offer the user three recovery options.
- `discard_agent_work({ agent })` — `git reset --hard HEAD && git clean -fdx` in the worktree. Agent stays seated.
- `sync_user_edits({ agent })` — copy the user's uncommitted edits from `parentRepo` INTO the worktree before next dispatch. Lets the agent pick up where the user left off without committing.

**HTTP API (server.js):**
- `GET  /preview-diff?agent=<ref>` — the visual diff page (`public/preview-diff.html`). File tree + unified diff + Accept/Discard/Branch buttons.
- `GET  /omo/api/agents/:ref/diff` — JSON: `{ ok, files, stat, diff_text, is_busy }`.
- `POST /omo/api/agents/:ref/accept` — body `{ mode, branch?, commit_message?, force? }`.
- `POST /omo/api/agents/:ref/discard`
- `POST /omo/api/agents/:ref/sync-user-edits`
- `POST /omo/api/agents/:ref/keep` — extend linger.
- `GET  /omo/api/hermes/worktrees` — inventory of every dir under `~/.omo/worktrees/` with disk usage, status (active vs orphan), changes summary.
- `POST /omo/api/hermes/agents/:ref/reap` — force-reap (body `{ force }` to interrupt a busy agent).

**Squad UI (public/squad.html):** Above the monitor compose, a workspace action row shows files-changed stat + linger countdown chip + Preview / Sync / Discard / On branch… / Accept buttons. Sidebar has a collapsible worktrees panel listing all on-disk worktrees with Reap buttons.

**Persona (src/session.js):** the MOMO_INSTRUCTIONS section under "Agent 完工后的 'AI coding loop'" teaches Momo to: auto-call `peek_agent_diff` on `task_complete` to surface file counts in the completion narration; offer preview/ship/scrap as the default follow-up; handle CONFLICT by offering three recovery paths (stash-and-apply, branch instead, or wait for the user to commit).

## Adding a new data tool

1. Create `src/tools/foo.js` exporting `definition` and `run`. In `run`, compute the data, call `store.put('foo_kind', data)`, return `{ id, ...summary }`.
2. Register it in `src/tools/index.js::REGISTRY`.
3. Mention it in `MOMO_INSTRUCTIONS` (`src/session.js`) under "Tools — data" so the model knows to reach for it.
4. Restart — token minting bakes schemas into the session config.

## Adding a new kitchen template

1. Create `src/kitchen/templates/foo.js` exporting a body-fragment renderer — never a full HTML document.
2. Re-export from `src/kitchen/templates/index.js` and add the match rule in `src/kitchen/templates.js` (or the module equivalent) so `(chart_type, data shape)` routes to it.
3. Keep it reflector-safe: stick to the existing palette. `validator.js` will reject off-palette output.
4. Do not inject scripts, `<link>` tags, or alter the document shell — `assembleDocument` owns that.

## Adding a new agent event

1. Emit via `src/agents/bus.js::emit()` — do not call `dataCore.emit` directly from agent code.
2. If it's a lifecycle event that should drive sprites, handle it in `installSpriteLayer()` (`public/agent-sprites.js`) and/or `SquadLayer.handleMessage()` (`public/agent-squads.js`).
3. For tool-call visualisation only, you may not need a new event at all — the client wraps `fetch('/tool')` and will spawn a sprite automatically.

## Adding a new connector

1. Put the HTTP client + routes in `src/connectors/foo.js`. Expose `start()` (boot-time init) and `mountRoutes(app)` (registers `/omo/api/integrations/foo/*`, including `status`, `connect`, and ideally `plaintext`).
2. Wire `start()` + `mountRoutes` in `server.js`; call `dataCore.markSourceLive('foo')` once the real connection succeeds so the mock producer stands down.
3. If it publishes high-signal events worth projecting directly onto the hologram, add a matching `src/projection/foo_live.js` that emits card viz_ids without going through a tool call.
4. Add a panel entry to `public/hq.html` (panels block around lines 1164–1300, modal glue around 2609–3075).

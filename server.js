// Omo boot script. Responsibilities are kept thin here: create the Express
// app, mount route groups in the right order, stand up the HTTP + WS
// servers, and start the Data Core mock producers. Per-subsystem logic
// lives in src/ (session, tools, kitchen, dataCore).

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import { mintSession, SESSION_META, startTokenPrefetch } from './src/session.js';
import { attachVoiceWebSocket } from './src/voice/ws.js';
import { ensureWhisperAvailable } from './src/voice/stt.js';
import { ensureTtsAvailable } from './src/voice/tts.js';
import { runTool, getViz, REGISTRY as TOOL_REGISTRY } from './src/tools/index.js';
import * as datasetStore from './src/store/datasets.js';
import * as projectableStore from './src/store/projectables.js';
import * as db from './src/db.js';
import * as dataCore from './src/data_core.js';
import * as logs from './src/logs/bus.js';
import * as agents from './src/agents/index.js';
import * as hermes from './src/hermes/index.js';
import * as claudePtyWs from './src/runtimes/claude_pty_ws.js';
import * as claudePty from './src/runtimes/claude_pty.js';
import * as hermesPtyWs from './src/runtimes/hermes_pty_ws.js';
import * as hermesPty from './src/runtimes/hermes_pty.js';
import * as momoIngest from './src/momo/ingest.js';
import * as momoView from './src/momo/view.js';
import * as stripeConnector from './src/connectors/stripe.js';
import * as metaConnector from './src/connectors/meta.js';
import * as neonConnector from './src/connectors/neon.js';
import * as google from './src/connectors/google.js';
import * as gmailConnector from './src/connectors/gmail.js';
import * as googleDrive from './src/connectors/google_drive.js';
import * as googleDocs from './src/connectors/google_docs.js';
import * as githubConnector from './src/connectors/github.js';
import * as voicePreview from './src/voice_preview.js';
import * as onboarding from './src/onboarding.js';
import * as textChat from './src/text_chat.js';
import * as localVoice from './src/local_voice/index.js';
import * as holo3 from './src/holo3/index.js';
import * as squadLayout from './src/squad_layout.js';
import * as previewBus from './src/preview/bus.js';
import * as previewAcks from './src/preview/acks.js';
import * as previewAgentWorktree from './src/preview/agent_worktree.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = process.env.PORT || 8080;
// Bind to loopback by default: this server exposes agent terminals and live
// business connectors. Set HOST=0.0.0.0 only on a network you trust.
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

// ─── Env + process-level guards ───────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('[holoscope] Missing GEMINI_API_KEY in .env');
}
process.on('unhandledRejection', (reason) => console.error('[holoscope] unhandledRejection', reason));
process.on('uncaughtException', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[holoscope] port ${PORT} is in use. Free it with: lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  }
  console.error('[holoscope] uncaughtException', err);
});

// Event-loop lag detector. Schedules a 200ms heartbeat; if it fires more
// than 300ms late, the Node event loop was blocked for that long. While
// blocked, no /tool replies, no /omo/ws frames, and no Gemini Live audio
// can flow — the cylinder appears to crash. The log line includes
// rough memory pressure so we can correlate stalls with backfill work.
(() => {
  const TICK_MS = 200;
  const LAG_THRESHOLD_MS = 300;
  let lastTick = Date.now();
  let stallStreak = 0;
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - TICK_MS;
    lastTick = now;
    if (lag > LAG_THRESHOLD_MS) {
      stallStreak += 1;
      const tag = stallStreak > 1 ? ` (#${stallStreak})` : '';
      const mem = process.memoryUsage();
      const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
      const rssMB  = (mem.rss      / 1024 / 1024).toFixed(0);
      console.warn(`[loop] ⏱ event-loop blocked ${lag}ms${tag} · heap=${heapMB}MB rss=${rssMB}MB`);
    } else {
      stallStreak = 0;
    }
  }, TICK_MS).unref();
})();

// Server heartbeat — every 30s, log a one-line snapshot of process
// state. If logs go silent for >30s we know the Node process itself
// is wedged (otherwise this line would print). Also lets us watch
// memory growth for slow leaks across long sessions.
(() => {
  const HEARTBEAT_MS = 30_000;
  setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
      const rssMB  = (mem.rss      / 1024 / 1024).toFixed(0);
      const uptimeMin = (process.uptime() / 60).toFixed(1);
      console.log(`[♥] server · uptime=${uptimeMin}m · heap=${heapMB}MB · rss=${rssMB}MB`);
    } catch { /* ignore */ }
  }, HEARTBEAT_MS).unref();
})();

// Holo3 step requests ship screenshots in the body (current frame + up to
// ~2 history frames). At 1512×982 JPEG q60 each frame is ~90 KB, so we
// bump just this route to 12 MB. The path-specific parser runs BEFORE
// the global 256 KB one; body-parser skips re-parsing once req._body is set.
app.use('/omo/api/holo3/step', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '256kb' }));

// ─── Preview-bridge auto-injection ────────────────────────────────────
// Every HTML page omo serves (its own pages OR any future page that
// rides through res.sendFile) gets <script src="/preview-bridge.js">
// injected before </head>. That bridge listens for voice-driven nav
// commands from the /preview parent and executes them against the DOM.
//
// Skips:
//   • preview.html itself (it's the relay, not the host)
//   • any file already carrying the bridge marker (idempotent)
//   • non-HTML files (only .html paths trigger this branch)
//
// Implementation: wrap res.sendFile so route handlers don't need to
// know about the injection. We read the file once, splice the tag in,
// send the string. Costs one synchronous fs read per HTML response —
// trivial for the dev workload, and the static middleware below is
// untouched (it serves JS/CSS/PNG, not these routes' HTML).
// Two scripts injected as one pair (so the marker check stays simple):
//   1. preview-bridge.js — voice nav into pages inside /preview iframes.
//   2. agent-review-bridge.js — handles SHIP/SCRAP/PREVIEW button
//      postMessages from the agent_review_card.
const BRIDGE_TAG = '<script src="/preview-bridge.js" async data-omo-bridge></script><script src="/agent-review-bridge.js" async data-omo-bridge></script>';
app.use((req, res, next) => {
  const orig = res.sendFile.bind(res);
  res.sendFile = function (path, opts, cb) {
    try {
      if (typeof path === 'string'
          && /\.html?$/i.test(path)
          && !/[\\/]preview\.html$/i.test(path)) {
        // Read sync — these files are small (<3 MB even for /squad), and
        // doing it async here would deny us the easy splice.
        let html = readFileSync(path, 'utf8');
        if (!html.includes('data-omo-bridge')) {
          if (html.includes('</head>'))      html = html.replace('</head>', `  ${BRIDGE_TAG}\n  </head>`);
          else if (/<body[\s>]/i.test(html)) html = html.replace(/<body([\s>])/i, `${BRIDGE_TAG}\n<body$1`);
          else                                html = BRIDGE_TAG + '\n' + html;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }
    } catch (err) {
      // Read or transform failed — fall through to the original
      // sendFile so the page still serves (just without the bridge).
      console.warn('[bridge] inject skipped for', path, '·', err?.message || err);
    }
    return orig(path, opts, cb);
  };
  next();
});

// ─── Browser log forwarder ────────────────────────────────────────────
// client-log.js batches console output, window errors, and unhandled
// rejections and POSTs (or sendBeacon's) them here so they show up in
// the Node terminal alongside server logs.
app.post('/log', express.json({ type: '*/*', limit: '256kb' }), (req, res) => {
  const entries = Array.isArray(req.body?.logs) ? req.body.logs : [];
  for (const e of entries) {
    const level = ['log', 'info', 'warn', 'error', 'debug'].includes(e?.level) ? e.level : 'log';
    const tag = `[client ${e.sid || '-'} ${e.page || '-'}]`;
    const args = Array.isArray(e.args) ? e.args : [];
    const extras = [];
    if (e.source) extras.push(`at ${e.source}:${e.line || '?'}:${e.col || '?'}`);
    if (e.stack) extras.push('\n' + e.stack);
    const out = console[level] || console.log;
    out(tag, ...args, ...extras);
  }
  res.status(204).end();
});

// ─── Hologram page routes (friendly URLs) ─────────────────────────────
app.get('/',          (_req, res) => res.sendFile(join(PUBLIC_DIR, 'holo_cylinder.html')));
app.get('/holo',      (_req, res) => res.redirect('/'));
app.get('/reflector', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'holo_reflector.html')));
app.get('/avatar',    (_req, res) => res.sendFile(join(PUBLIC_DIR, 'holo_avatar.html')));
app.get('/pyramid',   (_req, res) => res.sendFile(join(PUBLIC_DIR, 'holo_pyramid.html')));
// ─── HQ command-center dashboard ──────────────────────────────────────
// Terminal-aesthetic dashboard with blur-gated integration panels
// (stripe / meta / gmail / drive / transcript). See public/hq.html.
app.get('/hq', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'hq.html')));
// ─── Squad (pixel office — Hermes agent visualization) ────────────────
// Single second-screen view of what each Hermes slot is doing. Pair with
// /holo (voice) on a second monitor for the full workstation experience.
// /agents-grid was the previous terminal-aesthetic version; it has been
// retired in favor of /squad and its routes removed. The html file
// remains in public/ for reference but is no longer served.
app.get('/squad',       (_req, res) => res.sendFile(join(PUBLIC_DIR, 'squad.html')));
app.get('/grid',        (_req, res) => res.redirect('/squad?grid=1'));
// ─── /feather → /squad?grid=1 (legacy redirect) ───────────────────────
// /feather was the standalone tiled-terminal page. It's been folded into
// /squad's grid overlay (public/squad-grid.js), reached via the topbar
// "grid" button or the G key. Old bookmarks land in the same view with
// the overlay pre-opened.
app.get('/feather',     (_req, res) => res.redirect(302, '/squad?grid=1'));
// ─── /test-2 — tool sandbox ──────────────────────────────────────────
// Dev surface: lists every registered /tool entry, surfaces its
// parameter schema, and lets you POST hand-edited JSON at /tool to see
// the raw response. Useful for poking at connectors without going
// through Gemini Live.
app.get('/test-2',      (_req, res) => res.sendFile(join(PUBLIC_DIR, 'test-2.html')));
app.get('/omo/api/tools', (_req, res) => {
  const tools = Object.entries(TOOL_REGISTRY).map(([name, entry]) => ({
    name,
    description: entry?.definition?.description || '',
    parameters:  entry?.definition?.parameters  || null,
  }));
  res.json({ ok: true, tools });
});
// Mint a fresh agent identity + live PTY for the /feather + button.
// Same wiring as the claude-pty-ws spawn handler, but reachable as HTTP
// so the page knows the real agent_id before it opens the terminal WS.
// /feather posts here when it detects an agent's terminal parked on a
// permission prompt or y/n prompt. We re-emit onto the shared dataCore
// bus so the same event lands in /omo/ws (for any other live UI), the
// event log, and — eventually — Momo's brain. Body is best-effort and
// strictly bounded to keep this endpoint un-attackable.
app.post('/omo/api/feather/awaiting-input', (req, res) => {
  const body = req.body || {};
  const agent_id = String(body.agent_id || '').slice(0, 64);
  const name     = String(body.name || '').slice(0, 64);
  const kind     = ['menu', 'yn'].includes(body.kind) ? body.kind : 'unknown';
  const question = String(body.question || '').slice(0, 200);
  if (!agent_id) return res.status(400).json({ ok: false, error: 'agent_id required' });
  try {
    dataCore.emit({
      source: 'feather',
      kind: 'awaiting_input',
      data: { agent_id, name, prompt_kind: kind, question },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/omo/api/feather/agent', async (req, res) => {
  try {
    const requestedRuntime = String(req.body?.runtime || 'claude').toLowerCase();
    const r = await hermes.ensureAgentForPty(null, {
      runtime: requestedRuntime,
      permissionMode: req.body?.permission_mode || 'bypassPermissions',
      model: req.body?.model || null,
      repoPath: req.body?.repo_path || null,
    });
    const agent = hermes.listAgents().find((a) => a.agent_id === r.agent_id);
    res.json({
      ok: true,
      agent_id: r.agent_id,
      name: r.name || agent?.name,
      color: agent?.color || null,
      sigil: agent?.sigil || null,
      cwd: r.cwd || null,
      worktree_path: r.worktree_path || null,
      runtime: r.runtime || requestedRuntime,
      alive: !!r.alive,
    });
  } catch (err) {
    const code = err?.code || null;
    const status = code === 'NO_SEAT' ? 503
                 : code === 'NOT_INSTALLED' ? 503
                 : code === 'WORKTREE_FAILED' ? 500
                 : 500;
    res.status(status).json({ ok: false, error: String(err?.message || err), code });
  }
});
// /claude-deck — the multi-pane "war room" used to live here as a parallel
// surface. It's been absorbed into /squad — opening the monitor and clicking
// the @live tab gives the same xterm + split modes (1×/2×/3×/4×) in the
// same beautiful chrome as the rest of the squad page. The old URLs redirect
// so external links / show_pane('claude-deck') still resolve to the unified
// surface. Pass ?term=<agent[,agent…]>&split=<n> to pre-bind panes.
app.get('/claude-deck',         (_req, res) => res.redirect(302, '/squad?term=*&split=auto'));
app.get('/claude-deck/:agent',  (req, res) => {
  const ref = encodeURIComponent(String(req.params.agent || ''));
  res.redirect(302, `/squad?term=${ref}&split=1`);
});
// PTY status feed — drives the green-dot indicators on squad sidebar agent
// rows so the user sees at a glance which agents have a live Claude Code
// terminal currently spawned. Polled every ~2.5s by the squad client.
app.get('/omo/api/claude-pty/status', (_req, res) => {
  try {
    const sessions = claudePty.listSessions();
    const by_agent_id = {};
    for (const s of sessions) by_agent_id[s.agent_id] = s;
    res.json({ ok: true, sessions, by_agent_id, count: sessions.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
// Same shape, but for Hermes PTYs — squad sidebar uses both feeds so the
// runtime-agnostic green dot fires whether the agent is on claude OR hermes.
app.get('/omo/api/hermes-pty/status', (_req, res) => {
  try {
    const sessions = hermesPty.listSessions();
    const by_agent_id = {};
    for (const s of sessions) by_agent_id[s.agent_id] = s;
    res.json({ ok: true, sessions, by_agent_id, count: sessions.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
// /preview-diff was the older diff-only review surface. /preview-agent
// is strictly richer (file tabs, LIVE/DIFF toggle, SHIP/SCRAP buttons in
// one place), so /preview-diff now redirects there. Existing voice
// `show_pane({page:'preview-diff', agent})` calls + bookmarks still work.
app.get('/preview-diff', (req, res) => {
  const ref = String(req.query.agent || '').trim();
  res.redirect(302, ref ? `/preview-agent/${encodeURIComponent(ref)}` : '/squad');
});
// HERMES DASHBOARD ROUTE — wraps the built-in Hermes web dashboard
// (started by `hermes dashboard --no-open` at http://localhost:9119) in
// an iframe-host page so voice show_pane({page:'hermes-dashboard'}) can
// project it onto the holo. See public/hermes_dashboard.html.
app.get('/hermes-dashboard', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'hermes_dashboard.html')));
// JSON API for the page + the squad UI buttons. The agent reference
// can be an id, a name, or a prefix — hermes resolves it.
app.get('/omo/api/agents/:ref/diff', (req, res) => {
  try {
    const out = hermes.peekAgentDiff(String(req.params.ref || ''));
    if (!out.ok) return res.status(404).json(out);
    const text = hermes.getAgentDiffText(String(req.params.ref || ''));
    res.json({ ...out, diff_text: text?.ok ? text.text : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
app.post('/omo/api/agents/:ref/accept', async (req, res) => {
  try {
    const out = await hermes.acceptAgentWork(String(req.params.ref || ''), {
      mode: req.body?.mode || 'apply',
      branch: req.body?.branch || null,
      commitMessage: req.body?.commit_message || null,
      force: !!req.body?.force,
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
app.post('/omo/api/agents/:ref/discard', async (req, res) => {
  try {
    res.json(hermes.discardAgentWork(String(req.params.ref || '')));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
app.post('/omo/api/agents/:ref/sync-user-edits', async (req, res) => {
  try {
    res.json(await hermes.syncUserEdits(String(req.params.ref || '')));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ─── /feather review surface ──────────────────────────────────────────
// With OMO_WORKTREE_MODE=off agents edit ~/omo directly, so "review" is
// just inspecting the current dirty state of the main checkout. These
// endpoints power the slide-up review panel in /feather:
//   GET  /omo/api/main/changes  → list of git-modified files + diff
//   POST /omo/api/main/revert   → git restore / clean for selected paths
// Repo path = process.cwd() (omo's server boots from ~/omo).
function mainRepoPath() { return process.cwd(); }
app.get('/omo/api/main/changes', (_req, res) => {
  try {
    const repo = mainRepoPath();
    // Porcelain v1 is stable and easy to parse. Two-char status prefix +
    // path. The trailing -z would be safer for paths-with-spaces but we
    // don't have those in this repo; plain newline split is fine.
    const status = spawnSync('git', ['-C', repo, 'status', '--porcelain=v1'], {
      encoding: 'utf8', timeout: 8000,
    });
    if (status.status !== 0) {
      return res.json({ ok: false, error: status.stderr?.trim() || 'git status failed' });
    }
    const lines = (status.stdout || '').split('\n').filter(Boolean);
    const files = lines.map((line) => {
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      const untracked = code === '??';
      return { path, status: code.trim() || 'M', untracked };
    });
    // Per-file numstat (tracked changes only — untracked files aren't in
    // diff). We synthesize +N for untracked by counting lines from disk.
    const numstat = spawnSync('git', ['-C', repo, 'diff', '--numstat'], {
      encoding: 'utf8', timeout: 8000,
    });
    const numMap = {};
    for (const line of (numstat.stdout || '').split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) numMap[m[3]] = {
        added: m[1] === '-' ? null : parseInt(m[1], 10) || 0,
        removed: m[2] === '-' ? null : parseInt(m[2], 10) || 0,
      };
    }
    for (const f of files) {
      const n = numMap[f.path];
      if (n) { f.added = n.added; f.removed = n.removed; }
      else if (f.untracked) {
        try {
          const full = join(repo, f.path);
          if (existsSync(full)) {
            const st = statSync(full);
            if (st.isFile()) {
              const lines = readFileSync(full, 'utf8').split('\n').length;
              f.added = lines;
              f.removed = 0;
            }
          }
        } catch {}
      }
    }
    const totalAdded   = files.reduce((s, f) => s + (f.added   || 0), 0);
    const totalRemoved = files.reduce((s, f) => s + (f.removed || 0), 0);
    // One big diff text for the inline-diff view (non-renderable files).
    // Untracked files don't show in plain `git diff`; include them via
    // --no-index against /dev/null. Skip if there are too many.
    let diffText = '';
    if (files.length <= 64) {
      const trackedDiff = spawnSync('git', ['-C', repo, 'diff'], { encoding: 'utf8', timeout: 10000 });
      diffText += trackedDiff.stdout || '';
      for (const f of files.filter((x) => x.untracked)) {
        const untrackedDiff = spawnSync('git', ['-C', repo, 'diff', '--no-index', '--', '/dev/null', f.path], {
          encoding: 'utf8', timeout: 5000,
        });
        // `git diff --no-index` exits 1 when there is a diff — still valid.
        if (untrackedDiff.stdout) diffText += '\n' + untrackedDiff.stdout;
      }
    }
    res.json({
      ok: true,
      files,
      stat: { fileCount: files.length, added: totalAdded, removed: totalRemoved },
      diff_text: diffText,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
app.post('/omo/api/main/revert', (req, res) => {
  try {
    const repo = mainRepoPath();
    const requested = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const paths = requested
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      // Defence: keep paths inside the repo. Reject anything that escapes
      // via `..` or absolute paths. `git restore` would refuse anyway but
      // the explicit check is cheap.
      .filter((p) => !p.startsWith('/') && !p.startsWith('..') && !p.includes('/../'));
    if (!paths.length) return res.json({ ok: false, error: 'no paths to revert' });
    // Split tracked vs untracked. Tracked → restore (works for both
    // staged and unstaged modifications). Untracked → clean + force.
    const tracked = [];
    const untracked = [];
    for (const p of paths) {
      const r = spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', p], {
        encoding: 'utf8', timeout: 4000,
      });
      if (r.status === 0) tracked.push(p);
      else untracked.push(p);
    }
    const errors = [];
    if (tracked.length) {
      // --staged + --worktree together: undo whether staged or not.
      const r = spawnSync('git', ['-C', repo, 'restore', '--staged', '--worktree', '--', ...tracked], {
        encoding: 'utf8', timeout: 10000,
      });
      if (r.status !== 0) errors.push(r.stderr?.trim() || 'restore failed');
    }
    if (untracked.length) {
      // -f for force, -d for directories. Pass paths explicitly so we never
      // accidentally wipe more than asked.
      const r = spawnSync('git', ['-C', repo, 'clean', '-fd', '--', ...untracked], {
        encoding: 'utf8', timeout: 10000,
      });
      if (r.status !== 0) errors.push(r.stderr?.trim() || 'clean failed');
    }
    if (errors.length) return res.json({ ok: false, error: errors.join(' · '), reverted: [...tracked, ...untracked].filter(Boolean) });
    res.json({ ok: true, reverted: paths, tracked, untracked });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Have the agent fix a merge conflict between their work and the user's
// checkout. Body: { conflicting_paths?: string[], hint?: string }.
// Wraps the resolve_agent_conflict voice tool so the squad UI button
// and Momo can both reach the same logic.
app.post('/omo/api/agents/:ref/resolve-conflict', async (req, res) => {
  try {
    const { default: resolveAgentConflict } = await import('./src/tools/resolve_agent_conflict.js')
      .then((m) => ({ default: m }))
      .catch(() => ({ default: null }));
    if (!resolveAgentConflict) {
      return res.status(500).json({ ok: false, error: 'resolve_agent_conflict tool missing' });
    }
    res.json(await resolveAgentConflict.run({
      agent: String(req.params.ref || ''),
      conflicting_paths: req.body?.conflicting_paths || null,
      hint: req.body?.hint || null,
    }));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
// All worktrees on disk + their owner (if any). Used by the squad UI
// worktrees panel — shows "active" vs "orphan" entries with disk sizes,
// last-modified, and a Reap button.
app.get('/omo/api/hermes/worktrees', (_req, res) => {
  try { res.json({ ok: true, worktrees: hermes.listWorktrees() }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
});
// Force-reap an agent (free the seat + tear down the worktree). Pass
// { force: true } in the body to interrupt a busy agent first.
app.post('/omo/api/hermes/agents/:ref/reap', (req, res) => {
  try { res.json(hermes.reapAgentNow(String(req.params.ref || ''), { force: !!req.body?.force })); }
  catch (err) { res.status(500).json({ ok: false, error: String(err?.message || err) }); }
});
// Keep an agent on stage past its linger expiry — bumps lastActivityAt
// to now so the reap timer is reset. Used by the /squad "Keep" button.
app.post('/omo/api/agents/:ref/keep', (req, res) => {
  try {
    // resolve free-form ref → agent_id first
    const ref = String(req.params.ref || '');
    const matches = hermes.resolveActiveAgents(ref);
    if (matches.length === 0) return res.status(404).json({ ok: false, error: 'no such active agent' });
    if (matches.length > 1) return res.status(409).json({ ok: false, error: 'ambiguous', candidates: matches });
    res.json(hermes.keepAgent(matches[0].agent_id));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
squadLayout.mountRoutes(app);
// ─── Live web preview pane ────────────────────────────────────────────
// /preview wraps a user-supplied http(s) URL in a sandboxed iframe so
// the holo pane-layer can mount it like any other internal page. The
// show_preview tool builds /preview?url=<target>; the user's app runs
// inside a nested iframe so any error in it is fully isolated from omo.
app.get('/preview',     (_req, res) => res.sendFile(join(PUBLIC_DIR, 'preview.html')));

// Reachability probe for the preview pane. Cross-origin iframes fire
// `load` for both success AND the browser's "can't connect" error page,
// so /preview.html can't tell which it is. The server (same-origin) can
// do a quick HEAD/GET with a hard timeout and report back. Lets the
// pane show "couldn't reach localhost:3000" instead of mounting a
// confusing blank.
app.post('/omo/preview/probe', express.json({ limit: '4kb' }), async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  if (!raw) return res.status(400).json({ ok: false, error: 'invalid url' });
  // Tolerate scheme-less input ("localhost:3000") — same affordance as
  // the show_preview tool, so the probe is usable as a direct API.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try { parsed = new URL(withScheme); }
  catch { return res.status(400).json({ ok: false, error: 'invalid url' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ ok: false, error: 'only http(s) supported' });
  }
  // DNS first. Undici hides ENOTFOUND under a generic UND_ERR_SOCKET,
  // so by the time fetch fails we can't tell DNS-fail from server-down.
  // Resolving up-front lets us surface a precise error.
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname) || parsed.hostname.includes(':') || parsed.hostname === 'localhost';
  if (!isIp) {
    try {
      const dns = await import('node:dns/promises');
      await dns.lookup(parsed.hostname, { all: false });
    } catch (err) {
      return res.json({
        ok: false,
        status: 0,
        code: err?.code || 'ENOTFOUND',
        error: err?.code || 'ENOTFOUND',
      });
    }
  }
  // Hard cap on probe time — we don't want to wedge the UI waiting on a
  // slow upstream. 4s covers cold-start dev servers but kills hung ones.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    // HEAD first (cheap); some dev servers don't implement it cleanly so
    // fall back to GET if the response is 405/501.
    let resp = await fetch(parsed.toString(), {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    }).catch((err) => { throw err; });
    if (resp.status === 405 || resp.status === 501) {
      resp = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
    }
    res.json({
      ok: resp.ok || (resp.status >= 200 && resp.status < 500),
      status: resp.status,
      statusText: resp.statusText || null,
      finalUrl: resp.url || parsed.toString(),
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    // Node's undici-based fetch wraps the real network error in
    // err.cause; the outer error is just "fetch failed". Dig out the
    // ECONNREFUSED / ENOTFOUND / ETIMEDOUT so the client can show a
    // useful message.
    const cause = err?.cause;
    const code = cause?.code || err?.code || null;
    res.json({
      ok: false,
      status: 0,
      code,
      error: aborted
        ? 'timeout'
        : (code || cause?.message || err?.message || String(err)),
    });
  } finally {
    clearTimeout(timer);
  }
});
// ─── /automation (Holo3-piloted agent loop) ───────────────────────────
// Vision-language model from H Company drives a target (your Mac or a
// Browserbase Chromium): screenshot → next tool_call → execute → repeat.
// API keys live server-side; the browser talks only to /omo/api/holo3/*,
// /omo/api/holo3-mac/*, and /omo/api/holo3-browser/*.
app.get('/automation', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'automation.html')));
holo3.mountRoutes(app);
// ─── Pitch deck (3-slide 16:9 brand presentation) ─────────────────────
app.get('/pitch',       (_req, res) => res.sendFile(join(PUBLIC_DIR, 'pitch.html')));
// ─── Marketing landing page ───────────────────────────────────────────
app.get('/landing',     (_req, res) => res.sendFile(join(PUBLIC_DIR, 'landing.html')));
// Long-form variant — same hero as /landing, extended below the fold.
app.get('/landing-1',   (_req, res) => res.sendFile(join(PUBLIC_DIR, 'landing-1.html')));
// Agentic-coding variant — same chrome as /landing, coding-flavoured cards + rotor.
app.get('/landing-3',   (_req, res) => res.sendFile(join(PUBLIC_DIR, 'landing-3.html')));
// /new — minimal cream-theme explainer for the agentic coding loop.
app.get('/new',         (_req, res) => res.sendFile(join(PUBLIC_DIR, 'new.html')));
// Back-compat redirects for old paths that may be linked externally.
app.get(['/home', '/welcome', '/onboard', '/onboarding', '/landing-2', '/landing-4', '/landing-7', '/landing-15', '/landing-18', '/landing-alt'],
        (_req, res) => res.redirect(301, '/landing'));
// ─── Text-mode chat ───────────────────────────────────────────────────
// Driven by Gemini Flash text generation instead of the costly Live audio
// model — same persona, same tools, same /tool dispatcher. Surfaced to
// users as the glassmorphic overlay on the cylinder (`?text=1`, opened by
// `npm run text` or `/` / ⌘K from the hologram page). The overlay loads
// /chat-frame in an iframe; /text is kept as a redirect so bookmarks land
// in the new UX. POST /text/chat is the JSON endpoint (mountRoutes).
app.get('/chat-frame', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'text.html')));
app.get('/text', (_req, res) => res.redirect('/?text=1'));
textChat.mountRoutes(app);
// ─── Local voice path (Ollama-backed, browser STT/TTS) ────────────────
// /local-voice serves the page; /local/chat runs the tool-calling loop;
// /local/health checks that Ollama is reachable + the model is pulled.
// Same in-process tool registry as the Gemini path — no second wiring.
localVoice.mountRoutes(app);
// ─── Temporary: audition the 30 Gemini prebuilt voices ────────────────
// Serves /voices (HTML), /voices/list (JSON), /voices/sample.wav (TTS).
voicePreview.mountRoutes(app);
// ─── Google OAuth (Gmail / Drive / Docs / Calendar) ───────────────────
// On callback we persist the refresh token to ~/.omo/google-token.json,
// kick the Gmail/Drive/Docs connectors in-process, and render a small
// auto-closing success page. The old "paste into .env" flow is kept as a
// fallback path — any value in .env still wins over the persisted file.
// In-memory state nonce store: nonce -> { next, expiresAt }. 10-min TTL.
const oauthStateStore = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60_000;
function gcOAuthStates() {
  const now = Date.now();
  for (const [k, v] of oauthStateStore) if (v.expiresAt < now) oauthStateStore.delete(k);
}
function safeNext(raw) {
  const v = String(raw || '').trim();
  if (!v) return '/hq';
  if (!v.startsWith('/') || v.startsWith('//')) return '/hq';
  return v;
}

app.get('/auth/google/start', (req, res) => {
  if (!google.isConfigured()) {
    return res.status(500).send('Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env.');
  }
  const scopes = [
    google.SCOPES.GMAIL_MODIFY,
    google.SCOPES.GMAIL_SEND,
    google.SCOPES.DRIVE_META,
    google.SCOPES.DRIVE_ACTIVITY,
    google.SCOPES.DRIVE_FILE,
    google.SCOPES.DOCS_WRITE,
    google.SCOPES.USERINFO_EMAIL,
    google.SCOPES.USERINFO_PROFILE,
  ];
  const isAdd = req.query.add === '1' || req.query.add === 'true';
  const next = safeNext(req.query.next);
  const opts = {};
  if (isAdd) opts.prompt = 'select_account consent';
  if (isAdd || next !== '/hq') {
    gcOAuthStates();
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    oauthStateStore.set(nonce, { next, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    opts.state = nonce;
  }
  const url = google.getAuthUrl(scopes, opts);
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error, state } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code) return res.status(400).send('Missing code');

    let next = '/hq';
    if (state) {
      gcOAuthStates();
      const entry = oauthStateStore.get(String(state));
      if (entry) {
        next = entry.next || '/hq';
        oauthStateStore.delete(String(state));
      }
    }

    const { tokens } = await google.exchangeCode(String(code));
    if (!tokens.refresh_token) {
      return res.status(400).send(
        'No refresh_token returned. This usually means you previously authorized — revoke at ' +
        '<a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> ' +
        'and try again.'
      );
    }

    let email = null;
    try {
      const info = await google.fetchUserEmail(tokens);
      email = info.email;
    } catch (err) {
      console.warn('[google-oauth] fetchUserEmail failed:', err?.message || err);
    }

    if (email) {
      google.persistTokenForAccount(tokens, email);
    } else {
      // Fall back to legacy single-file persistence so we still survive.
      await google.persistToken(tokens);
    }
    google.setCurrentRefreshToken(tokens.refresh_token);

    // Fire connectors. For Gmail we use connectAccount(email) so the
    // newly-authorized account spins up its own runtime alongside any
    // existing ones — never disconnects the others. Drive / Docs are
    // still single-account today; calling .start() is a no-op when
    // already connected and naturally picks up the new primary.
    if (email && typeof gmailConnector.connectAccount === 'function') {
      gmailConnector.connectAccount(email, { emit: dataCore.emit })
        .catch((err) => console.error(`[gmail:${email}] post-oauth connect failed:`, err?.message));
    } else {
      try { gmailConnector.start?.({ emit: dataCore.emit })?.catch?.((err) => console.error('[gmail] post-oauth start failed:', err?.message)); } catch (err) { console.error('[gmail] post-oauth start threw:', err?.message); }
    }
    try { googleDrive.start?.({ emit: dataCore.emit })?.catch?.((err) => console.error('[drive] post-oauth start failed:', err?.message)); } catch (err) { console.error('[drive] post-oauth start threw:', err?.message); }
    try { googleDocs.start?.({ emit: dataCore.emit })?.catch?.((err) => console.error('[docs] post-oauth start failed:', err?.message)); } catch (err) { console.error('[docs] post-oauth start threw:', err?.message); }

    const safeNextEsc = next.replace(/[<>"'&]/g, (c) => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c]));
    const emailEsc = (email || 'account').replace(/[<>"'&]/g, (c) => ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c]));
    res.send(`<!doctype html><meta charset=utf-8><title>Connected</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:48px; background:#0A0E14; color:#B8E4C9; font:14px/1.5 "JetBrains Mono", ui-monospace, Menlo, monospace; text-align:center; }
  h1 { color:#F2C464; font-weight:700; letter-spacing:.08em; margin:6px 0 14px; }
  code { background:#131924; padding:2px 6px; border:1px solid rgba(184,228,201,.2); }
  a { color:#F2C464; }
  .face { font-size:40px; margin:16px 0; }
  .acct { color:#F2C464; }
</style>
<div class="face">(◕‿◕)</div>
<h1>GOOGLE OAUTH · CONNECTED</h1>
<p><span class="acct">${emailEsc}</span></p>
<p>Gmail, Drive, Docs connectors are booting in the background.</p>
<p>redirecting to <code>${safeNextEsc}</code> …</p>
<script>
  setTimeout(() => {
    try { window.location.replace(${JSON.stringify(next)}); } catch {}
    setTimeout(() => { try { window.close(); } catch {} }, 800);
  }, 600);
</script>`);
  } catch (err) {
    console.error('[google-oauth] callback error:', err);
    res.status(500).send(`Callback error: ${err.message}`);
  }
});

// ─── Data Core (event stream, mocks) ──────────────────────────────────
// Exposes /omo/api/* and /omo/ws consumed by /hq and the agents backend.
dataCore.mountRoutes(app);

// ─── Structured logs (persisted JSONL, queryable, faceted) ───────────
// Every dataCore event is persisted to data/logs/YYYY-MM-DD.jsonl. This
// mount only adds the query routes — /omo/api/logs{,/facets,/days,/export}.
logs.mountRoutes(app);

// ─── Integration routes (connect / status / disconnect from /hq) ──────
stripeConnector.mountRoutes(app, { emit: dataCore.emit });
metaConnector.mountRoutes(app, { emit: dataCore.emit });
gmailConnector.mountRoutes(app, { emit: dataCore.emit });
googleDrive.mountRoutes(app, { emit: dataCore.emit });
githubConnector.mountRoutes(app, { emit: dataCore.emit });

// ─── Onboarding (welcome flow) ────────────────────────────────────────
onboarding.mountRoutes(app, {
  google,
  gmailConnector,
  googleDrive,
  googleDocs,
  stripeConnector,
  metaConnector,
  emit: dataCore.emit,
});

// On-demand Drive Activity feed for the Google Docs deep panel.
app.get('/omo/api/google/docs/:fileId/activity', async (req, res) => {
  try {
    if (!google.hasRefreshToken()) return res.status(503).json({ error: 'google not connected' });
    const result = await googleDocs.fetchActivity(req.params.fileId);
    res.json(result);
  } catch (err) {
    console.error('[google-docs] activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Full-stage pane for a single Google Doc. Served from the public dir
// and validated at path level (no directory traversal) — the pane itself
// reads the id client-side from the URL and iframes docs.google.com/preview.
app.get('/doc/:fileId', (req, res) => {
  const id = String(req.params.fileId || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).send('Invalid doc id');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(PUBLIC_DIR, 'doc_view.html'));
});

// ─── Master Agents backend ────────────────────────────────────────────
// The agents module bridges its own event bus onto the Data Core event
// ring so /omo/ws fans them out alongside gmail/stripe/meta/audio events.
// Register routes before the static fallback so /omo/api/agents/* hits.
agents.attach(dataCore);
agents.mountRoutes(app);

// Hermes Agent backend — wraps the local `hermes` CLI as an omo agent
// runtime. attach/mountRoutes/mountWebSocket/start are all best-effort;
// failures must not break boot or the voice path. See src/hermes/index.js.
try { hermes.attach(dataCore); } catch (err) { console.warn('[hermes] attach failed:', err?.message || err); }
try { hermes.mountRoutes(app); } catch (err) { console.warn('[hermes] mountRoutes failed:', err?.message || err); }

// ─── Momo ingest (voice transcripts + tool announcements → /omo/ws) ────
// Browser hologram pages POST finalized turns here; /tool below is also
// wrapped so every tool call/result flows onto the shared event ring.
// Result: /hq's LOG pane and /agents-grid's ticker both see a live feed
// of "what did Momo hear, what did she say, what did she decide".
momoIngest.attach(dataCore);
momoIngest.mountRoutes(app);

// Browser posts "what pane / panel / drill-down is on screen right now"
// so Momo's get_screen_context tool can resolve "this" / "that" deixis.
// One in-memory slot, last-write-wins.
app.post('/omo/ingest/view', express.json({ limit: '8kb' }), (req, res) => {
  try {
    if (req.body && req.body.clear === true) momoView.clearView();
    else momoView.setView(req.body || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});
app.get('/omo/ingest/view', (_req, res) => res.json(momoView.getView() || null));

// ─── Static assets ────────────────────────────────────────────────────
// No-cache for .html/.js during dev so iframe-module edits show up on refresh.
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html') || path.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  },
}));

// ─── Momo API (session token, tool dispatch, viz iframes) ─────────────
// Shape-only check: accept reasonable Gemini prebuilt voice names like
// "Aoede", "Puck", etc. without hardcoding the current list (Gemini may
// add or rename voices). Anything beyond letters/digits/underscore, or
// longer than 32 chars, is obviously not a voice name — drop it and let
// the server default take over.
const VOICE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

app.post('/session', async (req, res) => {
  try {
    const raw = (req.query.voice || '').toString().trim();
    const voice = VOICE_SHAPE.test(raw) ? raw : undefined;
    const session = await mintSession({ voice });
    console.log('[holoscope] session ok', { model: session.model, voice: session.voice });
    res.json(session);
  } catch (err) {
    console.error('[holoscope] /session error', err.message);
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// Local-pipeline session descriptor — additive sibling of /session.
// Returns the metadata the cylinder needs to open /voice/ws when the
// user opts into the local engine via ?engine=local. Doesn't mint
// anything: the WS itself owns the conversation lifetime.
app.post('/voice/session', async (_req, res) => {
  // Preflight the system-side deps so the cylinder can show a clean
  // install hint on the splash instead of dying mid-WS.
  const [stt, tts] = await Promise.all([ensureWhisperAvailable(), ensureTtsAvailable()]);
  const errors = [];
  if (!stt.ok) errors.push(stt.reason);
  if (!tts.ok) errors.push(tts.reason);
  res.json({
    engine: 'local_pipeline',
    ws_url: '/voice/ws',
    model: process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite',
    voice: process.env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural',
    sample_rate_in: 16000,
    sample_rate_out: 24000,
    ready: errors.length === 0,
    setup_error: errors.length ? errors.join(' · ') : null,
    setup_hint: errors.length ? 'run ./bin/install-voice-deps.sh, then restart' : null,
  });
});

// Wrapped so every tool dispatch emits `momo_tool_call` + `momo_tool_result`
// onto the dataCore ring — no browser cooperation needed for the tool side
// of the feed. Body contract (`{ result }` | `{ error }`) is unchanged.
app.post('/tool', momoIngest.wrapToolEndpoint(runTool));

app.get('/viz/:id', (req, res) => {
  try {
    const entry = getViz(req.params.id);
    if (!entry) return res.status(404).type('text/plain').send('viz not found');
    res.set('Cache-Control', 'private, max-age=600');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(entry.html);
  } catch (err) {
    console.error('[holoscope] /viz error', err.message);
    res.status(500).type('text/plain').send('viz lookup failed');
  }
});

// Raw-data dump. Routes:
//   - /raw/<integration>  for stripe|gmail|meta|drive — proxies each connector's
//     existing /omo/api/integrations/<src>/plaintext and wraps it in our shell.
//   - /raw/<projectable>  (chrt_*, etc.) — renders underlying dataset refs.
//   - /raw/<dataset>      (orde_*, cust_*, etc.) — renders that dataset directly.
const INTEGRATION_SOURCES = new Set(['stripe', 'gmail', 'meta', 'drive', 'github']);

app.get('/raw/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).type('text/plain').send('missing id');

    if (INTEGRATION_SOURCES.has(id)) {
      try {
        const host = req.headers.host || `localhost:${PORT}`;
        const scheme = req.secure ? 'https' : 'http';
        const qs = req.query.limit ? `?limit=${encodeURIComponent(req.query.limit)}` : '';
        const upstream = await fetch(`${scheme}://${host}/omo/api/integrations/${id}/plaintext${qs}`);
        const body = await upstream.text();
        const html = renderRawHtml(
          { id, title: `${id.toUpperCase()} · RAW DUMP`, createdAt: Date.now(), metaLines: [] },
          body,
        );
        res.set('Cache-Control', 'no-store');
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      } catch (err) {
        return res.status(502).type('text/plain').send(`upstream plaintext failed: ${err?.message || err}`);
      }
    }

    // Structured path — projectable or dataset.
    const sections = [];
    const header = { id, title: 'RAW DATA DUMP', createdAt: null, metaLines: [] };

    const projectable = projectableStore.get(id);
    if (projectable) {
      header.title = `RAW DATA · ${projectable.kind.toUpperCase()}`;
      header.createdAt = projectable.createdAt;
      if (projectable.meta) {
        for (const [k, v] of Object.entries(projectable.meta)) {
          if (v == null) continue;
          const rendered = Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? JSON.stringify(v) : String(v));
          header.metaLines.push(`${k}: ${rendered}`);
        }
      }
      const refs = Array.isArray(projectable.meta?.data_refs) ? projectable.meta.data_refs : [];
      if (refs.length === 0) {
        sections.push({ id: null, kind: null, note: 'no dataset refs recorded for this projectable', data: null });
      } else {
        for (const ref of refs) {
          const ds = datasetStore.get(ref);
          if (!ds) sections.push({ id: ref, kind: null, note: 'dataset expired or not found', data: null });
          else     sections.push({ id: ref, kind: ds.kind, note: null, data: ds.data });
        }
      }
    } else {
      const ds = datasetStore.get(id);
      if (!ds) return res.status(404).type('text/plain').send('not found — id is not a live projectable or dataset (30 min TTL)');
      header.title = `RAW DATA · DATASET`;
      sections.push({ id, kind: ds.kind, note: null, data: ds.data });
    }

    const html = renderRawHtml(header, buildSectionsText(header, sections));
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[holoscope] /raw error', err.message);
    res.status(500).type('text/plain').send('raw dump failed');
  }
});

function buildSectionsText(header, sections) {
  const lines = [];
  lines.push(`==== OMO · ${header.title} ====`);
  lines.push(`id:      ${header.id}`);
  lines.push(`created: ${header.createdAt ? new Date(header.createdAt).toISOString() : '—'}`);
  for (const l of header.metaLines) lines.push(l);
  lines.push(`sections: ${sections.length}`);
  lines.push('');

  for (const s of sections) {
    const label = s.kind ? s.kind.toUpperCase() : 'SECTION';
    const idTag = s.id ? `· ${s.id}` : '';
    const count = Array.isArray(s.data) ? `· ${s.data.length} rows` : '';
    lines.push(`==== ${label} ${idTag} ${count} ====`.replace(/\s+/g, ' ').trim());
    if (s.note) {
      lines.push(`(${s.note})`);
      lines.push('');
      continue;
    }
    try { lines.push(JSON.stringify(s.data, null, 2)); }
    catch (_) { lines.push('[unserialisable payload]'); }
    lines.push('');
  }
  return lines.join('\n');
}

function renderRawHtml(header, textBody) {
  const escape = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const created = header.createdAt ? new Date(header.createdAt).toISOString() : '—';
  const text = escape(textBody);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>omo · raw · ${escape(header.id)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: #04070a; color: #b8e4c9; }
  body {
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.55;
    padding: 18px 22px 40px;
    min-height: 100vh;
  }
  .topbar {
    display: flex; align-items: baseline; gap: 14px;
    padding-bottom: 10px; margin-bottom: 14px;
    border-bottom: 1px solid rgba(0, 229, 255, 0.22);
    color: rgba(0, 229, 255, 0.85);
    letter-spacing: 1.5px;
    text-transform: uppercase;
    font-size: 11px;
  }
  .topbar .title { color: rgba(0, 229, 255, 0.95); }
  .topbar .tag { color: rgba(184, 228, 201, 0.55); }
  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: #d8f3e5;
  }
</style>
</head>
<body>
  <div class="topbar">
    <span class="title">omo · ${escape(header.title)}</span>
    <span class="tag">${escape(header.id)}</span>
    <span class="tag">${escape(created)}</span>
  </div>
  <pre>${text}</pre>
</body>
</html>`;
}

// ─── Ops ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ...SESSION_META, db: db.isConfigured() }));

// Warm the DB schema on boot so the first tool call doesn't pay the cost.
if (db.isConfigured()) {
  db.ensureSchema().catch((err) => console.error('[holoscope] schema init failed', err.message));
}

// ─── Browser auto-open ────────────────────────────────────────────────
// Only opens once per PORT within a 60-minute window (tmp-file marker).
// Every `node --watch` restart is suppressed by the same marker, so
// saving a file in dev never pops a new tab. Skip entirely with
// NO_OPEN=1 (set by `npm run dev`). When OMO_OPEN_PATH is set (e.g.
// `npm run text`), the user is explicitly asking for a specific URL —
// bypass the throttle so they always land where they expect.
function maybeOpenBrowser(url) {
  if (process.env.NO_OPEN) return;
  const explicitPath = !!process.env.OMO_OPEN_PATH;
  const marker = join(tmpdir(), `holoscope-opened-${PORT}`);
  try {
    if (!explicitPath && existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 60 * 60 * 1000) return;
    writeFileSync(marker, String(Date.now()));
  } catch {}
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'cmd' :
                                     'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); }
  catch (err) { console.warn('[holoscope] auto-open failed:', err.message); }
}

// ─── Boot ─────────────────────────────────────────────────────────────
const httpServer = createServer(app);

// Register error + signal handlers BEFORE the long-running boot awaits so
// that a SIGTERM from `node --watch` during Stripe/Neon backfill still
// triggers clean shutdown (which frees the port for the restart).
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[holoscope] port ${PORT} is in use. Free it with: lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  }
  console.error('[holoscope] server error:', err);
  process.exit(1);
});

let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Tell connected holo clients to drop their direct browser→Gemini Live
    // sockets and skip reconnection. Without this, Ctrl+C kills the local
    // server but the browser's mic keeps streaming to Google until the tab
    // is closed or the ephemeral token expires (a few minutes).
    try {
      dataCore.emit({ source: 'system', kind: 'shutdown', data: { reason: sig } });
    } catch {}
    // Stop child agents but preserve their worktrees. Pending agent work
    // should survive `node --watch` reloads so it can still be reviewed.
    try {
      const stopped = hermes.shutdown?.();
      if (stopped?.stopped || stopped?.preserved) {
        console.log(`[holoscope] stopped ${stopped.stopped || 0} agent task(s), preserved ${stopped.preserved || 0} worktree(s) on ${sig}`);
      }
    } catch {}
    // Brief grace period so the WS payload actually flushes to clients
    // before we force-close every connection. 150ms is enough on loopback.
    setTimeout(() => {
      httpServer.close(() => process.exit(0));
      httpServer.closeAllConnections?.();
      setTimeout(() => process.exit(0), 500).unref();
    }, 150).unref();
  });
}

dataCore.mountWebSocket(httpServer);
agents.terminals.mountWebSocket(httpServer);
try { hermes.mountWebSocket(httpServer); } catch (err) { console.warn('[hermes] mountWebSocket failed:', err?.message || err); }
// Live agent terminal PTYs — one WS endpoint per runtime. The protocol
// is identical (envelope names stay `claude_pty_*` for client parity);
// the only difference is which CLI gets spawned on `request_spawn`.
try {
  claudePtyWs.setSpawnRequestHandler(async (agent_id, msg) => {
    const r = await hermes.ensureAgentForPty(agent_id, {
      runtime:        'claude',
      model:          msg?.model || null,
      effort:         msg?.effort || null,
      permissionMode: msg?.permission_mode || msg?.permissionMode || 'bypassPermissions',
      addDirs:        Array.isArray(msg?.add_dirs) ? msg.add_dirs : (Array.isArray(msg?.addDirs) ? msg.addDirs : []),
      mcpConfig:      msg?.mcp_config || msg?.mcpConfig || null,
      settingsPath:   msg?.settings_path || msg?.settingsPath || null,
      resumeSessionId: msg?.resume_session_id || msg?.resumeSessionId || null,
      continueLast:    !!(msg?.continue_last || msg?.continueLast),
      repoPath:        msg?.repo_path || msg?.repoPath || null,
    });
    return r?.agent_id ? claudePty.getSession(r.agent_id) : null;
  });
  claudePtyWs.mountWebSocket(httpServer);
} catch (err) { console.warn('[claude-pty-ws] mountWebSocket failed:', err?.message || err); }
try {
  hermesPtyWs.setSpawnRequestHandler(async (agent_id, msg) => {
    const r = await hermes.ensureAgentForPty(agent_id, {
      runtime:        'hermes',
      model:          msg?.model || null,
      provider:       msg?.provider || null,
      toolsets:       Array.isArray(msg?.toolsets) ? msg.toolsets : [],
      skills:         Array.isArray(msg?.skills) ? msg.skills : [],
      maxTurns:       Number.isFinite(msg?.max_turns) ? msg.max_turns : (Number.isFinite(msg?.maxTurns) ? msg.maxTurns : null),
      checkpoints:    !!(msg?.checkpoints),
      resumeSessionId: msg?.resume_session_id || msg?.resumeSessionId || null,
      continueName:    msg?.continue_name || msg?.continueName || null,
      continueLast:    !!(msg?.continue_last || msg?.continueLast),
      repoPath:        msg?.repo_path || msg?.repoPath || null,
    });
    return r?.agent_id ? hermesPty.getSession(r.agent_id) : null;
  });
  hermesPtyWs.mountWebSocket(httpServer);
} catch (err) { console.warn('[hermes-pty-ws] mountWebSocket failed:', err?.message || err); }
// Preview voice-nav: small WS (server → holo command push) + the ack route.
try { previewBus.mountWebSocket(httpServer); } catch (err) { console.warn('[preview/bus] mountWebSocket failed:', err?.message || err); }
try { previewAcks.mountRoutes(app); } catch (err) { console.warn('[preview/acks] mountRoutes failed:', err?.message || err); }
try { previewAgentWorktree.mountRoutes(app); } catch (err) { console.warn('[preview/agent_worktree] mountRoutes failed:', err?.message || err); }
attachVoiceWebSocket(httpServer);
dataCore.startMocks();
stripeConnector.start({ emit: dataCore.emit }).catch((err) => console.error('[stripe] start failed:', err.message));
metaConnector.start({ emit: dataCore.emit }).catch((err) => console.error('[meta] start failed:', err.message));
neonConnector.start({ emit: dataCore.emit }).catch((err) => console.error('[neon] start failed:', err.message));
gmailConnector.start({ emit: dataCore.emit }).catch((err) => console.error('[gmail] start failed:', err.message));
googleDrive.start({ emit: dataCore.emit }).catch((err) => console.error('[drive] start failed:', err.message));
googleDocs.start({ emit: dataCore.emit }).catch((err) => console.error('[docs] start failed:', err.message));
githubConnector.start({ emit: dataCore.emit }).catch((err) => console.error('[github] start failed:', err.message));

// Autonomous projection — subscribe to dataCore events and auto-mount
// cards inside the hologram without a voice/tool round-trip. Must run
// AFTER mountWebSocket + startMocks so every client that connects sees
// projections flowing through /omo/ws, and so the mock producers are
// already seeding events the projectors can pick up immediately.
const { install: installStripeLive } = await import('./src/projection/stripe_live.js');
const { install: installGmailLive }  = await import('./src/projection/gmail_live.js');
const { install: installGithubLive } = await import('./src/projection/github_live.js');
const { install: installAgentReview } = await import('./src/projection/agent_review.js');
installStripeLive();
installGmailLive();
installGithubLive();
installAgentReview();

agents.start().catch((err) => console.error('[agents] start failed:', err.message));
hermes.start().catch((err) => console.warn('[hermes] start failed', err?.message || err));

// Pre-mint a Gemini ephemeral token on boot so the first /session call
// is instant (see src/session.js::startTokenPrefetch). Runs in background.
startTokenPrefetch();

httpServer.listen(PORT, HOST, () => {
  const base = `http://localhost:${PORT}`;
  const url = base + (process.env.OMO_OPEN_PATH || '');
  console.log(`[holoscope] ${base}                        (default)`);
  console.log(`[holoscope] ${base}/reflector`);
  console.log(`[holoscope] ${base}/avatar`);
  console.log(`[holoscope] ${base}/pyramid`);
  console.log(`[holoscope] ${base}/hq                 (command center)`);
  console.log(`[holoscope] ${base}/squad              (pixel-office agent view)`);
  if (holo3.isConfigured()) {
    console.log(`[holoscope] ${base}/automation        (Holo3 vision agent · optional · /mac or /browser)`);
  }
  console.log(`[holoscope] ${base}/?text=1           (text-mode · no voice)`);
  console.log(`[holoscope] ${base}/local-voice       (fully local · Ollama + browser STT/TTS)`);
  console.log(`[holoscope] ${base}/omo/api/agents/state   (master agents backend)`);
  maybeOpenBrowser(url);
});

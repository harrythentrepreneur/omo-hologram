// src/logs/bus.js — unified structured logger for all subsystems.
//
// Every event that appears in /hq's LOG pane and on /omo/ws flows through
// here. Two producers:
//
//   1. Diagnostics  — createLogger(source).info/warn/error/debug(kind, title, data)
//      Use for lifecycle, poll cycles, connection state, errors. These carry
//      a `level` field and kinds prefixed with `log.` so the UI can color
//      + filter them separately from domain events.
//
//   2. Domain events — createLogger(source).event({ kind, title, summary, data })
//      Thin wrapper around dataCore.emit for the richer "a charge succeeded"
//      / "an email arrived" events. Still persisted + fanned out.
//
// Both paths emit through dataCore so the existing ring + WebSocket fanout
// keep working. In addition, every event is appended to a daily JSONL file
// at data/logs/YYYY-MM-DD.jsonl (append-only, safe across restarts) so the
// HQ log survives a server bounce and queries can span days.

import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as dataCore from '../data_core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '..', '..', 'data', 'logs');

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// Captured once at module load so our own terminal mirroring calls the
// *real* console even after installConsoleBridge() patches the globals.
const _rawConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// ─── JSONL daily rotation ────────────────────────────────────────────────
// One stream per day. Switched lazily on the first write after midnight.
// Keeps the file handle count bounded and gives clean file-per-day slices.

let currentStream = null;
let currentDay = null;

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function streamFor(ts) {
  const key = dayKey(ts);
  if (key !== currentDay) {
    try { currentStream?.end(); } catch {}
    currentStream = createWriteStream(join(LOG_DIR, `${key}.jsonl`), { flags: 'a' });
    currentStream.on('error', (err) => _rawConsole.error('[logs] write stream error:', err.message));
    currentDay = key;
  }
  return currentStream;
}

function persist(ev) {
  try {
    const s = streamFor(ev.ts);
    s.write(JSON.stringify(ev) + '\n');
  } catch (err) {
    // Never let disk failures crash the event path.
    if (!persist._warned) {
      _rawConsole.error('[logs] persist failed (will not warn again):', err.message);
      persist._warned = true;
    }
  }
}

// Subscribe to the full dataCore stream so even events emitted without
// going through createLogger (e.g. the existing mock producers, or
// connectors that emit directly via dataCore.emit) are persisted. This
// gives us a single disk record that matches what clients see on /omo/ws.
dataCore.subscribe(persist);

// ─── Helpers ─────────────────────────────────────────────────────────────

const TITLE_MAX = 180;
const SUMMARY_MAX = 260;

function clip(v, n) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Map log level → console method. Debug is silenced unless OMO_LOG_DEBUG=1.
const DEBUG_ENABLED = /^(1|true|yes)$/i.test(process.env.OMO_LOG_DEBUG || '');

function consoleFor(level) {
  if (level === 'error') return _rawConsole.error;
  if (level === 'warn') return _rawConsole.warn;
  if (level === 'debug') return DEBUG_ENABLED ? _rawConsole.log : () => {};
  return _rawConsole.log;
}

// ─── Core emit ───────────────────────────────────────────────────────────

function emitLog({ source, level, kind, title, summary, data, terminal = true }) {
  const ev = {
    id: randomUUID(),
    source: String(source || 'system'),
    kind: String(kind || `log.${level || 'info'}`),
    level: level || 'info',
    ts: Date.now(),
    title: clip(title, TITLE_MAX),
    summary: clip(summary ?? title, SUMMARY_MAX),
    data: data && typeof data === 'object' ? data : (data != null ? { value: data } : {}),
  };
  try {
    dataCore.emit(ev); // subscribe() above will persist it
  } catch (err) {
    _rawConsole.error('[logs] dataCore.emit threw:', err.message);
  }
  // When called via the console bridge the terminal already has the line
  // (pass() ran first). Only mirror when `terminal` is true — i.e. when
  // someone called createLogger(src).info(...) directly.
  if (terminal) {
    const tag = `[${ev.source}]`;
    const out = consoleFor(ev.level);
    if (ev.data && Object.keys(ev.data).length) out(tag, ev.title, ev.data);
    else out(tag, ev.title);
  }
  return ev;
}

function emitEvent({ source, kind, title, summary, data }) {
  // Domain events don't carry `level`. Still persisted + fanned out.
  const ev = {
    id: randomUUID(),
    source: String(source || 'system'),
    kind: String(kind || 'event'),
    ts: Date.now(),
    title: clip(title, TITLE_MAX),
    summary: clip(summary ?? title, SUMMARY_MAX),
    data: data && typeof data === 'object' ? data : {},
  };
  try { dataCore.emit(ev); } catch (err) { _rawConsole.error('[logs] emit threw:', err.message); }
  return ev;
}

// ─── Public API ──────────────────────────────────────────────────────────

export function createLogger(source) {
  const s = String(source || 'system');
  return {
    debug: (kind, title, data) => emitLog({ source: s, level: 'debug', kind, title, data }),
    info:  (kind, title, data) => emitLog({ source: s, level: 'info',  kind, title, data }),
    warn:  (kind, title, data) => emitLog({ source: s, level: 'warn',  kind, title, data }),
    error: (kind, title, data) => emitLog({ source: s, level: 'error', kind, title, data }),
    event: (ev) => emitEvent({ source: s, ...ev }),
  };
}

// ─── Query (in-memory ring + on-disk tail) ───────────────────────────────

// Fast path: the dataCore ring already holds the last ~1000 events. For
// anything older (or for filtered queries that would blow past the ring),
// stitch together today's + yesterday's JSONL files. Deliberately capped
// so we never re-read weeks of history on a single request.

export async function queryLogs({ source, level, kind, since, until, q, limit = 200 } = {}) {
  const cap = Math.min(Math.max(1, limit | 0), 1000);
  const sinceMs = since ? Number(since) : 0;
  const untilMs = until ? Number(until) : Date.now() + 1;
  const wantSource = source && source !== 'all' ? String(source) : null;
  const wantLevel = level && level !== 'all' ? String(level) : null;
  const wantKind = kind ? String(kind) : null;
  const needle = q ? String(q).trim().toLowerCase() : '';

  const match = (ev) => {
    if (!ev) return false;
    if (ev.ts < sinceMs || ev.ts > untilMs) return false;
    if (wantSource && ev.source !== wantSource) return false;
    if (wantLevel && ev.level !== wantLevel) return false;
    if (wantKind && ev.kind !== wantKind) return false;
    if (needle) {
      const hay = [ev.title, ev.summary, ev.kind, ev.source, JSON.stringify(ev.data || {})]
        .filter(Boolean).join(' \n ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };

  // Ring first (fastest, newest).
  const ringHits = dataCore.listEvents({ limit: 1000 }).filter(match);
  if (ringHits.length >= cap || sinceMs >= (ringHits.at(-1)?.ts ?? 0)) {
    return ringHits.slice(0, cap);
  }

  // Fall back to disk, newest day first, up to a 2-day window so we stay fast.
  const out = [...ringHits];
  const seen = new Set(out.map((e) => e.id));
  const days = [dayKey(Date.now()), dayKey(Date.now() - 24 * 60 * 60 * 1000)];
  for (const d of days) {
    if (out.length >= cap) break;
    const buf = await readFile(join(LOG_DIR, `${d}.jsonl`), 'utf8').catch(() => '');
    if (!buf) continue;
    const lines = buf.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i--) {
      const line = lines[i];
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (seen.has(ev.id)) continue;
      if (!match(ev)) continue;
      seen.add(ev.id);
      out.push(ev);
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, cap);
}

// ─── HTTP ────────────────────────────────────────────────────────────────

export function mountRoutes(app) {
  // Structured log query. Filters: source, level, kind, since (epoch ms),
  // until, q (case-insensitive substring), limit (1..1000).
  app.get('/omo/api/logs', async (req, res) => {
    try {
      const events = await queryLogs({
        source: req.query.source,
        level:  req.query.level,
        kind:   req.query.kind,
        since:  req.query.since,
        until:  req.query.until,
        q:      req.query.q,
        limit:  Number(req.query.limit) || 200,
      });
      res.json({ events });
    } catch (err) {
      _rawConsole.error('[logs] query failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Available source + level facets so the UI can render filter chips.
  app.get('/omo/api/logs/facets', async (_req, res) => {
    const stats = dataCore.statsBySource();
    res.json({
      sources: Object.keys(stats.bySource || {}),
      levels: ['debug', 'info', 'warn', 'error'],
      liveSources: stats.liveSources || [],
    });
  });

  // Lightweight daily-file listing for the "export" button.
  app.get('/omo/api/logs/days', async (_req, res) => {
    try {
      const files = await readdir(LOG_DIR).catch(() => []);
      const days = files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map((f) => f.replace(/\.jsonl$/, ''))
        .sort()
        .reverse();
      res.json({ days });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Raw daily dump (JSONL) for download. Only the day= param is honored;
  // path traversal guarded by the regex check.
  app.get('/omo/api/logs/export', async (req, res) => {
    const day = String(req.query.day || dayKey());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).send('bad day');
    try {
      const buf = await readFile(join(LOG_DIR, `${day}.jsonl`), 'utf8').catch(() => '');
      res.set('Content-Type', 'application/x-ndjson');
      res.set('Content-Disposition', `attachment; filename="omo-logs-${day}.jsonl"`);
      res.send(buf);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });
}

// Flush on shutdown so the tail of the day file isn't lost.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'beforeExit']) {
  process.on(sig, () => { try { currentStream?.end(); } catch {} });
}

// ─── Console bridge ──────────────────────────────────────────────────────
// Existing subsystems already prefix their console output with a source
// tag — e.g. console.log('[stripe] connected · acct_…'). Rather than
// refactor every connector, we install a transparent shim that detects
// those tagged lines and re-emits them as structured log events. The
// terminal output is unchanged (we always pass through to the real
// console first); callers that want richer events can still reach for
// createLogger().
//
// Source allowlist deliberately broad — adding a new subsystem just
// means adding its tag here.

const ALLOWED_SOURCES = new Set([
  'stripe', 'meta', 'gmail', 'drive', 'docs', 'google', 'google-oauth', 'google-docs',
  'agents', 'momo', 'neon', 'mocks', 'holoscope', 'logs', 'transcript',
  'client', 'kitchen',
]);

// Pin the level→event mapping so callers reading the LOG pane see
// intuitive colours (red for errors, amber for warnings, etc.).
const LEVEL_MAP = { log: 'info', info: 'info', warn: 'warn', error: 'error' };

let inBus = false; // prevents the bus's own terminal mirror from re-emitting

function stringifyArg(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function installConsoleBridge() {
  function wrap(level) {
    const pass = _rawConsole[level] || _rawConsole.log;
    return function (...args) {
      pass(...args); // terminal output preserved
      if (inBus) return;
      const first = args[0];
      if (typeof first !== 'string') return;
      const m = first.match(/^\s*\[([a-z0-9_\-]+)\]\s*(.*)$/i);
      if (!m) return;
      const srcRaw = m[1].toLowerCase();
      if (!ALLOWED_SOURCES.has(srcRaw)) return;
      // Normalise a couple of common aliases for the UI palette.
      const src = srcRaw === 'holoscope' ? 'system'
                : srcRaw === 'mocks'     ? 'system'
                : srcRaw === 'logs'      ? 'system'
                : srcRaw;
      const tail = args.length > 1 ? args.slice(1).map(stringifyArg).join(' ') : '';
      const title = (m[2] + (tail ? ' ' + tail : '')).trim();
      if (!title) return;
      inBus = true;
      try {
        emitLog({
          source: src,
          level: LEVEL_MAP[level] || 'info',
          kind: `log.${LEVEL_MAP[level] || 'info'}`,
          title,
          data: {},
          terminal: false, // pass() above already printed
        });
      } finally {
        inBus = false;
      }
    };
  }
  console.log = wrap('log');
  console.info = wrap('info');
  console.warn = wrap('warn');
  console.error = wrap('error');
}

installConsoleBridge();

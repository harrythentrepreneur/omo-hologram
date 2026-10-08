// Live Google Drive connector. Polls the Drive `changes` feed and emits
// Data Core events for file create / modify / trash. Side-emits a
// `google_docs/doc_edited` event whenever the changed item is a Google
// Doc, so the Docs deep panel sees activity without needing its own
// poller (Google Docs has no first-class "changes" feed — Drive's is the
// canonical source).
//
// Single-user MVP. In-memory page token + caches; we re-watermark from
// `getStartPageToken` on boot or on a 410 InvalidPageToken response.

import { google } from 'googleapis';
import express from 'express';
import * as gauth from './google.js';
import * as dataCore from '../data_core.js';
import * as integrationDb from '../store/integration_db.js';

const POLL_MS = Number(process.env.DRIVE_POLL_MS) || 90_000;
const DEDUPE_WINDOW_MS = 5_000;
const DEDUPE_CAP = 500;
const NAME_CACHE_CAP = 1_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

let started = false;
let pageToken = null;
let lastErrorLogAt = 0;

// fileId -> last-emit timestamp; FIFO ring for trimming.
const dedupe = new Map();
const dedupeOrder = [];
// fileId -> name; FIFO for trimming. Lets us label `file_trashed` events
// after Drive stops sending the file metadata payload.
const nameCache = new Map();
const nameCacheOrder = [];

function rememberDedupe(fileId, ts) {
  dedupe.set(fileId, ts);
  dedupeOrder.push(fileId);
  while (dedupeOrder.length > DEDUPE_CAP) {
    const old = dedupeOrder.shift();
    if (dedupe.get(old) === ts) dedupe.delete(old);
    else dedupe.delete(old); // any value is fine — we only care about "seen recently"
  }
}

function rememberName(fileId, name) {
  if (!fileId || !name) return;
  if (nameCache.has(fileId)) {
    nameCache.set(fileId, name);
    return;
  }
  nameCache.set(fileId, name);
  nameCacheOrder.push(fileId);
  while (nameCacheOrder.length > NAME_CACHE_CAP) {
    const old = nameCacheOrder.shift();
    nameCache.delete(old);
  }
}

function shouldDedupe(fileId) {
  const last = dedupe.get(fileId);
  if (!last) return false;
  return (Date.now() - last) < DEDUPE_WINDOW_MS;
}

export function prettyType(mimeType) {
  if (!mimeType) return 'File';
  switch (mimeType) {
    case 'application/vnd.google-apps.document':     return 'Doc';
    case 'application/vnd.google-apps.spreadsheet':  return 'Sheet';
    case 'application/vnd.google-apps.presentation': return 'Slides';
    case 'application/vnd.google-apps.form':         return 'Form';
    case 'application/vnd.google-apps.drawing':      return 'Drawing';
    case 'application/vnd.google-apps.folder':       return 'Folder';
    case 'application/pdf':                          return 'PDF';
    case 'application/zip':
    case 'application/x-zip-compressed':             return 'Archive';
    default: break;
  }
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Audio';
  const slash = mimeType.indexOf('/');
  if (slash > 0) {
    const sub = mimeType.slice(slash + 1);
    return sub.charAt(0).toUpperCase() + sub.slice(1);
  }
  return mimeType;
}

export function ownerName(file) {
  return (
    file?.owners?.[0]?.displayName ||
    file?.owners?.[0]?.emailAddress?.split('@')[0] ||
    'unknown'
  );
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: gauth.getOAuth2Client() });
}

function logErrorThrottled(prefix, err) {
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt = now;
  console.warn(prefix, err.message || err);
}

async function fetchStartPageToken(drive) {
  const resp = await drive.changes.getStartPageToken({ supportsAllDrives: true });
  return resp.data.startPageToken;
}

async function pollOnce(drive, emit) {
  if (!pageToken) {
    pageToken = await fetchStartPageToken(drive);
    return;
  }

  let nextPageToken = pageToken;
  while (nextPageToken) {
    let resp;
    try {
      resp = await drive.changes.list({
        pageToken: nextPageToken,
        includeRemoved: true,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 100,
        fields: 'newStartPageToken, nextPageToken, changes(fileId, removed, time, file(id,name,mimeType,owners,modifiedTime,size,trashed,iconLink,webViewLink))',
      });
    } catch (err) {
      if (err?.code === 410) {
        console.warn('[drive] page token expired (410), re-watermarking');
        pageToken = await fetchStartPageToken(drive);
        return;
      }
      throw err;
    }

    const changes = resp.data.changes || [];
    for (const change of changes) {
      try {
        await handleChange(change, emit);
      } catch (err) {
        logErrorThrottled('[drive] change handler error:', err);
      }
    }

    if (resp.data.newStartPageToken) {
      pageToken = resp.data.newStartPageToken;
    }
    nextPageToken = resp.data.nextPageToken || null;
  }
}

function handleChange(change, emit) {
  const fileId = change.fileId;
  if (!fileId) return;

  const file = change.file;
  const removed = change.removed === true;
  const trashed = file?.trashed === true;

  if (removed || trashed) {
    const cachedName = nameCache.get(fileId);
    const name = file?.name || cachedName;
    if (!name && !file) return; // nothing useful to report
    const mimeType = file?.mimeType;
    const owner = file ? ownerName(file) : 'unknown';
    const ts = new Date(file?.modifiedTime || change.time || Date.now()).getTime();
    emit({
      id: `drive_${fileId}_${Date.now()}`,
      source: 'google_drive',
      kind: 'file_trashed',
      ts,
      title: name || '(deleted)',
      summary: `${owner} · ${prettyType(mimeType) || 'File'}`,
      data: {
        id: fileId,
        mimeType: mimeType || null,
        owner,
        sizeBytes: file?.size ? Number(file.size) : null,
        modifiedTime: file?.modifiedTime || null,
        iconLink: file?.iconLink || null,
        webViewLink: file?.webViewLink || null,
        prettyType: prettyType(mimeType),
      },
    });
    nameCache.delete(fileId);
    return;
  }

  if (!file) return;

  const name = file.name || '';
  if (!name) return;
  if (name.startsWith('~$') || name.startsWith('.')) return; // lockfiles / hidden
  const mimeType = file.mimeType;
  if (mimeType === 'application/vnd.google-apps.shortcut') return;
  if (mimeType === 'application/vnd.google-apps.folder') return;

  if (shouldDedupe(fileId)) return;

  const previouslyKnown = nameCache.has(fileId);
  const kind = previouslyKnown ? 'file_modified' : 'file_created';
  rememberName(fileId, name);
  rememberDedupe(fileId, Date.now());

  const owner = ownerName(file);
  const ts = new Date(file.modifiedTime || change.time || Date.now()).getTime();
  const data = {
    id: fileId,
    mimeType,
    owner,
    sizeBytes: file.size ? Number(file.size) : null,
    modifiedTime: file.modifiedTime || null,
    iconLink: file.iconLink || null,
    webViewLink: file.webViewLink || null,
    prettyType: prettyType(mimeType),
  };
  const summary = `${owner} · ${prettyType(mimeType)}`;

  emit({
    id: `drive_${fileId}_${Date.now()}`,
    source: 'google_drive',
    kind,
    ts,
    title: name,
    summary,
    data,
  });

  // Side-emit for Docs panel.
  if (mimeType === 'application/vnd.google-apps.document') {
    emit({
      id: `docs_${fileId}_${Date.now()}`,
      source: 'google_docs',
      kind: 'doc_edited',
      ts,
      title: name,
      summary,
      data: { ...data, docId: fileId },
    });
  }
}

export async function start({ emit }) {
  if (!gauth.hasRefreshToken()) {
    console.log('[drive] skipped (no GOOGLE_REFRESH_TOKEN)');
    return;
  }
  if (!gauth.isConfigured()) {
    console.log('[drive] skipped (OAuth client id/secret missing)');
    return;
  }
  if (started) {
    // change-feed poll already running — just make sure the integration
    // runtime (deep backfill, DB persistence, /status) is set up too.
    if (!runtime) {
      try { await connect({ emit }); } catch (err) { console.error('[drive] connect failed:', err.message); }
    }
    return;
  }
  started = true;

  const drive = getDriveClient();
  try {
    pageToken = await fetchStartPageToken(drive);
    console.log(`[drive] live · pageToken ${pageToken}`);
    if (typeof dataCore.markSourceLive === 'function') dataCore.markSourceLive('google_drive');
  } catch (err) {
    console.error('[drive] initial getStartPageToken failed:', err.message);
    started = false;
    return;
  }

  const tick = async () => {
    try {
      await pollOnce(drive, emit);
      if (runtime) runtime.lastPollAt = Date.now();
      invalidateDriveSummary();
    } catch (err) {
      logErrorThrottled('[drive] poll error:', err);
    } finally {
      const t = setTimeout(tick, POLL_MS);
      t.unref?.();
    }
  };

  const t = setTimeout(tick, POLL_MS);
  t.unref?.();

  // Set up the integration runtime (deep backfill + routes scaffolding).
  // Non-fatal if it fails; the change-feed poll above still runs.
  try { await connect({ emit }); } catch (err) { console.error('[drive] connect failed:', err.message); }
}

// Exposed for tests.
export const _internal = { dedupe, nameCache, getPageToken: () => pageToken };

// ═══════════════════════════════════════════════════════════════════
// Integration layer — deep backfill to integration_data + /omo/api/integrations/drive/*
// Same pattern as stripe / meta / gmail. The poll/change-feed logic
// above handles real-time deltas; this layer catches everything else
// via a periodic snapshot of the entire drive.
// ═══════════════════════════════════════════════════════════════════

const DEEP_RESYNC_MS = parseInt(process.env.DRIVE_RESYNC_MS, 10) || 21_600_000; // 6h
const BACKFILL_CAP = parseInt(process.env.DRIVE_BACKFILL_CAP, 10) || 500;
const DOC_BODY_CAP = parseInt(process.env.DRIVE_DOC_CHAR_CAP, 10) || 20_000;

let runtime = null;

// 30s in-memory cache for /summary. Smaller dataset than gmail/stripe/meta
// (~500 files) so the compute is only ~20–50ms, but the HQ panel re-fetches
// often and there's no reason to re-walk the same rows. Invalidated by
// poll/backfill below.
let _driveSummaryCache = { at: 0, body: null };
const DRIVE_SUMMARY_CACHE_TTL_MS = 30_000;
function invalidateDriveSummary() { _driveSummaryCache = { at: 0, body: null }; }

function getDocsClient() {
  return google.docs({ version: 'v1', auth: gauth.getOAuth2Client() });
}

function fmtIso(s) { return s ? String(s).replace('T', ' ').slice(0, 19) + 'Z' : '—'; }
function fmtBytes(n) {
  if (n == null) return '—';
  const x = Number(n);
  if (x < 1024) return `${x} B`;
  if (x < 1048576) return `${(x / 1024).toFixed(1)} KB`;
  if (x < 1073741824) return `${(x / 1048576).toFixed(1)} MB`;
  return `${(x / 1073741824).toFixed(2)} GB`;
}

// Walk a Google Docs document body and concatenate all text runs. Tries
// to preserve paragraph breaks + heading markers so the LLM sees the
// structure, not just a wall of text.
function extractDocText(doc) {
  if (!doc?.body?.content) return '';
  const lines = [];
  for (const el of doc.body.content) {
    if (!el.paragraph) continue;
    const style = el.paragraph.paragraphStyle?.namedStyleType || '';
    let text = '';
    for (const piece of el.paragraph.elements || []) {
      if (piece.textRun?.content) text += piece.textRun.content;
    }
    text = text.replace(/\n+$/, '');
    if (!text) { lines.push(''); continue; }
    if (style === 'TITLE')          lines.push('# ' + text);
    else if (style === 'HEADING_1') lines.push('## ' + text);
    else if (style === 'HEADING_2') lines.push('### ' + text);
    else if (style === 'HEADING_3') lines.push('#### ' + text);
    else                             lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderFile(file, bodyText) {
  const type = prettyType(file.mimeType);
  const owners = (file.owners || []).map((o) => o.emailAddress || o.displayName).filter(Boolean).join(', ') || '—';
  const lines = [
    `[${file.id}] ${file.name || '(unnamed)'} · ${type}${file.trashed ? ' · TRASHED' : ''}`,
    `  mime: ${file.mimeType || '—'} · size: ${fmtBytes(file.size)}`,
    `  owners: ${owners}`,
    `  created: ${fmtIso(file.createdTime)} · modified: ${fmtIso(file.modifiedTime)}`,
    `  url: ${file.webViewLink || '—'}`,
  ];
  if (file.starred) lines.push('  starred: yes');
  if (file.description) lines.push(`  description: ${file.description}`);
  if (bodyText) {
    const trimmed = bodyText.length > DOC_BODY_CAP ? bodyText.slice(0, DOC_BODY_CAP) + '\n  …[truncated at ' + DOC_BODY_CAP + ' chars]' : bodyText;
    lines.push('  body:');
    for (const ln of trimmed.split(/\r?\n/)) lines.push('    ' + ln);
  }
  return {
    plaintext: lines.join('\n'),
    title: file.name || file.id,
    summary: `${type} · ${ownerName(file)}`,
  };
}

// Paginated files.list. Excludes folders + trashed items to keep the
// dump relevant to actual content. Orders newest modified first.
async function listFiles(drive, cap) {
  const out = [];
  let pageToken;
  for (let page = 0; page < Math.ceil(cap / 100); page++) {
    const r = await drive.files.list({
      pageSize: Math.min(100, cap - out.length),
      pageToken,
      orderBy: 'modifiedTime desc',
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields: 'nextPageToken, files(id,name,mimeType,owners(displayName,emailAddress),modifiedTime,createdTime,size,starred,trashed,description,iconLink,webViewLink,parents)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    out.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
    if (!pageToken || out.length >= cap) break;
  }
  return out;
}

async function deepBackfill(rt) {
  if (!rt || rt.stopped) return;
  const drive = getDriveClient();
  const docs = getDocsClient();

  let files = [];
  try {
    files = await listFiles(drive, BACKFILL_CAP);
  } catch (err) {
    logErrorThrottled('[drive] files.list failed:', err);
    return;
  }

  let fetched = 0, docBodies = 0;
  for (const file of files) {
    if (rt.stopped) return;
    let bodyText = '';
    if (file.mimeType === 'application/vnd.google-apps.document') {
      try {
        const r = await docs.documents.get({ documentId: file.id });
        bodyText = extractDocText(r.data);
        docBodies++;
      } catch (err) {
        // Docs API failures shouldn't block the file row — just skip body.
        logErrorThrottled('[drive] docs.get failed for ' + file.id + ':', err);
      }
    }
    try {
      await integrationDb.upsertMany([{
        source: 'drive', kind: 'file', external_id: file.id,
        ts: new Date(file.modifiedTime || file.createdTime || Date.now()),
        data: { ...file, bodyText: bodyText || undefined },
        ...renderFile(file, bodyText),
      }]);
      fetched++;
    } catch { /* swallow per-row */ }
  }

  rt.persisted.file = fetched;
  rt.persisted.doc_bodies = docBodies;
  rt.deepBackfillDoneAt = Date.now();
  invalidateDriveSummary();
  console.log(`[drive] persisted ${fetched} file(s) · ${docBodies} doc body(ies) extracted`);
}

export async function connect({ emit }) {
  if (!gauth.isConfigured()) throw new Error('Google OAuth not configured.');
  if (!gauth.hasRefreshToken()) throw new Error('Drive not connected — run /auth/google/start first.');
  if (runtime) disconnect();

  const drive = getDriveClient();
  // Validate via about.get (cheap).
  const about = await drive.about.get({ fields: 'user(displayName,emailAddress,photoLink),storageQuota' });

  runtime = {
    emit,
    user: about.data.user,
    storageQuota: about.data.storageQuota,
    connectedAt: Date.now(),
    stopped: false,
    resyncTimer: null,
    persisted: {},
    deepBackfillDoneAt: null,
    lastPollAt: null,
    pollIntervalMs: POLL_MS,
    resyncIntervalMs: DEEP_RESYNC_MS,
  };

  console.log(`[drive] connected · ${about.data.user?.emailAddress} · poll=${Math.round(POLL_MS/1000)}s · resync=${Math.round(DEEP_RESYNC_MS/60000)}min`);

  deepBackfill(runtime).catch((err) => logErrorThrottled('[drive] deep backfill failed:', err));

  runtime.resyncTimer = setInterval(() => {
    const rt = runtime;
    if (!rt || rt.stopped) return;
    rt.persisted = {};
    rt.deepBackfillDoneAt = null;
    console.log('[drive] scheduled deep resync starting');
    deepBackfill(rt).catch((err) => logErrorThrottled('[drive] scheduled resync failed:', err));
  }, DEEP_RESYNC_MS);
  runtime.resyncTimer?.unref?.();

  return getStatus();
}

export function disconnect() {
  if (runtime) {
    runtime.stopped = true;
    if (runtime.resyncTimer) clearInterval(runtime.resyncTimer);
    runtime = null;
  }
  started = false;
  pageToken = null;
  console.log('[drive] disconnected');
}

export function getStatus() {
  if (!runtime) {
    return {
      connected: false,
      oauth_configured: gauth.isConfigured(),
      has_refresh_token: gauth.hasRefreshToken(),
    };
  }
  return {
    connected: true,
    oauth_configured: true,
    has_refresh_token: true,
    user_email: runtime.user?.emailAddress,
    user_name: runtime.user?.displayName,
    storage_limit: runtime.storageQuota?.limit ? Number(runtime.storageQuota.limit) : null,
    storage_usage: runtime.storageQuota?.usage ? Number(runtime.storageQuota.usage) : null,
    connected_at: runtime.connectedAt,
    persisted: runtime.persisted || {},
    deep_backfill_done_at: runtime.deepBackfillDoneAt,
    last_poll_at: runtime.lastPollAt,
    poll_interval_ms: runtime.pollIntervalMs,
    resync_interval_ms: runtime.resyncIntervalMs,
  };
}

export function mountRoutes(app, { emit }) {
  app.get('/omo/api/integrations/drive/status', (_req, res) => {
    res.json(getStatus());
  });

  app.post('/omo/api/integrations/drive/connect', express.json(), async (_req, res) => {
    if (!gauth.isConfigured()) return res.status(400).json({ ok: false, error: 'Google OAuth not configured.' });
    if (!gauth.hasRefreshToken()) return res.status(400).json({ ok: false, error: 'No refresh token — visit /auth/google/start first.' });
    try {
      // start() covers both the change-feed poll and the integration runtime.
      await start({ emit });
      res.json({ ok: true, status: getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/integrations/drive/disconnect', (_req, res) => {
    disconnect();
    res.json({ ok: true });
  });

  app.post('/omo/api/integrations/drive/backfill', async (req, res) => {
    if (!runtime) return res.status(409).json({ ok: false, error: 'Not connected.' });
    const rt = runtime;
    const prune = req.query.prune === '1' || req.query.prune === 'true';
    const waitForDone = req.query.wait === '1' || req.query.wait === 'true';
    try {
      if (prune) {
        const n = await integrationDb.pruneSource('drive');
        console.log(`[drive] pruned ${n} existing row(s) before backfill`);
      }
      rt.persisted = {};
      rt.deepBackfillDoneAt = null;
      const p = deepBackfill(rt).catch((err) => logErrorThrottled('[drive] manual backfill failed:', err));
      if (waitForDone) await p;
      res.json({ ok: true, pruned: prune, waited: waitForDone, status: getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get('/omo/api/integrations/drive/plaintext', async (req, res) => {
    try {
      const limitPerKind = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const status = getStatus();
      const counts = await integrationDb.countsBySource('drive');
      const totalRows = Object.values(counts).reduce((s, n) => s + n, 0);
      const ageMin = (t) => (t ? Math.round((Date.now() - t) / 60000) + 'm ago' : '—');
      const header = [
        '='.repeat(72),
        'GOOGLE DRIVE DATA DUMP',
        `generated: ${new Date().toISOString()}`,
        status.connected
          ? `account: ${status.user_email} · ${fmtBytes(status.storage_usage)} used of ${fmtBytes(status.storage_limit)}`
          : `account: (connector not currently connected — showing last persisted data)`,
        `poll: every ${Math.round((status.poll_interval_ms || 0) / 1000)}s · last_poll: ${ageMin(status.last_poll_at)}`,
        `deep resync: every ${Math.round((status.resync_interval_ms || 0) / 60000)}min · last_deep: ${ageMin(status.deep_backfill_done_at)}`,
        `rows: ${totalRows} across ${Object.keys(counts).length} kind(s) · limit per kind: ${limitPerKind}`,
        '='.repeat(72),
        '',
      ].join('\n');
      const order = ['file'];
      const body = await integrationDb.plaintextBySource('drive', { kindOrder: order, limitPerKind, header });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    } catch (err) {
      res.status(500).type('text/plain').send(`ERROR: ${err?.message || err}`);
    }
  });

  app.get('/omo/api/integrations/drive/summary', async (_req, res) => {
    try {
      if (_driveSummaryCache.body && (Date.now() - _driveSummaryCache.at) < DRIVE_SUMMARY_CACHE_TTL_MS) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(_driveSummaryCache.body);
      }
      const files = await integrationDb.listBySource('drive', { kind: 'file', limit: 500 });
      const byType = {};
      for (const r of files) {
        const mt = r.data?.mimeType || 'unknown';
        const t = prettyType(mt);
        byType[t] = (byType[t] || 0) + 1;
      }
      const recent = files.slice(0, 50).map((r) => {
        const d = r.data || {};
        return {
          id: r.external_id,
          name: d.name,
          type: prettyType(d.mimeType),
          mime: d.mimeType,
          owner: ownerName(d),
          modified: d.modifiedTime,
          size: d.size ? Number(d.size) : null,
          web_view_link: d.webViewLink,
          has_body: !!(d.bodyText && d.bodyText.length > 0),
        };
      });
      const body = {
        connected: !!runtime,
        user_email: runtime?.user?.emailAddress || null,
        total_files: files.length,
        by_type: byType,
        recent,
        counts: await integrationDb.countsBySource('drive'),
        last_poll_at: runtime?.lastPollAt || null,
        deep_backfill_done_at: runtime?.deepBackfillDoneAt || null,
      };
      _driveSummaryCache = { at: Date.now(), body };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Single Drive file by fileId. Returns the persisted data row including
  // the extracted bodyText (Markdown-formatted, capped at DOC_BODY_CAP).
  // Used by hq.html::openDriveFile() for the full-screen reader.
  app.get('/omo/api/integrations/drive/file/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'missing id' });
      const row = await integrationDb.getByExternalId('drive', id);
      if (!row) return res.status(404).json({ error: 'not found' });
      const d = row.data || {};
      res.json({
        id: row.external_id,
        ts: row.ts,
        title: row.title,
        summary: row.summary,
        name: d.name || row.title,
        mime: d.mimeType || null,
        size: d.size != null ? Number(d.size) : null,
        owners: Array.isArray(d.owners) ? d.owners.map((o) => ({ name: o.displayName, email: o.emailAddress })) : [],
        modified: d.modifiedTime || null,
        created: d.createdTime || null,
        starred: !!d.starred,
        trashed: !!d.trashed,
        description: d.description || '',
        web_link: d.webViewLink || null,
        parents: d.parents || [],
        body: typeof d.bodyText === 'string' ? d.bodyText : '',
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}

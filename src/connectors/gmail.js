// Live Gmail connector. Three responsibilities:
//   1. On connect, deep-backfill recent messages + labels + profile into
//      integration_data (source='gmail') so /hq can dump them as plaintext
//      and Momo can feed them to the LLM.
//   2. Poll the Gmail history feed and emit Data Core events + persist
//      each new inbox message.
//   3. Send mail on behalf of the user (driven by the send_email tool).
//
// Module-scoped `recentlySent` dedupes messages we just sent ourselves
// so they don't get re-emitted as "received" when they surface in SENT.

import { google } from 'googleapis';
import { randomUUID } from 'node:crypto';
import express from 'express';
import * as gauth from './google.js';
import * as integrationDb from '../store/integration_db.js';
import * as dataCore from '../data_core.js';

const POLL_MS = Number(process.env.GMAIL_POLL_MS) || 180_000;          // 3 min
const DEEP_RESYNC_MS = Number(process.env.GMAIL_RESYNC_MS) || 21_600_000; // 6 h
const BACKFILL_DAYS = Number(process.env.GMAIL_BACKFILL_DAYS) || 90;
const BACKFILL_CAP = Number(process.env.GMAIL_BACKFILL_CAP) || 500;
const PAGE_LIMIT = 100;
const RECENT_SENT_CAP = 50;

// Multi-account: one Runtime per connected Gmail address. The map is the
// single source of truth — lookups go runtimes.get(email). The legacy
// single-runtime API stays available via firstRuntime() / primaryRuntime()
// for callers that still operate on "the" account (mostly transitional).
const runtimes = new Map(); // email → Runtime

// /summary response cache, scoped per account. Building the summary
// touches 1000 messages 3x synchronously (top senders + labels breakdown
// + hourly_today), plus a few Postgres queries. 30s TTL keeps panels
// feeling live while collapsing duplicate work; the cache for a given
// account is invalidated on any poll/backfill that touched its rows.
const _summaryCache = new Map(); // accountId → { at, body }
const SUMMARY_CACHE_TTL_MS = 30_000;
function invalidateSummary(accountId) {
  if (accountId) _summaryCache.delete(accountId);
  else _summaryCache.clear();
}

// Drafts-list count cache, scoped per account.
const _draftsCache = new Map(); // accountId → { at, count }
const DRAFTS_CACHE_TTL_MS = 60_000;

async function getDraftsCountCached(rt) {
  if (!rt?.gmail) return 0;
  const accountId = rt.email;
  const cached = _draftsCache.get(accountId);
  const now = Date.now();
  if (cached && cached.count != null && now - cached.at < DRAFTS_CACHE_TTL_MS) {
    return cached.count;
  }
  try {
    const r = await rt.gmail.users.drafts.list({ userId: 'me', maxResults: 1 });
    const count = Number(r?.data?.resultSizeEstimate ?? 0);
    _draftsCache.set(accountId, { at: now, count });
    return count;
  } catch (err) {
    _draftsCache.set(accountId, { at: now, count: cached?.count ?? 0 });
    return cached?.count ?? 0;
  }
}

function firstRuntime() {
  return runtimes.values().next().value || null;
}

function resolveRuntime(accountId) {
  if (accountId && runtimes.has(accountId)) return runtimes.get(accountId);
  if (accountId) {
    // Tolerate case differences ("Alex@…" vs "alex@…").
    const key = String(accountId).toLowerCase();
    for (const [k, rt] of runtimes) {
      if (k.toLowerCase() === key) return rt;
    }
  }
  // Default: prefer the primary, else any first runtime.
  const primaryEmail = gauth.getPrimaryAccount?.();
  if (primaryEmail && runtimes.has(primaryEmail)) return runtimes.get(primaryEmail);
  return firstRuntime();
}

function listRuntimes() {
  return Array.from(runtimes.values());
}

// Walk a Gmail payload tree yielding any part with a non-empty filename.
// Iterative (stack) so we avoid recursion cost on deeply-nested MIME.
function walkAttachmentParts(payload) {
  const out = [];
  if (!payload) return out;
  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.filename && node.filename.length > 0) {
      out.push({
        filename: node.filename,
        mime: node.mimeType || '',
        size: Number(node.body?.size) || 0,
      });
    }
    if (Array.isArray(node.parts)) {
      for (const p of node.parts) stack.push(p);
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────── helpers

// Per-runtime "we just sent this" set, used to suppress emitting a
// just-sent message as a fresh inbound when it surfaces in SENT. Each
// account has its own set so a sent-id from account A can't suppress an
// inbound on account B (Gmail message ids are unique per-mailbox).
function rememberSent(rt, messageId) {
  if (!rt || !messageId) return;
  if (!rt.recentlySent) { rt.recentlySent = new Set(); rt.recentlySentOrder = []; }
  rt.recentlySent.add(messageId);
  rt.recentlySentOrder.push(messageId);
  while (rt.recentlySentOrder.length > RECENT_SENT_CAP) {
    const old = rt.recentlySentOrder.shift();
    rt.recentlySent.delete(old);
  }
}

function getGmailClientFor(email) {
  return google.gmail({ version: 'v1', auth: gauth.getOAuth2ClientFor(email) });
}

// Legacy single-account client. Kept for any caller that hasn't been
// migrated yet — falls back to the global resolver in google.js.
function getGmailClient() {
  return google.gmail({ version: 'v1', auth: gauth.getOAuth2Client() });
}

function header(headers, name) {
  if (!Array.isArray(headers)) return '';
  const lower = name.toLowerCase();
  const match = headers.find((h) => (h?.name || '').toLowerCase() === lower);
  return match?.value || '';
}

function fromName(fromHeader) {
  if (!fromHeader) return '';
  const m = fromHeader.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
  if (m) return m[1].trim();
  const at = fromHeader.indexOf('@');
  if (at > 0) return fromHeader.slice(0, at);
  return fromHeader;
}

function fromEmail(fromHeader) {
  if (!fromHeader) return '';
  const m = fromHeader.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  return fromHeader.includes('@') ? fromHeader.toLowerCase() : '';
}

function fmtTs(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

// Walk a Gmail payload tree and return the best plain-text body.
// Priority: text/plain > text/html (stripped) > nothing.
function extractBody(payload) {
  if (!payload) return '';

  const decode = (data) => {
    if (!data) return '';
    try { return Buffer.from(data, 'base64url').toString('utf8'); }
    catch { return ''; }
  };
  const stripHtml = (html) => html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Prefer text/plain walker (BFS).
  const queue = [payload];
  let htmlFallback = '';
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    const mt = (node.mimeType || '').toLowerCase();
    if (mt === 'text/plain' && node.body?.data) {
      return decode(node.body.data).trim();
    }
    if (mt === 'text/html' && node.body?.data && !htmlFallback) {
      htmlFallback = stripHtml(decode(node.body.data));
    }
    if (Array.isArray(node.parts)) queue.push(...node.parts);
  }
  if (htmlFallback) return htmlFallback;
  // Single-part edge case — body.data at root.
  if (payload.body?.data) return decode(payload.body.data).trim();
  return '';
}

// Shrink a full Gmail message object so the stored JSONB row is small.
// Keep: headers, labels, decoded bodyText, and attachment metadata
// (filename/mime/size + the per-part attachmentId so we can re-download
// a blob on demand). Drop the raw part tree and every base64 `body.data`
// blob — those are the big ones.
// Cap stored bodyText. A single newsletter or auto-report can hit several
// MB; storing the raw body means upsertMany has to JSON.stringify rows
// that big in a tight loop, which blocks the Node event loop for many
// seconds during deep backfill — long enough that the cylinder's WS
// frames to Gemini Live time out and the tab appears to crash. 200KB is
// far more than anyone will read in a HQ pane.
const BODY_STORE_MAX = 200 * 1024;

function slimMessage(msg, bodyText) {
  const attachments = extractAttachmentMeta(msg.payload);
  const capped = typeof bodyText === 'string' && bodyText.length > BODY_STORE_MAX
    ? bodyText.slice(0, BODY_STORE_MAX) + `\n\n[…truncated · original ${(bodyText.length / 1024).toFixed(0)}KB]`
    : (bodyText || '');
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    internalDate: msg.internalDate,
    sizeEstimate: msg.sizeEstimate,
    historyId: msg.historyId,
    payload: {
      mimeType: msg.payload?.mimeType,
      headers: msg.payload?.headers,
    },
    attachments,
    has_attachment: attachments.length > 0,
    bodyText: capped,
    body_truncated: typeof bodyText === 'string' && bodyText.length > BODY_STORE_MAX,
    body_original_bytes: typeof bodyText === 'string' ? bodyText.length : 0,
  };
}

// Walk a payload tree and return a compact list of attachment metadata
// records — no base64 data, just { filename, mime, size, partId,
// attachmentId }. Iterative (stack) to tolerate deeply-nested multipart.
function extractAttachmentMeta(payload) {
  const out = [];
  if (!payload) return out;
  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.filename && node.filename.length > 0) {
      out.push({
        filename: node.filename,
        mime: node.mimeType || '',
        size: Number(node.body?.size) || 0,
        partId: node.partId || null,
        attachmentId: node.body?.attachmentId || null,
      });
    }
    if (Array.isArray(node.parts)) {
      for (const p of node.parts) stack.push(p);
    }
  }
  return out;
}

const BODY_CAP = Number(process.env.GMAIL_BODY_CHAR_CAP) || 8000;

function isAsciiOnly(str) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(str);
}

function encodeRFC2047(subject) {
  if (!subject) return '';
  if (isAsciiOnly(subject)) return subject;
  const b64 = Buffer.from(subject, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

// ──────────────────────────────────────────────────────── plaintext renderers

function renderMessage(msg) {
  const headers = msg.payload?.headers || [];
  const from = header(headers, 'From');
  const to = header(headers, 'To');
  const cc = header(headers, 'Cc');
  const subject = header(headers, 'Subject') || '(no subject)';
  const date = header(headers, 'Date');
  const snippet = (msg.snippet || '').slice(0, 300);
  const labels = (msg.labelIds || []).join(', ') || '—';
  const ts = Number(msg.internalDate) || Date.now();
  // bodyText is populated by deepBackfill/poll fetches (format: 'full').
  // Older rows from the metadata-only era fall back to snippet.
  const bodyRaw = msg.bodyText ? String(msg.bodyText) : '';
  const body = bodyRaw.length > BODY_CAP ? bodyRaw.slice(0, BODY_CAP) + '\n  …[truncated at ' + BODY_CAP + ' chars]' : bodyRaw;

  const lines = [
    `[${msg.id}] ${fmtTs(ts)} · ${subject}`,
    `  from: ${from}`,
    `  to:   ${to}${cc ? ' · cc: ' + cc : ''}`,
    `  labels: ${labels} · thread: ${msg.threadId || '—'}`,
  ];
  if (date) lines.push(`  date: ${date}`);
  if (body) {
    lines.push('  body:');
    for (const ln of body.split(/\r?\n/)) lines.push('    ' + ln);
  } else if (snippet) {
    lines.push(`  snippet: ${snippet}${(msg.snippet || '').length > 300 ? '…' : ''}`);
  }
  return {
    plaintext: lines.join('\n'),
    title: subject,
    summary: `${fromName(from)} · ${snippet.slice(0, 80)}`,
  };
}

function renderLabel(lbl) {
  const unread = lbl.messagesUnread ?? 0;
  const total = lbl.messagesTotal ?? 0;
  return {
    plaintext: `[${lbl.id}] ${lbl.name} · type=${lbl.type} · messages=${total} (${unread} unread) · threads=${lbl.threadsTotal ?? 0}`,
    title: lbl.name,
    summary: `${total} messages · ${unread} unread`,
  };
}

function renderProfile(p) {
  return {
    plaintext: [
      `[${p.emailAddress}] Gmail profile`,
      `  messages_total: ${p.messagesTotal}`,
      `  threads_total:  ${p.threadsTotal}`,
      `  history_id:     ${p.historyId}`,
    ].join('\n'),
    title: p.emailAddress,
    summary: `${p.messagesTotal} messages · ${p.threadsTotal} threads`,
  };
}

// ──────────────────────────────────────────────────────── persistence

async function persistMessage(msg, accountId) {
  if (!msg?.id) return;
  try {
    const ts = new Date(Number(msg.internalDate) || Date.now());
    const bodyText = extractBody(msg.payload);
    const slim = slimMessage(msg, bodyText);
    await integrationDb.upsertMany([{
      source: 'gmail', kind: 'message', external_id: msg.id,
      ts, data: slim, ...renderMessage(slim),
      account_id: accountId || null,
    }]);
  } catch { /* swallow */ }
}

// ──────────────────────────────────────────────────────── deep backfill

async function deepBackfill(rt) {
  if (!rt || rt.stopped) return;
  const gmail = rt.gmail;
  const acct = rt.email;

  // Profile
  try {
    const r = await gmail.users.getProfile({ userId: 'me' });
    const p = r.data;
    await integrationDb.upsertMany([{
      source: 'gmail', kind: 'profile', external_id: p.emailAddress,
      ts: new Date(), data: p, ...renderProfile(p),
      account_id: acct,
    }]);
    rt.email = p.emailAddress;
    rt.messagesTotal = p.messagesTotal;
    rt.threadsTotal = p.threadsTotal;
    rt.persisted.profile = 1;
  } catch (err) {
    logErrorThrottled(rt, 'profile pull failed', err);
  }

  // Labels
  try {
    const r = await gmail.users.labels.list({ userId: 'me' });
    const labels = r.data.labels || [];
    const enriched = await Promise.all(labels.slice(0, 80).map(async (l) => {
      try {
        const g = await gmail.users.labels.get({ userId: 'me', id: l.id });
        return g.data;
      } catch { return l; }
    }));
    const rows = enriched.map((l) => ({
      source: 'gmail', kind: 'label', external_id: `${acct}:${l.id}`,
      ts: new Date(), data: l, ...renderLabel(l),
      account_id: acct,
    }));
    rt.persisted.label = await integrationDb.upsertMany(rows);
  } catch (err) {
    logErrorThrottled(rt, 'labels pull failed', err);
  }

  // Messages — pull last BACKFILL_DAYS, capped at BACKFILL_CAP
  try {
    const q = `newer_than:${BACKFILL_DAYS}d`;
    const ids = [];
    let pageToken;
    for (let page = 0; page < Math.ceil(BACKFILL_CAP / PAGE_LIMIT); page++) {
      const r = await gmail.users.messages.list({
        userId: 'me',
        maxResults: Math.min(PAGE_LIMIT, BACKFILL_CAP - ids.length),
        pageToken,
        q,
      });
      const batch = r.data.messages || [];
      ids.push(...batch.map((m) => m.id));
      pageToken = r.data.nextPageToken;
      if (!pageToken || ids.length >= BACKFILL_CAP) break;
    }
    let fetched = 0;
    const CONCURRENCY = 8;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      if (rt.stopped) return;
      const batch = ids.slice(i, i + CONCURRENCY);
      const msgs = await Promise.all(batch.map(async (id) => {
        try {
          const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          return r.data;
        } catch (err) {
          if (err?.code !== 404) logErrorThrottled(rt, 'message get failed', err);
          return null;
        }
      }));
      const rows = msgs.filter(Boolean).map((m) => {
        const bodyText = extractBody(m.payload);
        const slim = slimMessage(m, bodyText);
        return {
          source: 'gmail', kind: 'message', external_id: m.id,
          ts: new Date(Number(m.internalDate) || Date.now()),
          data: slim, ...renderMessage(slim),
          account_id: acct,
        };
      });
      await integrationDb.upsertMany(rows);
      fetched += rows.length;
    }
    rt.persisted.message = fetched;
    console.log(`[gmail] persisted ${fetched} message(s) · profile=${rt.email}`);
  } catch (err) {
    logErrorThrottled(rt, 'messages backfill failed', err);
  }

  rt.deepBackfillDoneAt = Date.now();
  invalidateSummary(acct);
  console.log(`[gmail] deep backfill complete · ${acct}`);
}

// ──────────────────────────────────────────────────────── poll loop

async function resyncWatermark(rt) {
  const profile = await rt.gmail.users.getProfile({ userId: 'me' });
  rt.email = profile.data.emailAddress;
  rt.lastHistoryId = profile.data.historyId;
  return profile.data;
}

async function fetchAndEmitMessage(rt, messageId) {
  try {
    const msg = await rt.gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'full',
    });
    const headers = msg.data.payload?.headers || [];
    const labelIds = msg.data.labelIds || [];

    persistMessage(msg.data, rt.email);

    // Skip emitting messages we just sent ourselves (per-account dedupe).
    if (labelIds.includes('SENT') && rt.recentlySent?.has(messageId)) return;
    if (!labelIds.includes('INBOX')) return;

    const from = header(headers, 'From');
    const to = header(headers, 'To');
    const subject = header(headers, 'Subject') || '(no subject)';
    const snippet = (msg.data.snippet || '').toString();
    const ts = Number(msg.data.internalDate) || Date.now();

    rt.emit({
      id: randomUUID(),
      source: 'gmail', kind: 'email_received', ts,
      title: subject,
      summary: `${fromName(from)} · ${snippet.slice(0, 60)}`,
      account_id: rt.email,
      data: {
        from, to, subject, snippet, labels: labelIds,
        threadId: msg.data.threadId, messageId,
        account_id: rt.email,
      },
    });
  } catch (err) {
    if (err?.code === 404) return;
    console.warn(`[gmail:${rt.email}] message fetch failed:`, err.message);
  }
}

async function pollOnce(rt) {
  if (!rt.lastHistoryId) {
    await resyncWatermark(rt);
    return;
  }

  let pageToken;
  let newWatermark = rt.lastHistoryId;
  do {
    let resp;
    try {
      resp = await rt.gmail.users.history.list({
        userId: 'me',
        startHistoryId: rt.lastHistoryId,
        historyTypes: ['messageAdded', 'labelAdded', 'labelRemoved'],
        maxResults: 100,
        pageToken,
      });
    } catch (err) {
      if (err?.code === 404) {
        console.warn('[gmail] history watermark expired (>7d), resyncing — events in this window skipped');
        await resyncWatermark(rt);
        return;
      }
      throw err;
    }

    const history = resp.data.history || [];
    for (const entry of history) {
      const added = entry.messagesAdded || [];
      for (const m of added) {
        const id = m.message?.id;
        const labelIds = m.message?.labelIds || [];
        if (!id) continue;
        if (!labelIds.includes('INBOX')) continue;
        await fetchAndEmitMessage(rt, id);
      }

      for (const l of (entry.labelsAdded || [])) {
        const id = l.message?.id;
        if (!id) continue;
        rt.emit({
          id: randomUUID(),
          source: 'gmail', kind: 'email_labeled', ts: Date.now(),
          title: 'Label added',
          summary: (l.labelIds || []).join(', '),
          account_id: rt.email,
          data: { messageId: id, added: l.labelIds || [], removed: [], account_id: rt.email },
        });
      }
      for (const l of (entry.labelsRemoved || [])) {
        const id = l.message?.id;
        if (!id) continue;
        rt.emit({
          id: randomUUID(),
          source: 'gmail', kind: 'email_labeled', ts: Date.now(),
          title: 'Label removed',
          summary: (l.labelIds || []).join(', '),
          account_id: rt.email,
          data: { messageId: id, added: [], removed: l.labelIds || [], account_id: rt.email },
        });
      }
    }

    if (resp.data.historyId) newWatermark = resp.data.historyId;
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  rt.lastHistoryId = newWatermark;
  rt.lastPollAt = Date.now();
  invalidateSummary(rt.email);
}

function logErrorThrottled(rt, label, err) {
  const now = Date.now();
  if (!rt || now - rt.lastErrorLogAt < 60_000) return;
  if (rt) rt.lastErrorLogAt = now;
  console.error(`[gmail] ${label}:`, err?.message || err);
}

function isAuthError(err) {
  const s = err?.code || err?.response?.status;
  return s === 401 || s === 403;
}

// ──────────────────────────────────────────────────────── connect / disconnect

// Per-account connect. Always operate against runtimes Map — never a
// shared singleton. Idempotent: reconnecting an already-live account
// disconnects it first.
export async function connectAccount(email, { emit }) {
  if (!gauth.isConfigured()) throw new Error('Google OAuth not configured (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env).');
  if (!email) throw new Error('connectAccount: email required');
  if (!gauth.getRefreshTokenFor(email)) throw new Error(`Gmail account ${email} has no refresh token — run /auth/google/start first.`);

  if (runtimes.has(email)) disconnectAccount(email);

  const gmail = getGmailClientFor(email);
  const profile = await gmail.users.getProfile({ userId: 'me' });
  if (profile.data.emailAddress !== email) {
    console.warn(`[gmail] account file ${email} resolved to profile ${profile.data.emailAddress} — using profile email as canonical`);
    email = profile.data.emailAddress;
  }

  const rt = {
    gmail,
    emit,
    email,
    messagesTotal: profile.data.messagesTotal,
    threadsTotal: profile.data.threadsTotal,
    lastHistoryId: profile.data.historyId,
    connectedAt: Date.now(),
    lastErrorLogAt: 0,
    lastPollAt: null,
    stopped: false,
    pollTimer: null,
    resyncTimer: null,
    persisted: {},
    deepBackfillDoneAt: null,
    errorStreak: 0,
    pollIntervalMs: POLL_MS,
    resyncIntervalMs: DEEP_RESYNC_MS,
    recentlySent: new Set(),
    recentlySentOrder: [],
  };

  runtimes.set(email, rt);
  console.log(`[gmail] connected · ${email} · history ${profile.data.historyId} · poll=${Math.round(POLL_MS/1000)}s · resync=${Math.round(DEEP_RESYNC_MS/60000)}min · runtimes=${runtimes.size}`);

  if (typeof dataCore.markSourceLive === 'function') dataCore.markSourceLive('gmail');

  deepBackfill(rt).catch((err) => {
    if (isAuthError(err)) { disconnectAccount(email); return; }
    logErrorThrottled(rt, 'deep backfill failed', err);
  });

  const tickWrapped = async () => {
    const cur = runtimes.get(email);
    if (!cur || cur.stopped) return;
    try {
      await pollOnce(cur);
      cur.errorStreak = 0;
    } catch (err) {
      cur.errorStreak += 1;
      if (isAuthError(err)) { disconnectAccount(email); return; }
      console.warn(`[gmail:${email}] poll error (#${cur.errorStreak}):`, err.message);
    } finally {
      if (cur && !cur.stopped) {
        const delay = POLL_MS * Math.min(1 + cur.errorStreak, 6);
        cur.pollTimer = setTimeout(tickWrapped, delay);
        cur.pollTimer?.unref?.();
      }
    }
  };

  rt.pollTimer = setTimeout(tickWrapped, POLL_MS);
  rt.pollTimer?.unref?.();

  rt.resyncTimer = setInterval(() => {
    const cur = runtimes.get(email);
    if (!cur || cur.stopped) return;
    cur.persisted = {};
    cur.deepBackfillDoneAt = null;
    console.log(`[gmail:${email}] scheduled deep resync starting`);
    deepBackfill(cur).catch((err) => {
      if (isAuthError(err)) { disconnectAccount(email); return; }
      logErrorThrottled(cur, 'scheduled resync failed', err);
    });
  }, DEEP_RESYNC_MS);
  rt.resyncTimer?.unref?.();

  return getAccountStatus(email);
}

export function disconnectAccount(email) {
  const rt = runtimes.get(email);
  if (!rt) return;
  rt.stopped = true;
  if (rt.pollTimer) clearTimeout(rt.pollTimer);
  if (rt.resyncTimer) clearInterval(rt.resyncTimer);
  runtimes.delete(email);
  invalidateSummary(email);
  _draftsCache.delete(email);
  console.log(`[gmail] disconnected · ${email} · runtimes=${runtimes.size}`);
}

// Legacy single-account API. Kept so existing callers (server.js boot,
// onboarding's reconnectGoogleConnectors, /disconnect route) keep
// working — primary-or-first semantics.
export async function connect({ emit }) {
  const primary = gauth.getPrimaryAccount?.() || null;
  if (primary && gauth.getRefreshTokenFor(primary)) {
    return connectAccount(primary, { emit });
  }
  // Fallback: legacy env-token path. Resolve email by hitting getProfile
  // with the global client and persisting that email as account_id.
  if (!gauth.hasRefreshToken()) throw new Error('Gmail not connected — run /auth/google/start first.');
  const gmail = getGmailClient();
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress;
  return connectAccount(email, { emit });
}

export function disconnect() {
  // Disconnect everything.
  for (const email of Array.from(runtimes.keys())) disconnectAccount(email);
}

export function getAccountStatus(email) {
  const rt = runtimes.get(email);
  if (!rt) return null;
  return {
    connected: true,
    email: rt.email,
    messages_total: rt.messagesTotal,
    threads_total: rt.threadsTotal,
    connected_at: rt.connectedAt,
    last_history_id: rt.lastHistoryId,
    last_poll_at: rt.lastPollAt,
    persisted: rt.persisted || {},
    deep_backfill_done_at: rt.deepBackfillDoneAt,
    poll_interval_ms: rt.pollIntervalMs,
    resync_interval_ms: rt.resyncIntervalMs,
  };
}

export function getStatus() {
  const oauth_configured = gauth.isConfigured();
  const accounts = listRuntimes().map((rt) => getAccountStatus(rt.email)).filter(Boolean);
  if (accounts.length === 0) {
    return {
      connected: false,
      oauth_configured,
      has_refresh_token: gauth.hasRefreshToken(),
      accounts: [],
      primary: null,
    };
  }
  const primary = gauth.getPrimaryAccount?.() || accounts[0].email;
  // Backwards-compat: hoist the primary account's fields to the top
  // level so callers reading .email / .messages_total still work.
  const top = accounts.find((a) => a.email === primary) || accounts[0];
  return {
    connected: true,
    oauth_configured: true,
    has_refresh_token: true,
    primary,
    accounts,
    ...top,
  };
}

// ──────────────────────────────────────────────────────── env-based boot

export async function start({ emit }) {
  if (!gauth.isConfigured()) {
    console.log('[gmail] skipped (OAuth client id/secret missing)');
    return;
  }
  // New: connect every persisted account, not just the primary.
  const accounts = gauth.listAccounts?.() || [];
  if (accounts.length === 0) {
    if (!gauth.hasRefreshToken()) {
      console.log('[gmail] skipped (no refresh token — run /auth/google/start)');
      return;
    }
    // Legacy single-token path.
    try { await connect({ emit }); } catch (err) {
      console.error('[gmail] start failed:', err?.message || err);
    }
    return;
  }
  for (const a of accounts) {
    try {
      await connectAccount(a.email, { emit });
    } catch (err) {
      console.error(`[gmail:${a.email}] start failed:`, err?.message || err);
    }
  }
}

// ──────────────────────────────────────────────────────── send

export async function sendEmail({ to, subject, body, cc, bcc, replyToThreadId, account_id }, { emit } = {}) {
  if (!to) throw new Error('sendEmail: `to` is required');
  if (!subject) throw new Error('sendEmail: `subject` is required');
  if (typeof body !== 'string') throw new Error('sendEmail: `body` is required (string)');
  if (!gauth.hasRefreshToken()) throw new Error('Gmail not connected (no refresh token).');

  // Resolve the account: explicit arg → primary → first runtime → throw.
  let acct = account_id || gauth.getPrimaryAccount?.() || firstRuntime()?.email || null;
  if (!acct) throw new Error('sendEmail: no account_id and no primary Gmail account');
  const rt = resolveRuntime(acct);
  // If the runtime isn't live yet (account just added pre-backfill), use
  // a fresh per-account client directly — sending doesn't need the poll
  // loop to be running.
  const gmail = rt?.gmail || getGmailClientFor(acct);

  const headerLines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeRFC2047(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean).join('\r\n');

  const bodyB64 = Buffer.from(body, 'utf8').toString('base64');
  const raw = `${headerLines}\r\n\r\n${bodyB64}`;
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded, threadId: replyToThreadId || undefined },
  });

  const messageId = result.data.id;
  const threadId = result.data.threadId;
  if (rt) rememberSent(rt, messageId);

  if (typeof emit === 'function') {
    emit({
      id: randomUUID(),
      source: 'gmail', kind: 'email_sent', ts: Date.now(),
      title: subject,
      summary: `to ${to}`,
      account_id: acct,
      data: { to, cc, bcc, subject, body, messageId, threadId, account_id: acct },
    });
  }

  return { id: messageId, threadId, summary: `sent to ${to}`, account_id: acct };
}

// ──────────────────────────────────────────────────────── routes

export function mountRoutes(app, { emit }) {
  app.get('/omo/api/integrations/gmail/status', (_req, res) => {
    res.json(getStatus());
  });

  // POST /connect: kicks the connector. Optional `?account=email` body or
  // query connects a specific account; otherwise connects every persisted
  // account in parallel.
  app.post('/omo/api/integrations/gmail/connect', express.json(), async (req, res) => {
    if (!gauth.isConfigured()) return res.status(400).json({ ok: false, error: 'Google OAuth not configured — set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env.' });
    const acct = req.query?.account || req.body?.account || null;
    try {
      if (acct) {
        const status = await connectAccount(String(acct), { emit });
        return res.json({ ok: true, status });
      }
      await start({ emit });
      res.json({ ok: true, status: getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Disconnect a specific account (?account=email) or all of them.
  app.post('/omo/api/integrations/gmail/disconnect', express.json(), (req, res) => {
    const acct = req.query?.account || req.body?.account || null;
    if (acct) disconnectAccount(String(acct));
    else disconnect();
    res.json({ ok: true });
  });

  app.post('/omo/api/integrations/gmail/backfill', async (req, res) => {
    const acct = req.query?.account || null;
    const rt = acct ? runtimes.get(String(acct)) : firstRuntime();
    if (!rt) return res.status(409).json({ ok: false, error: acct ? `Not connected: ${acct}` : 'Not connected — connect first.' });
    const prune = req.query.prune === '1' || req.query.prune === 'true';
    const waitForDone = req.query.wait === '1' || req.query.wait === 'true';
    try {
      if (prune) {
        // Prune only this account's rows — never wipe the whole gmail
        // source (would also kill other accounts' data).
        const q = (await import('../db.js')).sql();
        const r = await q`DELETE FROM integration_data WHERE source = 'gmail' AND account_id = ${rt.email}`;
        console.log(`[gmail:${rt.email}] pruned ${r?.rowCount ?? 0} row(s) before backfill`);
      }
      rt.persisted = {};
      rt.deepBackfillDoneAt = null;
      const p = deepBackfill(rt).catch((err) => {
        if (isAuthError(err)) { disconnectAccount(rt.email); return; }
        logErrorThrottled(rt, 'manual backfill failed', err);
      });
      if (waitForDone) await p;
      res.json({ ok: true, account: rt.email, pruned: prune, waited: waitForDone, status: getAccountStatus(rt.email) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/integrations/gmail/rehydrate', async (req, res) => {
    const acct = req.query?.account || null;
    const rt = acct ? runtimes.get(String(acct)) : firstRuntime();
    if (!rt) return res.status(409).json({ ok: false, error: acct ? `Not connected: ${acct}` : 'Not connected — connect first.' });
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    try {
      const rows = await integrationDb.listBySource('gmail', { kind: 'message', limit, account_id: rt.email });
      let updated = 0, skipped = 0, failed = 0;
      for (const r of rows) {
        const id = r.external_id;
        if (!id) { skipped++; continue; }
        try {
          const full = await rt.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const m = full.data;
          const bodyText = extractBody(m.payload).slice(0, BODY_CAP);
          const slim = slimMessage(m, bodyText);
          await integrationDb.upsertMany([{
            source: 'gmail', kind: 'message', external_id: m.id,
            ts: new Date(Number(m.internalDate) || Date.now()),
            data: slim,
            ...renderMessage(m),
            account_id: rt.email,
          }]);
          updated++;
        } catch (err) {
          failed++;
          if (isAuthError(err)) break;
        }
      }
      res.json({ ok: true, account: rt.email, scanned: rows.length, updated, skipped, failed });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get('/omo/api/integrations/gmail/plaintext', async (req, res) => {
    try {
      const limitPerKind = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 200));
      const status = getStatus();
      const counts = await integrationDb.countsBySource('gmail');
      const totalRows = Object.values(counts).reduce((s, n) => s + n, 0);
      const ageMin = (t) => (t ? Math.round((Date.now() - t) / 60000) + 'm ago' : '—');
      const header = [
        '='.repeat(72),
        'GMAIL DATA DUMP',
        `generated: ${new Date().toISOString()}`,
        status.connected
          ? `account: ${status.email} · ${status.messages_total || '?'} messages · ${status.threads_total || '?'} threads`
          : `account: (connector not currently connected — showing last persisted data)`,
        `poll: every ${Math.round((status.poll_interval_ms || 0) / 1000)}s · last_poll: ${ageMin(status.last_poll_at)}`,
        `deep resync: every ${Math.round((status.resync_interval_ms || 0) / 60000)}min · last_deep: ${ageMin(status.deep_backfill_done_at)}`,
        `rows: ${totalRows} across ${Object.keys(counts).length} kind(s) · limit per kind: ${limitPerKind}`,
        '='.repeat(72),
        '',
      ].join('\n');
      const order = ['profile', 'label', 'message'];
      const body = await integrationDb.plaintextBySource('gmail', { kindOrder: order, limitPerKind, header });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    } catch (err) {
      res.status(500).type('text/plain').send(`ERROR: ${err?.message || err}`);
    }
  });

  // Summary: unread count, top senders, newest N messages. Driven entirely
  // from the persisted integration_data rows — no additional API calls.
  // ?account=email   → filter to that account
  // ?account=all     → unified across every connected account (default)
  app.get('/omo/api/integrations/gmail/summary', async (req, res) => {
    try {
      const acctParam = req.query?.account ? String(req.query.account) : null;
      const account = acctParam && acctParam.toLowerCase() !== 'all' ? acctParam : null;
      const cacheKey = account || '__all__';
      const cached = _summaryCache.get(cacheKey);
      if (cached?.body && (Date.now() - cached.at) < SUMMARY_CACHE_TTL_MS) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(cached.body);
      }
      const dbOpts = account ? { account_id: account } : {};
      const msgs = await integrationDb.listBySource('gmail', { kind: 'message', limit: 1000, ...dbOpts });
      const labels = await integrationDb.listBySource('gmail', { kind: 'label', limit: 100, ...dbOpts });
      const inboxLbl = labels.find((l) => (l.data?.id || l.external_id) === 'INBOX');
      const unreadLbl = labels.find((l) => (l.data?.id || l.external_id) === 'UNREAD');
      const senders = {};
      const now = Date.now();
      let today = 0, last7 = 0;
      for (const r of msgs) {
        const d = r.data || {};
        const h = d.payload?.headers || [];
        const from = h.find((x) => (x.name || '').toLowerCase() === 'from')?.value || '';
        const email = fromEmail(from);
        const name = fromName(from) || email;
        if (email) {
          senders[email] = senders[email] || { email, name, n: 0 };
          senders[email].n++;
        }
        const ts = Number(d.internalDate) || new Date(r.ts).getTime();
        if (now - ts < 86400_000) today++;
        if (now - ts < 7 * 86400_000) last7++;
      }
      const topSenders = Object.values(senders).sort((a, b) => b.n - a.n).slice(0, 8);
      const recent = msgs.slice(0, 50).map((r) => {
        const d = r.data || {};
        const h = d.payload?.headers || [];
        // Prefer the new slimMessage-persisted `has_attachment` flag +
        // `attachments` list; fall back to a parts walk for legacy rows
        // persisted before this field existed.
        const hasAtt = (d.has_attachment === true)
          || (Array.isArray(d.attachments) && d.attachments.length > 0)
          || (d.payload?.mimeType || '').startsWith('multipart/mixed');
        return {
          id: r.external_id,
          from: h.find((x) => (x.name || '').toLowerCase() === 'from')?.value || '',
          subject: h.find((x) => (x.name || '').toLowerCase() === 'subject')?.value || '(no subject)',
          snippet: d.snippet || '',
          has_attachment: hasAtt,
          ts: Number(d.internalDate) || new Date(r.ts).getTime(),
          labels: d.labelIds || [],
          unread: (d.labelIds || []).includes('UNREAD'),
        };
      });
      // Label breakdown — counts across persisted inbox messages. Powers
      // the LABELS card in the fullscreen dashboard.
      const labels_breakdown = {};
      for (const r of msgs) {
        for (const id of (r.data?.labelIds || [])) {
          if (id === 'UNREAD' || id === 'INBOX') continue;
          labels_breakdown[id] = (labels_breakdown[id] || 0) + 1;
        }
      }

      // hourly_today — 24-slot array of message counts across ALL persisted
      // messages (not just the first 50), bucketed by local hour-of-day where
      // the message's internal date is today. Cheap O(n) over msgs (already
      // loaded), so no extra query needed.
      let hourly_today = new Array(24).fill(0);
      try {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const startMs = startOfToday.getTime();
        const endMs = startMs + 86400_000;
        for (const r of msgs) {
          const d = r.data || {};
          const ts = Number(d.internalDate) || new Date(r.ts).getTime();
          if (ts < startMs || ts >= endMs) continue;
          const hr = new Date(ts).getHours();
          if (hr >= 0 && hr < 24) hourly_today[hr]++;
        }
      } catch {
        hourly_today = new Array(24).fill(0);
      }

      // drafts_count — single cached Gmail API call (60s TTL per account).
      let drafts_count = null;
      try {
        const targetRt = account ? runtimes.get(account) : firstRuntime();
        drafts_count = targetRt ? await getDraftsCountCached(targetRt) : null;
      } catch {
        drafts_count = null;
      }

      // attachments_recent — up to 12 recent attachments, newest first.
      // Reads `data.attachments` (persisted by the new slimMessage). Legacy
      // rows that pre-date the slim upgrade fall back to a live MIME walk,
      // which will almost always be empty because the old slimMessage
      // stripped `parts` — those rows will refresh on the next deep-resync.
      let attachments_recent = [];
      try {
        const ATT_CAP = 12;
        outer:
        for (const r of msgs) {
          const d = r.data || {};
          const attList = Array.isArray(d.attachments) && d.attachments.length
            ? d.attachments
            : walkAttachmentParts(d.payload);
          if (attList.length === 0) continue;
          const h = d.payload?.headers || [];
          const from = h.find((x) => (x.name || '').toLowerCase() === 'from')?.value || '';
          const subject = h.find((x) => (x.name || '').toLowerCase() === 'subject')?.value || '(no subject)';
          const ts = Number(d.internalDate) || new Date(r.ts).getTime();
          for (const p of attList) {
            attachments_recent.push({
              filename: p.filename,
              mime: p.mime || '',
              size: Number(p.size) || 0,
              from_name: fromName(from) || fromEmail(from),
              subject,
              ts,
              message_id: r.external_id,
              attachment_id: p.attachmentId || null,
            });
            if (attachments_recent.length >= ATT_CAP) break outer;
          }
        }
      } catch {
        attachments_recent = [];
      }

      // threads_top — top 6 active threads (>2 messages within msgs window),
      // by message count. Subject taken from the most recent message; unique
      // sender names collected. O(n) over msgs — no nested loops.
      let threads_top = [];
      try {
        const threads = new Map();
        for (const r of msgs) {
          const d = r.data || {};
          const tid = d.threadId;
          if (!tid) continue;
          const h = d.payload?.headers || [];
          const from = h.find((x) => (x.name || '').toLowerCase() === 'from')?.value || '';
          const subject = h.find((x) => (x.name || '').toLowerCase() === 'subject')?.value || '(no subject)';
          const ts = Number(d.internalDate) || new Date(r.ts).getTime();
          const name = fromName(from) || fromEmail(from);
          let t = threads.get(tid);
          if (!t) {
            t = { thread_id: tid, subject, message_count: 0, last_ts: 0, _participants: new Set() };
            threads.set(tid, t);
          }
          t.message_count++;
          // msgs is ts-desc, so first seen is newest — use that for subject/last_ts.
          if (ts > t.last_ts) {
            t.last_ts = ts;
            t.subject = subject;
          }
          if (name) t._participants.add(name);
        }
        threads_top = Array.from(threads.values())
          .filter((t) => t.message_count > 2)
          .sort((a, b) => b.message_count - a.message_count)
          .slice(0, 6)
          .map((t) => ({
            thread_id: t.thread_id,
            subject: t.subject,
            message_count: t.message_count,
            last_ts: t.last_ts,
            participants: Array.from(t._participants).slice(0, 8),
          }));
      } catch {
        threads_top = [];
      }

      // labels_full — real per-label counts from Gmail (messagesTotal /
      // messagesUnread / threadsTotal / threadsUnread). Pulled from the
      // `label` kind rows the connector already persists on connect +
      // every deep resync, so this is just a DB read.
      let labels_full = [];
      try {
        const labelRows = await integrationDb.listBySource('gmail', { kind: 'label', limit: 200, ...dbOpts });
        labels_full = labelRows.map((r) => {
          const d = r.data || {};
          return {
            id: d.id,
            name: d.name,
            type: d.type || 'user', // 'system' | 'user'
            messages_total: Number(d.messagesTotal) || 0,
            messages_unread: Number(d.messagesUnread) || 0,
            threads_total: Number(d.threadsTotal) || 0,
            threads_unread: Number(d.threadsUnread) || 0,
            visibility: d.labelListVisibility || null,
            color: d.color || null,
          };
        }).filter((l) => l.id).sort((a, b) => b.messages_total - a.messages_total);
      } catch {
        labels_full = [];
      }

      const targetRt = account ? runtimes.get(account) : (firstRuntime() || null);
      const profile = {
        email: targetRt?.email || null,
        messages_total: targetRt?.messagesTotal ?? null,
        threads_total: targetRt?.threadsTotal ?? null,
        history_id: targetRt?.lastHistoryId || null,
        connected_at: targetRt?.connectedAt || null,
      };

      // Account roster on every summary so the UI can render the chip
      // strip without an extra round-trip.
      const accounts = listRuntimes().map((rt) => ({
        email: rt.email,
        messages_total: rt.messagesTotal,
        threads_total: rt.threadsTotal,
        last_poll_at: rt.lastPollAt,
        connected_at: rt.connectedAt,
        primary: rt.email === gauth.getPrimaryAccount?.(),
      }));

      const body = {
        connected: runtimes.size > 0,
        scope: account || 'all',
        account_email: targetRt?.email || (account || null),
        accounts,
        inbox_messages: inboxLbl?.data?.messagesTotal ?? null,
        inbox_unread: inboxLbl?.data?.messagesUnread ?? null,
        total_messages: unreadLbl?.data?.messagesTotal ?? targetRt?.messagesTotal ?? null,
        unread_total: unreadLbl?.data?.messagesUnread ?? null,
        today_count: today,
        last_7d_count: last7,
        top_senders: topSenders,
        recent,
        labels_breakdown,
        labels_full,
        profile,
        hourly_today,
        drafts_count,
        attachments_recent,
        threads_top,
        counts: await integrationDb.countsBySource('gmail', dbOpts),
        last_poll_at: targetRt?.lastPollAt || null,
        deep_backfill_done_at: targetRt?.deepBackfillDoneAt || null,
      };
      _summaryCache.set(cacheKey, { at: Date.now(), body });
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Single message by Gmail messageId. Reads the persisted slimMessage
  // (headers + decoded bodyText + attachment metadata), so this endpoint
  // is a pure DB hit — no Gmail API round-trip on the voice path. Used by
  // hq.html::openGmailReader() to render the full-screen email reader
  // after `open_hq_detail` resolves a query into a messageId.
  app.get('/omo/api/integrations/gmail/message/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'missing id' });
      const row = await integrationDb.getByExternalId('gmail', id);
      if (!row) return res.status(404).json({ error: 'not found' });
      const d = row.data || {};
      const h = d.payload?.headers || [];
      const pick = (name) => h.find((x) => (x.name || '').toLowerCase() === name.toLowerCase())?.value || '';
      const labels = d.labelIds || [];
      const rawBody = typeof d.bodyText === 'string' ? d.bodyText : '';
      // Cap body size at the response boundary. We've crashed the HQ
      // iframe (and with it the host tab — they share an OS process)
      // on a single email with a multi-MB HTML newsletter body. The
      // failure chain: server returns full body → client JSON.parse →
      // sanitize regex → innerHTML of megabytes into a <pre>. 200KB
      // is far more than anyone will read; the truncated marker tells
      // the client a longer body exists in case we ever add a "show
      // full" affordance.
      const BODY_MAX = 200 * 1024;
      const truncated = rawBody.length > BODY_MAX;
      const body = truncated
        ? rawBody.slice(0, BODY_MAX) + `\n\n[…truncated · original ${(rawBody.length / 1024).toFixed(0)}KB]`
        : rawBody;
      let staged_draft = null;
      try {
        const drafts = await import('./gmail_drafts.js');
        staged_draft = drafts.getDraft(row.external_id, row.account_id);
      } catch {}
      res.json({
        id: row.external_id,
        thread_id: d.threadId || null,
        account_id: row.account_id || null,
        from: pick('From'),
        to: pick('To'),
        cc: pick('Cc'),
        reply_to: pick('Reply-To'),
        subject: pick('Subject') || row.title || '(no subject)',
        date: pick('Date'),
        ts: Number(d.internalDate) || new Date(row.ts).getTime(),
        snippet: d.snippet || '',
        body,
        body_truncated: truncated,
        body_original_bytes: rawBody.length,
        labels,
        unread: labels.includes('UNREAD'),
        starred: labels.includes('STARRED'),
        important: labels.includes('IMPORTANT'),
        size_estimate: Number(d.sizeEstimate) || 0,
        attachments: Array.isArray(d.attachments) ? d.attachments : [],
        has_attachment: !!d.has_attachment,
        staged_draft: staged_draft ? {
          draft_id: staged_draft.draft_id,
          account_id: staged_draft.account_id,
          to: staged_draft.to,
          cc: staged_draft.cc,
          subject: staged_draft.subject,
          body: staged_draft.body,
          tone: staged_draft.tone,
          length: staged_draft.length,
          instruction: staged_draft.instruction,
          created_at: staged_draft.created_at,
          source: staged_draft.source,
        } : null,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Full thread for a given threadId. Pure DB read over the persisted
  // gmail rows — used by the email reader to show prior messages above
  // the focused one. Messages oldest → newest so the reader can render
  // the conversation top-down.
  app.get('/omo/api/integrations/gmail/thread/:threadId', async (req, res) => {
    try {
      const threadId = String(req.params.threadId || '').trim();
      if (!threadId) return res.status(400).json({ error: 'missing threadId' });
      const acct = req.query?.account ? String(req.query.account) : null;
      const rows = await integrationDb.listBySource('gmail', { kind: 'message', limit: 500, ...(acct && acct !== 'all' ? { account_id: acct } : {}) });
      const matches = rows.filter((r) => String(r.data?.threadId || '') === threadId);
      if (matches.length === 0) return res.status(404).json({ error: 'no messages for thread' });

      const HEADER = (h, name) => Array.isArray(h)
        ? (h.find((x) => (x.name || '').toLowerCase() === name.toLowerCase())?.value || '')
        : '';
      const messages = matches
        .map((r) => {
          const d = r.data || {};
          const h = d.payload?.headers || [];
          const labels = d.labelIds || [];
          const rawBody = typeof d.bodyText === 'string' ? d.bodyText : '';
          const BODY_MAX = 32 * 1024;
          const trimmed = rawBody.length > BODY_MAX ? rawBody.slice(0, BODY_MAX) + ' […]' : rawBody;
          return {
            id: r.external_id,
            account_id: r.account_id || null,
            from: HEADER(h, 'From'),
            to: HEADER(h, 'To'),
            cc: HEADER(h, 'Cc'),
            subject: HEADER(h, 'Subject') || r.title || '(no subject)',
            date: HEADER(h, 'Date'),
            ts: Number(d.internalDate) || new Date(r.ts).getTime(),
            snippet: d.snippet || '',
            body: trimmed,
            labels,
            unread: labels.includes('UNREAD'),
            starred: labels.includes('STARRED'),
            attachments: Array.isArray(d.attachments) ? d.attachments : [],
            has_attachment: !!d.has_attachment,
          };
        })
        .sort((a, b) => a.ts - b.ts);

      const participants = new Map();
      for (const m of messages) {
        const raw = m.from || '';
        const mm = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
        const email = (mm ? mm[2] : raw).trim().toLowerCase();
        const name = (mm ? mm[1] : '').trim();
        if (!email) continue;
        if (!participants.has(email)) participants.set(email, { email, name, count: 0 });
        participants.get(email).count++;
      }

      res.json({
        thread_id: threadId,
        account_id: messages[messages.length - 1]?.account_id || null,
        message_count: messages.length,
        unread_count: messages.filter((m) => m.unread).length,
        subject: messages[messages.length - 1]?.subject || '(no subject)',
        participants: Array.from(participants.values()).sort((a, b) => b.count - a.count),
        messages,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Reply draft + send + discard. Lazy-loaded so the gmail connector
  // doesn't pull in @google/genai at boot for users without GEMINI_API_KEY.
  app.post('/omo/api/integrations/gmail/draft-reply', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      if (!gauth.hasRefreshToken()) return res.status(409).json({ ok: false, error: 'gmail not connected' });
      const { message_id, instruction, tone, length, language, source, account_id } = req.body || {};
      if (!message_id) return res.status(400).json({ ok: false, error: 'message_id required' });
      const drafts = await import('./gmail_drafts.js');
      const draft = await drafts.generateReplyDraft(message_id, {
        instruction, tone, length, language, source: source || 'ui', account_id,
      });
      res.json({ ok: true, draft });
    } catch (err) {
      const code = err?.code === 'NOT_FOUND' ? 404 : 500;
      res.status(code).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/integrations/gmail/send-reply', express.json({ limit: '512kb' }), async (req, res) => {
    try {
      if (!gauth.hasRefreshToken()) return res.status(409).json({ ok: false, error: 'gmail not connected' });
      const { message_id, to, cc, bcc, subject, body, thread_id, account_id } = req.body || {};
      if (!message_id && !(to && subject && body)) {
        return res.status(400).json({ ok: false, error: 'provide message_id (with staged draft) or full to/subject/body' });
      }
      const drafts = await import('./gmail_drafts.js');
      const result = await drafts.sendStoredDraft(message_id, { to, cc, bcc, subject, body, thread_id, account_id });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/integrations/gmail/discard-draft', express.json(), async (req, res) => {
    try {
      const { message_id, account_id } = req.body || {};
      if (!message_id) return res.status(400).json({ ok: false, error: 'message_id required' });
      const drafts = await import('./gmail_drafts.js');
      const had = drafts.discardDraft(message_id, account_id);
      res.json({ ok: true, discarded: !!had });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
}

// Exposed for tests / introspection.
export const _internal = { runtimes };

// Gmail reply-drafts — in-memory staging for inline reply composition.
//
// Flow:
//   1. UI / voice asks for a draft → generateReplyDraft(messageId, opts)
//      pulls the message + thread from integration_db, calls Gemini for a
//      reply body, stores the draft keyed by message_id, broadcasts an
//      `email_reply_drafted` event onto the data-core bus so any open
//      reader can populate its compose pane.
//   2. UI / voice confirms → sendStoredDraft(messageId, overrides) sends
//      via gmail.sendEmail and clears the staged draft. The user can also
//      send by submitting an edited body directly through the REST path.
//   3. UI / voice cancels → discardDraft(messageId).
//
// Drafts are scoped per-process and TTL'd at 1 hour, LRU-capped at 50.
// They are NOT persisted — a server restart drops all in-flight drafts,
// which is fine because the source email is still in integration_db and
// re-drafting is cheap.

import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'node:crypto';
import * as integrationDb from '../store/integration_db.js';
import * as dataCore from '../data_core.js';
import { sendEmail } from './gmail.js';

const DRAFT_MODEL = process.env.GMAIL_DRAFT_MODEL
  || process.env.VIZ_GEN_MODEL
  || 'gemini-3.1-flash-lite';

const DRAFT_TTL_MS = 60 * 60 * 1000;  // 1 hour
const DRAFT_CAP = 50;
// Hard wall-clock deadline for the body-generation LLM call. The Gemini
// SDK's AbortSignal is only loosely honored in practice (3.x thinking
// models in particular often blow well past their abort), so we ALSO
// race the call against a manual timeout below — whichever fires first
// wins. This must stay well under the /tool dispatch wrap (60s) but the
// tool returns immediately anyway, so this only governs how long the
// background body generator hangs around.
const DRAFT_TIMEOUT_MS = 20_000;
const BODY_CONTEXT_CHARS = 4000;
const THREAD_CONTEXT_CAP = 6;

let genAI;
function client() {
  if (genAI) return genAI;
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set; cannot draft reply');
  genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return genAI;
}

// Drafts keyed by `${account_id}:${message_id}` to keep multi-account
// drafts from colliding (Gmail message ids are unique per-mailbox, not
// globally). Single-account callers can omit account_id and we'll fall
// through to the row's persisted account_id, or the default sender.
const drafts = new Map();

function draftKey(accountId, messageId) {
  return `${accountId || '_'}:${messageId}`;
}
function findDraftByMessageId(messageId) {
  if (!messageId) return null;
  for (const [k, v] of drafts) {
    if (v.message_id === messageId) return { key: k, draft: v };
  }
  return null;
}

function evict() {
  const now = Date.now();
  for (const [k, v] of drafts) {
    if (now - v.created_at > DRAFT_TTL_MS) drafts.delete(k);
  }
  while (drafts.size > DRAFT_CAP) {
    const oldestKey = drafts.keys().next().value;
    drafts.delete(oldestKey);
  }
}

function header(headers, name) {
  if (!Array.isArray(headers)) return '';
  const lower = name.toLowerCase();
  return headers.find((h) => (h?.name || '').toLowerCase() === lower)?.value || '';
}

function parseAddress(raw) {
  if (!raw) return { name: '', email: '' };
  const m = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: String(raw).trim() };
}

function ensureReSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Re: (no subject)';
  if (/^re:/i.test(s)) return s;
  return `Re: ${s}`;
}

async function loadMessage(messageId) {
  if (!messageId) return null;
  const row = await integrationDb.getByExternalId('gmail', messageId);
  if (!row) return null;
  const d = row.data || {};
  const h = d.payload?.headers || [];
  return {
    id: row.external_id,
    thread_id: d.threadId || null,
    account_id: row.account_id || null,
    from: header(h, 'From'),
    to: header(h, 'To'),
    cc: header(h, 'Cc'),
    subject: header(h, 'Subject') || row.title || '(no subject)',
    date: header(h, 'Date'),
    ts: Number(d.internalDate) || new Date(row.ts).getTime(),
    snippet: d.snippet || '',
    body: typeof d.bodyText === 'string' ? d.bodyText : '',
    labels: d.labelIds || [],
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
  };
}

async function loadThread(threadId, { excludeId } = {}) {
  if (!threadId) return [];
  // Targeted JSONB-filter query — used to be a 200-row scan that was
  // moving 10-50 MB across the wire just to find ~5 matching messages.
  const rows = await integrationDb.listGmailByThreadId(threadId, { limit: 50 });
  const out = [];
  for (const r of rows) {
    if (excludeId && r.external_id === excludeId) continue;
    out.push(r);
  }
  return out.slice(-THREAD_CONTEXT_CAP).map((r) => {
    const d = r.data || {};
    const h = d.payload?.headers || [];
    return {
      id: r.external_id,
      from: header(h, 'From'),
      subject: header(h, 'Subject') || r.title || '',
      ts: Number(d.internalDate) || new Date(r.ts).getTime(),
      body: (typeof d.bodyText === 'string' ? d.bodyText : '').slice(0, 1500),
      snippet: d.snippet || '',
    };
  });
}

function buildSystemPrompt({ tone, length, language, userProfile }) {
  const toneDesc = ({
    friendly: 'warm, friendly, lightly casual',
    professional: 'professional and concise',
    direct: 'direct and brief, no fluff',
    apologetic: 'apologetic and accommodating',
    enthusiastic: 'positive, enthusiastic but still professional',
    formal: 'formal and polished',
  })[tone] || 'natural, professional but human';

  const lenDesc = ({
    short: '1-3 short sentences, no preamble',
    medium: '3-6 sentences — enough to address the points without padding',
    long: '6-12 sentences — full reply with context, but no fluff',
  })[length] || '3-6 sentences';

  const langDesc = language === 'zh' ? 'Simplified Chinese' : language === 'auto'
    ? 'whichever language the original email is in'
    : 'English';

  return [
    'You are drafting an email reply on behalf of the user.',
    `Tone: ${toneDesc}.`,
    `Length: ${lenDesc}.`,
    `Language: ${langDesc}.`,
    'Output ONLY the email body. No subject line, no greeting metadata, no markdown fences, no commentary.',
    'Do NOT invent facts or commit to anything specific the user did not ask for (no dates, prices, or numbers unless given).',
    'Sign off naturally; do not include the user\'s contact details.',
    userProfile ? `User context: ${userProfile}` : '',
  ].filter(Boolean).join('\n');
}

function buildUserPrompt({ message, thread, instruction }) {
  const lines = [];
  lines.push('# Original email being replied to');
  lines.push(`From: ${message.from}`);
  if (message.to) lines.push(`To: ${message.to}`);
  if (message.cc) lines.push(`Cc: ${message.cc}`);
  lines.push(`Subject: ${message.subject}`);
  if (message.date) lines.push(`Date: ${message.date}`);
  lines.push('');
  lines.push('Body:');
  lines.push((message.body || message.snippet || '').slice(0, BODY_CONTEXT_CHARS));
  lines.push('');

  if (thread && thread.length) {
    lines.push('# Earlier messages in this thread (oldest first)');
    for (const m of thread) {
      lines.push(`— ${m.from} · ${new Date(m.ts).toISOString().slice(0, 10)}`);
      lines.push((m.body || m.snippet || '').slice(0, 800));
      lines.push('');
    }
  }

  lines.push('# What the user wants to say in the reply');
  lines.push(instruction || '(no specific instruction — write a natural, helpful response that acknowledges the email and moves the conversation forward)');
  lines.push('');
  lines.push('Write the reply body now.');
  return lines.join('\n');
}

async function generateBody({ message, thread, instruction, tone, length, language, userProfile }) {
  const sys = buildSystemPrompt({ tone, length, language, userProfile });
  const usr = buildUserPrompt({ message, thread, instruction });

  // Race the SDK call against a hard wall-clock deadline. AbortSignal is
  // passed too so the SDK can clean up its own fetch, but we don't trust
  // it to fire on time — Gemini 3 thinking models have been observed
  // running 40+ seconds past abort. Whichever resolves first wins; the
  // loser's promise gets detached (Node will GC it after it eventually
  // settles, nothing else is awaiting it).
  const ctrl = AbortSignal.timeout(DRAFT_TIMEOUT_MS);
  const callPromise = client().models.generateContent({
    model: DRAFT_MODEL,
    contents: [{ role: 'user', parts: [{ text: usr }] }],
    config: {
      systemInstruction: sys,
      temperature: 0.55,
      thinkingConfig: { thinkingBudget: 0 },
    },
  }, { signal: ctrl });

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`draft body generation timed out after ${DRAFT_TIMEOUT_MS}ms`);
      e.code = 'DRAFT_TIMEOUT';
      reject(e);
    }, DRAFT_TIMEOUT_MS);
    timer.unref?.();
  });

  let resp;
  try {
    resp = await Promise.race([callPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  const text = (resp?.text || '').trim();
  // Strip stray code fences just in case.
  return text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
}

// Tracks an in-flight body-generation promise per draft-key so that
// (a) sendStoredDraft can await it if the user fires "send" before the
// body lands, (b) repeat draft requests for the same message can be
// detected and the older one's emission cancelled, and (c) the legacy
// awaiting export `generateReplyDraft` can still surface the final body.
const pendingBodies = new Map();

// Voice-tool entry point. Awaits ONLY the cheap synchronous prep — a
// single-row PK lookup of the message + a `email_reply_drafting` event
// so the UI flips into a skeleton state. Returns immediately with
// `status: 'drafting'`. The body-generation LLM call runs detached;
// when it resolves, an `email_reply_drafted` event populates the
// compose pane and the staged draft is stored. On error, an
// `email_reply_drafting_failed` event clears the loading state.
//
// This is the change that fixes the 47-68 s freezes: the /tool dispatch
// path now returns in <100 ms instead of blocking on Gemini.
export async function prepareReplyDraft(messageId, opts = {}) {
  if (!messageId) throw new Error('message_id required');
  const message = await loadMessage(messageId);
  if (!message) {
    const err = new Error(`message not in local cache: ${messageId}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const accountId = opts.account_id || message.account_id || null;
  const sender = parseAddress(message.from);
  if (!sender.email) {
    throw new Error('original sender has no email address — cannot draft a reply');
  }

  const tone = opts.tone || 'professional';
  const length = opts.length || 'medium';
  const language = opts.language || 'auto';
  const instruction = opts.instruction ? String(opts.instruction).trim() : '';
  const draft_id = `dr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const subject = ensureReSubject(message.subject);
  const source = opts.source || 'voice';

  const meta = {
    draft_id,
    message_id: message.id,
    thread_id: message.thread_id || null,
    account_id: accountId,
    to: sender.email,
    to_name: sender.name || '',
    cc: '',
    subject,
    instruction,
    tone,
    length,
    language,
    source,
  };

  try {
    dataCore.emit({
      id: randomUUID(),
      source: 'gmail',
      kind: 'email_reply_drafting',
      ts: Date.now(),
      title: 'drafting reply',
      summary: instruction ? `"${instruction.slice(0, 60)}"` : 'no specific instruction',
      account_id: accountId,
      data: { ...meta },
    });
  } catch {}

  const key = draftKey(accountId, messageId);
  const existing = pendingBodies.get(key);
  if (existing) existing.stale = true;

  const slot = { draft_id, stale: false, promise: null, error: null };
  pendingBodies.set(key, slot);

  // Detached body generation. Errors funnel into the
  // `email_reply_drafting_failed` event so the UI can clear its
  // skeleton, AND get re-thrown out of `slot.promise` so the legacy
  // awaiting `generateReplyDraft` path can surface a proper error to
  // the REST caller.
  slot.promise = (async () => {
    try {
      const thread = await loadThread(message.thread_id, { excludeId: messageId });
      const body = await generateBody({
        message,
        thread,
        instruction,
        tone,
        length,
        language,
        userProfile: opts.user_profile || null,
      });

      if (slot.stale) return null;          // a newer draft superseded us
      if (!body) throw new Error('drafting model returned empty body');

      const draft = { ...meta, body, created_at: Date.now() };
      drafts.set(key, draft);
      evict();

      try {
        dataCore.emit({
          id: randomUUID(),
          source: 'gmail',
          kind: 'email_reply_drafted',
          ts: Date.now(),
          title: subject,
          summary: `draft to ${sender.name || sender.email}`,
          account_id: accountId,
          data: { ...draft },
        });
      } catch {}

      return draft;
    } catch (err) {
      slot.error = err;
      if (slot.stale) return null;
      const msg = err?.message || String(err);
      console.warn(`[gmail-drafts] body generation failed for ${messageId}: ${msg}`);
      try {
        dataCore.emit({
          id: randomUUID(),
          source: 'gmail',
          kind: 'email_reply_drafting_failed',
          ts: Date.now(),
          title: 'reply draft failed',
          summary: msg.slice(0, 120),
          account_id: accountId,
          data: { ...meta, error: msg },
        });
      } catch {}
      throw err;
    } finally {
      if (pendingBodies.get(key) === slot) pendingBodies.delete(key);
    }
  })();
  // Detach a no-op handler so a rejection never goes "unhandled" when
  // no other consumer awaits slot.promise — voice path discards the
  // promise entirely. The legacy REST path attaches its own awaiter.
  slot.promise.catch(() => {});

  return { ...meta, status: 'drafting' };
}

// Legacy awaiting export, used by the REST staging endpoint
// (/omo/api/integrations/gmail/messages/:id/draft) which posts a draft
// and returns the fully-staged record. Voice tools should use
// prepareReplyDraft + listen for the WS event.
export async function generateReplyDraft(messageId, opts = {}) {
  const meta = await prepareReplyDraft(messageId, opts);
  const key = draftKey(meta.account_id, messageId);
  const slot = pendingBodies.get(key);
  if (slot?.promise) {
    const draft = await slot.promise;
    if (draft) return draft;
  }
  // Generation failed (timeout / empty body) — return the metadata so
  // the caller still has identifiers; body is empty and the REST path
  // can surface that as a 504 if it likes.
  return { ...meta, body: '' };
}

// Lookup is messageId-only (back-compat) but now searches across all
// account namespaces. Voice tools that already know the account can pass
// it explicitly to avoid the linear scan.
export function getDraft(messageId, accountId) {
  if (!messageId) return null;
  evict();
  if (accountId) return drafts.get(draftKey(accountId, messageId)) || null;
  const hit = findDraftByMessageId(messageId);
  return hit?.draft || null;
}

export function discardDraft(messageId, accountId) {
  if (!messageId) return false;
  let had = false;
  // Mark any in-flight body generation as stale so its eventual
  // resolution suppresses the `email_reply_drafted` emit. Otherwise a
  // discard followed by a late-resolving LLM call would resurrect the
  // compose pane the user just dismissed.
  const candidateKeys = accountId
    ? [draftKey(accountId, messageId)]
    : [...pendingBodies.keys()].filter((k) => k.endsWith(`:${messageId}`));
  for (const k of candidateKeys) {
    const slot = pendingBodies.get(k);
    if (slot) slot.stale = true;
  }
  if (accountId) {
    had = drafts.delete(draftKey(accountId, messageId));
  } else {
    const hit = findDraftByMessageId(messageId);
    if (hit) had = drafts.delete(hit.key);
  }
  if (had) {
    try {
      dataCore.emit({
        id: randomUUID(),
        source: 'gmail',
        kind: 'email_reply_discarded',
        ts: Date.now(),
        title: 'draft discarded',
        summary: messageId,
        account_id: accountId || null,
        data: { message_id: messageId, account_id: accountId || null },
      });
    } catch {}
  }
  return had;
}

export async function sendStoredDraft(messageId, overrides = {}) {
  // If a body-generation is still in flight for this message, wait for
  // it before we declare "no staged draft". Otherwise a user saying
  // "send it" while the LLM is mid-stream would race past the staged
  // draft and 400-out.
  const accountHint = overrides.account_id;
  const candidateKeys = accountHint
    ? [draftKey(accountHint, messageId)]
    : [...pendingBodies.keys()].filter((k) => k.endsWith(`:${messageId}`));
  for (const k of candidateKeys) {
    const slot = pendingBodies.get(k);
    if (slot?.promise) {
      try { await slot.promise; } catch { /* failure already emitted */ }
    }
  }

  const staged = getDraft(messageId, overrides.account_id);
  if (!staged && !(overrides.to && overrides.subject && overrides.body)) {
    throw new Error('no staged draft and no full override (to / subject / body) provided');
  }
  const accountId = overrides.account_id || staged?.account_id || null;
  const to = overrides.to || staged?.to;
  const subject = overrides.subject || staged?.subject;
  const body = overrides.body || staged?.body;
  const cc = overrides.cc != null ? overrides.cc : (staged?.cc || '');
  const bcc = overrides.bcc || '';
  const thread_id = overrides.thread_id || staged?.thread_id || null;

  const result = await sendEmail(
    {
      to, subject, body,
      cc: cc || undefined, bcc: bcc || undefined,
      replyToThreadId: thread_id || undefined,
      account_id: accountId,
    },
    { emit: dataCore.emit },
  );

  // Clear the staged draft on success (key by the actual account_id used).
  if (staged) drafts.delete(draftKey(staged.account_id, staged.message_id));

  try {
    dataCore.emit({
      id: randomUUID(),
      source: 'gmail',
      kind: 'email_reply_sent',
      ts: Date.now(),
      title: subject,
      summary: `sent to ${to}`,
      account_id: result.account_id || accountId || null,
      data: {
        message_id: messageId,
        thread_id: result.threadId || thread_id || null,
        account_id: result.account_id || accountId || null,
        to, cc: cc || '', bcc, subject, body,
        sent_message_id: result.id,
      },
    });
  } catch {}

  return { ok: true, message_id: messageId, sent_message_id: result.id, thread_id: result.threadId || thread_id || null, account_id: result.account_id || accountId || null };
}

// Exported so the message endpoint can return a staged draft alongside
// the email body (so an opened reader picks up an in-flight draft).
export function listDraftsByMessageIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return {};
  evict();
  const out = {};
  for (const id of ids) {
    const hit = findDraftByMessageId(id);
    if (hit) out[id] = hit.draft;
  }
  return out;
}

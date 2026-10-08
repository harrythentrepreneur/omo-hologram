// Google Docs connector. For MVP we don't run an independent poller —
// the Drive `changes` feed already side-emits a `google_docs/doc_edited`
// event whenever a Google Doc is touched (see google_drive.js). What
// lives here is the on-demand `fetchActivity(fileId)` helper used by the
// Docs deep panel via /omo/api/google/docs/:fileId/activity.

import { google } from 'googleapis';
import * as gauth from './google.js';
import * as dataCore from '../data_core.js';

const ACTIVITY_CACHE_TTL_MS = 60_000;
const activityCache = new Map(); // fileId -> { ts, payload }

// Short-circuit when the Drive Activity API is disabled for the project
// (a 403 SERVICE_DISABLED). Without this, every call retries the API and
// a disabled project spams thousands of log lines. Flag stays set for
// DISABLED_BACKOFF_MS and the caller gets a clean stub payload.
let apiDisabledUntil = 0;
const DISABLED_BACKOFF_MS = 5 * 60_000;

let started = false;

export async function start({ emit: _emit } = {}) {
  if (!gauth.hasRefreshToken()) {
    console.log('[docs] skipped (no GOOGLE_REFRESH_TOKEN)');
    return;
  }
  if (!gauth.isConfigured()) {
    console.log('[docs] skipped (OAuth client id/secret missing)');
    return;
  }
  if (started) return;
  started = true;
  console.log('[docs] live · piggybacking on drive.changes');
  if (typeof dataCore.markSourceLive === 'function') dataCore.markSourceLive('google_docs');
}

function getActivityClient() {
  return google.driveactivity({ version: 'v2', auth: gauth.getOAuth2Client() });
}

function getDocsClient() {
  return google.docs({ version: 'v1', auth: gauth.getOAuth2Client() });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: gauth.getOAuth2Client() });
}

// Pull all text runs out of a Google Docs body into a flat string.
function extractDocText(body) {
  const out = [];
  for (const el of body?.content || []) {
    const para = el.paragraph;
    if (!para) continue;
    for (const pe of para.elements || []) {
      const content = pe.textRun?.content;
      if (content) out.push(content);
    }
  }
  // Google Docs uses \x0B (vertical tab) for soft line breaks -- normalize to \n.
  return out.join('').replace(/\x0B/g, '\n');
}

// Create a new Google Doc, optionally seeded with content. Returns
// { docId, title, url, wrote }. Safe to call with no content.
export async function createDoc({ title, content } = {}) {
  if (!gauth.hasRefreshToken()) throw new Error('Google not connected (no refresh token).');
  const docs = getDocsClient();
  const cleanTitle = String(title || 'Untitled').trim().slice(0, 200) || 'Untitled';

  const created = await docs.documents.create({ requestBody: { title: cleanTitle } });
  const docId = created.data.documentId;

  let wrote = 0;
  if (content && String(content).trim()) {
    const text = String(content);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text } }],
      },
    });
    wrote = text.length;
  }

  return {
    docId,
    title: cleanTitle,
    url: `https://docs.google.com/document/d/${docId}/edit`,
    wrote,
  };
}

// Append plain text to the end of an existing doc. Returns
// { docId, appended, url }.
export async function appendToDoc(docId, content) {
  if (!gauth.hasRefreshToken()) throw new Error('Google not connected (no refresh token).');
  if (!docId) throw new Error('appendToDoc: docId is required');
  if (!content || !String(content).trim()) throw new Error('appendToDoc: content is required');

  const docs = getDocsClient();
  const text = String(content);

  // Ensure a leading newline so appends don't merge with the previous line.
  const payload = text.startsWith('\n') ? text : `\n${text}`;

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{ insertText: { endOfSegmentLocation: {}, text: payload } }],
    },
  });

  return {
    docId,
    appended: payload.length,
    url: `https://docs.google.com/document/d/${docId}/edit`,
  };
}

// Fetch a doc's plain-text body + title. Returns
// { docId, title, text, length, url }.
export async function getDocPlaintext(docId) {
  if (!gauth.hasRefreshToken()) throw new Error('Google not connected (no refresh token).');
  if (!docId) throw new Error('getDocPlaintext: docId is required');

  const docs = getDocsClient();
  const r = await docs.documents.get({ documentId: docId });
  const text = extractDocText(r.data.body).trim();
  return {
    docId,
    title: r.data.title || '(untitled)',
    text,
    length: text.length,
    url: `https://docs.google.com/document/d/${docId}/edit`,
  };
}

// Map a single action to a normalized item. Drive Activity uses a
// discriminated-union shape on `action.detail`. We inspect known keys.
function classifyAction(detail) {
  if (!detail || typeof detail !== 'object') return 'event';
  if (detail.edit) return 'edit';
  if (detail.comment) return 'comment';
  if (detail.create) return 'create';
  if (detail.move) return 'move';
  if (detail.permissionChange) return 'shared';
  if (detail.rename) return 'rename';
  if (detail.delete) return 'delete';
  if (detail.restore) return 'restore';
  if (detail.dlpChange) return 'dlp';
  if (detail.reference) return 'reference';
  if (detail.settingsChange) return 'settings';
  return 'event';
}

function actorOf(action) {
  const a = action?.actors?.[0] || action?.actor;
  if (!a) return 'unknown';
  // Possible shapes: { user: { knownUser: { personName }, deletedUser, unknownUser } }
  if (a.user?.knownUser?.personName) return a.user.knownUser.personName;
  if (a.user?.knownUser?.isCurrentUser) return 'me';
  if (a.user?.deletedUser) return '(deleted user)';
  if (a.user?.unknownUser) return 'unknown';
  if (a.impersonation) return 'impersonation';
  if (a.system) return 'system';
  if (a.administrator) return 'admin';
  if (a.anonymous) return 'anonymous';
  return 'unknown';
}

function targetOf(action) {
  const t = action?.targets?.[0] || action?.target;
  if (!t) return null;
  return t.driveItem?.title || t.drive?.title || t.fileComment?.parent?.title || null;
}

function snippetOf(detail) {
  if (!detail) return undefined;
  if (detail.comment?.post?.subtype) return `comment ${detail.comment.post.subtype.toLowerCase()}`;
  if (detail.comment?.suggestion?.subtype) return `suggestion ${detail.comment.suggestion.subtype.toLowerCase()}`;
  if (detail.permissionChange?.addedPermissions?.length) return `${detail.permissionChange.addedPermissions.length} added`;
  if (detail.permissionChange?.removedPermissions?.length) return `${detail.permissionChange.removedPermissions.length} removed`;
  if (detail.move) return 'moved';
  if (detail.rename?.newTitle) return `renamed → ${detail.rename.newTitle}`;
  return undefined;
}

function tsOf(action) {
  const raw = action?.timestamp || action?.timeRange?.endTime || action?.timeRange?.startTime;
  if (!raw) return Date.now();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Date.now();
}

function normalizeAction(action) {
  const detail = action?.detail || {};
  return {
    kind: classifyAction(detail),
    ts: tsOf(action),
    actor: actorOf(action),
    target: targetOf(action),
    snippet: snippetOf(detail),
    raw: action,
  };
}

export async function fetchActivity(fileId) {
  if (!fileId) throw new Error('fetchActivity: fileId is required');
  if (!gauth.hasRefreshToken()) throw new Error('Google not connected (no refresh token).');

  const cached = activityCache.get(fileId);
  if (cached && (Date.now() - cached.ts) < ACTIVITY_CACHE_TTL_MS) {
    return cached.payload;
  }

  if (apiDisabledUntil && Date.now() < apiDisabledUntil) {
    return { activities: [], api_disabled: true };
  }

  const activity = getActivityClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let resp;
  try {
    resp = await activity.activity.query({
      requestBody: {
        itemName: 'items/' + fileId,
        pageSize: 50,
        filter: `time >= "${since}"`,
      },
    });
  } catch (err) {
    // Drive Activity API disabled for the project — stop hammering it.
    const msg = err?.message || '';
    if (err?.code === 403 && /has not been used|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) {
      if (!apiDisabledUntil) {
        console.warn('[docs] Drive Activity API disabled · suppressing further calls for 5min · enable at https://console.developers.google.com/apis/api/driveactivity.googleapis.com');
      }
      apiDisabledUntil = Date.now() + DISABLED_BACKOFF_MS;
      return { activities: [], api_disabled: true };
    }
    throw err;
  }

  const items = [];
  for (const a of resp.data.activities || []) {
    // Each activity may bundle multiple actions; flatten so the panel can
    // render row-per-action.
    const actions = a.actions || [];
    if (actions.length === 0) {
      items.push(normalizeAction(a));
    } else {
      for (const action of actions) {
        // Inherit actor/target from parent activity when missing.
        const merged = {
          ...action,
          actors: action.actors || a.actors,
          targets: action.targets || a.targets,
          timestamp: action.timestamp || a.timestamp,
          timeRange: action.timeRange || a.timeRange,
        };
        items.push(normalizeAction(merged));
      }
    }
  }

  const payload = { activities: items };
  activityCache.set(fileId, { ts: Date.now(), payload });
  return payload;
}

export const _internal = { activityCache };

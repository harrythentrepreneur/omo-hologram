// Shared Google OAuth client. Used by Gmail / Drive / Docs — single
// OAuth2 client, multiple persisted accounts, exactly one marked primary
// at a time.
//
// Token store layout (multi-account):
//   ~/.omo/google-tokens/{sanitized-email}.json
//     { email, refresh_token, scope, token_type, obtained_at, primary }
//
// Backwards compat: a legacy single-file token at ~/.omo/google-token.json
// is auto-migrated on first load if the directory is empty. If migration
// fails (e.g. userinfo lookup fails) the legacy file is left in place and
// treated as a primary anonymous account.
//
// Token resolution order (for the global default OAuth client):
//   1. process.env.GOOGLE_REFRESH_TOKEN          (dev override, wins)
//   2. runtime value set via setCurrentRefreshToken()
//   3. primary account in the multi-account store
//   4. legacy ~/.omo/google-token.json           (last resort)

import { google } from 'googleapis';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, unlinkSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const LEGACY_TOKEN_FILE = process.env.GOOGLE_TOKEN_FILE || join(homedir(), '.omo', 'google-token.json');
const TOKENS_DIR = process.env.GOOGLE_TOKENS_DIR || join(homedir(), '.omo', 'google-tokens');

let cachedClient = null;
let currentRefreshToken = null;
let migrationAttempted = false;

function ensureDir(p) {
  try { mkdirSync(p, { recursive: true }); } catch {}
}

function sanitizeEmail(email) {
  return String(email || '').toLowerCase().replace(/[^a-z0-9._@+-]/g, '_');
}

function pathFor(email) {
  return join(TOKENS_DIR, `${sanitizeEmail(email)}.json`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, payload) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
}

function listAccountFiles() {
  ensureDir(TOKENS_DIR);
  let entries = [];
  try { entries = readdirSync(TOKENS_DIR); } catch { return []; }
  return entries.filter((f) => f.endsWith('.json')).map((f) => join(TOKENS_DIR, f));
}

function loadAllAccounts() {
  return listAccountFiles()
    .map((p) => ({ path: p, payload: readJson(p) }))
    .filter((a) => a.payload && a.payload.refresh_token);
}

async function migrateLegacyIfNeeded() {
  if (migrationAttempted) return;
  migrationAttempted = true;
  ensureDir(TOKENS_DIR);
  if (loadAllAccounts().length > 0) return;
  if (!existsSync(LEGACY_TOKEN_FILE)) return;

  const legacy = readJson(LEGACY_TOKEN_FILE);
  if (!legacy?.refresh_token) return;

  let email = legacy.email || null;
  if (!email && isConfigured()) {
    try {
      const tmp = newOAuth2Client();
      tmp.setCredentials({ refresh_token: legacy.refresh_token });
      const oauth2 = google.oauth2({ version: 'v2', auth: tmp });
      const r = await oauth2.userinfo.get();
      email = r.data.email || null;
    } catch (err) {
      console.warn('[google] legacy token migration: userinfo failed —', err?.message || err);
    }
  }
  if (!email) {
    console.warn('[google] legacy token left in place (could not resolve email); treating as primary anonymous');
    return;
  }
  const payload = {
    email,
    refresh_token: legacy.refresh_token,
    scope: legacy.scope,
    token_type: legacy.token_type,
    obtained_at: legacy.obtained_at || Date.now(),
    primary: true,
  };
  writeJson(pathFor(email), payload);
  console.log(`[google] migrated legacy token → ${pathFor(email)}`);
}

function newOAuth2Client() {
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:8080/auth/google/callback';
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri,
  );
}

function getPrimaryPayload() {
  const accounts = loadAllAccounts();
  if (accounts.length === 0) return null;
  const primary = accounts.find((a) => a.payload.primary === true);
  return (primary || accounts[0]).payload;
}

function loadLegacyPayload() {
  if (!existsSync(LEGACY_TOKEN_FILE)) return null;
  return readJson(LEGACY_TOKEN_FILE);
}

export function persistTokenForAccount(tokens, email) {
  if (!tokens?.refresh_token) throw new Error('persistTokenForAccount: missing refresh_token');
  if (!email) throw new Error('persistTokenForAccount: missing email');
  ensureDir(TOKENS_DIR);
  const accounts = loadAllAccounts();
  const isFirst = accounts.length === 0;
  const payload = {
    email,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    obtained_at: Date.now(),
    primary: isFirst,
  };
  writeJson(pathFor(email), payload);
  if (isFirst) {
    // ensure exactly one primary
    setPrimary(email);
  }
  console.log(`[google] refresh token persisted for ${email} → ${pathFor(email)}${isFirst ? ' (primary)' : ''}`);
  return payload;
}

// Legacy wrapper. If the caller has access to a fresh tokens object with
// access_token we discover the email via userinfo; otherwise we fall back
// to writing the legacy single-file shape.
export async function persistToken(tokens, meta = {}) {
  if (!tokens?.refresh_token) return;
  let email = meta.email || null;
  if (!email && tokens.access_token) {
    try {
      const info = await fetchUserEmail(tokens);
      email = info.email;
    } catch (err) {
      console.warn('[google] persistToken: userinfo lookup failed —', err?.message || err);
    }
  }
  if (email) {
    persistTokenForAccount(tokens, email);
    return;
  }
  ensureDir(dirname(LEGACY_TOKEN_FILE));
  writeJson(LEGACY_TOKEN_FILE, {
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    obtained_at: Date.now(),
    ...meta,
  });
  console.log(`[google] refresh token persisted (legacy, no email) → ${LEGACY_TOKEN_FILE}`);
}

export async function fetchUserEmail(tokens) {
  if (!isConfigured()) throw new Error('Google OAuth not configured.');
  if (!tokens?.access_token && !tokens?.refresh_token) {
    throw new Error('fetchUserEmail: tokens missing access_token and refresh_token');
  }
  const tmp = newOAuth2Client();
  tmp.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: tmp });
  const r = await oauth2.userinfo.get();
  return {
    email: r.data.email || null,
    name: r.data.name || null,
    picture: r.data.picture || null,
  };
}

export function listAccounts() {
  const accounts = loadAllAccounts();
  return accounts.map(({ payload }) => ({
    email: payload.email,
    scopes: payload.scope ? String(payload.scope).split(/\s+/).filter(Boolean) : [],
    obtained_at: payload.obtained_at || null,
    primary: !!payload.primary,
  }));
}

export function getPrimaryAccount() {
  const p = getPrimaryPayload();
  return p?.email || null;
}

export function getRefreshTokenFor(email) {
  if (!email) return null;
  const path = pathFor(email);
  if (!existsSync(path)) return null;
  const payload = readJson(path);
  return payload?.refresh_token || null;
}

export function setPrimary(email) {
  const target = sanitizeEmail(email);
  const accounts = loadAllAccounts();
  const match = accounts.find((a) => sanitizeEmail(a.payload.email) === target);
  if (!match) throw new Error(`setPrimary: no account for ${email}`);
  for (const { path, payload } of accounts) {
    const wantPrimary = sanitizeEmail(payload.email) === target;
    if (!!payload.primary === wantPrimary) continue;
    writeJson(path, { ...payload, primary: wantPrimary });
  }
  // bust the cached client so the next refresh-token resolution wins.
  if (cachedClient) cachedClient.setCredentials({});
  currentRefreshToken = null;
  console.log(`[google] primary account → ${match.payload.email}`);
  return match.payload.email;
}

export function removeAccount(email) {
  const target = sanitizeEmail(email);
  const accounts = loadAllAccounts();
  const match = accounts.find((a) => sanitizeEmail(a.payload.email) === target);
  if (!match) return { removed: false, promoted: null };
  const wasPrimary = !!match.payload.primary;
  try { unlinkSync(match.path); } catch {}
  forgetOAuth2ClientFor(match.payload.email);

  let promoted = null;
  if (wasPrimary) {
    const remaining = loadAllAccounts();
    if (remaining.length > 0) {
      remaining.sort((a, b) => (b.payload.obtained_at || 0) - (a.payload.obtained_at || 0));
      promoted = remaining[0].payload.email;
      setPrimary(promoted);
    }
  }
  if (cachedClient) cachedClient.setCredentials({});
  currentRefreshToken = null;
  console.log(`[google] removed account ${match.payload.email}${wasPrimary ? ' (was primary)' : ''}${promoted ? ` · promoted ${promoted}` : ''}`);
  return { removed: true, promoted };
}

export function forgetPersistedToken() {
  // Wipe everything: per-account files + legacy file.
  for (const { path } of loadAllAccounts()) {
    try { unlinkSync(path); } catch {}
  }
  try {
    if (existsSync(LEGACY_TOKEN_FILE)) writeFileSync(LEGACY_TOKEN_FILE, '{}', 'utf8');
  } catch {}
  currentRefreshToken = null;
  if (cachedClient) cachedClient.setCredentials({});
}

export function setCurrentRefreshToken(token) {
  currentRefreshToken = token || null;
  if (cachedClient) {
    if (token) cachedClient.setCredentials({ refresh_token: token });
    else cachedClient.setCredentials({});
  }
}

function resolveRefreshToken() {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  if (currentRefreshToken) return currentRefreshToken;
  const primary = getPrimaryPayload();
  if (primary?.refresh_token) return primary.refresh_token;
  const legacy = loadLegacyPayload();
  return legacy?.refresh_token || null;
}

export function isConfigured() {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function hasRefreshToken() {
  return !!resolveRefreshToken();
}

export function getPersistedTokenMeta() {
  const primary = getPrimaryPayload();
  if (primary) return primary;
  return loadLegacyPayload();
}

export function getOAuth2Client() {
  if (!isConfigured()) {
    throw new Error('Google OAuth not configured (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).');
  }
  if (cachedClient) {
    const tok = resolveRefreshToken();
    if (tok) cachedClient.setCredentials({ refresh_token: tok });
    return cachedClient;
  }
  cachedClient = newOAuth2Client();
  const tok = resolveRefreshToken();
  if (tok) cachedClient.setCredentials({ refresh_token: tok });
  return cachedClient;
}

// Per-account OAuth client. Builds a fresh OAuth2 client and credentials
// it strictly from the persisted refresh token for `email`, ignoring the
// env override + the global "current" runtime token. This is the API the
// multi-account Gmail / Drive connectors use to drive each account
// independently — never reach for getOAuth2Client() inside a per-account
// runtime; the global cached client only exists to keep single-account
// callers (legacy tools, onboarding) working unchanged.
const _perAccountClients = new Map();
export function getOAuth2ClientFor(email) {
  if (!isConfigured()) {
    throw new Error('Google OAuth not configured (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).');
  }
  if (!email) throw new Error('getOAuth2ClientFor: email required');
  const key = sanitizeEmail(email);
  if (_perAccountClients.has(key)) {
    const cached = _perAccountClients.get(key);
    const tok = getRefreshTokenFor(email);
    if (tok) cached.setCredentials({ refresh_token: tok });
    return cached;
  }
  const tok = getRefreshTokenFor(email);
  if (!tok) throw new Error(`getOAuth2ClientFor: no refresh token for ${email}`);
  const c = newOAuth2Client();
  c.setCredentials({ refresh_token: tok });
  _perAccountClients.set(key, c);
  return c;
}

// Drop a per-account client (called when the account is removed so we
// don't keep stale credentials around).
export function forgetOAuth2ClientFor(email) {
  if (!email) return;
  _perAccountClients.delete(sanitizeEmail(email));
}

export function getAuthUrl(scopes, opts = {}) {
  const client = getOAuth2Client();
  const params = {
    access_type: 'offline',
    prompt: opts.prompt || 'consent',
    scope: scopes,
    include_granted_scopes: true,
  };
  if (opts.state) params.state = opts.state;
  return client.generateAuthUrl(params);
}

export async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return { tokens };
}

// Eager migration: any module-level consumer can call this once at boot.
export async function init() {
  await migrateLegacyIfNeeded();
}

// Kick legacy migration in the background. Best-effort — failure is logged
// and the legacy file is left in place. Boot order doesn't wait on this.
migrateLegacyIfNeeded().catch((err) => console.warn('[google] migration error:', err?.message || err));

// Standard scope sets.
//  - GMAIL_MODIFY: read + label/trash/mark-read (no send)
//  - GMAIL_SEND:   send-only
// Together they cover full read+write email. GMAIL_READ is kept for
// callers that only need readonly access.
export const SCOPES = {
  GMAIL_READ:   'https://www.googleapis.com/auth/gmail.readonly',
  GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
  GMAIL_SEND:   'https://www.googleapis.com/auth/gmail.send',
  DRIVE_META:   'https://www.googleapis.com/auth/drive.metadata.readonly',
  DRIVE_ACTIVITY: 'https://www.googleapis.com/auth/drive.activity.readonly',
  DRIVE_FILE:   'https://www.googleapis.com/auth/drive.file',
  DOCS_READ:    'https://www.googleapis.com/auth/documents.readonly',
  DOCS_WRITE:   'https://www.googleapis.com/auth/documents',
  USERINFO_EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
  USERINFO_PROFILE: 'https://www.googleapis.com/auth/userinfo.profile',
};

// internal: filesystem path for a given email (exposed for tests + onboarding diagnostics)
export const _internal = { pathFor, sanitizeEmail, TOKENS_DIR, LEGACY_TOKEN_FILE };

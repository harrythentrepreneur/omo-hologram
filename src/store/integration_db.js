// integration_data table helpers — one row per external object from any
// source (stripe / gmail / drive / meta). Upserts are idempotent on the
// composite id `${source}:${external_id}`. The `plaintext` column is
// pre-rendered at write time so the dump endpoints can just SELECT and
// concatenate.
//
// Public surface:
//   upsert(row)                       → Promise<void>
//   upsertMany(rows)                  → Promise<number>   (chunked)
//   listBySource(source, opts?)       → Promise<row[]>
//   countsBySource(source)            → Promise<{ kind: n }>
//   plaintextBySource(source, opts?)  → Promise<string>
//   pruneSource(source)               → Promise<number>   (delete all rows for that source)

import * as db from '../db.js';

const CHUNK = 50;

function compositeId(source, externalId) {
  return `${source}:${externalId}`;
}

// Write one row. Prefer upsertMany for multiple rows.
export async function upsert(row) {
  const n = await upsertMany([row]);
  return n;
}

// Chunked multi-row INSERT … ON CONFLICT DO UPDATE. Rows must carry:
//   { source, kind, external_id, ts, title?, summary?, plaintext?, data? }
// Any row missing source/kind/external_id is skipped.
//
// Chunks default to 50 (was 100). Smaller chunks = smaller per-batch
// JSON.stringify cost = the Node event loop is freed up more often,
// which keeps /tool, /omo/ws, and Gemini Live frames flowing during
// deep backfill. Between every chunk we yield via setImmediate so the
// event loop can drain pending I/O before we start the next.
export async function upsertMany(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  if (!db.isConfigured()) return 0;
  await db.ensureSchema();
  const q = db.sql();

  const clean = [];
  for (const r of rows) {
    if (!r?.source || !r?.kind || !r?.external_id) continue;
    const ts = r.ts instanceof Date ? r.ts : new Date(r.ts || Date.now());
    clean.push({
      id: compositeId(r.source, r.external_id),
      source: String(r.source),
      kind: String(r.kind),
      external_id: String(r.external_id),
      ts: ts.toISOString(),
      title: r.title ?? null,
      summary: r.summary ?? null,
      plaintext: r.plaintext ?? null,
      data: r.data ?? null,
      account_id: r.account_id ?? null,
    });
  }
  if (clean.length === 0) return 0;

  // Tag the source/kind for the per-chunk log. Used to spot which
  // backfill is dominating during a cylinder freeze.
  const tagSource = clean[0]?.source || '?';
  const tagKind = clean[0]?.kind || '?';
  const t0 = Date.now();
  const totalChunks = Math.ceil(clean.length / CHUNK);
  let written = 0;
  let bytesStringified = 0;

  for (let i = 0; i < clean.length; i += CHUNK) {
    const cT0 = Date.now();
    const batch = clean.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    let chunkBytes = 0;
    batch.forEach((r, idx) => {
      const base = idx * 10;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb, $${base + 10})`);
      const dataStr = r.data == null ? null : JSON.stringify(r.data);
      if (dataStr) chunkBytes += dataStr.length;
      params.push(
        r.id, r.source, r.kind, r.external_id, r.ts,
        r.title, r.summary, r.plaintext,
        dataStr,
        r.account_id,
      );
    });
    bytesStringified += chunkBytes;
    const text =
      `INSERT INTO integration_data (id, source, kind, external_id, ts, title, summary, plaintext, data, account_id) VALUES ` +
      values.join(',') +
      ` ON CONFLICT (id) DO UPDATE SET ` +
      `  kind = EXCLUDED.kind,` +
      `  ts = EXCLUDED.ts,` +
      `  title = COALESCE(EXCLUDED.title, integration_data.title),` +
      `  summary = COALESCE(EXCLUDED.summary, integration_data.summary),` +
      `  plaintext = COALESCE(EXCLUDED.plaintext, integration_data.plaintext),` +
      `  data = COALESCE(EXCLUDED.data, integration_data.data),` +
      `  account_id = COALESCE(EXCLUDED.account_id, integration_data.account_id),` +
      `  updated_at = NOW()`;
    await q.query(text, params);
    written += batch.length;

    const cMs = Date.now() - cT0;
    // Only log slow chunks so normal backfills don't spam the terminal.
    if (cMs >= 250 || chunkBytes >= 1024 * 1024) {
      const chunkIdx = Math.floor(i / CHUNK) + 1;
      console.log(`[db] upsert ${tagSource}/${tagKind} chunk ${chunkIdx}/${totalChunks} · ${batch.length} rows · ${(chunkBytes / 1024).toFixed(0)}KB · ${cMs}ms`);
    }

    // Yield to the event loop between chunks so live work (tool calls,
    // WS heartbeats, Gemini Live audio) doesn't queue up behind us.
    if (i + CHUNK < clean.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const totalMs = Date.now() - t0;
  if (totalMs >= 500 || bytesStringified >= 5 * 1024 * 1024) {
    console.log(`[db] upsert ${tagSource}/${tagKind} done · ${written} rows · ${(bytesStringified / 1024).toFixed(0)}KB · ${totalMs}ms (${totalChunks} chunk${totalChunks === 1 ? '' : 's'})`);
  }
  return written;
}

// `account_id` is optional — when omitted we don't filter by account
// (back-compat for callers that don't yet know which account owns a
// row). Pass it to scope to one upstream account (Gmail address, Drive
// owner, …). Multi-account routes thread it through here.
export async function listBySource(source, { kind, limit = 1000, account_id } = {}) {
  if (!db.isConfigured()) return [];
  await db.ensureSchema();
  const q = db.sql();
  const cap = Math.min(Math.max(1, limit | 0), 10000);
  if (kind && account_id) {
    return await q`SELECT * FROM integration_data WHERE source = ${source} AND kind = ${kind} AND account_id = ${account_id} ORDER BY ts DESC LIMIT ${cap}`;
  }
  if (kind) {
    return await q`SELECT * FROM integration_data WHERE source = ${source} AND kind = ${kind} ORDER BY ts DESC LIMIT ${cap}`;
  }
  if (account_id) {
    return await q`SELECT * FROM integration_data WHERE source = ${source} AND account_id = ${account_id} ORDER BY ts DESC LIMIT ${cap}`;
  }
  return await q`SELECT * FROM integration_data WHERE source = ${source} ORDER BY ts DESC LIMIT ${cap}`;
}

// Slim variant — projects only metadata columns (no `data` JSON blob).
// Use this when you only need to match against title/summary/plaintext;
// avoids pulling full payloads (Gmail messages and Drive doc bodies can
// be 50–500KB each, which makes a `SELECT *` over hundreds of rows take
// seconds and freezes the tool path).
export async function listSlimBySource(source, { kind, limit = 1000, account_id } = {}) {
  if (!db.isConfigured()) return [];
  await db.ensureSchema();
  const q = db.sql();
  const cap = Math.min(Math.max(1, limit | 0), 10000);
  if (kind && account_id) {
    return await q`SELECT external_id, ts, title, summary, account_id FROM integration_data WHERE source = ${source} AND kind = ${kind} AND account_id = ${account_id} ORDER BY ts DESC LIMIT ${cap}`;
  }
  if (kind) {
    return await q`SELECT external_id, ts, title, summary, account_id FROM integration_data WHERE source = ${source} AND kind = ${kind} ORDER BY ts DESC LIMIT ${cap}`;
  }
  if (account_id) {
    return await q`SELECT external_id, ts, title, summary, account_id FROM integration_data WHERE source = ${source} AND account_id = ${account_id} ORDER BY ts DESC LIMIT ${cap}`;
  }
  return await q`SELECT external_id, ts, title, summary, account_id FROM integration_data WHERE source = ${source} ORDER BY ts DESC LIMIT ${cap}`;
}

// Single-row lookup by (source, external_id). Returns the full row
// including the `data` JSON blob and `account_id`, or null when not
// found. Hits the primary key directly (id = "source:external_id"),
// which is critical for speed — without this, the query falls back to
// a seq scan and a single lookup can take 100s of ms during backfill,
// which freezes any tool that resolves "the email currently open".
export async function getByExternalId(source, externalId) {
  if (!db.isConfigured()) return null;
  if (!source || !externalId) return null;
  await db.ensureSchema();
  const q = db.sql();
  const id = `${String(source)}:${String(externalId)}`;
  const rows = await q`SELECT * FROM integration_data WHERE id = ${id} LIMIT 1`;
  return rows[0] || null;
}

export async function countsBySource(source, { account_id } = {}) {
  if (!db.isConfigured()) return {};
  await db.ensureSchema();
  const q = db.sql();
  const rows = account_id
    ? await q`SELECT kind, COUNT(*)::int AS n FROM integration_data WHERE source = ${source} AND account_id = ${account_id} GROUP BY kind ORDER BY kind`
    : await q`SELECT kind, COUNT(*)::int AS n FROM integration_data WHERE source = ${source} GROUP BY kind ORDER BY kind`;
  const out = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

// All distinct account_ids that have rows for this source. Used by the
// HQ chip strip + the connector's `getStatus()` fallback to discover
// accounts even before the runtime registry is hot.
export async function listAccountsForSource(source) {
  if (!db.isConfigured()) return [];
  await db.ensureSchema();
  const q = db.sql();
  const rows = await q`SELECT account_id, COUNT(*)::int AS n, MAX(ts) AS last_ts FROM integration_data WHERE source = ${source} AND account_id IS NOT NULL GROUP BY account_id ORDER BY last_ts DESC`;
  return rows.map((r) => ({ account_id: r.account_id, count: r.n, last_ts: r.last_ts }));
}

// Targeted JSONB lookup for the messages in a single Gmail thread.
// Indexed via the source/kind composite — Postgres prunes by source first
// and then JSONB->>'threadId' across just the gmail/message rows. Far
// cheaper than the legacy "fetch 200 rows then filter in JS" path.
// Ordered ts ASC so callers can render the thread top-down.
export async function listGmailByThreadId(threadId, { limit = 50, account_id } = {}) {
  if (!db.isConfigured() || !threadId) return [];
  await db.ensureSchema();
  const q = db.sql();
  const cap = Math.min(Math.max(1, limit | 0), 500);
  const tid = String(threadId);
  if (account_id) {
    return await q`SELECT * FROM integration_data
      WHERE source = 'gmail' AND kind = 'message' AND account_id = ${account_id} AND data->>'threadId' = ${tid}
      ORDER BY ts ASC LIMIT ${cap}`;
  }
  return await q`SELECT * FROM integration_data
    WHERE source = 'gmail' AND kind = 'message' AND data->>'threadId' = ${tid}
    ORDER BY ts ASC LIMIT ${cap}`;
}

export async function pruneSource(source) {
  if (!db.isConfigured()) return 0;
  await db.ensureSchema();
  const q = db.sql();
  const res = await q`DELETE FROM integration_data WHERE source = ${source}`;
  return res?.rowCount ?? 0;
}

// Render a big plaintext dump grouped by kind. `kindOrder` controls the
// section order; `header` is prepended verbatim; `limitPerKind` caps each
// section (cheaper than LIMIT-per-source for fairness). Uses stored
// plaintext per row — callers should make sure plaintext was populated
// at upsert time for this to look good.
export async function plaintextBySource(source, { kindOrder, limitPerKind = 500, header } = {}) {
  if (!db.isConfigured()) {
    return '(database not configured — set NEON_DB_DATABASE in .env to enable persistent dumps)';
  }
  await db.ensureSchema();
  const q = db.sql();

  const counts = await countsBySource(source);
  const kinds = kindOrder && kindOrder.length
    ? kindOrder.filter((k) => k in counts).concat(Object.keys(counts).filter((k) => !kindOrder.includes(k)))
    : Object.keys(counts).sort();

  const parts = [];
  if (header) parts.push(header);

  const totalRows = Object.values(counts).reduce((s, n) => s + n, 0);
  parts.push(`==== COUNTS ====`);
  parts.push(`total rows: ${totalRows}`);
  for (const k of kinds) parts.push(`  ${k.padEnd(20)} ${String(counts[k]).padStart(6)}`);
  parts.push('');

  for (const kind of kinds) {
    const cap = Math.min(Math.max(1, limitPerKind | 0), 5000);
    const rows = await q`SELECT plaintext, title FROM integration_data WHERE source = ${source} AND kind = ${kind} ORDER BY ts DESC LIMIT ${cap}`;
    parts.push(`==== ${kind.toUpperCase()} · ${rows.length} shown of ${counts[kind] ?? rows.length} ====`);
    parts.push('');
    for (const r of rows) {
      parts.push(r.plaintext || r.title || '(no plaintext)');
      parts.push('');
    }
  }

  return parts.join('\n');
}

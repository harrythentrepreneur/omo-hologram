// Neon serverless Postgres client. Lazy-initialises on first use so the
// app still boots without DB creds (dev fallback), and exposes an
// idempotent `ensureSchema()` that creates the tables and seeds demo
// data on first run from `data/seed.json`.
//
// Why Neon serverless over `pg`: HTTP-based, zero-config connection
// pooling, sub-100ms cold start — suits a Realtime app where each tool
// call is a short independent query.

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CURRENT_USER_ID = 'u_demo';
const SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed.json');

let _sql;
export function sql() {
  if (_sql) return _sql;
  const url = process.env.NEON_DB_DATABASE;
  if (!url) throw new Error('NEON_DB_DATABASE not set');
  _sql = neon(url);
  return _sql;
}

export function isConfigured() {
  return Boolean(process.env.NEON_DB_DATABASE);
}

export function currentUserId() {
  return CURRENT_USER_ID;
}

let _seed;
function loadSeed() {
  if (_seed) return _seed;
  _seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  return _seed;
}

let _schemaReady;
export async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS users (
      id      TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      plan    TEXT NOT NULL,
      joined  DATE NOT NULL
    )`;
    await q`CREATE TABLE IF NOT EXISTS customers (
      id                    TEXT PRIMARY KEY,
      first_seen            DATE NOT NULL,
      country               TEXT NOT NULL,
      total_orders          INTEGER NOT NULL DEFAULT 0,
      lifetime_value_pence  INTEGER NOT NULL DEFAULT 0,
      is_returning          BOOLEAN NOT NULL DEFAULT FALSE
    )`;
    await q`CREATE TABLE IF NOT EXISTS products (
      sku           TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      category      TEXT NOT NULL,
      price_pence   INTEGER NOT NULL,
      inventory     INTEGER NOT NULL,
      launched_at   DATE NOT NULL
    )`;
    await q`CREATE TABLE IF NOT EXISTS campaigns (
      id                         TEXT PRIMARY KEY,
      platform                   TEXT NOT NULL CHECK (platform IN ('meta','google')),
      name                       TEXT NOT NULL,
      started_at                 DATE NOT NULL,
      ended_at                   DATE,
      spend_pence                INTEGER NOT NULL,
      impressions                INTEGER NOT NULL,
      clicks                     INTEGER NOT NULL,
      attributed_orders          INTEGER NOT NULL,
      attributed_revenue_pence   INTEGER NOT NULL
    )`;
    await q`CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
      sku           TEXT REFERENCES products(sku) ON DELETE SET NULL,
      campaign_id   TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
      item          TEXT NOT NULL,
      category      TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('processing','shipped','delivered')),
      channel       TEXT NOT NULL CHECK (channel IN ('direct','meta','google','email')),
      value_pence   INTEGER NOT NULL,
      placed_at     DATE NOT NULL,
      eta           DATE,
      delivered_at  DATE
    )`;

    // Idempotent upgrade: if the `orders` table pre-dates the richer
    // schema, add the new FK columns as nullable. Legacy rows get
    // customer/sku/campaign = NULL and channel defaulting to 'direct';
    // the reseed below will replace them with proper rows anyway.
    await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL`;
    await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sku         TEXT REFERENCES products(sku)  ON DELETE SET NULL`;
    await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL`;
    await q`ALTER TABLE orders ADD COLUMN IF NOT EXISTS channel     TEXT NOT NULL DEFAULT 'direct'`;

    await q`CREATE INDEX IF NOT EXISTS idx_orders_placed_at ON orders (placed_at DESC)`;
    await q`CREATE INDEX IF NOT EXISTS idx_orders_category ON orders (category)`;
    await q`CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders (channel)`;
    await q`CREATE INDEX IF NOT EXISTS idx_orders_sku ON orders (sku)`;
    await q`CREATE INDEX IF NOT EXISTS idx_orders_campaign ON orders (campaign_id)`;
    await q`CREATE INDEX IF NOT EXISTS idx_customers_country ON customers (country)`;
    await q`CREATE INDEX IF NOT EXISTS idx_campaigns_platform ON campaigns (platform)`;

    // Generic integration_data: one row per external object from any
    // source (stripe / gmail / drive / meta). Carries both raw JSONB and
    // a pre-rendered `plaintext` chunk that /omo/api/integrations/*/plaintext
    // concatenates for LLM context dumps.
    await q`CREATE TABLE IF NOT EXISTS integration_data (
      id             TEXT PRIMARY KEY,
      source         TEXT NOT NULL,
      kind           TEXT NOT NULL,
      external_id    TEXT NOT NULL,
      ts             TIMESTAMPTZ NOT NULL,
      title          TEXT,
      summary        TEXT,
      plaintext      TEXT,
      data           JSONB,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await q`CREATE INDEX IF NOT EXISTS idx_integration_source_ts ON integration_data (source, ts DESC)`;
    await q`CREATE INDEX IF NOT EXISTS idx_integration_source_kind ON integration_data (source, kind, ts DESC)`;
    // Multi-account support: every row is now optionally tagged with the
    // upstream account that produced it (Gmail address, Drive owner,
    // future Stripe connect-id, etc). Nullable so legacy rows still match
    // queries that don't filter by account_id.
    await q`ALTER TABLE integration_data ADD COLUMN IF NOT EXISTS account_id TEXT`;
    await q`CREATE INDEX IF NOT EXISTS idx_integration_source_account_ts ON integration_data (source, account_id, ts DESC)`;

    // Seed if any of the main tables is underpopulated — covers fresh DBs
    // AND partial-seed states from interrupted runs. Expected counts come
    // from the seed file itself.
    const expected = loadSeed();
    const [cust] = await q`SELECT COUNT(*)::int AS n FROM customers`;
    const [prod] = await q`SELECT COUNT(*)::int AS n FROM products`;
    const [camp] = await q`SELECT COUNT(*)::int AS n FROM campaigns`;
    const [ord]  = await q`SELECT COUNT(*)::int AS n FROM orders`;
    const needsSeed =
      cust.n < expected.customers.length ||
      prod.n < expected.products.length ||
      camp.n < expected.campaigns.length ||
      ord.n  < expected.orders.length;
    if (needsSeed) {
      console.log(`[db] reseeding — have ${cust.n}/${expected.customers.length} customers, ${prod.n}/${expected.products.length} products, ${camp.n}/${expected.campaigns.length} campaigns, ${ord.n}/${expected.orders.length} orders`);
      await reseedFromFile(q);
    }
  })();
  return _schemaReady;
}

async function reseedFromFile(q) {
  // Clear in FK-safe order; schema is preserved.
  await q`DELETE FROM orders`;
  await q`DELETE FROM campaigns`;
  await q`DELETE FROM products`;
  await q`DELETE FROM customers`;
  await q`DELETE FROM users`;
  await seedFromFile(q);
}

async function seedFromFile(q) {
  const { users, customers, products, campaigns, orders } = loadSeed();

  // Batched multi-row INSERTs. Neon serverless is HTTP-based so every
  // round trip costs ~100–500ms; inserting 1000+ rows one at a time takes
  // minutes. Chunking keeps the whole seed under ~5 seconds.
  await bulkInsert(q, 'users',     ['id','name','plan','joined'], users);
  await bulkInsert(q, 'customers', ['id','first_seen','country','total_orders','lifetime_value_pence','is_returning'], customers);
  await bulkInsert(q, 'products',  ['sku','name','category','price_pence','inventory','launched_at'], products);
  await bulkInsert(q, 'campaigns', ['id','platform','name','started_at','ended_at','spend_pence','impressions','clicks','attributed_orders','attributed_revenue_pence'], campaigns);
  await bulkInsert(q, 'orders',    ['id','user_id','customer_id','sku','campaign_id','item','category','status','channel','value_pence','placed_at','eta','delivered_at'],
    orders.map((o) => ({ ...o, channel: o.channel ?? 'direct' })));
}

// Chunked multi-row INSERT via positional params. The `neon()` function
// supports call-form `sql(text, params)` alongside the tagged template.
async function bulkInsert(q, table, columns, rows, chunkSize = 200) {
  if (!rows.length) return;
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const t0 = Date.now();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk
      .map((_, ri) => `(${columns.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(',')})`)
      .join(',');
    const params = chunk.flatMap((row) => columns.map((c) => row[c] ?? null));
    try {
      await q.query(`INSERT INTO ${table} (${colList}) VALUES ${placeholders}`, params);
      inserted += chunk.length;
    } catch (err) {
      console.error(`[db] bulkInsert ${table} chunk ${i}-${i + chunk.length} failed:`, err.message);
      throw err;
    }
  }
  console.log(`[db] bulkInsert ${table}: ${inserted} rows in ${Date.now() - t0}ms`);
}


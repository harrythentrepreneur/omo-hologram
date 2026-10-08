// NeonDB connector for the Omo Data Core.
//
// Polls Neon serverless Postgres on two cadences and emits structured
// events into the shared dataCore ring + WebSocket fan-out:
//   - 5s  → `database/order_placed` for any new orders since last poll
//          (also `database/customer_signup` for new customers)
//   - 15s → `database/snapshot` with KPI roll-ups (revenue today, AOV,
//          top SKUs, channel split, inventory at risk, etc.)
//
// First-tick behaviour seeds the "seen" sets WITHOUT emitting, so a
// fresh boot doesn't flood the ring with the entire seed dataset.
//
// All polling loops are wrapped in try/catch with throttled error logs
// (≤ once per minute per loop). Timers are .unref()-ed so they don't
// block process exit.
//
// Schema is owned by `src/db.js` — we call `ensureSchema()` once on
// start to make sure the tables exist before issuing queries.
//
// IMPORTANT: uses the tagged-template form of the Neon `sql` client
// (`await q\`SELECT ...\``) to match the rest of `db.js`.

import * as db from '../db.js';

const ORDER_POLL_MS = 5000;
const SNAPSHOT_POLL_MS = 15000;
const ERR_LOG_THROTTLE_MS = 60_000;

export async function start({ emit }) {
  if (!db.isConfigured()) {
    console.log('[neon] NEON_DB_DATABASE not set — connector disabled');
    return;
  }

  try {
    await db.ensureSchema();
  } catch (err) {
    console.error('[neon] ensureSchema failed:', err.message);
    return;
  }

  const q = db.sql();
  const userId = db.currentUserId();

  const seenOrders = new Set();
  const seenCustomers = new Set();

  // ----- First-tick seed: populate seen-sets WITHOUT emitting --------------
  try {
    const initialOrders = await q`
      SELECT id FROM orders WHERE user_id = ${userId}
      ORDER BY placed_at DESC LIMIT 500
    `;
    for (const row of initialOrders) seenOrders.add(row.id);

    const initialCustomers = await q`
      SELECT id FROM customers ORDER BY first_seen DESC LIMIT 500
    `;
    for (const row of initialCustomers) seenCustomers.add(row.id);

    console.log(`[neon] connector online — seeded ${seenOrders.size} orders, ${seenCustomers.size} customers`);
  } catch (err) {
    console.error('[neon] initial seed query failed:', err.message);
    // continue anyway — loops will retry
  }

  // ----- Loop A: orders (5s) ------------------------------------------------
  let ordersErrLast = 0;
  async function pollOrders() {
    try {
      const rows = await q`
        SELECT id, item, value_pence, channel, sku, customer_id, placed_at
        FROM orders WHERE user_id = ${userId}
        ORDER BY placed_at DESC LIMIT 50
      `;
      for (const row of rows) {
        if (seenOrders.has(row.id)) continue;
        seenOrders.add(row.id);
        const dollars = (Number(row.value_pence) / 100).toFixed(2);
        emit({
          id: `db_order_${row.id}`,
          source: 'database',
          kind: 'order_placed',
          ts: new Date(row.placed_at).getTime() || Date.now(),
          title: `$${dollars} · ${row.item}`,
          summary: `${row.channel} · order ${row.id}`,
          data: {
            order_id: row.id,
            value_pence: row.value_pence,
            channel: row.channel,
            sku: row.sku,
            customer_id: row.customer_id,
            item: row.item,
          },
        });
      }
    } catch (err) {
      const now = Date.now();
      if (now - ordersErrLast >= ERR_LOG_THROTTLE_MS) {
        ordersErrLast = now;
        console.error('[neon] orders poll error:', err.message);
      }
    }
  }

  // ----- Loop B: snapshot + customers (15s) --------------------------------
  let snapErrLast = 0;
  async function pollSnapshot() {
    try {
      const [kpis] = await q`
        SELECT
          COALESCE(SUM(value_pence) FILTER (WHERE placed_at = CURRENT_DATE),0)::int AS revenue_today_pence,
          COUNT(*) FILTER (WHERE placed_at = CURRENT_DATE)::int AS orders_today,
          COUNT(*) FILTER (WHERE placed_at >= CURRENT_DATE - 7)::int AS orders_7d,
          COALESCE(AVG(value_pence) FILTER (WHERE placed_at >= CURRENT_DATE - 7),0)::int AS aov_pence_7d,
          COUNT(DISTINCT customer_id) FILTER (WHERE placed_at >= CURRENT_DATE - 30)::int AS active_customers_30d
        FROM orders WHERE user_id = ${userId}
      `;

      const topSkusRows = await q`
        SELECT sku, SUM(value_pence)::int AS revenue_pence, COUNT(*)::int AS qty
          FROM orders WHERE user_id = ${userId} AND placed_at >= CURRENT_DATE - 7
         GROUP BY sku ORDER BY revenue_pence DESC LIMIT 8
      `;

      const channelRows = await q`
        SELECT channel, COUNT(*)::int AS n FROM orders
         WHERE user_id = ${userId} AND placed_at >= CURRENT_DATE - 7
         GROUP BY channel
      `;

      const [riskRow] = await q`
        SELECT COUNT(*)::int AS at_risk FROM products WHERE inventory < 10
      `;

      const revenueTodayPence = kpis?.revenue_today_pence ?? 0;
      const ordersToday = kpis?.orders_today ?? 0;
      const orders7d = kpis?.orders_7d ?? 0;
      const aovPence7d = kpis?.aov_pence_7d ?? 0;
      const activeCustomers30d = kpis?.active_customers_30d ?? 0;
      const inventoryAtRisk = riskRow?.at_risk ?? 0;

      const topSkus = topSkusRows.map((r) => ({
        sku: r.sku,
        revenue_pence: r.revenue_pence,
        qty: r.qty,
      }));
      const channelSplit = channelRows.map((r) => ({ channel: r.channel, n: r.n }));

      emit({
        id: `db_snapshot_${Date.now()}`,
        source: 'database',
        kind: 'snapshot',
        ts: Date.now(),
        title: 'DB snapshot',
        summary: `$${(revenueTodayPence / 100).toFixed(2)} today · ${ordersToday} orders`,
        data: {
          revenueTodayPence,
          ordersToday,
          orders7d,
          aovPence7d,
          activeCustomers30d,
          topSkus,
          channelSplit,
          inventoryAtRisk,
        },
      });
    } catch (err) {
      const now = Date.now();
      if (now - snapErrLast >= ERR_LOG_THROTTLE_MS) {
        snapErrLast = now;
        console.error('[neon] snapshot poll error:', err.message);
      }
    }

    // New-customer detection on the same cadence.
    try {
      const customerRows = await q`
        SELECT id, country, first_seen FROM customers
        ORDER BY first_seen DESC LIMIT 100
      `;
      for (const row of customerRows) {
        if (seenCustomers.has(row.id)) continue;
        seenCustomers.add(row.id);
        emit({
          id: `db_customer_${row.id}`,
          source: 'database',
          kind: 'customer_signup',
          ts: new Date(row.first_seen).getTime() || Date.now(),
          title: `New customer · ${row.country || '??'}`,
          summary: `customer ${row.id}`,
          data: {
            customer_id: row.id,
            country: row.country,
            first_seen: row.first_seen,
          },
        });
      }
    } catch (err) {
      const now = Date.now();
      if (now - snapErrLast >= ERR_LOG_THROTTLE_MS) {
        snapErrLast = now;
        console.error('[neon] customers poll error:', err.message);
      }
    }
  }

  // Kick off the loops. Use setInterval so the cadence is steady; .unref()
  // so process exit isn't blocked.
  const t1 = setInterval(pollOrders, ORDER_POLL_MS);
  const t2 = setInterval(pollSnapshot, SNAPSHOT_POLL_MS);
  t1.unref?.();
  t2.unref?.();

  // Fire one snapshot immediately so consumers have KPIs on first paint
  // (the orders loop is silent on first-tick by design — initial seed already
  // marks them all "seen").
  setTimeout(pollSnapshot, 500).unref?.();
}

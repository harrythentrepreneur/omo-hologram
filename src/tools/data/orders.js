import * as db from '../../db.js';
import * as store from '../../store/datasets.js';
import { clamp } from '../../util.js';

const CATEGORY_LABELS = {
  display:   'Displays',
  accessory: 'Accessories',
  sticker:   'Stickers',
  cable:     'Cables',
};

// ─── Recent orders ────────────────────────────────────────────────────────
export const recentDefinition = {
  type: 'function',
  name: 'get_recent_orders',
  description: "Fetch the current user's most recent named orders.",
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many orders to return (default 3).' },
    },
    additionalProperties: false,
  },
};

export async function runRecent(args) {
  await db.ensureSchema();
  const limit = clamp(args.limit ?? 3, 1, 10);
  // Named orders only — synthetic backfill rows (BG-%) exist for aggregates.
  const rows = await db.sql()`
    SELECT id, item, status, value_pence,
           eta::text AS eta,
           delivered_at::text AS delivered_at
    FROM orders
    WHERE user_id = ${db.currentUserId()} AND id NOT LIKE 'BG-%'
    ORDER BY placed_at DESC, id DESC
    LIMIT ${limit}
  `;
  const orders = rows.map((r) => ({
    id: r.id,
    item: r.item,
    status: r.status,
    value: Math.round(r.value_pence) / 100,
    eta: r.eta,
    delivered_at: r.delivered_at,
  }));
  const id = store.put('orders_recent', { orders, unit: 'USD' });
  return { id, orders };
}

// ─── Revenue timeseries ───────────────────────────────────────────────────
export const timeseriesDefinition = {
  type: 'function',
  name: 'get_orders_timeseries',
  description:
    'Daily revenue totals over a window. Returns a dataset id for render_viz plus summary stats.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 7, maximum: 90, description: 'Days of history (default 30).' },
    },
    additionalProperties: false,
  },
};

export async function runTimeseries(args) {
  await db.ensureSchema();
  const days = clamp(args.days ?? 30, 7, 90);
  const rows = await db.sql()`
    WITH window_days AS (
      SELECT generate_series(
        (CURRENT_DATE - (${days}::int - 1)),
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT w.day::text AS day, COALESCE(SUM(o.value_pence), 0)::int AS pence
    FROM window_days w
    LEFT JOIN orders o ON o.placed_at = w.day AND o.user_id = ${db.currentUserId()}
    GROUP BY w.day
    ORDER BY w.day ASC
  `;
  const series = rows.map((r) => ({ t: r.day, value: Math.round(r.pence / 100) }));
  const values = series.map((p) => p.value);
  const total = values.reduce((a, b) => a + b, 0);
  const summary = {
    range_days: days,
    unit: 'USD',
    points: series.length,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    total,
    avg: series.length ? Math.round(total / series.length) : 0,
    latest: series[series.length - 1] ?? null,
  };
  const id = store.put('orders_timeseries', { series, unit: 'USD', ...summary });
  return { id, ...summary, sample: series.slice(-3) };
}

// ─── Channel mix ──────────────────────────────────────────────────────────
const CHANNEL_LABELS = {
  direct: 'Direct',
  meta:   'Meta',
  google: 'Google',
  email:  'Email',
};

export const channelMixDefinition = {
  type: 'function',
  name: 'get_channel_mix',
  description:
    'Order count and revenue grouped by acquisition channel (direct/meta/google/email) over a window. Returns a dataset id for render_viz plus summary stats.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 7, maximum: 90, description: 'Days of history (default 30).' },
    },
    additionalProperties: false,
  },
};

export async function runChannelMix(args) {
  await db.ensureSchema();
  const days = clamp(args.days ?? 30, 7, 90);
  const rows = await db.sql()`
    SELECT channel, COUNT(*)::int AS orders, COALESCE(SUM(value_pence), 0)::int AS pence
    FROM orders
    WHERE user_id = ${db.currentUserId()}
      AND placed_at >= CURRENT_DATE - (${days}::int - 1)
    GROUP BY channel
    ORDER BY pence DESC
  `;
  const channels = rows.map((r) => ({
    key:     r.channel,
    label:   CHANNEL_LABELS[r.channel] ?? r.channel,
    orders:  r.orders,
    revenue: Math.round(r.pence / 100),
  }));
  const totalRevenue = channels.reduce((a, c) => a + c.revenue, 0);
  const totalOrders = channels.reduce((a, c) => a + c.orders, 0);
  const paid = channels.filter((c) => c.key === 'meta' || c.key === 'google');
  const paidRevenue = paid.reduce((a, c) => a + c.revenue, 0);
  const summary = {
    range_days: days,
    unit: 'USD',
    total_orders: totalOrders,
    total_revenue: totalRevenue,
    paid_share: totalRevenue > 0 ? Number((paidRevenue / totalRevenue).toFixed(3)) : 0,
    leader: channels[0] ?? null,
  };
  const id = store.put('channel_mix', { channels, unit: 'USD', ...summary });
  return { id, channels, ...summary };
}

// ─── Revenue breakdown ────────────────────────────────────────────────────
export const breakdownDefinition = {
  type: 'function',
  name: 'get_revenue_breakdown',
  description:
    'Revenue split by product category. Returns a dataset id for render_viz plus a summary.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runBreakdown() {
  await db.ensureSchema();
  const rows = await db.sql()`
    SELECT category, SUM(value_pence)::int AS pence
    FROM orders
    WHERE user_id = ${db.currentUserId()}
    GROUP BY category
    ORDER BY pence DESC
  `;
  const slices = rows.map((r) => ({
    label: CATEGORY_LABELS[r.category] ?? r.category,
    value: Math.round(r.pence / 100),
  }));
  const total = slices.reduce((a, s) => a + s.value, 0);
  const id = store.put('revenue_breakdown', { slices, unit: 'USD', total });
  return { id, slices, unit: 'USD', total };
}

// get_daily_snapshot — a compound data tool. Rolls up today's numbers
// plus the context the model needs to narrate a morning briefing, and
// stores a single dataset the daily_brief template can render in one
// render_viz call. Backed by the same Postgres fixtures as the atomic
// data tools, just computed server-side in one query pass so Momo
// doesn't need to chain five calls.
//
// Returned dataset shape:
//   {
//     date, unit, greeting,
//     headline:   { revenue, orders, aov, delta_pct },
//     kpis:       [{ title, value, trend, delta_pct, currency }],
//     revenue_series: [{ t, v }],
//     top_products:   [{ label, v }],
//     channel_mix:    [{ label, v }],
//     flags:          [{ kind, text }],
//   }

import * as db from '../../db.js';
import * as store from '../../store/datasets.js';
import { clamp } from '../../util.js';

export const definition = {
  type: 'function',
  name: 'get_daily_snapshot',
  description:
    "Compound morning-briefing data: latest-day revenue/orders/AOV/ROAS + deltas vs the day before, a 30-day revenue timeseries, top 3 products, channel mix slices, and flags worth surfacing (low stock, big swing, slow day). Feed the returned id into render_viz with chart_type 'daily_brief' to paint the whole CEO report as one card. Defaults to a 30-day trailing window.",
  parameters: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 14,
        maximum: 90,
        description: 'Days of trailing history (default 30).',
      },
    },
    additionalProperties: false,
  },
};

export async function run(args) {
  await db.ensureSchema();
  const days = clamp(args?.days ?? 30, 14, 90);

  // ── Revenue timeseries (daily totals across the window) ────────────
  const tsRows = await db.sql()`
    WITH window_days AS (
      SELECT generate_series(
        (CURRENT_DATE - (${days}::int - 1)),
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS day
    )
    SELECT w.day::text AS day,
           COALESCE(SUM(o.value_pence), 0)::int AS pence,
           COUNT(o.id)::int AS orders
    FROM window_days w
    LEFT JOIN orders o
      ON o.placed_at = w.day AND o.user_id = ${db.currentUserId()}
    GROUP BY w.day
    ORDER BY w.day ASC
  `;
  const series = tsRows.map((r) => ({
    t: r.day,
    v: Math.round(r.pence / 100),
    orders: r.orders,
  }));
  if (!series.length) return { error: 'no data' };

  const latest = series[series.length - 1];
  const prev   = series[series.length - 2] || null;
  const window7 = series.slice(-7);
  const prior7  = series.slice(-14, -7);
  const window7Sum = window7.reduce((a, r) => a + r.v, 0);
  const prior7Sum  = prior7.reduce((a, r) => a + r.v, 0);
  const window7Orders = window7.reduce((a, r) => a + r.orders, 0);
  const prior7Orders  = prior7.reduce((a, r) => a + r.orders, 0);
  const aov7 = window7Orders > 0 ? window7Sum / window7Orders : 0;
  const aovPrior = prior7Orders > 0 ? prior7Sum / prior7Orders : 0;

  function pct(curr, prior) {
    return prior > 0 ? Number((((curr - prior) / Math.abs(prior)) * 100).toFixed(1)) : 0;
  }

  // ── Top 3 products (by revenue, last 30 days) ──────────────────────
  const prodRows = await db.sql()`
    SELECT p.name, COALESCE(SUM(o.value_pence), 0)::int AS pence,
           p.inventory
    FROM products p
    LEFT JOIN orders o ON o.sku = p.sku
      AND o.placed_at >= CURRENT_DATE - (${days}::int - 1)
    GROUP BY p.name, p.inventory
    ORDER BY pence DESC
    LIMIT 3
  `;
  const topProducts = prodRows.map((r) => ({
    label: r.name,
    v: Math.round(r.pence / 100),
    inventory: r.inventory,
  }));

  // ── Channel mix (last 30 days, revenue per channel) ────────────────
  const chanRows = await db.sql()`
    SELECT channel, COALESCE(SUM(value_pence), 0)::int AS pence
    FROM orders
    WHERE user_id = ${db.currentUserId()}
      AND placed_at >= CURRENT_DATE - (${days}::int - 1)
    GROUP BY channel
    ORDER BY pence DESC
  `;
  const channelMix = chanRows.map((r) => ({
    label: r.channel ? r.channel[0].toUpperCase() + r.channel.slice(1) : 'Direct',
    v: Math.round(r.pence / 100),
  }));

  // ── Ads ROAS (overall in window) ───────────────────────────────────
  const adsRows = await db.sql()`
    SELECT SUM(spend_pence)::int AS spend,
           SUM(attributed_revenue_pence)::int AS rev
    FROM campaigns
    WHERE COALESCE(ended_at, CURRENT_DATE) >= CURRENT_DATE - (${days}::int - 1)
  `;
  const adsSpend = Math.round((adsRows[0]?.spend ?? 0) / 100);
  const adsRev   = Math.round((adsRows[0]?.rev   ?? 0) / 100);
  const roas     = adsSpend > 0 ? Number((adsRev / adsSpend).toFixed(2)) : 0;

  // ── Flags: signals worth a pill on the brief card ──────────────────
  // These are deliberately modest — no "omg huge spike!!" framing; one
  // sentence each, in Momo's calm voice. The template filters to 3
  // slots so we don't over-cover the card.
  const flags = [];
  const lowStock = topProducts.filter((p) => p.inventory != null && p.inventory <= 10);
  if (lowStock.length) {
    flags.push({
      kind: 'warn',
      text: `Low stock: ${lowStock.map((p) => p.label).slice(0, 2).join(', ')}`,
    });
  }
  if (window7Sum > prior7Sum * 1.15 && prior7Sum > 0) {
    flags.push({ kind: 'good', text: `7-day revenue up ${pct(window7Sum, prior7Sum)}% WoW` });
  } else if (window7Sum < prior7Sum * 0.85 && prior7Sum > 0) {
    flags.push({ kind: 'warn', text: `7-day revenue down ${Math.abs(pct(window7Sum, prior7Sum))}% WoW` });
  }
  if (roas >= 3) {
    flags.push({ kind: 'good', text: `Ads ROAS ${roas.toFixed(1)}× — paid is carrying weight` });
  } else if (roas > 0 && roas < 1.5) {
    flags.push({ kind: 'warn', text: `Ads ROAS ${roas.toFixed(1)}× — watch spend` });
  }
  if (channelMix[0]) {
    flags.push({
      kind: 'info',
      text: `${channelMix[0].label} leading revenue`,
    });
  }

  // Trim to max 3 pills so the card stays glanceable.
  const trimmedFlags = flags.slice(0, 3);

  const snapshot = {
    date: latest.t,
    unit: 'USD',
    greeting: pickGreeting(),
    headline: {
      revenue: latest.v,
      orders: latest.orders,
      aov: latest.orders > 0 ? Math.round(latest.v / latest.orders) : 0,
      delta_pct: prev ? pct(latest.v, prev.v) : 0,
    },
    kpis: [
      {
        title: 'REVENUE · 7D',
        value: window7Sum,
        trend: window7.map((r) => r.v),
        delta_pct: pct(window7Sum, prior7Sum),
        currency: 'USD',
      },
      {
        title: 'ORDERS · 7D',
        value: window7Orders,
        trend: window7.map((r) => r.orders),
        delta_pct: pct(window7Orders, prior7Orders),
      },
      {
        title: 'AOV · 7D',
        value: Math.round(aov7),
        trend: window7.map((r) => (r.orders > 0 ? Math.round(r.v / r.orders) : 0)),
        delta_pct: aovPrior > 0 ? pct(aov7, aovPrior) : 0,
        currency: 'USD',
      },
    ],
    revenue_series: series.map(({ t, v }) => ({ t, v })),
    top_products: topProducts.map(({ label, v }) => ({ label, v })),
    channel_mix:  channelMix,
    flags: trimmedFlags,
  };

  const id = store.put('daily_snapshot', snapshot);

  // Summary for the model — enough to speak to before the chart mounts.
  return {
    id,
    date: snapshot.date,
    unit: 'USD',
    headline: snapshot.headline,
    kpis_summary: snapshot.kpis.map((k) => ({ title: k.title, value: k.value, delta_pct: k.delta_pct })),
    flags: trimmedFlags,
    note: "Pass id into render_viz with chart_type 'daily_brief' to mount the whole morning report in one card.",
  };
}

// Time-of-day greeting. Cmn-CN phrasing — Momo speaks Chinese by default.
// The template shows whichever language the snapshot was built in; if the
// user is speaking English the model can override by passing its own
// string through the intent field.
function pickGreeting() {
  const h = new Date().getUTCHours();
  if (h < 5)  return '深夜好';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

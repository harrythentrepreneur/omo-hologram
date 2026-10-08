import * as db from '../../db.js';
import * as store from '../../store/datasets.js';
import { clamp } from '../../util.js';

// ─── Ads performance ──────────────────────────────────────────────────────
export const performanceDefinition = {
  type: 'function',
  name: 'get_ads_performance',
  description:
    'Per-campaign ad performance (spend, attributed revenue, ROAS, orders) over a window. Returns a dataset id for render_viz plus summary totals.',
  parameters: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['meta', 'google', 'all'],
        description: 'Filter by ad platform (default all).',
      },
      days: {
        type: 'integer',
        minimum: 7,
        maximum: 90,
        description: 'Only include campaigns whose window overlaps the last N days (default 30).',
      },
    },
    additionalProperties: false,
  },
};

export async function runPerformance(args) {
  await db.ensureSchema();
  const days = clamp(args.days ?? 30, 7, 90);
  const platform = ['meta', 'google'].includes(args.platform) ? args.platform : 'all';

  // A campaign is "in window" when its run interval overlaps the last N days.
  // COALESCE(ended_at, CURRENT_DATE) handles still-running campaigns.
  const rows = platform === 'all'
    ? await db.sql()`
        SELECT id, platform, name,
               started_at::text AS started_at,
               ended_at::text   AS ended_at,
               spend_pence, impressions, clicks,
               attributed_orders, attributed_revenue_pence
        FROM campaigns
        WHERE COALESCE(ended_at, CURRENT_DATE) >= CURRENT_DATE - (${days}::int - 1)
        ORDER BY attributed_revenue_pence DESC
      `
    : await db.sql()`
        SELECT id, platform, name,
               started_at::text AS started_at,
               ended_at::text   AS ended_at,
               spend_pence, impressions, clicks,
               attributed_orders, attributed_revenue_pence
        FROM campaigns
        WHERE platform = ${platform}
          AND COALESCE(ended_at, CURRENT_DATE) >= CURRENT_DATE - (${days}::int - 1)
        ORDER BY attributed_revenue_pence DESC
      `;

  const campaigns = rows.map((r) => {
    const spend = Math.round(r.spend_pence) / 100;
    const revenue = Math.round(r.attributed_revenue_pence) / 100;
    return {
      id: r.id,
      platform: r.platform,
      name: r.name,
      started_at: r.started_at,
      ended_at: r.ended_at,
      spend,
      revenue,
      roas: spend > 0 ? Number((revenue / spend).toFixed(2)) : 0,
      orders: r.attributed_orders,
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.impressions > 0 ? Number((r.clicks / r.impressions).toFixed(4)) : 0,
    };
  });

  const totalSpend = campaigns.reduce((a, c) => a + c.spend, 0);
  const totalRevenue = campaigns.reduce((a, c) => a + c.revenue, 0);
  const totalOrders = campaigns.reduce((a, c) => a + c.orders, 0);

  const summary = {
    range_days: days,
    platform,
    unit: 'USD',
    campaign_count: campaigns.length,
    total_spend: totalSpend,
    total_revenue: totalRevenue,
    total_orders: totalOrders,
    overall_roas: totalSpend > 0 ? Number((totalRevenue / totalSpend).toFixed(2)) : 0,
    best: campaigns.slice().sort((a, b) => b.roas - a.roas)[0] ?? null,
    worst: campaigns.slice().sort((a, b) => a.roas - b.roas)[0] ?? null,
  };

  const id = store.put('ads_performance', { campaigns, unit: 'USD', ...summary });
  return { id, ...summary, sample: campaigns.slice(0, 3) };
}

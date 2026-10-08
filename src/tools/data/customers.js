import * as db from '../../db.js';
import * as store from '../../store/datasets.js';
import { clamp } from '../../util.js';

// ─── Customer stats ───────────────────────────────────────────────────────
export const statsDefinition = {
  type: 'function',
  name: 'get_customer_stats',
  description:
    'Customer mix over a window: new vs returning, top-country split, and LTV distribution. Returns a dataset id for render_viz plus summary stats.',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 7, maximum: 180, description: 'Window for "new" vs "returning" (default 30).' },
    },
    additionalProperties: false,
  },
};

export async function runStats(args) {
  await db.ensureSchema();
  const days = clamp(args.days ?? 30, 7, 180);

  // Aggregate in one round-trip using three CTEs: global totals, the
  // new/returning split over the window, and per-country distribution.
  const [header] = await db.sql()`
    SELECT
      COUNT(*)::int                                  AS total_customers,
      COUNT(*) FILTER (WHERE is_returning)::int      AS returning_customers,
      COUNT(*) FILTER (WHERE total_orders > 0)::int  AS active_customers,
      COALESCE(AVG(lifetime_value_pence) FILTER (WHERE total_orders > 0), 0)::bigint AS avg_ltv_pence,
      COALESCE(
        PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY lifetime_value_pence)
        FILTER (WHERE total_orders > 0),
      0)::bigint                                     AS median_ltv_pence,
      COALESCE(MAX(lifetime_value_pence), 0)::bigint AS max_ltv_pence
    FROM customers
  `;

  const windowRows = await db.sql()`
    SELECT
      COUNT(*) FILTER (WHERE first_seen >= CURRENT_DATE - (${days}::int - 1))::int  AS new_in_window,
      COUNT(*) FILTER (WHERE first_seen <  CURRENT_DATE - (${days}::int - 1)
                           AND is_returning)::int                                   AS returning_in_window
    FROM customers
  `;

  const countryRows = await db.sql()`
    SELECT country, COUNT(*)::int AS count
    FROM customers
    GROUP BY country
    ORDER BY count DESC
  `;

  const newVsReturning = [
    { label: 'New',       value: windowRows[0].new_in_window },
    { label: 'Returning', value: windowRows[0].returning_in_window },
  ];
  const countries = countryRows.map((r) => ({ label: r.country, value: r.count }));
  const topCountries = countries.slice(0, 5);

  const summary = {
    range_days: days,
    unit: 'USD',
    total_customers: header.total_customers,
    active_customers: header.active_customers,
    returning_customers: header.returning_customers,
    returning_rate: header.active_customers > 0
      ? Number((header.returning_customers / header.active_customers).toFixed(3))
      : 0,
    avg_ltv: Math.round(Number(header.avg_ltv_pence)) / 100,
    median_ltv: Math.round(Number(header.median_ltv_pence)) / 100,
    max_ltv: Math.round(Number(header.max_ltv_pence)) / 100,
    new_in_window: windowRows[0].new_in_window,
    top_country: topCountries[0] ?? null,
  };

  const id = store.put('customer_stats', {
    new_vs_returning: newVsReturning,
    countries,
    unit: 'USD',
    ...summary,
  });
  return { id, ...summary, top_countries: topCountries };
}

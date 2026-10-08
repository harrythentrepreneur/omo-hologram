import * as db from '../../db.js';
import * as store from '../../store/datasets.js';
import { clamp } from '../../util.js';

// ─── Top products ─────────────────────────────────────────────────────────
export const topDefinition = {
  type: 'function',
  name: 'get_top_products',
  description:
    'Top-N products by revenue over a window. Each row includes units sold, revenue, current inventory, and a low-stock flag. Returns a dataset id for render_viz plus summary stats.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 3, maximum: 12, description: 'How many products to return (default 5).' },
      days:  { type: 'integer', minimum: 7, maximum: 90, description: 'Days of history (default 30).' },
    },
    additionalProperties: false,
  },
};

const LOW_STOCK_THRESHOLD = 10;

export async function runTop(args) {
  await db.ensureSchema();
  const limit = clamp(args.limit ?? 5, 3, 12);
  const days = clamp(args.days ?? 30, 7, 90);

  // Join orders to products so we keep product metadata (name, inventory)
  // even when a few orders have a null SKU.
  const rows = await db.sql()`
    SELECT p.sku, p.name, p.category, p.inventory,
           p.launched_at::text AS launched_at,
           COUNT(o.id)::int AS units,
           COALESCE(SUM(o.value_pence), 0)::int AS pence
    FROM products p
    LEFT JOIN orders o
      ON o.sku = p.sku
      AND o.placed_at >= CURRENT_DATE - (${days}::int - 1)
    GROUP BY p.sku, p.name, p.category, p.inventory, p.launched_at
    ORDER BY pence DESC
    LIMIT ${limit}
  `;

  const products = rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    category: r.category,
    units: r.units,
    revenue: Math.round(r.pence / 100),
    inventory: r.inventory,
    low_stock: r.inventory <= LOW_STOCK_THRESHOLD,
    launched_at: r.launched_at,
  }));

  const totalRevenue = products.reduce((a, p) => a + p.revenue, 0);
  const totalUnits = products.reduce((a, p) => a + p.units, 0);
  const lowStockCount = products.filter((p) => p.low_stock).length;

  const summary = {
    range_days: days,
    unit: 'USD',
    limit,
    total_revenue: totalRevenue,
    total_units: totalUnits,
    low_stock_count: lowStockCount,
    leader: products[0] ?? null,
  };

  const id = store.put('top_products', { products, unit: 'USD', ...summary });
  return { id, products, ...summary };
}

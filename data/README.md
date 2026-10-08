# Holoscope seed data

`seed.json` is the source of truth for the synthetic business world. Edit
it freely — `src/db.js` reads it on first run and writes it into Postgres
via `ensureSchema()`. Delete the DB rows and restart to reseed.

The world ends on **2026-04-22** (Momo's "today"). All dates are ISO
`YYYY-MM-DD` strings.

## Top-level shape

```
{
  "users":     [...],   // 1 row — the current user
  "customers": [...],   // ~800 rows — end buyers
  "products":  [...],   // ~12 rows — SKUs you sell
  "campaigns": [...],   // ~10 rows — Meta/Google ad campaigns
  "orders":    [...]    // ~200 rows — 90 days of orders
}
```

## Fields

### `users[]`
| field   | notes                                             |
| ------- | ------------------------------------------------- |
| id      | primary key, referenced by `orders.user_id`       |
| name    | display name                                      |
| plan    | free-text plan label                              |
| joined  | date the account was created                      |

### `customers[]`
| field                | notes                                           |
| -------------------- | ----------------------------------------------- |
| id                   | primary key, referenced by `orders.customer_id` |
| first_seen           | date of first visit                             |
| country              | ISO-2 country code (GB/US/DE/FR/NL/ES/IT/SE)    |
| total_orders         | denormalised count — should match orders table  |
| lifetime_value_pence | denormalised sum — should match orders table    |
| is_returning         | `true` when `total_orders >= 2`                 |

> `total_orders` / `lifetime_value_pence` / `is_returning` are
> pre-aggregated for fast reads. If you hand-edit `orders`, either
> recompute these or run a `UPDATE customers …` in the db.

### `products[]`
| field        | notes                                       |
| ------------ | ------------------------------------------- |
| sku          | primary key (short slug, upper-case)        |
| name         | display name                                |
| category     | `display` / `accessory` / `sticker` / `cable` |
| price_pence  | list price in pence (GBP)                   |
| inventory    | units in stock right now                    |
| launched_at  | date the SKU first became available         |

### `campaigns[]`
| field                     | notes                                             |
| ------------------------- | ------------------------------------------------- |
| id                        | primary key (e.g. `cmp_meta_portrait_q2`)         |
| platform                  | `meta` or `google`                                |
| name                      | display name                                      |
| started_at                | campaign start date                               |
| ended_at                  | campaign end date, or `null` if still running     |
| spend_pence               | total spend in pence                              |
| impressions               | total impressions                                 |
| clicks                    | total clicks                                      |
| attributed_orders         | count of orders attributed to this campaign       |
| attributed_revenue_pence  | revenue attributed to this campaign (pence)       |

ROAS is derived: `attributed_revenue_pence / spend_pence`. Aggregate
attributed revenue is ~50% of total `orders.value_pence` from the
`meta` + `google` channels, a realistic fraction after view-through
discounting.

### `orders[]`
| field         | notes                                                     |
| ------------- | --------------------------------------------------------- |
| id            | primary key (`HX-xxxx` named, `BG-xxxx` synthetic)        |
| user_id       | -> `users.id`                                             |
| customer_id   | -> `customers.id`                                         |
| sku           | -> `products.sku`                                         |
| item          | denormalised product name (for display)                   |
| category      | denormalised product category                             |
| status        | `processing` / `shipped` / `delivered`                    |
| value_pence   | order value in pence                                      |
| placed_at     | date placed                                               |
| eta           | expected delivery (usually `null` once `delivered_at` set) |
| delivered_at  | actual delivery date (`null` until delivered)             |
| channel       | `direct` / `meta` / `google` / `email`                    |
| campaign_id   | optional -> `campaigns.id` (only for `meta`/`google`)     |

## Adding your own story

- Want a viral week? Bump `value_pence` on a cluster of orders in one
  date range, or add more rows for those days.
- Want to break a product? Set `products[n].inventory` to `0`.
- Want a new breakout campaign? Add a row to `campaigns[]` and drop a
  few orders with the matching `channel` + `campaign_id`.

Keep foreign keys honest and the ID prefixes consistent and the tools
will pick up your edits automatically.

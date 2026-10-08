// Shared helpers for deterministic chart templates. Every template is a
// pure function of { dataset, datasets, intent, size } and returns
// { body, exposedData } — body is the <div id="viz">...</div> fragment
// that goes into the iframe shell, exposedData gets published under
// window.__DATA so the inline script can read it by key.
//
// Shared helpers are now owned by theme.js so theme tokens, palettes, and
// runtime helpers all live in one file. Re-export here so templates that
// import from './shared.js' keep working unchanged.
export { HELPERS_JS } from '../theme.js';

// ── Tiny HTML escapers (titles only; values never go through innerHTML).
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Uppercase title label that lives above every chart. Non-Latin characters
// (e.g. Chinese) are left as-is — toUpperCase is a no-op for them, which is
// exactly what we want.
export function titleText(intent, fallback = 'CHART') {
  const s = String(intent || '').trim();
  if (!s) return fallback;
  return s.length > 64 ? s.slice(0, 61) + '…' : s;
}

// Shared empty-state body — dignified, no ECharts instance. Still calls
// __READY so the parent frame gets the "mounted" signal quickly.
export function emptyStateBody(title, subtitle) {
  const t = escapeHtml(titleText(title));
  const sub = escapeHtml(subtitle || 'No data yet for this window.');
  return `<div id="viz">
  <div class="holo-title holo-title--ruled">${t}</div>
  <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
    <div class="holo-stat holo-stat--sm" style="opacity:0.6;">NO DATA YET</div>
    <div class="holo-caption" style="opacity:0.8;">${sub}</div>
  </div>
  <script>(function(){window.__READY && window.__READY();})();</script>
</div>`;
}

// ─── Dataset-shape coercion helpers ───────────────────────────────────
// Each template accepts a moderately flexible input and normalises it
// server-side so the iframe script doesn't have to branch.

export function coerceTimeseries(data) {
  // orders_timeseries has { series: [{t, value}], ... }
  if (!data) return null;
  const raw = Array.isArray(data.series) ? data.series
            : Array.isArray(data) ? data
            : null;
  if (!raw || !raw.length) return null;
  const out = raw.map((r) => {
    const t = r.t ?? r.date ?? r.day ?? r.ts ?? r.timestamp ?? '';
    const v = Number(r.value ?? r.v ?? r.count ?? r.amount ?? r.revenue ?? 0);
    return { t: String(t), v };
  }).filter((r) => Number.isFinite(r.v));
  return out.length ? out : null;
}

export function coerceCategorical(data) {
  // Accept shapes from:
  //   revenue_breakdown → { slices: [{label, value}] }
  //   channel_mix       → { channels: [{label, revenue, orders}] }
  //   customer_stats    → { countries: [{label, value}], new_vs_returning: [...] }
  //   top_products      → { products: [{name, revenue, units}] }
  //   ads_performance   → { campaigns: [{name, spend, revenue, roas}] }
  //   generic           → { rows: [{...}] }
  if (!data) return null;
  let raw = data.slices || data.channels || data.rows || data.countries
         || data.new_vs_returning || data.products || data.campaigns
         || (Array.isArray(data) ? data : null);
  if (!raw || !raw.length) return null;

  return raw.map((r) => {
    const label =
      r.label ?? r.name ?? r.category ?? r.key ?? r.channel ?? r.country ?? r.sku ?? '—';
    const value = Number(
      r.value ?? r.v ?? r.revenue ?? r.count ?? r.amount
      ?? r.total ?? r.spend ?? r.units ?? r.share_pct ?? 0
    );
    return { label: String(label), v: Number.isFinite(value) ? value : 0 };
  }).filter((r) => r.label);
}

export function sumValues(rows) {
  let t = 0;
  for (const r of rows) t += r.v || r.value || 0;
  return t;
}

// Does the dataset look like it should get USD currency formatting?
// The kind regex is intentionally tight — only kinds that are unambiguously
// money. Anything else (analytics, traffic, custom findings) must opt in by
// setting `data.unit = 'USD' | 'GBP'` explicitly, otherwise it stays
// dimensionless. Avoids "$0" / "£0" leaking onto non-money cards.
export function isCurrencyDataset(dataset) {
  if (!dataset) return false;
  const kind = String(dataset.kind || '').toLowerCase();
  if (/orders|revenue|payout|invoice|charge|ads_performance|top_products|channel_mix|revenue_breakdown|aov|mrr|earnings|spend/.test(kind)) return true;
  const unit = String(dataset.data?.unit || '').toUpperCase();
  return unit === 'USD' || unit === 'GBP';
}

// Size-preset detection from the SIZES object — templates want a name, not dims.
export function sizeNameFromSize(size) {
  if (!size) return 'wide';
  if (size.width === 360) return 'stat';
  if (size.width === 480) return 'square';
  return 'wide';
}

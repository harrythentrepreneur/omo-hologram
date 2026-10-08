// receipt_card — a single customer order receipt: items purchased, totals,
// shipping status. Sibling of email_card / payout_card / invoice_card.
//
// Data shape:
//   {
//     order_id, placed,                   // ISO
//     customer: { name, email? } | "Name <email>" string,
//     items: [{ label, qty, price, sku? }],
//     subtotal, shipping, tax?, total,
//     status: 'placed' | 'shipped' | 'delivered' | 'refunded',
//     tracking_url?,
//     currency
//   }
//
// Pure text card — no ECharts, no runtime math.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, tagHTML, keyValueRowHTML, personChipHTML, iconHTML,
} from './primitives.js';

function fmtMoney(n, currency = 'USD') {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: String(currency || 'USD').toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch (e) {
    const sym = currency === 'GBP' ? '£' : '$';
    return sym + num.toFixed(2);
  }
}

// Returns either "APR 24" or "APR 24 · 2:15 PM" depending on whether the
// source carries a non-zero time-of-day component. Unparseable → raw.
function formatDate(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0
               || d.getHours() !== 0   || d.getMinutes() !== 0   || d.getSeconds() !== 0;
  if (!hasTime) return date;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function coerceCustomer(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*([^<]+)?<?([^>]+@[^>]+)?>?\s*$/);
    return {
      name:  (m?.[1] || raw).trim() || (m?.[2] || '').trim(),
      email: (m?.[2] || '').trim() || null,
    };
  }
  return {
    name:  raw.name || raw.display_name || raw.email || '',
    email: raw.email || null,
  };
}

function statusMeta(status) {
  const s = String(status || 'placed').toLowerCase();
  switch (s) {
    case 'delivered': return { label: 'DELIVERED', tone: 'cyan'  };
    case 'shipped':   return { label: 'SHIPPED',   tone: 'ice'   };
    case 'refunded':  return { label: 'REFUNDED',  tone: 'pink'  };
    case 'placed':    return { label: 'PLACED',    tone: 'muted' };
    default:          return { label: s.toUpperCase(), tone: 'muted' };
  }
}

// Truncate an order id to ~10 chars with an ellipsis so long Stripe-ish
// ids don't overflow the kicker line.
function truncateId(id) {
  const s = String(id || '');
  if (s.length <= 10) return s;
  return s.slice(0, 9) + '…';
}

function coerceReceipt(data) {
  if (!data) return null;
  const items = Array.isArray(data.items) ? data.items.map((it) => ({
    label: String(it?.label || it?.name || ''),
    qty:   Number.isFinite(Number(it?.qty)) ? Number(it.qty) : 1,
    price: Number.isFinite(Number(it?.price)) ? Number(it.price) : null,
    sku:   it?.sku || null,
  })).filter((it) => it.label) : [];

  const total = Number(data.total);
  if (!Number.isFinite(total) && !items.length) return null;

  return {
    order_id: data.order_id ? String(data.order_id) : null,
    placed:   data.placed || null,
    customer: coerceCustomer(data.customer),
    items,
    subtotal: Number.isFinite(Number(data.subtotal)) ? Number(data.subtotal) : null,
    shipping: Number.isFinite(Number(data.shipping)) ? Number(data.shipping) : null,
    tax:      Number.isFinite(Number(data.tax)) ? Number(data.tax) : 0,
    total:    Number.isFinite(total) ? total : null,
    status:   data.status || 'placed',
    tracking_url: data.tracking_url || null,
    currency: String(data.currency || 'USD').toUpperCase(),
  };
}

export function receiptCardTemplate({ dataset, intent }) {
  const r = coerceReceipt(dataset?.data);
  if (!r) {
    return { body: emptyStateBody(intent, 'Need an order object.'), exposedData: {}, needsEcharts: false };
  }

  titleText(intent, 'ORDER');
  const kicker = r.order_id ? `ORDER · #${truncateId(r.order_id)}` : 'ORDER';
  const headline = r.total != null ? fmtMoney(r.total, r.currency) : '—';

  const meta = statusMeta(r.status);
  const right = tagHTML({ label: meta.label, tone: meta.tone });

  const customerMarkup = r.customer
    ? personChipHTML({ name: r.customer.name, role: r.customer.email || '', size: 'md' })
    : '';

  // Items: 1–3 → all inline; 4+ → first 3 + "+ N more items".
  const visibleItems = r.items.slice(0, r.items.length > 3 ? 3 : r.items.length);
  const itemRows = visibleItems.map((it) => {
    const label = it.qty && it.qty !== 1 ? `${it.qty}× ${it.label}` : it.label;
    const value = it.price != null ? fmtMoney(it.price, r.currency) : '—';
    return keyValueRowHTML({ label, value });
  }).join('');
  const moreItems = r.items.length > visibleItems.length
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${r.items.length - visibleItems.length} more items</div>`
    : '';

  // Totals rows with a hairline above the Total.
  const totalsRows = [];
  if (r.subtotal != null) {
    totalsRows.push(keyValueRowHTML({ label: 'Subtotal', value: fmtMoney(r.subtotal, r.currency), icon: 'hashtag' }));
  }
  if (r.shipping != null) {
    totalsRows.push(keyValueRowHTML({ label: 'Shipping', value: fmtMoney(r.shipping, r.currency), icon: 'paperclip' }));
  }
  if (r.tax > 0) {
    totalsRows.push(keyValueRowHTML({ label: 'Tax', value: fmtMoney(r.tax, r.currency) }));
  }
  const totalRow = r.total != null
    ? `<div class="holo-hairline"></div>
       ${keyValueRowHTML({ label: 'Total', value: fmtMoney(r.total, r.currency), icon: 'money' })}`
    : '';

  const trackingFooter = (r.status === 'shipped' && r.tracking_url)
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">
         ${iconHTML({ name: 'paperclip', inline: true })} Tracking ready
       </div>`
    : '';

  // Placed-date footer if we have one and no tracking line above.
  const placedLine = (!trackingFooter && r.placed)
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">
         ${iconHTML({ name: 'clock', inline: true })} Placed ${escapeHtml(formatDate(r.placed))}
       </div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-receipt-total {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.1;
      background: linear-gradient(180deg, #ffffff 0%, #6ff2ff 70%, #00e5ff 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      text-shadow: 0 0 16px rgba(0, 229, 255, 0.3);
      font-variant-numeric: tabular-nums;
    }
    .holo-receipt-customer { margin-top: 2px; }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: '', kicker, right })}
    <div class="holo-receipt-total">${escapeHtml(headline)}</div>
    <div class="holo-receipt-customer">${customerMarkup}</div>
    <div class="holo-hairline"></div>
    <div class="holo-stack holo-stack--sm">
      ${itemRows}
      ${moreItems}
    </div>
    <div class="holo-stack holo-stack--sm">
      ${totalsRows.join('')}
      ${totalRow}
    </div>
    <div class="holo-spacer"></div>
    ${trackingFooter}
    ${placedLine}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('receipt_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

// invoice_card — a single invoice projectable (vendor → buyer, line items,
// totals). Sibling to email_card and payout_card; same skeleton.
//
// Data shape:
//   {
//     number, issued, due,                // ISO dates
//     status: 'draft' | 'sent' | 'paid' | 'overdue',
//     vendor: { name, email? } | "Name <email>" string,
//     buyer:  { name, email? } | "Name <email>" string,
//     lines: [{ label, qty?, price, subtotal? }],
//     subtotal, tax, total,
//     currency
//   }
//
// Pure text card — no ECharts, no math at runtime. Server-rendered.

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

function formatDate(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

// Parse "Name <email@x.com>" strings or pass through object form.
function coerceParty(raw) {
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
  const s = String(status || 'sent').toLowerCase();
  switch (s) {
    case 'paid':    return { label: 'PAID',    tone: 'cyan'  };
    case 'overdue': return { label: 'OVERDUE', tone: 'pink'  };
    case 'draft':   return { label: 'DRAFT',   tone: 'muted' };
    case 'sent':    return { label: 'SENT',    tone: 'muted' };
    default:        return { label: s.toUpperCase(), tone: 'muted' };
  }
}

function coerceInvoice(data) {
  if (!data) return null;
  const vendor = coerceParty(data.vendor);
  const buyer  = coerceParty(data.buyer);
  const lines = Array.isArray(data.lines) ? data.lines.map((l) => ({
    label: String(l?.label || l?.description || ''),
    qty:   Number.isFinite(Number(l?.qty)) ? Number(l.qty) : null,
    price: Number.isFinite(Number(l?.price)) ? Number(l.price) : null,
    subtotal: Number.isFinite(Number(l?.subtotal)) ? Number(l.subtotal) : null,
  })).filter((l) => l.label) : [];

  const total = Number(data.total);
  if (!Number.isFinite(total) && !lines.length) return null;

  return {
    number:   data.number ? String(data.number) : null,
    issued:   data.issued || null,
    due:      data.due || null,
    status:   data.status || 'sent',
    vendor, buyer, lines,
    subtotal: Number.isFinite(Number(data.subtotal)) ? Number(data.subtotal) : null,
    tax:      Number.isFinite(Number(data.tax)) ? Number(data.tax) : 0,
    total:    Number.isFinite(total) ? total : null,
    currency: String(data.currency || 'USD').toUpperCase(),
  };
}

export function invoiceCardTemplate({ dataset, intent }) {
  const inv = coerceInvoice(dataset?.data);
  if (!inv) {
    return { body: emptyStateBody(intent, 'Need an invoice object.'), exposedData: {}, needsEcharts: false };
  }

  titleText(intent, 'INVOICE');
  const kicker = inv.number ? `INVOICE · #${inv.number}` : 'INVOICE';
  const headline = inv.total != null ? fmtMoney(inv.total, inv.currency) : '—';

  const meta = statusMeta(inv.status);
  const right = tagHTML({ label: meta.label, tone: meta.tone });

  // Parties row: two small person chips side-by-side, each under a label.
  const partyCell = (label, party) => {
    const chipMarkup = party
      ? personChipHTML({ name: party.name, role: party.email || '', size: 'sm' })
      : `<div class="holo-body holo-body--muted" style="font-size:11px;">—</div>`;
    return `<div class="holo-invoice-party">
      <div class="holo-invoice-party-label">${escapeHtml(label)}</div>
      ${chipMarkup}
    </div>`;
  };
  const partiesRow = `<div class="holo-row holo-row--between holo-invoice-parties">
    ${partyCell('FROM', inv.vendor)}
    ${partyCell('TO',   inv.buyer)}
  </div>`;

  // Up to 4 line items, each as a kv row.
  const visibleLines = inv.lines.slice(0, 4);
  const lineRows = visibleLines.map((l) => {
    const value = l.qty != null && l.price != null
      ? `${l.qty}× ${fmtMoney(l.price, inv.currency)}`
      : (l.subtotal != null ? fmtMoney(l.subtotal, inv.currency)
        : (l.price != null ? fmtMoney(l.price, inv.currency) : '—'));
    return keyValueRowHTML({ label: l.label, value });
  }).join('');
  const moreLine = inv.lines.length > visibleLines.length
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">+ ${inv.lines.length - visibleLines.length} more</div>`
    : '';

  // Totals block — subtotal, tax (only if > 0), total.
  const totalsRows = [];
  if (inv.subtotal != null) {
    totalsRows.push(keyValueRowHTML({ label: 'Subtotal', value: fmtMoney(inv.subtotal, inv.currency), icon: 'hashtag' }));
  }
  if (inv.tax > 0) {
    totalsRows.push(keyValueRowHTML({ label: 'Tax', value: fmtMoney(inv.tax, inv.currency) }));
  }
  if (inv.total != null) {
    totalsRows.push(keyValueRowHTML({ label: 'Total', value: fmtMoney(inv.total, inv.currency), icon: 'money' }));
  }

  const dueLine = inv.due
    ? `<div class="holo-body holo-body--muted" style="font-size:11px;">
         ${iconHTML({ name: 'calendar', inline: true })} Due ${escapeHtml(formatDate(inv.due))}
       </div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-invoice-total {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.1;
      background: linear-gradient(180deg, #ffffff 0%, #6ff2ff 70%, #00e5ff 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      text-shadow: 0 0 16px rgba(0, 229, 255, 0.3);
      font-variant-numeric: tabular-nums;
    }
    .holo-invoice-parties { gap: 14px; align-items: flex-start; }
    .holo-invoice-party { flex: 1 1 0; min-width: 0; }
    .holo-invoice-party-label {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.7);
      text-transform: uppercase;
      margin-bottom: 5px;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: '', kicker, right })}
    <div class="holo-invoice-total">${escapeHtml(headline)}</div>
    ${partiesRow}
    <div class="holo-hairline"></div>
    <div class="holo-stack holo-stack--sm">
      ${lineRows}
      ${moreLine}
    </div>
    <div class="holo-hairline"></div>
    <div class="holo-stack holo-stack--sm">
      ${totalsRows.join('')}
    </div>
    <div class="holo-spacer"></div>
    ${dueLine}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('invoice_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

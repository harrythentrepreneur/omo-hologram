// payout_card — a single payout summary (bank deposit for settled charges).
// Sibling to email_card; same skeleton, different primitives.
//
// Data shape (all optional except `amount`):
//   {
//     amount,     currency: 'GBP' | 'USD',
//     status:     'paid' | 'pending' | 'in_transit' | 'failed',
//     date,       arrival_date,       // ISO strings
//     bank_last4, bank_name,
//     fees, net,                      // numbers, same unit as amount
//     reference,                      // payout id (e.g. "po_abc123")
//     source_txn_count                // number of charges this payout covers
//   }
//
// Pure text card — no ECharts, no runtime math. The inline script only
// signals __READY so the parent iframe can unmount its skeleton.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import {
  cardHeaderHTML, tagHTML, keyValueRowHTML, iconHTML,
} from './primitives.js';

// Money formatter. Intl gives us currency symbol + grouping for free; on
// any failure (unknown currency string, missing Intl in the runtime) we
// fall back to a USD-ish "$4,210.00" string so the UI never shows NaN.
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

// Format an ISO date as "APR 24" (or leave the raw string if unparseable).
function formatDate(raw) {
  if (!raw) return '';
  const s = String(raw);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

// Status → human label + tag tone. Unknown statuses fall through to muted.
function statusMeta(status) {
  const s = String(status || 'pending').toLowerCase();
  switch (s) {
    case 'paid':        return { label: 'PAID',        tone: 'cyan'  };
    case 'failed':      return { label: 'FAILED',      tone: 'pink'  };
    case 'in_transit':  return { label: 'IN TRANSIT',  tone: 'muted' };
    case 'pending':     return { label: 'PENDING',     tone: 'muted' };
    default:            return { label: s.toUpperCase(), tone: 'muted' };
  }
}

function coercePayout(data) {
  if (!data) return null;
  const amount = Number(data.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    amount,
    currency: String(data.currency || 'USD').toUpperCase(),
    status:   data.status || 'pending',
    date:         data.date || null,
    arrival_date: data.arrival_date || null,
    bank_last4: data.bank_last4 ? String(data.bank_last4).slice(-4) : null,
    bank_name:  data.bank_name || null,
    fees: Number.isFinite(Number(data.fees)) ? Number(data.fees) : null,
    net:  Number.isFinite(Number(data.net))  ? Number(data.net)  : null,
    reference: data.reference || null,
    source_txn_count: Number.isInteger(data.source_txn_count) ? data.source_txn_count : null,
  };
}

export function payoutCardTemplate({ dataset, intent }) {
  const p = coercePayout(dataset?.data);
  if (!p) {
    return { body: emptyStateBody(intent, 'Need a payout object with amount.'), exposedData: {}, needsEcharts: false };
  }

  titleText(intent, 'PAYOUT'); // reserved for future title override
  const kickerSuffix = p.date ? formatDate(p.date) : (p.reference || '');
  const kicker = kickerSuffix ? `PAYOUT · ${kickerSuffix}` : 'PAYOUT';
  const headline = fmtMoney(p.amount, p.currency);

  const meta = statusMeta(p.status);
  const right = tagHTML({ label: meta.label, tone: meta.tone });

  // Build body rows. Skip any row whose value is unknown rather than
  // showing "undefined" — every card must degrade gracefully.
  const rows = [];
  rows.push(keyValueRowHTML({ label: 'Status', value: meta.label, icon: 'bolt' }));
  if (p.net != null) {
    rows.push(keyValueRowHTML({ label: 'Net', value: fmtMoney(p.net, p.currency), icon: 'money' }));
  }
  if (p.fees != null) {
    rows.push(keyValueRowHTML({ label: 'Fees', value: fmtMoney(p.fees, p.currency), icon: 'tag' }));
  }
  if (p.bank_last4 || p.bank_name) {
    const bankBits = [];
    if (p.bank_last4) bankBits.push(`••••${p.bank_last4}`);
    if (p.bank_name)  bankBits.push(p.bank_name);
    rows.push(keyValueRowHTML({ label: 'Bank', value: bankBits.join(' · '), icon: 'file' }));
  }
  if (p.source_txn_count != null) {
    const noun = p.source_txn_count === 1 ? 'charge' : 'charges';
    rows.push(keyValueRowHTML({ label: 'Covers', value: `${p.source_txn_count} ${noun}`, icon: 'hashtag' }));
  }

  // Footer: only when arrival is in the future.
  let footer = '';
  if (p.arrival_date) {
    const d = new Date(p.arrival_date);
    if (Number.isFinite(d.getTime()) && d.getTime() > Date.now()) {
      footer = `<div class="holo-body holo-body--muted" style="font-size:11px;">
        ${iconHTML({ name: 'clock', inline: true })} Arriving ${escapeHtml(formatDate(p.arrival_date))}
      </div>`;
    }
  }

  const body = `<div id="viz">
  <style>
    .holo-payout-amount {
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 0.01em;
      line-height: 1.1;
      color: rgba(255, 255, 255, 0.98);
      background: linear-gradient(180deg, #ffffff 0%, #6ff2ff 75%, #00e5ff 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      text-shadow: 0 0 16px rgba(0, 229, 255, 0.3);
      font-variant-numeric: tabular-nums;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: '', kicker, right })}
    <div class="holo-payout-amount">${escapeHtml(headline)}</div>
    <div class="holo-stack holo-stack--sm">
      ${rows.join('')}
    </div>
    <div class="holo-spacer"></div>
    ${footer}
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('payout_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

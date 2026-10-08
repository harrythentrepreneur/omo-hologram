// Stripe → hologram projector.
//
// Subscribes to the Data Core event bus, filters for source:'stripe', and
// translates each relevant kind into a card that materialises inside
// Momo's hologram — with zero model round-trip. The pattern mirrors the
// render_viz id-referencing invariant: every structured payload lives in
// the dataset / projectable store, and broadcastProjection (or a direct
// emit for status cards) only carries ids.
//
// Wire once from server boot:
//   import { install as installStripeLive } from './projection/stripe_live.js';
//   const unsub = installStripeLive();
//
// Handled kinds:
//   charge_succeeded   →  receipt_card  (status: 'placed')
//   charge_refunded    →  receipt_card  (status: 'refunded', refunded: true)
//   payout_paid        →  payout_card
//   charge_failed      →  status card, variant: 'alert'
//   dispute_opened     →  status card, variant: 'alert'
//
// TODO: subscription_created / subscription_canceled — the current card
// templates (invoice/receipt/payout) don't map cleanly to a recurring
// plan delta. Revisit once a dedicated subscription_card lands.

import { randomUUID } from 'node:crypto';
import * as datasets from '../store/datasets.js';
import * as projectables from '../store/projectables.js';
import { subscribe, emit } from '../data_core.js';
import { broadcastProjection } from './broadcast.js';

// Stripe reports money in the smallest currency unit (cents / pence).
// The card templates expect whole units. Keep one coercion helper so a
// future currency with different subunit precision can be patched here.
function centsToMajor(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return num / 100;
}

// arrival_date on a Stripe payout is a Unix seconds timestamp; payout_card
// wants an ISO string (passes it through `new Date(...)`). Gracefully fall
// back to undefined when the source is missing rather than "Invalid Date".
function unixSecondsToIso(sec) {
  if (!Number.isFinite(Number(sec))) return null;
  const ms = Number(sec) * 1000;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

// Short HOLO-TITLE phrases. broadcastProjection caps numeric tokens on
// `intent` the same way render_viz does, so keep these verb-only — the
// concrete money lives in the dataset the data_refs point to.
function buildChargeIntent(kind) {
  if (kind === 'charge_refunded') return 'REFUND ISSUED';
  return 'NEW SALE';
}

// Receipt card dataset shape (see src/kitchen/templates/receipt_card.js).
// A single Stripe charge has no "items" array, so synthesise one line from
// the description / product so the card still looks like a proper receipt
// instead of just a total.
function buildReceiptDataset(event) {
  const d = event.data || {};
  const amount = centsToMajor(d.amount);
  if (amount == null) return null;
  // Force USD — Stripe revenue is always surfaced in USD across Omo, even
  // when the underlying account settles in AUD or another currency.
  const currency = 'USD';
  const product = d.product || 'Charge';
  const customerEmail = d.customer_email || null;
  const refunded = event.kind === 'charge_refunded';

  return {
    order_id: d.charge_id || event.id || null,
    placed: event.ts ? new Date(event.ts).toISOString() : new Date().toISOString(),
    customer: customerEmail
      ? { name: customerEmail.split('@')[0], email: customerEmail }
      : { name: 'customer', email: null },
    items: [{ label: product, qty: 1, price: amount }],
    subtotal: amount,
    shipping: null,
    tax: 0,
    total: amount,
    status: refunded ? 'refunded' : 'placed',
    currency,
    refunded,
    // Extras the template ignores today but keep them for future shapes.
    card_brand: d.card_brand || null,
    last4: d.last4 || null,
    charge_id: d.charge_id || null,
  };
}

// Payout card dataset shape (see src/kitchen/templates/payout_card.js).
function buildPayoutDataset(event) {
  const d = event.data || {};
  const amount = centsToMajor(d.amount);
  if (amount == null) return null;
  return {
    amount,
    currency: 'USD',
    status: 'paid', // kind is payout_paid, so it's paid by construction
    date: event.ts ? new Date(event.ts).toISOString() : new Date().toISOString(),
    arrival_date: unixSecondsToIso(d.arrival_date),
    // Stripe gives us a destination id (ba_... / card_...); the template
    // shows it under "Bank" if bank_name or bank_last4 are present. The
    // raw destination isn't either, so we surface it as bank_name so the
    // user at least sees *something* tied to the account.
    bank_name: d.destination || null,
    bank_last4: null,
    fees: null,
    net: null,
    reference: d.destination || null,
    source_txn_count: null,
  };
}

// ────────────────────────────────────────────────── alert status card
// Unlike chart projectables, status cards don't pass through the kitchen —
// they store a meta-only payload via projectables.put('status', ...) and
// are mounted client-side by the stage's kind-dispatch. We still need to
// emit a source:'projection', kind:'project' event so the browser's
// auto-project subscriber (public/auto-project.js) picks it up.
function broadcastAlertStatus({ title, detail, reason, ttlMs = 0 }) {
  const projectable_id = projectables.put('status', {
    meta: {
      title: String(title || '').slice(0, 32),
      detail: String(detail || '').slice(0, 96),
      variant: 'alert',
      ttl_ms: ttlMs > 0 ? ttlMs : undefined,
    },
  });

  emit({
    id: randomUUID(),
    ts: Date.now(),
    source: 'projection',
    kind: 'project',
    title: String(title || '').slice(0, 64),
    summary: reason || 'stripe alert',
    data: {
      projectable_kind: 'status',
      projectable_id,
      ttlMs,
      reason,
    },
  });

  return { ok: true, projectable_id };
}

// ────────────────────────────────────────────────── handlers

function formatMoneyShort(amountMajor, currency) {
  if (!Number.isFinite(amountMajor)) return '—';
  const cur = String(currency || 'USD').toUpperCase();
  const sym = cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : '';
  return `${sym}${amountMajor.toFixed(2)}${sym ? '' : ` ${cur}`}`;
}

async function handleCharge(event) {
  const data = buildReceiptDataset(event);
  if (!data) {
    console.warn('[projection/stripe] charge event missing amount, skipping', event.id);
    return;
  }
  const id = datasets.put('order_receipt', data);
  const intent = buildChargeIntent(event.kind);
  const moneyLabel = formatMoneyShort(data.total, data.currency);
  const reason = event.kind === 'charge_refunded'
    ? `stripe refund ${moneyLabel} · ${data.customer?.email || 'customer'}`
    : `stripe charge ${moneyLabel} · ${data.customer?.email || 'customer'}`;

  const res = await broadcastProjection({
    intent,
    data_refs: [id],
    chart_type: 'receipt_card',
    size: 'wide',
    reason,
    producer: 'projection',
  });
  if (!res.ok) {
    console.warn('[projection/stripe] broadcast failed:', res.error);
    return;
  }
  console.log(`[projection/stripe] projected ${event.kind} → receipt_card (${res.projectable_id}) · ${reason}`);
}

async function handlePayout(event) {
  const data = buildPayoutDataset(event);
  if (!data) {
    console.warn('[projection/stripe] payout event missing amount, skipping', event.id);
    return;
  }
  const id = datasets.put('stripe_payout', data);
  const moneyLabel = formatMoneyShort(data.amount, data.currency);
  const reason = `stripe payout ${moneyLabel}${data.arrival_date ? ` · arrives ${data.arrival_date.slice(0, 10)}` : ''}`;

  const res = await broadcastProjection({
    intent: 'PAYOUT PAID',
    data_refs: [id],
    chart_type: 'payout_card',
    size: 'wide',
    reason,
    producer: 'projection',
  });
  if (!res.ok) {
    console.warn('[projection/stripe] broadcast failed:', res.error);
    return;
  }
  console.log(`[projection/stripe] projected payout_paid → payout_card (${res.projectable_id}) · ${reason}`);
}

function handleChargeFailed(event) {
  const d = event.data || {};
  const amount = centsToMajor(d.amount);
  const moneyLabel = amount != null ? formatMoneyShort(amount, d.currency) : '';
  const customer = d.customer_email || 'customer';
  const detail = moneyLabel
    ? `${moneyLabel} · ${customer}`
    : customer;
  const reason = `stripe charge failed · ${detail}`;
  const res = broadcastAlertStatus({
    title: 'CHARGE FAILED',
    detail,
    reason,
    ttlMs: 0,
  });
  console.log(`[projection/stripe] projected charge_failed → status alert (${res.projectable_id}) · ${reason}`);
}

function handleDisputeOpened(event) {
  const d = event.data || {};
  const amount = centsToMajor(d.amount);
  const moneyLabel = amount != null ? formatMoneyShort(amount, d.currency) : '';
  const reasonText = d.reason ? String(d.reason).replace(/_/g, ' ') : 'reason unknown';
  const detail = moneyLabel ? `${moneyLabel} · ${reasonText}` : reasonText;
  const reason = `stripe dispute · ${detail}`;
  const res = broadcastAlertStatus({
    title: 'DISPUTE OPENED',
    detail,
    reason,
    ttlMs: 0,
  });
  console.log(`[projection/stripe] projected dispute_opened → status alert (${res.projectable_id}) · ${reason}`);
}

// ────────────────────────────────────────────────── install

/**
 * Subscribe to the Data Core bus and project Stripe cards into the holo.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeMocks=true]  If false, only react to
 *   events from the real Stripe connector (id prefixed `evt_` or
 *   `evt_synth_`). Useful when you want the demo quiet during a real
 *   investor call where the mock producer would spam cards.
 * @returns {() => void}  unsubscribe fn (idempotent)
 */
export function install({ includeMocks = true } = {}) {
  // Last seen event id — cheap re-entrancy guard. The bus won't deliver
  // the same event twice under normal conditions, but an upstream resend
  // or a malformed producer could, and the hot path must stay safe.
  let lastEventId = null;

  const onEvent = (event) => {
    try {
      if (!event || event.source !== 'stripe') return;
      if (event.id && event.id === lastEventId) return;
      // Backfilled events (re-pulled 24h history on every boot) still go
      // into the event ring for /hq, but we don't want to pop 10-20 cards
      // onto the hologram every time the server restarts. The connector
      // tags them with historical:true.
      if (event.historical) return;

      // If mocks are suppressed, only let events minted by the real
      // connector through. The mock Stripe producer uses randomUUID()
      // while the real connector always emits `evt_*` or `evt_synth_*`.
      if (!includeMocks) {
        const id = String(event.id || '');
        if (!id.startsWith('evt_')) return;
      }

      lastEventId = event.id || lastEventId;

      switch (event.kind) {
        case 'charge_succeeded':
        case 'charge_refunded':
          // fire-and-forget; handler owns its own error logging
          handleCharge(event).catch((err) => {
            console.warn('[projection/stripe] handleCharge threw:', err?.message || err);
          });
          return;

        case 'payout_paid':
          handlePayout(event).catch((err) => {
            console.warn('[projection/stripe] handlePayout threw:', err?.message || err);
          });
          return;

        case 'charge_failed':
          handleChargeFailed(event);
          return;

        case 'dispute_opened':
          handleDisputeOpened(event);
          return;

        case 'subscription_created':
        case 'subscription_canceled':
        case 'subscription_deleted':
          // TODO: needs a dedicated subscription_card template. Ignored
          // for now — the existing receipt/invoice shapes don't fit an
          // MRR delta without papering over the data.
          return;

        default:
          // Unhandled Stripe kind — not an error. Just not our lane.
          return;
      }
    } catch (err) {
      // Belt-and-braces: a throw here would kill the bus subscriber
      // loop (see dataCore.publish). Never let that happen.
      console.warn('[projection/stripe] onEvent crashed:', err?.message || err);
    }
  };

  const unsubscribe = subscribe(onEvent);
  console.log('[projection/stripe] installed · listening for stripe events');

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { unsubscribe(); } catch (_) {}
    console.log('[projection/stripe] uninstalled');
  };
}

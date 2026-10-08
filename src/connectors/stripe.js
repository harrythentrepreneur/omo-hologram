// Stripe read-only connector for the Omo Data Core.
//
// Two entry points:
//   start({ emit })                       — env-based boot (STRIPE_SECRET_KEY)
//   connect({ emit, key })                — runtime connect from /hq form
// Both validate the key, backfill the last 24h of charges, and start a
// 15s polling loop on /v1/events for a curated set of types. Events are
// translated into the Data Core event shape and emit()'d onto the shared
// bus (consumed by /hq and agents).
//
// Restricted Keys (rk_*) are recommended — only the resources we read
// need to be enabled. On auth errors (401/403) the poll loop stops so
// a bad key doesn't hammer Stripe forever.
//
// Public surface:
//   start({ emit })                → Promise<void>
//   connect({ emit, key })         → Promise<{ account, livemode, key_mask, ... }>
//   disconnect()                   → void
//   getStatus()                    → { connected, ... }
//   mountRoutes(app, { emit })     → registers /omo/api/integrations/stripe/*

import { randomUUID } from 'node:crypto';
import express from 'express';
import Stripe from 'stripe';
import * as integrationDb from '../store/integration_db.js';
import * as db from '../db.js';
import * as dataCore from '../data_core.js';

// How often to poll /v1/events for new deltas. 3 min by default —
// responsive enough to catch new charges quickly without hammering
// Stripe. Override with STRIPE_POLL_MS.
const POLL_INTERVAL_MS = parseInt(process.env.STRIPE_POLL_MS, 10) || 180_000;
// How often to re-run the deep backfill to sync everything (customer
// edits, subscription status drift, invoice changes, etc.). 6h default.
// Override with STRIPE_RESYNC_MS.
const DEEP_RESYNC_MS = parseInt(process.env.STRIPE_RESYNC_MS, 10) || 21_600_000;
const BACKFILL_HOURS = 24;
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const SEEN_CAP = 1000;

// Event types the poll loop subscribes to. Includes non-charge deltas
// (customer/sub/invoice edits, payouts, disputes, price edits) so the
// DB stays reasonably fresh between deep resyncs.
// Stripe's events.list caps `types` at 20 per their docs, but in practice
// this account rejects the 20-item list with "You may only specify up to
// '20' values in the 'types' parameter." so we ship 19. Pruned from the
// full wishlist to preserve everything the connector actually acts on
// (mapStripeEvent) plus the high-signal persistence kinds (persistObject).
// Dropped: customer.deleted, invoice.voided, customer.dispute.closed,
// price.updated, product.updated, product.created — all rare and covered
// well enough by the remaining lifecycle events. (Products still backfill
// during the deep resync.)
const POLL_TYPES = [
  'charge.succeeded',
  'charge.failed',
  'charge.refunded',
  'charge.updated',
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'customer.dispute.created',
  'customer.dispute.updated',
  'price.created',
];

// Module-scope runtime so connect/disconnect/getStatus can toggle the
// connector at runtime (driven by /hq). Null when not connected.
let runtime = null;

// /summary response cache. The endpoint runs ~5 Postgres queries
// (charges last 31d, subscriptions+invoices join for MRR/ARR, payouts,
// recent charges with customer joins, plans+top customers in parallel),
// then aggregates 6000+ charges synchronously to build daily_30d /
// spark_7d / spark_30d. Realistic cost: 150–300ms steady-state, much
// worse when the connector pool is busy persisting a backfill chunk.
//
// 30s TTL collapses the duplicate work the HQ panel does on focus +
// every 30s poll. invalidateStripeSummary() is called from deepBackfill
// so a freshly persisted batch shows up on the next request.
let _stripeSummaryCache = { at: 0, body: null };
const STRIPE_SUMMARY_CACHE_TTL_MS = 30_000;
function invalidateStripeSummary() { _stripeSummaryCache = { at: 0, body: null }; }

// ──────────────────────────────────────────────────────── helpers

function maskKey(key) {
  if (!key) return '';
  return `${key.slice(0, 8)}...`;
}

// Revenue is always surfaced in USD — the connector ignores the account's
// actual settlement currency (e.g. AUD) and renders the raw minor-unit
// amount with a "$" prefix. No FX conversion is applied.
function formatMoney(amount) {
  if (typeof amount !== 'number') return '$0.00';
  return `$${(amount / 100).toFixed(2)}`;
}

function intervalToMonths(interval, count = 1) {
  const c = Math.max(1, count | 0);
  switch (interval) {
    case 'day':   return c / 30;
    case 'week':  return c / 4.345;
    case 'month': return c;
    case 'year':  return c * 12;
    default:      return c;
  }
}

function mapStripeEvent(event) {
  const ts = (event.created || Math.floor(Date.now() / 1000)) * 1000;
  const id = event.id || randomUUID();

  switch (event.type) {
    case 'charge.succeeded':
    case 'charge.failed':
    case 'charge.refunded': {
      const c = event.data?.object || {};
      const kind =
        event.type === 'charge.succeeded' ? 'charge_succeeded' :
        event.type === 'charge.failed'    ? 'charge_failed'    :
                                            'charge_refunded';
      const customer_email = c.billing_details?.email || c.receipt_email || null;
      const customer_name = c.billing_details?.name || null;
      const product = c.description || c.statement_descriptor || 'Charge';
      // Prefer the settled amount (account currency, post-FX) when the
      // balance_transaction was expanded; otherwise fall back to the raw
      // charge amount. /hq's charge list uses this so AUD charges show
      // the USD amount that actually hit the account.
      const bt = (c.balance_transaction && typeof c.balance_transaction === 'object') ? c.balance_transaction : null;
      const amountUsd = bt && typeof bt.amount === 'number' ? bt.amount : c.amount;
      return {
        id,
        source: 'stripe',
        kind,
        ts,
        title: `${formatMoney(amountUsd)} · ${product}`,
        summary: `${customer_name || customer_email || 'customer'} · ${c.status || kind}`,
        data: {
          amount: amountUsd,
          amount_original: c.amount,
          currency_original: c.currency,
          currency: 'usd',
          status: c.status,
          customer_email,
          customer_name,
          product,
          card_brand: c.payment_method_details?.card?.brand,
          last4: c.payment_method_details?.card?.last4,
          charge_id: c.id,
        },
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.deleted': {
      const s = event.data?.object || {};
      const item = s.items?.data?.[0] || {};
      const price = item.price || {};
      const plan = price.nickname || price.id || 'subscription';
      const interval = price.recurring?.interval || 'month';
      const intervalCount = price.recurring?.interval_count || 1;
      const months = intervalToMonths(interval, intervalCount);
      const unitAmount = price.unit_amount || 0;
      const qty = item.quantity || 1;
      const monthlyCents = months > 0 ? Math.round((unitAmount * qty) / months) : 0;
      const created = event.type === 'customer.subscription.created';
      return {
        id,
        source: 'stripe',
        kind: created ? 'subscription_created' : 'subscription_canceled',
        ts,
        title: `${created ? 'New sub' : 'Sub canceled'} · ${plan}`,
        summary: `${s.customer || 'customer'} · ${formatMoney(unitAmount * qty)}/${interval}`,
        data: {
          customer: s.customer,
          plan,
          interval,
          mrr_delta: created ? monthlyCents : -monthlyCents,
          subscription_id: s.id,
          currency: 'usd',
        },
      };
    }

    case 'payout.paid': {
      const p = event.data?.object || {};
      return {
        id,
        source: 'stripe',
        kind: 'payout_paid',
        ts,
        title: `Payout · ${formatMoney(p.amount)}`,
        summary: `arrives ${p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : 'soon'}`,
        data: {
          amount: p.amount,
          currency: 'usd',
          arrival_date: p.arrival_date,
          destination: p.destination,
        },
      };
    }

    case 'customer.dispute.created': {
      const d = event.data?.object || {};
      return {
        id,
        source: 'stripe',
        kind: 'dispute_opened',
        ts,
        title: `Dispute · ${formatMoney(d.amount)}`,
        summary: `${d.reason || 'reason unknown'}${d.charge ? ` · ${d.charge}` : ''}`,
        data: {
          amount: d.amount,
          reason: d.reason,
          charge: d.charge,
          currency: 'usd',
        },
      };
    }

    default:
      return null;
  }
}

function chargeToSyntheticEvent(charge) {
  let type = 'charge.succeeded';
  if (charge.refunded || (charge.amount_refunded && charge.amount_refunded > 0)) {
    type = 'charge.refunded';
  } else if (charge.status === 'failed') {
    type = 'charge.failed';
  } else if (charge.status !== 'succeeded') {
    return null;
  }
  return {
    id: `evt_synth_${charge.id}`,
    type,
    created: charge.created,
    data: { object: charge },
  };
}

function accountDisplayName(account) {
  return (
    account?.business_profile?.name ||
    account?.settings?.dashboard?.display_name ||
    account?.email ||
    null
  );
}

function isAuthError(err) {
  const status = err?.statusCode || err?.raw?.statusCode;
  return status === 401 || status === 403;
}

// Money with currency code for plaintext (keeps the unified $ prefix per
// formatMoney's rule, but appends the true currency for LLM context).
function fmtMoneyCur(amount, currency) {
  const base = formatMoney(amount);
  const cur = (currency || '').toUpperCase();
  return cur && cur !== 'USD' ? `${base} ${cur}` : base;
}

function fmtTs(unixSec) {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

// ──────────────────────────────────────────────────────── plaintext renderers
// Each returns { plaintext, title, summary }. The plaintext block is what
// the /plaintext endpoint concatenates into an LLM-feedable dump.

function renderCharge(c) {
  const amount = fmtMoneyCur(c.amount, c.currency);
  const email = c.billing_details?.email || c.receipt_email || '—';
  const name = c.billing_details?.name || '';
  const card = c.payment_method_details?.card;
  const cardStr = card ? `${card.brand} ****${card.last4}${card.country ? ' · ' + card.country : ''}${card.funding ? ' · ' + card.funding : ''}` : '—';
  const riskStr = c.outcome?.risk_level ? `risk=${c.outcome.risk_level}` : '';
  const declineStr = c.failure_code ? `failure=${c.failure_code}${c.failure_message ? ' (' + c.failure_message + ')' : ''}` : '';
  const desc = c.description || c.statement_descriptor || '';
  const lines = [
    `[${c.id}] ${fmtTs(c.created)} · ${amount} · ${c.status}${c.refunded ? ' · REFUNDED' : ''}`,
    `  customer: ${email}${name ? ' (' + name + ')' : ''}${c.customer ? ' · ' + c.customer : ''}`,
    `  card: ${cardStr}`,
  ];
  if (desc) lines.push(`  description: ${desc}`);
  if (riskStr || declineStr) lines.push(`  ${[riskStr, declineStr].filter(Boolean).join(' · ')}`);
  if (c.metadata && Object.keys(c.metadata).length) lines.push(`  metadata: ${JSON.stringify(c.metadata)}`);
  return {
    plaintext: lines.join('\n'),
    title: `${amount} · ${desc || 'Charge'}`,
    summary: `${email} · ${c.status}`,
  };
}

function renderCustomer(c) {
  const email = c.email || '—';
  const name = c.name || '';
  const country = c.address?.country || c.shipping?.address?.country || '';
  const balance = c.balance || 0;
  const currency = (c.currency || 'usd').toUpperCase();
  const phone = c.phone || '';
  const lines = [
    `[${c.id}] ${name ? name + ' ' : ''}<${email}>`,
    `  created: ${fmtTs(c.created)} · currency: ${currency}${country ? ' · country: ' + country : ''}${phone ? ' · phone: ' + phone : ''}`,
    `  balance: ${fmtMoneyCur(balance, c.currency || 'usd')} · delinquent: ${c.delinquent ? 'yes' : 'no'}`,
  ];
  if (c.description) lines.push(`  description: ${c.description}`);
  if (c.metadata && Object.keys(c.metadata).length) lines.push(`  metadata: ${JSON.stringify(c.metadata)}`);
  return {
    plaintext: lines.join('\n'),
    title: name || email,
    summary: `balance ${fmtMoneyCur(balance, c.currency || 'usd')}`,
  };
}

function renderSubscription(s) {
  const item = s.items?.data?.[0];
  const price = item?.price;
  const planName = price?.nickname || (typeof price?.product === 'object' ? price?.product?.name : null) || price?.id || 'plan';
  const interval = price?.recurring?.interval || 'month';
  const intervalCount = price?.recurring?.interval_count || 1;
  const unit = price?.unit_amount || 0;
  const qty = item?.quantity || 1;
  const currency = price?.currency || s.currency || 'usd';
  const mrrCents = Math.round((unit * qty) / intervalToMonths(interval, intervalCount));
  const lines = [
    `[${s.id}] ${s.status} · ${planName}`,
    `  customer: ${s.customer}`,
    `  ${fmtMoneyCur(unit * qty, currency)} / ${intervalCount > 1 ? intervalCount + ' ' : ''}${interval}${intervalCount > 1 ? 's' : ''} · MRR ≈ ${fmtMoneyCur(mrrCents, currency)}`,
    `  started: ${fmtTs(s.start_date || s.created)}` +
      (s.current_period_end ? ` · next_invoice: ${fmtTs(s.current_period_end)}` : '') +
      (s.trial_end ? ` · trial_end: ${fmtTs(s.trial_end)}` : '') +
      (s.cancel_at_period_end ? ' · cancel_at_period_end: YES' : '') +
      (s.canceled_at ? ` · canceled: ${fmtTs(s.canceled_at)}` : ''),
  ];
  if (s.metadata && Object.keys(s.metadata).length) lines.push(`  metadata: ${JSON.stringify(s.metadata)}`);
  return {
    plaintext: lines.join('\n'),
    title: `${planName} · ${s.status}`,
    summary: `${s.customer} · MRR ${fmtMoneyCur(mrrCents, currency)}`,
  };
}

function renderInvoice(i) {
  const lines = [
    `[${i.id}] ${fmtTs(i.created)} · ${fmtMoneyCur(i.amount_due, i.currency)} · ${i.status}`,
    `  customer: ${i.customer_email || i.customer_name || i.customer}`,
    `  paid: ${fmtMoneyCur(i.amount_paid, i.currency)}${i.amount_remaining ? ' · remaining: ' + fmtMoneyCur(i.amount_remaining, i.currency) : ''}`,
  ];
  if (i.number) lines.push(`  number: ${i.number}${i.hosted_invoice_url ? ' · url: ' + i.hosted_invoice_url : ''}`);
  if (i.description) lines.push(`  description: ${i.description}`);
  return {
    plaintext: lines.join('\n'),
    title: `Invoice ${i.number || i.id} · ${fmtMoneyCur(i.amount_due, i.currency)}`,
    summary: i.customer_email || i.customer || '—',
  };
}

function renderPayout(p) {
  const arrival = p.arrival_date ? fmtTs(p.arrival_date) : '—';
  const lines = [
    `[${p.id}] ${fmtTs(p.created)} · ${fmtMoneyCur(p.amount, p.currency)} · ${p.status}`,
    `  arrives: ${arrival} · method: ${p.method || '—'} · type: ${p.type || '—'}${p.destination ? ' · dest: ' + p.destination : ''}`,
  ];
  if (p.description) lines.push(`  description: ${p.description}`);
  return {
    plaintext: lines.join('\n'),
    title: `Payout · ${fmtMoneyCur(p.amount, p.currency)}`,
    summary: `${p.status} · arrives ${arrival}`,
  };
}

function renderProduct(pr) {
  const lines = [
    `[${pr.id}] ${pr.name || '(unnamed)'}${pr.active ? '' : ' · INACTIVE'}`,
    `  created: ${fmtTs(pr.created)}${pr.updated ? ' · updated: ' + fmtTs(pr.updated) : ''}`,
  ];
  if (pr.description) lines.push(`  description: ${pr.description}`);
  if (pr.metadata && Object.keys(pr.metadata).length) lines.push(`  metadata: ${JSON.stringify(pr.metadata)}`);
  return {
    plaintext: lines.join('\n'),
    title: pr.name || pr.id,
    summary: pr.active ? 'active' : 'inactive',
  };
}

function renderPrice(pr) {
  const recurring = pr.recurring ? `recurring ${pr.recurring.interval_count || 1}${pr.recurring.interval[0]}` : 'one-time';
  const amt = pr.unit_amount != null ? fmtMoneyCur(pr.unit_amount, pr.currency) : '(custom)';
  const lines = [
    `[${pr.id}] ${pr.nickname || ''} · ${amt} · ${recurring}${pr.active ? '' : ' · INACTIVE'}`,
    `  product: ${pr.product || '—'}${pr.lookup_key ? ' · lookup: ' + pr.lookup_key : ''}`,
  ];
  return {
    plaintext: lines.join('\n'),
    title: `${pr.nickname || pr.id} · ${amt}`,
    summary: recurring,
  };
}

function renderDispute(d) {
  const lines = [
    `[${d.id}] ${fmtTs(d.created)} · ${fmtMoneyCur(d.amount, d.currency)} · ${d.status}`,
    `  reason: ${d.reason} · charge: ${d.charge || '—'}`,
    `  evidence_due: ${d.evidence_details?.due_by ? fmtTs(d.evidence_details.due_by) : '—'}${d.is_charge_refundable ? '' : ' · NON-REFUNDABLE'}`,
  ];
  return {
    plaintext: lines.join('\n'),
    title: `Dispute · ${fmtMoneyCur(d.amount, d.currency)}`,
    summary: `${d.reason} · ${d.status}`,
  };
}

function renderAccount(a) {
  const cap = a.capabilities ? Object.entries(a.capabilities).map(([k, v]) => `${k}=${v}`).join(', ') : '—';
  const lines = [
    `[${a.id}] ${accountDisplayName(a) || '(account)'}`,
    `  country: ${a.country || '—'} · currency: ${(a.default_currency || 'usd').toUpperCase()} · timezone: ${a.settings?.dashboard?.timezone || '—'}`,
    `  type: ${a.type || '—'} · email: ${a.email || '—'} · charges_enabled: ${a.charges_enabled} · payouts_enabled: ${a.payouts_enabled}`,
    `  business: ${a.business_profile?.name || '—'}${a.business_profile?.url ? ' · url: ' + a.business_profile.url : ''}`,
    `  capabilities: ${cap}`,
  ];
  return {
    plaintext: lines.join('\n'),
    title: accountDisplayName(a) || a.id,
    summary: `${a.country || ''} · ${(a.default_currency || '').toUpperCase()}`,
  };
}

function renderBalance(bal) {
  const part = (arr) => (arr || []).map((b) => fmtMoneyCur(b.amount, b.currency)).join(', ') || '—';
  return {
    plaintext: [
      `[balance] as of ${new Date().toISOString().slice(0, 19)}Z`,
      `  available: ${part(bal.available)}`,
      `  pending:   ${part(bal.pending)}`,
      `  connect_reserved: ${part(bal.connect_reserved)}`,
    ].join('\n'),
    title: 'balance',
    summary: `available ${part(bal.available)}`,
  };
}

// ──────────────────────────────────────────────────────── deep backfill

async function pullList(listFn, { limit = 500 } = {}) {
  const out = [];
  let startingAfter;
  const pages = Math.ceil(limit / 100);
  for (let page = 0; page < pages; page++) {
    const params = { limit: Math.min(100, limit - out.length) };
    if (startingAfter) params.starting_after = startingAfter;
    const res = await listFn(params);
    const items = res.data || [];
    out.push(...items);
    if (!res.has_more || items.length === 0) break;
    startingAfter = items[items.length - 1].id;
    if (out.length >= limit) break;
  }
  return out;
}

async function deepBackfill(rt) {
  if (!rt || rt.stopped) return;

  // Account + balance — single reads.
  try {
    const accountRow = {
      source: 'stripe', kind: 'account', external_id: rt.account.id,
      ts: new Date((rt.account.created || Math.floor(Date.now() / 1000)) * 1000),
      data: rt.account, ...renderAccount(rt.account),
    };
    const balance = await rt.stripe.balance.retrieve();
    const balanceRow = {
      source: 'stripe', kind: 'balance', external_id: `${rt.account.id}:balance`,
      ts: new Date(), data: balance, ...renderBalance(balance),
    };
    await integrationDb.upsertMany([accountRow, balanceRow]);
  } catch (err) { logErrorThrottled(rt, 'account/balance persist failed', err); }

  const sections = [
    { kind: 'customer',     listFn: (p) => rt.stripe.customers.list(p),                                   limit: 1000, render: renderCustomer },
    { kind: 'subscription', listFn: (p) => rt.stripe.subscriptions.list({ ...p, status: 'all' }),          limit: 500,  render: renderSubscription },
    { kind: 'invoice',      listFn: (p) => rt.stripe.invoices.list(p),                                     limit: 500,  render: renderInvoice },
    // Pull last 60 days of charges so /summary's 7d and 30d windows
    // have full coverage. STRIPE_CHARGE_BACKFILL_DAYS overrides the
    // window; limit is sized for a busy account (~100 charges/day).
    // balance_transaction is expanded so we have the FX-converted
    // amount in the account's settlement currency for accurate revenue
    // totals that match Stripe's dashboard.
    { kind: 'charge',
      listFn: (p) => {
        const days = parseInt(process.env.STRIPE_CHARGE_BACKFILL_DAYS, 10) || 60;
        const since = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
        return rt.stripe.charges.list({
          ...p,
          created: { gte: since },
          expand: ['data.balance_transaction'],
        });
      },
      limit: 6000, render: renderCharge },
    { kind: 'payout',       listFn: (p) => rt.stripe.payouts.list(p),                                      limit: 200,  render: renderPayout },
    { kind: 'product',      listFn: (p) => rt.stripe.products.list(p),                                     limit: 500,  render: renderProduct },
    { kind: 'price',        listFn: (p) => rt.stripe.prices.list(p),                                       limit: 500,  render: renderPrice },
    { kind: 'dispute',      listFn: (p) => rt.stripe.disputes.list(p),                                     limit: 200,  render: renderDispute },
  ];

  for (const sec of sections) {
    if (rt.stopped) return;
    try {
      const items = await pullList(sec.listFn, { limit: sec.limit });
      const rows = items.map((it) => ({
        source: 'stripe', kind: sec.kind, external_id: it.id,
        ts: new Date((it.created || Math.floor(Date.now() / 1000)) * 1000),
        data: it, ...sec.render(it),
      }));
      const n = await integrationDb.upsertMany(rows);
      rt.persisted[sec.kind] = n;
      console.log(`[stripe] persisted ${n} ${sec.kind}(s)`);
    } catch (err) {
      if (isAuthError(err)) { disconnect(); return; }
      logErrorThrottled(rt, `${sec.kind} pull failed`, err);
    }
  }

  rt.deepBackfillDoneAt = Date.now();
  invalidateStripeSummary();
  console.log('[stripe] deep backfill complete');
}

// Resolve the customer's display name from the DB. billing_details.name
// on a charge is often null for subscription renewals — the reliable
// source is the customer.name field on the customer record. Cached in
// memory for the process lifetime.
const customerNameCache = new Map();
async function resolveCustomerName(customerId) {
  if (!customerId) return null;
  if (customerNameCache.has(customerId)) return customerNameCache.get(customerId);
  try {
    const q = db.sql();
    if (!db.isConfigured()) return null;
    const rows = await q`
      SELECT data->>'name' AS name, data->>'email' AS email
      FROM integration_data
      WHERE source = 'stripe' AND kind = 'customer' AND external_id = ${customerId}
      LIMIT 1
    `;
    const row = rows?.[0];
    const name = row?.name || null;
    customerNameCache.set(customerId, name);
    return name;
  } catch { return null; }
}

// Enrich a mapped charge event in-place with customer_name resolved
// from the customer DB row (so /hq shows "Leanne Hunt" not "leanne.hunt").
async function enrichChargeEventWithCustomerName(ev, charge) {
  if (!ev?.data) return;
  if (ev.data.customer_name) return;
  const cid = charge?.customer;
  const name = await resolveCustomerName(cid);
  if (name) {
    ev.data.customer_name = name;
    // Also swap the summary prefix so the WS log ticker reads nicely.
    const email = ev.data.customer_email || 'customer';
    if (typeof ev.summary === 'string' && ev.summary.startsWith(email)) {
      ev.summary = ev.summary.replace(email, name);
    }
  }
}

async function persistCharge(charge) {
  if (!charge?.id) return;
  try {
    await integrationDb.upsertMany([{
      source: 'stripe', kind: 'charge', external_id: charge.id,
      ts: new Date((charge.created || Math.floor(Date.now() / 1000)) * 1000),
      data: charge, ...renderCharge(charge),
    }]);
  } catch { /* swallow — poll loop should keep running */ }
}

// Persist any object that came in on an event.data.object. Dispatches on
// obj.object ("customer", "subscription", "invoice", etc.) and no-ops for
// kinds we don't render. Fire-and-forget — never throw into the poll loop.
async function persistObject(obj) {
  if (!obj || !obj.id || !obj.object) return;
  try {
    const ts = new Date((obj.created || Math.floor(Date.now() / 1000)) * 1000);
    let row;
    switch (obj.object) {
      case 'charge':        row = { kind: 'charge',        ...renderCharge(obj) }; break;
      case 'customer':      row = { kind: 'customer',      ...renderCustomer(obj) }; break;
      case 'subscription':  row = { kind: 'subscription',  ...renderSubscription(obj) }; break;
      case 'invoice':       row = { kind: 'invoice',       ...renderInvoice(obj) }; break;
      case 'payout':        row = { kind: 'payout',        ...renderPayout(obj) }; break;
      case 'product':       row = { kind: 'product',       ...renderProduct(obj) }; break;
      case 'price':         row = { kind: 'price',         ...renderPrice(obj) }; break;
      case 'dispute':       row = { kind: 'dispute',       ...renderDispute(obj) }; break;
      default: return;
    }
    await integrationDb.upsertMany([{
      source: 'stripe', external_id: obj.id, ts, data: obj, ...row,
    }]);
  } catch { /* swallow */ }
}

// ──────────────────────────────────────────────────────── connect / disconnect

// Validate the key against /v1/account and stand up the polling loop.
// Returns the current status (also available via getStatus()).
export async function connect({ emit, key }) {
  if (runtime) disconnect();
  if (!key) throw new Error('Stripe key required');

  const stripe = new Stripe(key);
  const account = await stripe.accounts.retrieve(); // throws on bad key

  const seenEventIds = new Set();
  const seenOrder = [];

  runtime = {
    stripe,
    emit,
    account,
    keyMask: maskKey(key),
    livemode: key.startsWith('sk_live_') || key.startsWith('rk_live_'),
    connectedAt: Date.now(),
    lastEventTs: Math.floor((Date.now() - BACKFILL_HOURS * 60 * 60 * 1000) / 1000),
    lastSeenEventId: null,
    lastErrorLogAt: 0,
    stopped: false,
    pollTimer: null,
    resyncTimer: null,
    seenEventIds,
    seenOrder,
    backfilled: 0,
    eventCount: 0,
    persisted: {},            // per-kind DB counts from last deepBackfill
    deepBackfillDoneAt: null, // set when each deep pull completes
    lastPollAt: null,         // ms timestamp of last successful poll
    pollIntervalMs: POLL_INTERVAL_MS,
    resyncIntervalMs: DEEP_RESYNC_MS,
  };

  console.log(`[stripe] connected · ${runtime.livemode ? 'livemode' : 'testmode'} · acct ${account.id} · key ${runtime.keyMask} · poll=${Math.round(POLL_INTERVAL_MS/1000)}s · resync=${Math.round(DEEP_RESYNC_MS/1000/60)}min`);

  if (typeof dataCore.markSourceLive === 'function') dataCore.markSourceLive('stripe');

  // Fire-and-forget: charge backfill + deep backfill run in parallel in
  // the background; the caller gets a response as soon as the key is
  // validated.
  runBackfill(runtime).catch((err) => {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(runtime, 'backfill failed', err);
  });
  deepBackfill(runtime).catch((err) => {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(runtime, 'deep backfill failed', err);
  });

  // Schedule the poll loop.
  runtime.pollTimer = setTimeout(() => tick(runtime), POLL_INTERVAL_MS);
  runtime.pollTimer?.unref?.();

  // Schedule periodic deep resyncs on top of the poll — catches drift
  // on fields the event stream doesn't broadcast.
  runtime.resyncTimer = setInterval(() => {
    const rt = runtime;
    if (!rt || rt.stopped) return;
    rt.persisted = {};
    rt.deepBackfillDoneAt = null;
    console.log('[stripe] scheduled deep resync starting');
    deepBackfill(rt).catch((err) => {
      if (isAuthError(err)) { disconnect(); return; }
      logErrorThrottled(rt, 'scheduled resync failed', err);
    });
  }, DEEP_RESYNC_MS);
  runtime.resyncTimer?.unref?.();

  return getStatus();
}

export function disconnect() {
  if (!runtime) return;
  runtime.stopped = true;
  if (runtime.pollTimer) clearTimeout(runtime.pollTimer);
  if (runtime.resyncTimer) clearInterval(runtime.resyncTimer);
  console.log('[stripe] disconnected');
  runtime = null;
}

export function getStatus() {
  if (!runtime) return { connected: false };
  return {
    connected: true,
    livemode: runtime.livemode,
    account_id: runtime.account?.id,
    account_name: accountDisplayName(runtime.account),
    country: runtime.account?.country,
    key_mask: runtime.keyMask,
    connected_at: runtime.connectedAt,
    last_event_ts: runtime.lastEventTs,
    backfilled: runtime.backfilled,
    event_count: runtime.eventCount,
    persisted: runtime.persisted || {},
    deep_backfill_done_at: runtime.deepBackfillDoneAt,
    last_poll_at: runtime.lastPollAt,
    poll_interval_ms: runtime.pollIntervalMs,
    resync_interval_ms: runtime.resyncIntervalMs,
  };
}

// ──────────────────────────────────────────────────────── internal loop

function rememberSeen(rt, id) {
  if (!id || rt.seenEventIds.has(id)) return false;
  rt.seenEventIds.add(id);
  rt.seenOrder.push(id);
  while (rt.seenOrder.length > SEEN_CAP) {
    const evicted = rt.seenOrder.shift();
    if (evicted) rt.seenEventIds.delete(evicted);
  }
  return true;
}

function logErrorThrottled(rt, label, err) {
  const now = Date.now();
  if (now - rt.lastErrorLogAt < 60_000) return;
  rt.lastErrorLogAt = now;
  console.error(`[stripe] ${label}:`, err?.message || err);
}

async function runBackfill(rt) {
  const sinceSec = Math.floor((Date.now() - BACKFILL_HOURS * 60 * 60 * 1000) / 1000);
  const collected = [];
  let startingAfter;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = {
      created: { gte: sinceSec },
      limit: PAGE_LIMIT,
      // Expand balance_transaction so amounts emit in the account's
      // settlement currency (USD) rather than the charge currency.
      expand: ['data.payment_method_details', 'data.balance_transaction'],
    };
    if (startingAfter) params.starting_after = startingAfter;
    const res = await rt.stripe.charges.list(params);
    const items = res.data || [];
    collected.push(...items);
    if (!res.has_more || items.length === 0) break;
    startingAfter = items[items.length - 1].id;
  }
  // oldest first so the ring stays sane
  collected.reverse();
  for (const charge of collected) {
    const synthetic = chargeToSyntheticEvent(charge);
    if (!synthetic) continue;
    const ev = mapStripeEvent(synthetic);
    if (!ev) continue;
    if (!rememberSeen(rt, synthetic.id)) continue;
    await enrichChargeEventWithCustomerName(ev, charge);
    // historical: true tells the projection layer not to pop a card on
    // the hologram for this event. It still lands in the event ring +
    // /hq log, but the stage stays quiet on boot.
    ev.historical = true;
    rt.emit(ev);
    rt.backfilled++;
    rt.eventCount++;
    persistCharge(charge); // async, fire-and-forget
  }
  console.log(`[stripe] backfilled ${rt.backfilled} charge event(s) from last ${BACKFILL_HOURS}h`);
}

async function tick(rt) {
  if (!runtime || runtime !== rt || rt.stopped) return;
  try {
    let startingAfter;
    let newestTs = rt.lastEventTs;
    let newestId = rt.lastSeenEventId;
    const fresh = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = {
        created: { gt: rt.lastEventTs },
        limit: PAGE_LIMIT,
        types: POLL_TYPES,
      };
      if (startingAfter) params.starting_after = startingAfter;
      const res = await rt.stripe.events.list(params);
      const items = res.data || [];
      for (const ev of items) fresh.push(ev);
      if (!res.has_more || items.length === 0) break;
      startingAfter = items[items.length - 1].id;
    }
    fresh.reverse();
    for (const event of fresh) {
      if (event.id === rt.lastSeenEventId) continue;
      if (!rememberSeen(rt, event.id)) continue;
      // For charge events, re-fetch the charge with the balance_transaction
      // expanded so downstream consumers see USD-settled amounts and the
      // persisted row carries FX-converted totals. Cheap (one call per
      // charge event) and avoids a stale sidecar lookup later.
      if (event.type?.startsWith('charge.')) {
        const chargeId = event.data?.object?.id;
        if (chargeId) {
          try {
            const full = await rt.stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
            event.data = event.data || {};
            event.data.object = full;
          } catch { /* fall through with non-expanded object */ }
        }
      }
      const mapped = mapStripeEvent(event);
      if (mapped) {
        if (event.type?.startsWith('charge.')) {
          await enrichChargeEventWithCustomerName(mapped, event.data?.object);
        }
        rt.emit(mapped);
        rt.eventCount++;
      }
      // Persist the underlying object for any type we render.
      persistObject(event.data?.object);
      if ((event.created || 0) > newestTs) {
        newestTs = event.created;
        newestId = event.id;
      }
    }
    rt.lastEventTs = newestTs;
    rt.lastSeenEventId = newestId;
    rt.lastPollAt = Date.now();
  } catch (err) {
    if (isAuthError(err)) {
      console.error(`[stripe] auth error (${err.statusCode}): ${err.message}. Stopping poll loop.`);
      disconnect();
      return;
    }
    logErrorThrottled(rt, 'poll failed', err);
  } finally {
    if (runtime === rt && !rt.stopped) {
      rt.pollTimer = setTimeout(() => tick(rt), POLL_INTERVAL_MS);
      rt.pollTimer?.unref?.();
    }
  }
}

// ──────────────────────────────────────────────────────── env-based boot

export async function start({ emit }) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log('[stripe] skipped (no STRIPE_SECRET_KEY)');
    return;
  }
  try {
    await connect({ emit, key });
  } catch (err) {
    console.error('[stripe] start failed:', err?.message || err);
  }
}

// ──────────────────────────────────────────────────────── routes

export function mountRoutes(app, { emit }) {
  app.get('/omo/api/integrations/stripe/status', (_req, res) => {
    res.json(getStatus());
  });

  app.post('/omo/api/integrations/stripe/connect', express.json(), async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
      return res.status(400).json({ ok: false, error: 'Key must look like sk_test_..., sk_live_..., rk_test_..., or rk_live_...' });
    }
    try {
      const status = await connect({ emit, key });
      res.json({ ok: true, status });
    } catch (err) {
      const code = err?.statusCode || err?.raw?.statusCode || 500;
      const msg = err?.raw?.message || err?.message || String(err);
      res.status(code >= 400 && code < 500 ? 400 : 500).json({ ok: false, error: msg });
    }
  });

  app.post('/omo/api/integrations/stripe/disconnect', (_req, res) => {
    disconnect();
    res.json({ ok: true });
  });

  // Manually kick a deep backfill. If `?prune=1`, delete all existing
  // stripe rows in integration_data first so the result is a fresh pull.
  // If `?wait=1`, block until the pull finishes (can take 30-120s).
  app.post('/omo/api/integrations/stripe/backfill', async (req, res) => {
    if (!runtime) return res.status(409).json({ ok: false, error: 'Not connected — connect first.' });
    const rt = runtime;
    const prune = req.query.prune === '1' || req.query.prune === 'true';
    const waitForDone = req.query.wait === '1' || req.query.wait === 'true';
    try {
      if (prune) {
        const n = await integrationDb.pruneSource('stripe');
        console.log(`[stripe] pruned ${n} existing row(s) before backfill`);
      }
      rt.persisted = {};
      rt.deepBackfillDoneAt = null;
      const p = deepBackfill(rt).catch((err) => {
        if (isAuthError(err)) { disconnect(); return; }
        logErrorThrottled(rt, 'manual backfill failed', err);
      });
      if (waitForDone) await p;
      res.json({
        ok: true,
        pruned: prune,
        waited: waitForDone,
        status: getStatus(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Revenue summary from persisted charges (source of truth for /hq
  // hero numbers). "Today" is the calendar day in the Stripe account's
  // timezone (e.g. Europe/London) — so the
  // hero matches what Stripe's own dashboard shows rather than resetting
  // at the server's midnight. Defensive: swallows any DB error and
  // returns zero so the UI stays usable if Neon is down.
  app.get('/omo/api/integrations/stripe/summary', async (_req, res) => {
    try {
      if (_stripeSummaryCache.body && (Date.now() - _stripeSummaryCache.at) < STRIPE_SUMMARY_CACHE_TTL_MS) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json(_stripeSummaryCache.body);
      }
      const q = db.sql();
      if (!db.isConfigured()) {
        return res.json({ ok: true, revenue_today_cents: 0, charges_today: 0, revenue_7d_cents: 0, spark_7d_cents: [0,0,0,0,0,0,0], currency: 'usd', timezone: 'UTC' });
      }
      await db.ensureSchema();
      // Resolve the account timezone from the persisted account row so
      // day boundaries match Stripe's dashboard. Fall back to UTC if we
      // can't read it (connector not yet connected / no account row).
      let tz = 'UTC';
      try {
        const acctRows = await q`
          SELECT data FROM integration_data
          WHERE source = 'stripe' AND kind = 'account' LIMIT 1
        `;
        const acct = acctRows?.[0]?.data;
        tz = acct?.settings?.dashboard?.timezone || acct?.timezone || 'UTC';
      } catch { /* keep default */ }

      // Pull 31 days of charges. We prefer balance_transaction.amount
      // (charge amount converted into the account's settlement currency
      // via Stripe's FX) so multi-currency accounts — e.g. AUD-priced
      // subs on a USD-settled account — report the same revenue Stripe's
      // own dashboard shows. Falls back to the raw charge amount when
      // the balance_transaction wasn't expanded at fetch time.
      const rows = await q`
        SELECT
          ts,
          COALESCE(
            (data->'balance_transaction'->>'amount')::bigint,
            (data->>'amount')::bigint
          ) AS amount,
          data->>'status' AS status
        FROM integration_data
        WHERE source = 'stripe' AND kind = 'charge'
          AND ts >= NOW() - INTERVAL '31 days'
      `;
      const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      const todayKey = dayKey(new Date());
      const dayMs = 24 * 3600 * 1000;
      // 7-day window [6 days ago ... today] keyed by account-tz day.
      const anchorNoon = new Date(`${todayKey}T12:00:00Z`).getTime();
      const windowKeys = [];
      for (let i = 6; i >= 0; i--) windowKeys.push(dayKey(new Date(anchorNoon - i * dayMs)));
      const keyToIdx = new Map(windowKeys.map((k, i) => [k, i]));
      // 30-day sparkline: 6 buckets of 5 days each (idx 5 = most recent).
      const spark7 = Array(7).fill(0);
      const spark30 = Array(6).fill(0);
      // Per-day 30-day rollup — powers the big SVG chart in the focus
      // dashboard. Oldest day first. Seed all 30 days so the chart renders
      // a continuous x-axis even on days without activity.
      const daily30Map = new Map();
      for (let i = 29; i >= 0; i--) {
        const k = dayKey(new Date(anchorNoon - i * dayMs));
        daily30Map.set(k, { date: k, revenue_cents: 0, charges: 0, failed_count: 0 });
      }
      const nowMs = Date.now();
      let revToday = 0, nToday = 0;
      let rev7 = 0, n7 = 0;
      let rev30 = 0, n30 = 0, failed30 = 0;
      for (const r of rows) {
        const amt = Number(r.amount) || 0;
        const status = r.status;
        const t = new Date(r.ts);
        const k = dayKey(t);
        const idx7 = keyToIdx.get(k);
        const ageDays = (nowMs - t.getTime()) / dayMs;
        const within30 = ageDays < 30;
        const dayEntry = daily30Map.get(k);
        if (status === 'succeeded') {
          if (idx7 != null) { spark7[idx7] += amt; rev7 += amt; n7 += 1; }
          if (within30) {
            rev30 += amt; n30 += 1;
            const bucket = Math.max(0, Math.min(5, 5 - Math.floor(ageDays / 5)));
            spark30[bucket] += amt;
            if (dayEntry) { dayEntry.revenue_cents += amt; dayEntry.charges += 1; }
          }
          if (k === todayKey) { revToday += amt; nToday += 1; }
        } else if (status === 'failed' && within30) {
          failed30 += 1;
          if (dayEntry) dayEntry.failed_count += 1;
        }
      }
      const daily30 = Array.from(daily30Map.values());

      // ARR = sum of each active paying subscription's last invoice
      // amount, normalised to annual. MRR = ARR / 12. We use the
      // actual amount_paid on the sub's latest_invoice, so discounts /
      // proration / declined cards are all correctly handled — a sub
      // whose last renewal failed contributed $0 to last-cycle revenue
      // and drops out naturally.
      let activeSubs = 0;
      let arrCents = 0;
      let mrrCents = 0;
      const override = parseInt(process.env.STRIPE_MRR_OVERRIDE_CENTS, 10);
      const debugMrr = {
        source: 'arr_div_12_from_latest_paid_invoice',
        counted: 0,
        by_interval: {},
        skipped: { no_invoice: 0, invoice_unpaid: 0, zero_amount: 0, no_interval: 0 },
      };
      try {
        // Derive per-currency FX rates from the last 30 days of
        // succeeded charges so we can convert invoice amounts paid in
        // AUD/etc. back into the account's settlement currency (USD).
        const fxRows = await q`
          SELECT
            data->>'currency' AS ccy,
            SUM((data->'balance_transaction'->>'amount')::bigint)::float AS settled,
            SUM((data->>'amount')::bigint)::float AS charged
          FROM integration_data
          WHERE source = 'stripe' AND kind = 'charge'
            AND data->>'status' = 'succeeded'
            AND (data->'balance_transaction'->>'amount') IS NOT NULL
            AND ts >= NOW() - INTERVAL '30 days'
          GROUP BY ccy
        `;
        const rates = { usd: 1 };
        for (const r of fxRows) {
          const c = (r.ccy || '').toLowerCase();
          const charged = Number(r.charged) || 0;
          const settled = Number(r.settled) || 0;
          if (c && charged > 0) rates[c] = settled / charged;
        }
        debugMrr.fx_rates = { ...rates };

        // One row per active subscription, joined to its
        // latest_invoice. Uses amount_paid directly — that's what the
        // subscriber actually paid last cycle, so failed / declined
        // renewals (amount_paid === 0 OR status !== 'paid') naturally
        // drop out.
        const rows = await q`
          SELECT
            s.external_id AS sub_id,
            s.data->'items'->'data'->0->'price'->'recurring'->>'interval' AS interval,
            COALESCE((s.data->'items'->'data'->0->'price'->'recurring'->>'interval_count')::int, 1) AS interval_count,
            (s.data->'items'->'data'->0->'price'->>'unit_amount')::bigint AS price_unit_amount,
            LOWER(s.data->'items'->'data'->0->'price'->>'currency') AS price_currency,
            COALESCE((s.data->'items'->'data'->0->>'quantity')::int, 1) AS quantity,
            i.data->>'status' AS invoice_status,
            (i.data->>'amount_paid')::bigint AS invoice_amount_paid,
            LOWER(i.data->>'currency') AS invoice_currency
          FROM integration_data s
          LEFT JOIN integration_data i
            ON i.source = 'stripe' AND i.kind = 'invoice'
           AND i.external_id = s.data->>'latest_invoice'
          WHERE s.source = 'stripe' AND s.kind = 'subscription'
            AND s.data->>'status' = 'active'
        `;
        activeSubs = rows.length;
        for (const r of rows) {
          if (!r.invoice_status) { debugMrr.skipped.no_invoice += 1; continue; }
          if (r.invoice_status !== 'paid') { debugMrr.skipped.invoice_unpaid += 1; continue; }
          const paid = Number(r.invoice_amount_paid);
          if (!Number.isFinite(paid) || paid <= 0) { debugMrr.skipped.zero_amount += 1; continue; }
          const interval = (r.interval || 'month').toLowerCase();
          const count = Math.max(1, Number(r.interval_count) || 1);
          const perYear = interval === 'day' ? 365 / count
            : interval === 'week' ? 52 / count
            : interval === 'month' ? 12 / count
            : interval === 'year' ? 1 / count
            : 0;
          if (perYear <= 0) { debugMrr.skipped.no_interval += 1; continue; }
          const ccy = r.invoice_currency || 'usd';
          const rate = rates[ccy] != null ? rates[ccy] : 1;
          const annualContribution = paid * perYear * rate;
          arrCents += annualContribution;
          const bucket = debugMrr.by_interval[interval] || { count: 0, arr_cents: 0 };
          bucket.count += 1;
          bucket.arr_cents += annualContribution;
          debugMrr.by_interval[interval] = bucket;
          debugMrr.counted += 1;
        }
        arrCents = Math.round(arrCents);
        mrrCents = Math.round(arrCents / 12);
      } catch (e) { debugMrr.error = e?.message || String(e); }

      if (Number.isFinite(override) && override > 0) {
        debugMrr.estimated_mrr_cents = mrrCents;
        debugMrr.estimated_arr_cents = arrCents;
        debugMrr.source = 'override_env';
        mrrCents = override;
        arrCents = override * 12;
      }

      // Most recent payout — if it's still pending/in_transit, surface
      // the amount so the user knows what's incoming next.
      let nextPayoutCents = 0;
      let nextPayoutAt = null;
      try {
        const payouts = await q`
          SELECT data FROM integration_data
          WHERE source = 'stripe' AND kind = 'payout'
            AND data->>'status' IN ('pending', 'in_transit', 'paid')
          ORDER BY ts DESC LIMIT 1
        `;
        const p = payouts?.[0]?.data;
        if (p) {
          nextPayoutCents = Number(p.amount) || 0;
          nextPayoutAt = p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null;
        }
      } catch { /* leave zero */ }

      // Last succeeded charges — powers the "live activity" list in /hq.
      // Joins customer name/email from the customer kind so the UI can
      // show a human name next to each amount.
      let recentCharges = [];
      try {
        const chargeRows = await q`
          SELECT
            ts,
            COALESCE(
              (data->'balance_transaction'->>'amount')::bigint,
              (data->>'amount')::bigint
            ) AS amount,
            data->>'currency' AS currency,
            data->>'customer' AS customer_id,
            data->'billing_details'->>'name' AS billing_name,
            data->'billing_details'->>'email' AS billing_email,
            data->>'description' AS description,
            data->>'id' AS charge_id
          FROM integration_data
          WHERE source = 'stripe' AND kind = 'charge'
            AND data->>'status' = 'succeeded'
          ORDER BY ts DESC LIMIT 8
        `;
        const customerIds = [...new Set(chargeRows.map((r) => r.customer_id).filter(Boolean))];
        const nameById = new Map();
        const emailById = new Map();
        if (customerIds.length) {
          const custRows = await q`
            SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'customer'
              AND data->>'id' = ANY(${customerIds})
          `;
          for (const c of custRows) {
            if (c.id) {
              if (c.name) nameById.set(c.id, c.name);
              if (c.email) emailById.set(c.id, c.email);
            }
          }
        }
        recentCharges = chargeRows.map((r) => ({
          id: r.charge_id,
          ts: new Date(r.ts).getTime(),
          amount_cents: Number(r.amount) || 0,
          currency: (r.currency || 'usd').toLowerCase(),
          customer_name: nameById.get(r.customer_id) || r.billing_name || null,
          customer_email: emailById.get(r.customer_id) || r.billing_email || null,
          description: r.description || null,
        }));
      } catch { /* leave empty */ }

      // Recent payouts list (last 8) — powers the payouts card.
      let recentPayouts = [];
      try {
        const payoutRows = await q`
          SELECT data FROM integration_data
          WHERE source = 'stripe' AND kind = 'payout'
          ORDER BY ts DESC LIMIT 8
        `;
        recentPayouts = payoutRows.map((r) => ({
          id: r.data?.id,
          amount_cents: Number(r.data?.amount) || 0,
          currency: (r.data?.currency || 'usd').toLowerCase(),
          status: r.data?.status || null,
          arrival_at: r.data?.arrival_date ? new Date(r.data.arrival_date * 1000).toISOString() : null,
          ts: new Date(r.data?.created ? r.data.created * 1000 : Date.now()).getTime(),
        }));
      } catch { /* leave empty */ }

      // --- Additional HQ dashboard fields (run in parallel where safe) ---
      // Each block is wrapped in its own try/catch so a failure in one
      // enrichment doesn't wipe out the rest of the summary response.
      let plans = [];
      let topCustomers = [];
      let refundRate30d = 0;
      let openDisputes = 0;
      let newCustomers30d = 0;
      let riskItems = [];
      // ── Extended dashboard fields (all populated in parallel below) ──
      let revenuePrev7Cents = 0, chargesPrev7 = 0;
      let revenuePrev30Cents = 0, chargesPrev30 = 0;
      let revenueYesterdayCents = 0, chargesYesterday = 0;
      let hourlyToday = Array(24).fill(0);
      let gross30Cents = 0, fees30Cents = 0;
      let balanceAvailable = [], balancePending = [], balanceConnectReserved = [];
      let subStatusCounts = {};
      let canceledSubs30d = [];
      let trialEndingSoon = [];
      let currencyBreakdown30d = [];
      let countryBreakdown30d = [];
      let cardBrand30d = [];
      let failureCodes30d = [];
      let biggestCharges30d = [];
      let lifetimeTopCustomers = [];
      let productsCatalog = [];
      let openInvoices = [];
      let paidInvoicesRecent = [];
      let disputesActive = [];
      let refundsRecent = [];
      let oldestActiveCustomer = null;
      let newCustomers7d = 0;

      const plansPromise = (async () => {
        try {
          // Pull all active/trialing subscriptions with their first line-item
          // price info and product linkage. We group by price_id so a plan
          // with many subscribers rolls up into one row.
          const subRows = await q`
            SELECT
              s.data->'items'->'data'->0->'price'->>'id' AS plan_id,
              s.data->'items'->'data'->0->'price'->>'nickname' AS nickname,
              s.data->'items'->'data'->0->'price'->>'product' AS product_id,
              (s.data->'items'->'data'->0->'price'->>'unit_amount')::bigint AS unit_amount,
              LOWER(s.data->'items'->'data'->0->'price'->'recurring'->>'interval') AS interval,
              COALESCE((s.data->'items'->'data'->0->'price'->'recurring'->>'interval_count')::int, 1) AS interval_count,
              COALESCE((s.data->'items'->'data'->0->>'quantity')::int, 1) AS quantity
            FROM integration_data s
            WHERE s.source = 'stripe' AND s.kind = 'subscription'
              AND s.data->>'status' IN ('active', 'trialing')
          `;
          const productIds = [...new Set(subRows.map((r) => r.product_id).filter(Boolean))];
          const productNameById = new Map();
          if (productIds.length) {
            const productRows = await q`
              SELECT data->>'id' AS id, data->>'name' AS name
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'product'
                AND data->>'id' = ANY(${productIds})
            `;
            for (const p of productRows) {
              if (p.id && p.name) productNameById.set(p.id, p.name);
            }
          }
          // Roll up per-plan: count subs and compute annualised MRR from
          // list-price × interval × quantity (falls back cleanly when an
          // amount or interval is missing).
          const byPlan = new Map();
          for (const r of subRows) {
            const planId = r.plan_id || '(no-price)';
            const qty = Math.max(1, Number(r.quantity) || 1);
            const unit = Number(r.unit_amount) || 0;
            const interval = r.interval || 'month';
            const count = Math.max(1, Number(r.interval_count) || 1);
            const perYear = interval === 'day' ? 365 / count
              : interval === 'week' ? 52 / count
              : interval === 'month' ? 12 / count
              : interval === 'year' ? 1 / count
              : 0;
            const subArr = unit * qty * perYear;
            const name = r.nickname
              || productNameById.get(r.product_id)
              || (planId !== '(no-price)' ? planId : 'Unnamed plan');
            const entry = byPlan.get(planId) || { plan_id: planId, name, subs: 0, arr_cents: 0 };
            entry.subs += 1;
            entry.arr_cents += subArr;
            // Prefer a richer name if we learn one later.
            if (!entry.name || entry.name === planId) entry.name = name;
            byPlan.set(planId, entry);
          }
          plans = Array.from(byPlan.values())
            .map((p) => ({
              plan_id: p.plan_id,
              name: p.name,
              subs: p.subs,
              mrr_cents: Math.round(p.arr_cents / 12),
              arr_cents: Math.round(p.arr_cents),
            }))
            .sort((a, b) => b.mrr_cents - a.mrr_cents)
            .slice(0, 10);
        } catch { plans = []; }
      })();

      const topCustomersPromise = (async () => {
        try {
          // 30-day succeeded spend grouped by customer id, top 8.
          const spendRows = await q`
            SELECT
              data->>'customer' AS customer_id,
              COUNT(*)::int AS charges,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              ))::bigint AS total_cents
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND data->>'customer' IS NOT NULL
              AND ts >= NOW() - INTERVAL '30 days'
            GROUP BY data->>'customer'
            ORDER BY total_cents DESC NULLS LAST
            LIMIT 8
          `;
          const ids = spendRows.map((r) => r.customer_id).filter(Boolean);
          const nameById = new Map();
          const emailById = new Map();
          if (ids.length) {
            const custRows = await q`
              SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ANY(${ids})
            `;
            for (const c of custRows) {
              if (c.id) {
                if (c.name) nameById.set(c.id, c.name);
                if (c.email) emailById.set(c.id, c.email);
              }
            }
          }
          topCustomers = spendRows.map((r) => ({
            id: r.customer_id,
            name: nameById.get(r.customer_id) || null,
            email: emailById.get(r.customer_id) || null,
            charges: Number(r.charges) || 0,
            total_cents: Number(r.total_cents) || 0,
          }));
        } catch { topCustomers = []; }
      })();

      const refundRatePromise = (async () => {
        try {
          // Refunds / succeeded-ish charges in the last 30 days. We count
          // charges that either explicitly succeeded OR were refunded
          // (refunded charges were successful captures in the first place),
          // so the denominator matches "all real revenue charges".
          const rr = await q`
            SELECT
              COUNT(*) FILTER (WHERE data->>'refunded' = 'true')::int AS refunded,
              COUNT(*) FILTER (
                WHERE data->>'status' = 'succeeded' OR data->>'refunded' = 'true'
              )::int AS succeeded
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND ts >= NOW() - INTERVAL '30 days'
          `;
          const refunded = Number(rr?.[0]?.refunded) || 0;
          const succeeded = Number(rr?.[0]?.succeeded) || 0;
          refundRate30d = succeeded > 0 ? refunded / succeeded : 0;
        } catch { refundRate30d = 0; }
      })();

      const openDisputesPromise = (async () => {
        try {
          const rows = await q`
            SELECT COUNT(*)::int AS n
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'dispute'
              AND data->>'status' IN ('needs_response', 'warning_needs_response', 'under_review')
          `;
          openDisputes = Number(rows?.[0]?.n) || 0;
        } catch { openDisputes = 0; }
      })();

      const newCustomersPromise = (async () => {
        try {
          const rows = await q`
            SELECT COUNT(*)::int AS n
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'customer'
              AND ts >= NOW() - INTERVAL '30 days'
          `;
          newCustomers30d = Number(rows?.[0]?.n) || 0;
        } catch { newCustomers30d = 0; }
      })();

      const riskItemsPromise = (async () => {
        try {
          // Pull candidates from three places in parallel.
          const [disputeRows, failedRows, refundRows] = await Promise.all([
            q`
              SELECT
                ts,
                data->>'id' AS id,
                (data->>'amount')::bigint AS amount,
                data->>'currency' AS currency,
                data->>'status' AS status,
                data->>'reason' AS reason,
                data->>'customer' AS customer_id,
                data->'charge'->'billing_details'->>'name' AS billing_name,
                data->'charge'->'billing_details'->>'email' AS billing_email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'dispute'
                AND data->>'status' IN ('needs_response', 'warning_needs_response', 'under_review')
              ORDER BY ts DESC LIMIT 8
            `,
            q`
              SELECT
                ts,
                data->>'id' AS id,
                COALESCE(
                  (data->'balance_transaction'->>'amount')::bigint,
                  (data->>'amount')::bigint
                ) AS amount,
                data->>'currency' AS currency,
                data->>'failure_message' AS failure_message,
                data->>'failure_code' AS failure_code,
                data->>'customer' AS customer_id,
                data->'billing_details'->>'name' AS billing_name,
                data->'billing_details'->>'email' AS billing_email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'charge'
                AND data->>'status' = 'failed'
                AND ts >= NOW() - INTERVAL '7 days'
              ORDER BY ts DESC LIMIT 8
            `,
            q`
              SELECT
                ts,
                data->>'id' AS id,
                COALESCE(
                  (data->>'amount_refunded')::bigint,
                  (data->'balance_transaction'->>'amount')::bigint,
                  (data->>'amount')::bigint
                ) AS amount,
                data->>'currency' AS currency,
                data->>'customer' AS customer_id,
                data->'billing_details'->>'name' AS billing_name,
                data->'billing_details'->>'email' AS billing_email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'charge'
                AND data->>'refunded' = 'true'
                AND ts >= NOW() - INTERVAL '7 days'
              ORDER BY ts DESC LIMIT 8
            `,
          ]);
          const allIds = [
            ...disputeRows.map((r) => r.customer_id),
            ...failedRows.map((r) => r.customer_id),
            ...refundRows.map((r) => r.customer_id),
          ].filter(Boolean);
          const uniqueIds = [...new Set(allIds)];
          const nameById = new Map();
          if (uniqueIds.length) {
            const custRows = await q`
              SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ANY(${uniqueIds})
            `;
            for (const c of custRows) {
              if (c.id) nameById.set(c.id, c.name || c.email || null);
            }
          }
          const pickCustomer = (row) =>
            nameById.get(row.customer_id) || row.billing_name || row.billing_email || row.customer_id || null;
          const merged = [
            ...disputeRows.map((r) => ({
              kind: 'dispute',
              amount_cents: Number(r.amount) || 0,
              currency: (r.currency || 'usd').toLowerCase(),
              customer: pickCustomer(r),
              reason: r.reason || r.status || 'dispute',
              ts: new Date(r.ts).getTime(),
            })),
            ...failedRows.map((r) => ({
              kind: 'failed',
              amount_cents: Number(r.amount) || 0,
              currency: (r.currency || 'usd').toLowerCase(),
              customer: pickCustomer(r),
              reason: r.failure_message || r.failure_code || 'payment failed',
              ts: new Date(r.ts).getTime(),
            })),
            ...refundRows.map((r) => ({
              kind: 'refund',
              amount_cents: Number(r.amount) || 0,
              currency: (r.currency || 'usd').toLowerCase(),
              customer: pickCustomer(r),
              reason: 'refunded',
              ts: new Date(r.ts).getTime(),
            })),
          ];
          merged.sort((a, b) => b.ts - a.ts);
          riskItems = merged.slice(0, 8);
        } catch { riskItems = []; }
      })();

      // ── Previous-period revenue (for delta arrows in the headline) ──
      const prevPeriodPromise = (async () => {
        try {
          const rows = await q`
            SELECT
              COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '14 days' AND ts < NOW() - INTERVAL '7 days')::int AS prev7_n,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              )) FILTER (WHERE ts >= NOW() - INTERVAL '14 days' AND ts < NOW() - INTERVAL '7 days')::bigint AS prev7_amt,
              COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL '60 days' AND ts < NOW() - INTERVAL '30 days')::int AS prev30_n,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              )) FILTER (WHERE ts >= NOW() - INTERVAL '60 days' AND ts < NOW() - INTERVAL '30 days')::bigint AS prev30_amt
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
          `;
          const r = rows?.[0] || {};
          revenuePrev7Cents = Number(r.prev7_amt) || 0;
          chargesPrev7 = Number(r.prev7_n) || 0;
          revenuePrev30Cents = Number(r.prev30_amt) || 0;
          chargesPrev30 = Number(r.prev30_n) || 0;
        } catch { /* leave zero */ }
      })();

      // ── Yesterday + intraday hourly buckets (today, account TZ) ──
      const intradayPromise = (async () => {
        try {
          // Pull today + yesterday in one query so we can split client-side.
          const rows = await q`
            SELECT ts, COALESCE(
              (data->'balance_transaction'->>'amount')::bigint,
              (data->>'amount')::bigint
            ) AS amount
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND ts >= NOW() - INTERVAL '2 days'
          `;
          const yesterdayKey = dayKey(new Date(anchorNoon - dayMs));
          const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
          for (const r of rows) {
            const t = new Date(r.ts);
            const k = dayKey(t);
            const amt = Number(r.amount) || 0;
            if (k === todayKey) {
              const hh = parseInt(hourFmt.format(t), 10);
              if (Number.isFinite(hh) && hh >= 0 && hh < 24) hourlyToday[hh] += amt;
            } else if (k === yesterdayKey) {
              revenueYesterdayCents += amt;
              chargesYesterday += 1;
            }
          }
        } catch { /* leave zero */ }
      })();

      // ── Gross / fees / net (30d, from balance_transaction.fee) ──
      const grossFeesPromise = (async () => {
        try {
          const rows = await q`
            SELECT
              SUM(COALESCE((data->'balance_transaction'->>'amount')::bigint, 0))::bigint AS gross,
              SUM(COALESCE((data->'balance_transaction'->>'fee')::bigint, 0))::bigint AS fees
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND ts >= NOW() - INTERVAL '30 days'
          `;
          gross30Cents = Number(rows?.[0]?.gross) || 0;
          fees30Cents = Number(rows?.[0]?.fees) || 0;
        } catch { /* leave zero */ }
      })();

      // ── Latest balance snapshot (available + pending + connect_reserved) ──
      const balancePromise = (async () => {
        try {
          const rows = await q`
            SELECT data FROM integration_data
            WHERE source = 'stripe' AND kind = 'balance'
            ORDER BY ts DESC LIMIT 1
          `;
          const b = rows?.[0]?.data;
          if (b) {
            balanceAvailable = (b.available || []).map((x) => ({ amount_cents: Number(x.amount) || 0, currency: (x.currency || 'usd').toLowerCase() }));
            balancePending = (b.pending || []).map((x) => ({ amount_cents: Number(x.amount) || 0, currency: (x.currency || 'usd').toLowerCase() }));
            balanceConnectReserved = (b.connect_reserved || []).map((x) => ({ amount_cents: Number(x.amount) || 0, currency: (x.currency || 'usd').toLowerCase() }));
          }
        } catch { /* leave empty */ }
      })();

      // ── Subscription status counts + churn list + trial-ending list ──
      const subSegmentsPromise = (async () => {
        try {
          const counts = await q`
            SELECT data->>'status' AS status, COUNT(*)::int AS n
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'subscription'
            GROUP BY data->>'status'
          `;
          subStatusCounts = {};
          for (const r of counts) {
            if (r.status) subStatusCounts[r.status] = Number(r.n) || 0;
          }

          // Recently canceled (last 30d) — we use ts (which is the
          // subscription created time on persist), so we filter by
          // canceled_at within 30d in JS. Pull anything canceled+lookalike.
          const canceledRows = await q`
            SELECT s.data, s.external_id
            FROM integration_data s
            WHERE s.source = 'stripe' AND s.kind = 'subscription'
              AND (s.data->>'status' = 'canceled' OR s.data->>'cancel_at_period_end' = 'true')
            LIMIT 200
          `;
          const cutoffSec = Math.floor((Date.now() - 30 * dayMs) / 1000);
          const cancelIds = new Set();
          const cancelRaw = [];
          for (const r of canceledRows) {
            const d = r.data || {};
            const cancelAt = Number(d.canceled_at || 0);
            if (cancelAt && cancelAt >= cutoffSec) {
              cancelIds.add(d.customer);
              cancelRaw.push({
                sub_id: d.id,
                customer_id: d.customer,
                canceled_at: cancelAt * 1000,
                plan: d.items?.data?.[0]?.price?.nickname
                  || d.items?.data?.[0]?.price?.id
                  || null,
                amount_cents: Number(d.items?.data?.[0]?.price?.unit_amount) || 0,
                currency: (d.items?.data?.[0]?.price?.currency || 'usd').toLowerCase(),
                interval: d.items?.data?.[0]?.price?.recurring?.interval || null,
              });
            }
          }
          // Trial ending soon — status='trialing' with trial_end ≤ +7d.
          const trialRows = await q`
            SELECT data, external_id FROM integration_data
            WHERE source = 'stripe' AND kind = 'subscription'
              AND data->>'status' = 'trialing'
              AND data->>'trial_end' IS NOT NULL
            LIMIT 200
          `;
          const horizonSec = Math.floor((Date.now() + 7 * dayMs) / 1000);
          const trialIds = new Set();
          const trialRaw = [];
          for (const r of trialRows) {
            const d = r.data || {};
            const tend = Number(d.trial_end || 0);
            if (tend && tend <= horizonSec && tend >= Math.floor(Date.now() / 1000) - 24 * 3600) {
              trialIds.add(d.customer);
              trialRaw.push({
                sub_id: d.id,
                customer_id: d.customer,
                trial_end: tend * 1000,
                plan: d.items?.data?.[0]?.price?.nickname
                  || d.items?.data?.[0]?.price?.id
                  || null,
                amount_cents: Number(d.items?.data?.[0]?.price?.unit_amount) || 0,
                currency: (d.items?.data?.[0]?.price?.currency || 'usd').toLowerCase(),
                interval: d.items?.data?.[0]?.price?.recurring?.interval || null,
              });
            }
          }
          const allIds = [...new Set([...cancelIds, ...trialIds])].filter(Boolean);
          const nameMap = new Map();
          if (allIds.length) {
            const cust = await q`
              SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ANY(${allIds})
            `;
            for (const c of cust) {
              if (c.id) nameMap.set(c.id, { name: c.name || null, email: c.email || null });
            }
          }
          canceledSubs30d = cancelRaw
            .map((x) => ({ ...x, customer: nameMap.get(x.customer_id) || null }))
            .sort((a, b) => b.canceled_at - a.canceled_at)
            .slice(0, 12);
          trialEndingSoon = trialRaw
            .map((x) => ({ ...x, customer: nameMap.get(x.customer_id) || null }))
            .sort((a, b) => a.trial_end - b.trial_end)
            .slice(0, 12);
        } catch { /* leave empty */ }
      })();

      // ── Currency / country / card-brand / failure-code breakdowns (30d) ──
      const breakdownsPromise = (async () => {
        try {
          const ccyRows = await q`
            SELECT
              LOWER(data->>'currency') AS currency,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              ))::bigint AS gross,
              COUNT(*)::int AS charges
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND ts >= NOW() - INTERVAL '30 days'
            GROUP BY LOWER(data->>'currency')
            ORDER BY gross DESC NULLS LAST
            LIMIT 8
          `;
          currencyBreakdown30d = ccyRows.map((r) => ({
            currency: r.currency || 'usd',
            gross_cents: Number(r.gross) || 0,
            charges: Number(r.charges) || 0,
          }));

          const countryRows = await q`
            SELECT
              UPPER(COALESCE(
                data->'billing_details'->'address'->>'country',
                data->'payment_method_details'->'card'->>'country'
              )) AS country,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              ))::bigint AS gross,
              COUNT(*)::int AS charges
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND ts >= NOW() - INTERVAL '30 days'
            GROUP BY country
            ORDER BY gross DESC NULLS LAST
            LIMIT 10
          `;
          countryBreakdown30d = countryRows
            .filter((r) => r.country)
            .map((r) => ({
              country: r.country,
              gross_cents: Number(r.gross) || 0,
              charges: Number(r.charges) || 0,
            }));

          const brandRows = await q`
            SELECT
              LOWER(COALESCE(
                data->'payment_method_details'->'card'->>'brand',
                data->'payment_method_details'->>'type'
              )) AS brand,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              ))::bigint AS gross,
              COUNT(*)::int AS charges
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND ts >= NOW() - INTERVAL '30 days'
            GROUP BY brand
            ORDER BY gross DESC NULLS LAST
            LIMIT 10
          `;
          cardBrand30d = brandRows
            .filter((r) => r.brand)
            .map((r) => ({
              brand: r.brand,
              gross_cents: Number(r.gross) || 0,
              charges: Number(r.charges) || 0,
            }));

          const failRows = await q`
            SELECT
              data->>'failure_code' AS code,
              MAX(data->>'failure_message') AS sample_message,
              COUNT(*)::int AS n
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'failed'
              AND ts >= NOW() - INTERVAL '30 days'
            GROUP BY data->>'failure_code'
            ORDER BY n DESC NULLS LAST
            LIMIT 8
          `;
          failureCodes30d = failRows
            .filter((r) => r.code)
            .map((r) => ({
              code: r.code,
              sample_message: r.sample_message || null,
              count: Number(r.n) || 0,
            }));
        } catch { /* leave empty */ }
      })();

      // ── Biggest single charges last 30d (top 5) ──
      const biggestPromise = (async () => {
        try {
          const rows = await q`
            SELECT
              ts,
              data->>'id' AS id,
              COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              ) AS amount,
              data->>'currency' AS currency,
              data->>'customer' AS customer_id,
              data->'billing_details'->>'name' AS billing_name,
              data->'billing_details'->>'email' AS billing_email,
              data->>'description' AS description
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND ts >= NOW() - INTERVAL '30 days'
            ORDER BY COALESCE(
              (data->'balance_transaction'->>'amount')::bigint,
              (data->>'amount')::bigint
            ) DESC NULLS LAST
            LIMIT 5
          `;
          const ids = rows.map((r) => r.customer_id).filter(Boolean);
          const nameMap = new Map();
          if (ids.length) {
            const cust = await q`
              SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ANY(${ids})
            `;
            for (const c of cust) {
              if (c.id) nameMap.set(c.id, c.name || c.email || null);
            }
          }
          biggestCharges30d = rows.map((r) => ({
            id: r.id,
            ts: new Date(r.ts).getTime(),
            amount_cents: Number(r.amount) || 0,
            currency: (r.currency || 'usd').toLowerCase(),
            customer: nameMap.get(r.customer_id) || r.billing_name || r.billing_email || null,
            description: r.description || null,
          }));
        } catch { /* leave empty */ }
      })();

      // ── Lifetime top customers (top 5 all-time succeeded spend) ──
      const lifetimePromise = (async () => {
        try {
          const rows = await q`
            SELECT
              data->>'customer' AS customer_id,
              COUNT(*)::int AS charges,
              SUM(COALESCE(
                (data->'balance_transaction'->>'amount')::bigint,
                (data->>'amount')::bigint
              ))::bigint AS total,
              MIN(ts) AS first_charge,
              MAX(ts) AS last_charge
            FROM integration_data
            WHERE source = 'stripe' AND kind = 'charge'
              AND data->>'status' = 'succeeded'
              AND data->>'customer' IS NOT NULL
            GROUP BY data->>'customer'
            ORDER BY total DESC NULLS LAST
            LIMIT 6
          `;
          const ids = rows.map((r) => r.customer_id).filter(Boolean);
          const nameMap = new Map();
          if (ids.length) {
            const cust = await q`
              SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ANY(${ids})
            `;
            for (const c of cust) {
              if (c.id) nameMap.set(c.id, { name: c.name || null, email: c.email || null });
            }
          }
          lifetimeTopCustomers = rows.map((r) => ({
            id: r.customer_id,
            name: nameMap.get(r.customer_id)?.name || null,
            email: nameMap.get(r.customer_id)?.email || null,
            charges: Number(r.charges) || 0,
            total_cents: Number(r.total) || 0,
            first_charge: new Date(r.first_charge).getTime(),
            last_charge: new Date(r.last_charge).getTime(),
          }));
        } catch { /* leave empty */ }
      })();

      // ── Products + active prices catalog ──
      const catalogPromise = (async () => {
        try {
          const [products, prices] = await Promise.all([
            q`
              SELECT data FROM integration_data
              WHERE source = 'stripe' AND kind = 'product'
              ORDER BY (data->>'created')::bigint DESC NULLS LAST
              LIMIT 60
            `,
            q`
              SELECT data FROM integration_data
              WHERE source = 'stripe' AND kind = 'price'
              LIMIT 500
            `,
          ]);
          const pricesByProduct = new Map();
          for (const r of prices) {
            const p = r.data || {};
            const pid = p.product;
            if (!pid) continue;
            if (!pricesByProduct.has(pid)) pricesByProduct.set(pid, []);
            pricesByProduct.get(pid).push({
              id: p.id,
              nickname: p.nickname || null,
              unit_amount: p.unit_amount != null ? Number(p.unit_amount) : null,
              currency: (p.currency || 'usd').toLowerCase(),
              interval: p.recurring?.interval || null,
              interval_count: p.recurring?.interval_count || 1,
              active: !!p.active,
              type: p.type || null,
            });
          }
          productsCatalog = products.map((r) => {
            const p = r.data || {};
            const ps = (pricesByProduct.get(p.id) || []).sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
            return {
              id: p.id,
              name: p.name || null,
              active: !!p.active,
              description: p.description || null,
              created: p.created ? p.created * 1000 : null,
              prices: ps,
            };
          });
        } catch { /* leave empty */ }
      })();

      // ── Open invoices + recent paid invoices ──
      const invoicesPromise = (async () => {
        try {
          const [open, paid] = await Promise.all([
            q`
              SELECT data FROM integration_data
              WHERE source = 'stripe' AND kind = 'invoice'
                AND data->>'status' IN ('open', 'past_due', 'uncollectible')
              ORDER BY ts DESC LIMIT 12
            `,
            q`
              SELECT data FROM integration_data
              WHERE source = 'stripe' AND kind = 'invoice'
                AND data->>'status' = 'paid'
              ORDER BY ts DESC LIMIT 8
            `,
          ]);
          const mapInv = (rows) => rows.map((r) => {
            const d = r.data || {};
            return {
              id: d.id,
              number: d.number || null,
              status: d.status || null,
              amount_due_cents: Number(d.amount_due) || 0,
              amount_paid_cents: Number(d.amount_paid) || 0,
              amount_remaining_cents: Number(d.amount_remaining) || 0,
              currency: (d.currency || 'usd').toLowerCase(),
              customer_id: d.customer || null,
              customer_email: d.customer_email || null,
              customer_name: d.customer_name || null,
              hosted_invoice_url: d.hosted_invoice_url || null,
              due_date: d.due_date ? d.due_date * 1000 : null,
              created: d.created ? d.created * 1000 : null,
            };
          });
          openInvoices = mapInv(open);
          paidInvoicesRecent = mapInv(paid);
        } catch { /* leave empty */ }
      })();

      // ── Active disputes (full detail) + recent refunds ──
      const disputeRefundPromise = (async () => {
        try {
          const [disp, refs] = await Promise.all([
            q`
              SELECT data FROM integration_data
              WHERE source = 'stripe' AND kind = 'dispute'
                AND data->>'status' IN ('needs_response', 'warning_needs_response', 'under_review', 'warning_under_review')
              ORDER BY ts DESC LIMIT 12
            `,
            q`
              SELECT
                ts,
                data->>'id' AS id,
                COALESCE(
                  (data->>'amount_refunded')::bigint,
                  (data->'balance_transaction'->>'amount')::bigint,
                  (data->>'amount')::bigint
                ) AS amount,
                data->>'currency' AS currency,
                data->>'customer' AS customer_id,
                data->'billing_details'->>'name' AS billing_name,
                data->'billing_details'->>'email' AS billing_email,
                data->>'description' AS description
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'charge'
                AND data->>'refunded' = 'true'
                AND ts >= NOW() - INTERVAL '60 days'
              ORDER BY ts DESC LIMIT 12
            `,
          ]);
          const refIds = refs.map((r) => r.customer_id).filter(Boolean);
          const nameMap = new Map();
          if (refIds.length) {
            const cust = await q`
              SELECT data->>'id' AS id, data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ANY(${refIds})
            `;
            for (const c of cust) {
              if (c.id) nameMap.set(c.id, c.name || c.email || null);
            }
          }
          disputesActive = disp.map((r) => {
            const d = r.data || {};
            return {
              id: d.id,
              status: d.status || null,
              reason: d.reason || null,
              amount_cents: Number(d.amount) || 0,
              currency: (d.currency || 'usd').toLowerCase(),
              charge_id: d.charge || null,
              evidence_due_by: d.evidence_details?.due_by ? d.evidence_details.due_by * 1000 : null,
              created: d.created ? d.created * 1000 : null,
              is_charge_refundable: !!d.is_charge_refundable,
            };
          });
          refundsRecent = refs.map((r) => ({
            id: r.id,
            ts: new Date(r.ts).getTime(),
            amount_cents: Number(r.amount) || 0,
            currency: (r.currency || 'usd').toLowerCase(),
            customer: nameMap.get(r.customer_id) || r.billing_name || r.billing_email || null,
            description: r.description || null,
          }));
        } catch { /* leave empty */ }
      })();

      // ── Oldest active customer + 7d new-customer count ──
      const customerExtraPromise = (async () => {
        try {
          const [oldestRows, n7Rows] = await Promise.all([
            q`
              SELECT s.data->>'customer' AS customer_id, MIN((s.data->>'created')::bigint) AS created
              FROM integration_data s
              WHERE s.source = 'stripe' AND s.kind = 'subscription'
                AND s.data->>'status' = 'active'
              GROUP BY s.data->>'customer'
              ORDER BY created ASC NULLS LAST
              LIMIT 1
            `,
            q`
              SELECT COUNT(*)::int AS n
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND ts >= NOW() - INTERVAL '7 days'
            `,
          ]);
          newCustomers7d = Number(n7Rows?.[0]?.n) || 0;
          const cid = oldestRows?.[0]?.customer_id;
          const since = oldestRows?.[0]?.created;
          if (cid) {
            const cust = await q`
              SELECT data->>'name' AS name, data->>'email' AS email
              FROM integration_data
              WHERE source = 'stripe' AND kind = 'customer'
                AND data->>'id' = ${cid}
              LIMIT 1
            `;
            const c = cust?.[0];
            oldestActiveCustomer = {
              id: cid,
              name: c?.name || null,
              email: c?.email || null,
              since: since ? Number(since) * 1000 : null,
            };
          }
        } catch { /* leave null */ }
      })();

      await Promise.all([
        plansPromise,
        topCustomersPromise,
        refundRatePromise,
        openDisputesPromise,
        newCustomersPromise,
        riskItemsPromise,
        prevPeriodPromise,
        intradayPromise,
        grossFeesPromise,
        balancePromise,
        subSegmentsPromise,
        breakdownsPromise,
        biggestPromise,
        lifetimePromise,
        catalogPromise,
        invoicesPromise,
        disputeRefundPromise,
        customerExtraPromise,
      ]);

      const status = getStatus();
      const body = {
        ok: true,
        revenue_today_cents: revToday,
        charges_today: nToday,
        revenue_yesterday_cents: revenueYesterdayCents,
        charges_yesterday: chargesYesterday,
        hourly_today_cents: hourlyToday,
        revenue_7d_cents: rev7,
        charges_7d: n7,
        revenue_prev_7d_cents: revenuePrev7Cents,
        charges_prev_7d: chargesPrev7,
        revenue_30d_cents: rev30,
        charges_30d: n30,
        revenue_prev_30d_cents: revenuePrev30Cents,
        charges_prev_30d: chargesPrev30,
        failed_30d: failed30,
        fail_rate_30d: (n30 + failed30) > 0 ? failed30 / (n30 + failed30) : 0,
        spark_7d_cents: spark7,
        spark_30d_cents: spark30,
        daily_30d: daily30,
        gross_30d_cents: gross30Cents,
        fees_30d_cents: fees30Cents,
        net_30d_cents: gross30Cents - fees30Cents,
        active_subscriptions: activeSubs,
        mrr_cents: mrrCents,
        arr_cents: arrCents,
        mrr_breakdown: debugMrr,
        sub_status_counts: subStatusCounts,
        canceled_subs_30d: canceledSubs30d,
        trial_ending_soon: trialEndingSoon,
        next_payout_cents: nextPayoutCents,
        next_payout_at: nextPayoutAt,
        balance_available: balanceAvailable,
        balance_pending: balancePending,
        balance_connect_reserved: balanceConnectReserved,
        recent_charges: recentCharges,
        recent_payouts: recentPayouts,
        avg_charge_cents: n30 > 0 ? Math.round(rev30 / n30) : 0,
        biggest_charges_30d: biggestCharges30d,
        currency_breakdown_30d: currencyBreakdown30d,
        country_breakdown_30d: countryBreakdown30d,
        card_brand_30d: cardBrand30d,
        failure_codes_30d: failureCodes30d,
        plans,
        products_catalog: productsCatalog,
        top_customers: topCustomers,
        lifetime_top_customers: lifetimeTopCustomers,
        oldest_active_customer: oldestActiveCustomer,
        new_customers_7d: newCustomers7d,
        open_invoices: openInvoices,
        paid_invoices_recent: paidInvoicesRecent,
        disputes_active: disputesActive,
        refunds_recent: refundsRecent,
        refund_rate_30d: refundRate30d,
        open_disputes: openDisputes,
        new_customers_30d: newCustomers30d,
        risk_items: riskItems,
        account: {
          id: status.account_id || null,
          name: status.account_name || null,
          livemode: status.livemode ?? null,
        },
        generated_at: new Date().toISOString(),
        currency: 'usd',
        timezone: tz,
        today: todayKey,
      };
      _stripeSummaryCache = { at: Date.now(), body };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Big human-readable dump of everything we have on disk for stripe.
  // Intended to be opened in a new tab and/or piped into an LLM prompt.
  app.get('/omo/api/integrations/stripe/plaintext', async (req, res) => {
    try {
      const limitPerKind = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
      const status = getStatus();
      const counts = await integrationDb.countsBySource('stripe');
      const totalRows = Object.values(counts).reduce((s, n) => s + n, 0);
      const ageMin = (t) => (t ? Math.round((Date.now() - t) / 60000) + 'm ago' : '—');
      const header = [
        '='.repeat(72),
        `STRIPE DATA DUMP`,
        `generated: ${new Date().toISOString()}`,
        status.connected
          ? `account: ${status.account_name || status.account_id} (${status.account_id}) · ${status.livemode ? 'LIVE' : 'TEST'} · ${status.country || '—'}`
          : `account: (connector not currently connected — showing last persisted data)`,
        `poll: every ${Math.round((status.poll_interval_ms || 0) / 1000)}s · last_poll: ${ageMin(status.last_poll_at)}`,
        `deep resync: every ${Math.round((status.resync_interval_ms || 0) / 60000)}min · last_deep: ${ageMin(status.deep_backfill_done_at)}`,
        `rows: ${totalRows} across ${Object.keys(counts).length} kind(s) · limit per kind: ${limitPerKind}`,
        '='.repeat(72),
        '',
      ].join('\n');
      const order = ['account', 'balance', 'customer', 'subscription', 'invoice', 'charge', 'payout', 'product', 'price', 'dispute'];
      const body = await integrationDb.plaintextBySource('stripe', { kindOrder: order, limitPerKind, header });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    } catch (err) {
      res.status(500).type('text/plain').send(`ERROR: ${err?.message || err}`);
    }
  });

  // Single Stripe object by id (charge, customer, subscription, payout,
  // invoice, price, dispute, …). Returns the persisted slim+data row;
  // no Stripe API round-trip — the connector keeps everything we
  // displayed in the HQ summary in integration_data already.
  app.get('/omo/api/integrations/stripe/object/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'missing id' });
      const row = await integrationDb.getByExternalId('stripe', id);
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({
        id: row.external_id,
        kind: row.kind,
        ts: row.ts,
        title: row.title,
        summary: row.summary,
        data: row.data || {},
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}

// Meta (Facebook) Ads read-only connector for the Omo Data Core.
//
// Mirrors src/connectors/stripe.js:
//   start({ emit })                       — env-based boot (FB_ACCESS_TOKEN, FB_AD_ACCOUNT_ID)
//   connect({ emit, token, accountId })   — runtime connect from /hq form
//   disconnect()                          — stop poll + resync timers
//   getStatus()                           — current connection info
//   mountRoutes(app, { emit })            — registers /omo/api/integrations/meta/*
//
// On connect we validate the token by hitting /me then /act_{id}. A deep
// backfill pulls campaigns / adsets / ads / creatives / insights (30d) and
// upserts into integration_data (source='meta'). A cheap poll re-fetches
// today's insights + campaign list every FB_POLL_MS so the /hq panel
// stays fresh, and a deep resync runs every FB_RESYNC_MS.

import * as integrationDb from '../store/integration_db.js';
import * as dataCore from '../data_core.js';
import express from 'express';

const GRAPH = 'https://graph.facebook.com/v19.0';
const POLL_INTERVAL_MS = parseInt(process.env.FB_POLL_MS, 10) || 300_000;       // 5 min
const DEEP_RESYNC_MS  = parseInt(process.env.FB_RESYNC_MS, 10) || 3_600_000;    // 1 h
const INSIGHT_DAYS    = parseInt(process.env.FB_INSIGHT_DAYS, 10) || 30;
const PAGE_LIMIT      = 100;
const MAX_PAGES       = 10;

let runtime = null;

// ──────────────────────────────────────────────────────── helpers

function maskToken(t) {
  if (!t) return '';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

function money(amount, currency) {
  if (amount == null || amount === '') return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (Number.isNaN(n)) return String(amount);
  const cur = (currency || 'USD').toUpperCase();
  return `$${n.toFixed(2)}${cur !== 'USD' ? ' ' + cur : ''}`;
}

function pct(n) {
  if (n == null || n === '') return '—';
  const v = typeof n === 'string' ? parseFloat(n) : n;
  return Number.isNaN(v) ? '—' : `${v.toFixed(2)}%`;
}

function fmtIsoShort(s) {
  if (!s) return '—';
  return String(s).replace('T', ' ').slice(0, 19);
}

// Fatal token errors: 401/403 HTTP, or Meta error codes that specifically
// mean the token itself is dead. Field-level permission errors (code 100)
// are NOT fatal — they just mean that one field can't be fetched.
const FATAL_FB_CODES = new Set([102, 190, 463, 464, 467]);
function isAuthError(err) {
  const http = err?.statusCode;
  if (http === 401 || http === 403) return true;
  const code = err?.fb?.code;
  return typeof code === 'number' && FATAL_FB_CODES.has(code);
}

// ──────────────────────────────────────────────────────── rate limiting
//
// Graph / Marketing API is throttled two ways: platform-level per-app
// (header X-App-Usage) and per-business-use-case (header
// X-Business-Use-Case-Usage, used by Marketing API + system/page tokens).
// Values are percentages of the rolling-window budget. Once any metric
// hits 100% Meta returns an error with a code from THROTTLE_FB_CODES and
// (for BUC errors) an estimated_time_to_regain_access in minutes. We
// honor that estimate, back off, and adaptively slow polling before we
// ever hit the wall. Docs:
// https://developers.facebook.com/docs/graph-api/overview/rate-limiting
const THROTTLE_FB_CODES = new Set([
  4,      // App rate limit
  17,     // User rate limit (subcode 2446079 = Ads v3.3+)
  32,     // Pages rate limit
  613,    // Custom rate limit
  80000,  // Ads Insights BUC
  80001,  // Pages BUC (page/sys-user token)
  80002,  // Instagram BUC
  80003,  // Custom Audience BUC
  80004,  // Ads Management BUC
  80005,  // LeadGen BUC
  80006,  // Messenger BUC
  80008,  // WhatsApp Business Mgmt BUC
  80009,  // Catalog Management BUC
  80014,  // Catalog Batch BUC
]);

function isThrottleError(err) {
  const code = err?.fb?.code;
  if (typeof code === 'number' && THROTTLE_FB_CODES.has(code)) return true;
  if (err?.statusCode === 429) return true;
  return false;
}

function parseUsageHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const appRaw = headers.get('x-app-usage');
  const bucRaw = headers.get('x-business-use-case-usage');
  const adRaw  = headers.get('x-ad-account-usage');
  if (!appRaw && !bucRaw && !adRaw) return null;
  let appUsage = null, bucUsage = null, adAcctUsage = null;
  try { if (appRaw) appUsage = JSON.parse(appRaw); } catch { /* tolerate */ }
  try { if (bucRaw) bucUsage = JSON.parse(bucRaw); } catch { /* tolerate */ }
  try { if (adRaw)  adAcctUsage = JSON.parse(adRaw);  } catch { /* tolerate */ }

  let worstPct = 0;
  let resumeSeconds = 0;
  let tier = null;

  if (appUsage) {
    worstPct = Math.max(worstPct, appUsage.call_count || 0, appUsage.total_time || 0, appUsage.total_cputime || 0);
  }
  if (bucUsage && typeof bucUsage === 'object') {
    for (const arr of Object.values(bucUsage)) {
      if (!Array.isArray(arr)) continue;
      for (const b of arr) {
        worstPct = Math.max(worstPct, b.call_count || 0, b.total_time || 0, b.total_cputime || 0);
        if (b.estimated_time_to_regain_access > 0) {
          // header value is in minutes per the docs
          resumeSeconds = Math.max(resumeSeconds, b.estimated_time_to_regain_access * 60);
        }
        if (b.ads_api_access_tier) tier = b.ads_api_access_tier;
      }
    }
  }
  if (adAcctUsage) {
    if (adAcctUsage.acc_id_util_pct != null) worstPct = Math.max(worstPct, adAcctUsage.acc_id_util_pct);
    if (adAcctUsage.reset_time_duration > 0) resumeSeconds = Math.max(resumeSeconds, adAcctUsage.reset_time_duration);
    if (adAcctUsage.ads_api_access_tier) tier = adAcctUsage.ads_api_access_tier;
  }

  return { worstPct, resumeSeconds, appUsage, bucUsage, adAcctUsage, tier };
}

function updateRateLimit(rt, usage) {
  if (!rt || !usage) return;
  const prev = rt.rateLimit?.worstPct || 0;
  rt.rateLimit = {
    ...(rt.rateLimit || {}),
    worstPct: usage.worstPct,
    appUsage: usage.appUsage,
    bucUsage: usage.bucUsage,
    adAcctUsage: usage.adAcctUsage,
    tier: usage.tier || rt.rateLimit?.tier || null,
    seenAt: Date.now(),
  };
  const crossed = (t) => prev < t && usage.worstPct >= t;
  if (crossed(75)) console.warn(`[meta] rate-limit usage crossed 75% — slowing polls (worst=${usage.worstPct}%)`);
  if (crossed(90)) console.warn(`[meta] rate-limit usage crossed 90% — skipping deep resync until <75% (worst=${usage.worstPct}%)`);
}

function enterCooldown(rt, err, usage) {
  if (!rt) return 0;
  const serverSecs = usage?.resumeSeconds || 0;
  const prev = rt.rateLimit?.throttleCount || 0;
  // Exponential fallback indexed by recent throttle count: 60, 120, 240,
  // 480, 900s (cap). Used only when the server didn't give us an estimate.
  const backoffSecs = Math.min(900, 60 * Math.pow(2, prev));
  const secs = serverSecs > 0 ? serverSecs : backoffSecs;
  rt.rateLimit = {
    ...(rt.rateLimit || {}),
    pausedUntil: Date.now() + secs * 1000,
    lastThrottleAt: Date.now(),
    lastThrottleCode: err?.fb?.code || err?.statusCode || null,
    throttleCount: prev + 1,
  };
  console.warn(`[meta] THROTTLED code=${rt.rateLimit.lastThrottleCode} — cooldown ${secs}s${serverSecs > 0 ? ' (server estimate)' : ' (exp backoff)'}`);
  return secs;
}

function isPaused(rt) {
  return !!(rt?.rateLimit?.pausedUntil && Date.now() < rt.rateLimit.pausedUntil);
}
function msRemainingInCooldown(rt) {
  if (!isPaused(rt)) return 0;
  return rt.rateLimit.pausedUntil - Date.now();
}

// Small randomized delay between paginated requests so we don't flood Meta
// with back-to-back calls and trip the burst-protection heuristics.
function pageJitter() {
  const min = 120, max = 280;
  return new Promise((r) => setTimeout(r, min + Math.floor(Math.random() * (max - min))));
}

// ──────────────────────────────────────────────────────── Graph GET

// Low-level GET with token as query param. Returns parsed JSON, throws on
// !ok with a status code attached. When `rt` is passed, rate-limit headers
// are parsed into `rt.rateLimit` and an in-force cooldown is honored before
// the call is made.
async function fbGet(path, token, params = {}, rt = null) {
  if (rt && isPaused(rt)) {
    const err = new Error(`meta rate-limit cooldown — ${Math.round(msRemainingInCooldown(rt)/1000)}s remaining`);
    err.throttled = true;
    throw err;
  }
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const usage = parseUsageHeaders(r.headers);
  if (usage && rt) updateRateLimit(rt, usage);
  let j = null;
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok || j?.error) {
    const err = new Error(j?.error?.message || `HTTP ${r.status}`);
    err.statusCode = r.status;
    err.fb = j?.error || null;
    if (isThrottleError(err)) enterCooldown(rt, err, usage);
    throw err;
  }
  // After a quiet, sub-50% response, reset the throttle streak so the next
  // backoff (if any) starts from the smallest exponent again.
  if (rt && rt.rateLimit?.throttleCount && usage && usage.worstPct < 50) {
    rt.rateLimit.throttleCount = 0;
  }
  return j;
}

// Follow data.paging.next cursors up to `limit` total items or MAX_PAGES.
async function fbGetAll(path, token, params = {}, limit = 500, rt = null) {
  const out = [];
  let next = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (rt && isPaused(rt)) {
      const err = new Error('meta rate-limit cooldown — pagination stopped');
      err.throttled = true;
      throw err;
    }
    let data, paging;
    if (next) {
      await pageJitter();
      const r = await fetch(next);
      const usage = parseUsageHeaders(r.headers);
      if (usage && rt) updateRateLimit(rt, usage);
      const j = await r.json();
      if (!r.ok || j?.error) {
        const err = new Error(j?.error?.message || `HTTP ${r.status}`);
        err.statusCode = r.status;
        err.fb = j?.error || null;
        if (isThrottleError(err)) enterCooldown(rt, err, usage);
        throw err;
      }
      data = j.data || [];
      paging = j.paging;
    } else {
      const j = await fbGet(path, token, { limit: Math.min(PAGE_LIMIT, limit - out.length), ...params }, rt);
      data = j.data || [];
      paging = j.paging;
    }
    out.push(...data);
    if (out.length >= limit || !paging?.next || data.length === 0) break;
    next = paging.next;
  }
  return out;
}

// ──────────────────────────────────────────────────────── plaintext renderers

function renderAccount(a) {
  const lines = [
    `[${a.id}] ${a.name || '(account)'}`,
    `  currency: ${a.currency || '—'} · timezone: ${a.timezone_name || '—'} · country: ${a.business_country_code || '—'}`,
    `  status: ${a.account_status_label || a.account_status || '—'} · disable_reason: ${a.disable_reason || '—'}`,
    `  amount_spent: ${money(a.amount_spent != null ? a.amount_spent / 100 : null, a.currency)} · balance: ${money(a.balance != null ? a.balance / 100 : null, a.currency)}`,
    `  spend_cap: ${a.spend_cap != null ? money(a.spend_cap / 100, a.currency) : '—'}`,
    `  business: ${a.business?.name || '—'}${a.business_name ? ' · ' + a.business_name : ''}`,
  ];
  return { plaintext: lines.join('\n'), title: a.name || a.id, summary: a.currency };
}

function insightLine(ins, currency) {
  if (!ins) return '';
  const spend = money(ins.spend, currency);
  const impr = ins.impressions ? Number(ins.impressions).toLocaleString() : '—';
  const clicks = ins.clicks ? Number(ins.clicks).toLocaleString() : '—';
  const ctr = pct(ins.ctr);
  const cpc = ins.cpc ? money(ins.cpc, currency) : '—';
  const cpm = ins.cpm ? money(ins.cpm, currency) : '—';
  const reach = ins.reach ? Number(ins.reach).toLocaleString() : '—';
  const freq = ins.frequency ? Number(ins.frequency).toFixed(2) : '—';
  return `spend=${spend} · impressions=${impr} · clicks=${clicks} · CTR=${ctr} · CPC=${cpc} · CPM=${cpm} · reach=${reach} · freq=${freq}`;
}

function renderCampaign(c, currency, ins) {
  const budget = c.daily_budget ? money(c.daily_budget / 100, currency) + '/day' :
                 c.lifetime_budget ? money(c.lifetime_budget / 100, currency) + ' lifetime' : '—';
  const lines = [
    `[${c.id}] ${c.name || '(campaign)'} · ${c.status}${c.effective_status && c.effective_status !== c.status ? ' (' + c.effective_status + ')' : ''}`,
    `  objective: ${c.objective || '—'} · buying_type: ${c.buying_type || '—'} · budget: ${budget}`,
    `  created: ${fmtIsoShort(c.created_time)}${c.start_time ? ' · start: ' + fmtIsoShort(c.start_time) : ''}${c.stop_time ? ' · stop: ' + fmtIsoShort(c.stop_time) : ''}`,
  ];
  if (ins) lines.push(`  30d: ${insightLine(ins, currency)}`);
  return { plaintext: lines.join('\n'), title: c.name || c.id, summary: c.effective_status || c.status };
}

function renderAdSet(s, currency, ins) {
  const budget = s.daily_budget ? money(s.daily_budget / 100, currency) + '/day' :
                 s.lifetime_budget ? money(s.lifetime_budget / 100, currency) + ' lifetime' : '—';
  const lines = [
    `[${s.id}] ${s.name || '(ad set)'} · ${s.status}${s.effective_status && s.effective_status !== s.status ? ' (' + s.effective_status + ')' : ''}`,
    `  campaign: ${s.campaign_id || '—'} · optimization: ${s.optimization_goal || '—'} · bid: ${s.bid_strategy || '—'}`,
    `  budget: ${budget} · created: ${fmtIsoShort(s.created_time)}`,
  ];
  if (s.targeting) {
    const t = s.targeting;
    const countries = t.geo_locations?.countries?.join(',') || '';
    const age = t.age_min || t.age_max ? `${t.age_min || '?'}–${t.age_max || '?'}` : '';
    const gender = t.genders?.length ? (t.genders.includes(1) && t.genders.includes(2) ? 'all' : t.genders.includes(1) ? 'male' : 'female') : 'all';
    lines.push(`  targeting: ${[countries && 'countries=' + countries, age && 'age=' + age, 'gender=' + gender].filter(Boolean).join(' · ')}`);
  }
  if (ins) lines.push(`  30d: ${insightLine(ins, currency)}`);
  return { plaintext: lines.join('\n'), title: s.name || s.id, summary: s.effective_status || s.status };
}

function renderAd(a, currency, ins) {
  const lines = [
    `[${a.id}] ${a.name || '(ad)'} · ${a.status}${a.effective_status && a.effective_status !== a.status ? ' (' + a.effective_status + ')' : ''}`,
    `  adset: ${a.adset_id || '—'} · campaign: ${a.campaign_id || '—'}${a.creative?.id ? ' · creative: ' + a.creative.id : ''}`,
    `  created: ${fmtIsoShort(a.created_time)}${a.updated_time ? ' · updated: ' + fmtIsoShort(a.updated_time) : ''}`,
  ];
  if (ins) lines.push(`  30d: ${insightLine(ins, currency)}`);
  return { plaintext: lines.join('\n'), title: a.name || a.id, summary: a.effective_status || a.status };
}

function renderCreative(c) {
  const body = c.body || c.object_story_spec?.link_data?.message || '';
  const title = c.title || c.object_story_spec?.link_data?.name || '';
  const cta = c.call_to_action_type || c.object_story_spec?.link_data?.call_to_action?.type || '';
  const url = c.object_story_spec?.link_data?.link || c.link_url || '';
  const lines = [
    `[${c.id}] ${c.name || '(creative)'}`,
    `  title: ${title || '—'}`,
    `  body: ${(body || '').slice(0, 300)}${body.length > 300 ? '…' : ''}`,
    `  cta: ${cta || '—'}${url ? ' · url: ' + url : ''}`,
    `  thumbnail: ${c.thumbnail_url || '—'}${c.image_url ? ' · image: ' + c.image_url : ''}`,
  ];
  return { plaintext: lines.join('\n'), title: c.name || title || c.id, summary: cta || '' };
}

function renderInsight(i, currency, parent) {
  const who = parent ? ` · campaign: ${parent}` : '';
  const name = i.adset_name || i.campaign_name || i.ad_name || '—';
  const lines = [
    `[${i.date_start} → ${i.date_stop}] ${name}${who}`,
    `  ${insightLine(i, currency)}`,
  ];
  return { plaintext: lines.join('\n'), title: `${i.date_start} · ${name}`, summary: money(i.spend, currency) };
}

// ──────────────────────────────────────────────────────── deep backfill

async function deepBackfill(rt) {
  if (!rt || rt.stopped) return;
  if (isPaused(rt)) {
    console.log(`[meta] deep backfill skipped — rate-limit cooldown ${Math.round(msRemainingInCooldown(rt)/1000)}s remaining`);
    return;
  }
  const { token, accountId } = rt;
  const acctPath = `/${accountId}`;
  const currency = rt.account?.currency || 'USD';

  // Account — only fields reachable with ads_read (business_management
  // is required for business{id,name} and business_name).
  try {
    const acct = await fbGet(acctPath, token, {
      fields: 'id,name,account_id,account_status,business_country_code,currency,timezone_name,amount_spent,balance,spend_cap,disable_reason',
    }, rt);
    rt.account = acct;
    await integrationDb.upsertMany([{
      source: 'meta', kind: 'account', external_id: acct.id,
      ts: new Date(), data: acct, ...renderAccount(acct),
    }]);
  } catch (err) {
    logErrorThrottled(rt, 'account pull failed', err);
    if (isAuthError(err)) { disconnect(); return; }
    if (err.throttled || isThrottleError(err)) return;
  }

  // Campaigns + campaign-level insights (last 30d)
  try {
    if (isPaused(rt)) return;
    const campaigns = await fbGetAll(acctPath + '/campaigns', token, {
      fields: 'id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,created_time,start_time,stop_time,updated_time',
    }, 500, rt);
    const insights = await pullInsights(rt, acctPath + '/insights', 'adset');
    // Build a campaign-level aggregation from adset-level insights so the
    // campaign rows still get a 30d rollup on their plaintext dump.
    const campAgg = {};
    for (const i of insights) {
      const id = i.campaign_id;
      if (!id) continue;
      if (!campAgg[id]) campAgg[id] = { spend: 0, impressions: 0, clicks: 0, reach: 0, frequency: 0, _n: 0 };
      campAgg[id].spend += parseFloat(i.spend || 0);
      campAgg[id].impressions += parseInt(i.impressions || 0, 10);
      campAgg[id].clicks += parseInt(i.clicks || 0, 10);
      campAgg[id].reach += parseInt(i.reach || 0, 10);
      campAgg[id].frequency += parseFloat(i.frequency || 0);
      campAgg[id]._n += 1;
    }
    for (const v of Object.values(campAgg)) {
      v.ctr = v.impressions > 0 ? (v.clicks / v.impressions) * 100 : 0;
      v.cpc = v.clicks > 0 ? v.spend / v.clicks : 0;
      v.cpm = v.impressions > 0 ? (v.spend / v.impressions) * 1000 : 0;
      v.frequency = v._n > 0 ? v.frequency / v._n : 0;
    }
    const rows = campaigns.map((c) => ({
      source: 'meta', kind: 'campaign', external_id: c.id,
      ts: new Date(c.updated_time || c.created_time || Date.now()),
      data: c, ...renderCampaign(c, currency, campAgg[c.id]),
    }));
    rt.persisted.campaign = await integrationDb.upsertMany(rows);

    // Persist adset-level insight rows keyed by adset+date so the HQ panel
    // can render a per-adset breakdown (more actionable than campaign-level
    // rollup). `data.adset_id` presence disambiguates these from any legacy
    // campaign-level rows in the table.
    const insightRows = insights.map((i) => ({
      source: 'meta', kind: 'insight', external_id: `${i.adset_id || i.campaign_id || 'acct'}:${i.date_start}:${i.date_stop}`,
      ts: new Date(i.date_stop),
      data: i, ...renderInsight(i, currency, i.campaign_name),
    }));
    rt.persisted.insight = await integrationDb.upsertMany(insightRows);
    console.log(`[meta] persisted ${rt.persisted.campaign} campaign(s) · ${rt.persisted.insight} adset-insight row(s)`);
  } catch (err) {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(rt, 'campaigns failed', err);
    if (err.throttled || isThrottleError(err)) return;
  }

  // Ad sets
  try {
    if (isPaused(rt)) return;
    const adsets = await fbGetAll(acctPath + '/adsets', token, {
      fields: 'id,name,status,effective_status,campaign_id,optimization_goal,bid_strategy,daily_budget,lifetime_budget,created_time,updated_time,targeting',
    }, 1000, rt);
    const rows = adsets.map((s) => ({
      source: 'meta', kind: 'adset', external_id: s.id,
      ts: new Date(s.updated_time || s.created_time || Date.now()),
      data: s, ...renderAdSet(s, currency),
    }));
    rt.persisted.adset = await integrationDb.upsertMany(rows);
    console.log(`[meta] persisted ${rt.persisted.adset} adset(s)`);
  } catch (err) {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(rt, 'adsets failed', err);
    if (err.throttled || isThrottleError(err)) return;
  }

  // Ads
  try {
    if (isPaused(rt)) return;
    const ads = await fbGetAll(acctPath + '/ads', token, {
      fields: 'id,name,status,effective_status,adset_id,campaign_id,creative,created_time,updated_time',
    }, 2000, rt);
    const rows = ads.map((a) => ({
      source: 'meta', kind: 'ad', external_id: a.id,
      ts: new Date(a.updated_time || a.created_time || Date.now()),
      data: a, ...renderAd(a, currency),
    }));
    rt.persisted.ad = await integrationDb.upsertMany(rows);
    console.log(`[meta] persisted ${rt.persisted.ad} ad(s)`);
  } catch (err) {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(rt, 'ads failed', err);
    if (err.throttled || isThrottleError(err)) return;
  }

  // Creatives
  try {
    if (isPaused(rt)) return;
    const creatives = await fbGetAll(acctPath + '/adcreatives', token, {
      fields: 'id,name,title,body,call_to_action_type,image_url,thumbnail_url,link_url',
    }, 2000, rt);
    const rows = creatives.map((c) => ({
      source: 'meta', kind: 'creative', external_id: c.id,
      ts: new Date(),
      data: c, ...renderCreative(c),
    }));
    rt.persisted.creative = await integrationDb.upsertMany(rows);
    console.log(`[meta] persisted ${rt.persisted.creative} creative(s)`);
  } catch (err) {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(rt, 'creatives failed', err);
    if (err.throttled || isThrottleError(err)) return;
  }

  rt.deepBackfillDoneAt = Date.now();
  console.log('[meta] deep backfill complete');
}

// Insights with time_range covering last INSIGHT_DAYS. Level controls the
// breakdown: 'account', 'campaign', 'adset', 'ad'. `time_increment: 1`
// returns one row per day so the /summary endpoint can filter by
// date_start for today / 7d / 30d windows — `all_days` would collapse
// everything into a single row per entity, making per-window slicing
// impossible.
async function pullInsights(rt, path, level) {
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - INSIGHT_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  // Entity × days ≈ few hundred rows for a typical account; fbGetAll
  // pages through with MAX_PAGES×PAGE_LIMIT = 1000 as a cap.
  return await fbGetAll(path, rt.token, {
    level,
    fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,action_values,purchase_roas,outbound_clicks,date_start,date_stop',
    time_range: { since, until },
    time_increment: 1,
  }, 1000, rt);
}

// ──────────────────────────────────────────────────────── connect / disconnect

function logErrorThrottled(rt, label, err) {
  const now = Date.now();
  if (!rt || now - rt.lastErrorLogAt < 60_000) return;
  if (rt) rt.lastErrorLogAt = now;
  console.error(`[meta] ${label}:`, err?.message || err);
}

export async function connect({ emit, token, accountId }) {
  if (runtime) disconnect();
  if (!token) throw new Error('FB access token required');
  if (!accountId) throw new Error('FB ad account id required');
  const normAcct = accountId.startsWith('act_') ? accountId : `act_${accountId}`;

  // Validate token against /me, then pull the account info. Either call
  // will throw on a bad token. Thread a pre-runtime stub so these two
  // validation calls also populate the rate-limit state we'll move onto
  // the real runtime below.
  const preRt = { rateLimit: { worstPct: 0, pausedUntil: 0, throttleCount: 0, lastThrottleAt: 0, lastThrottleCode: null, seenAt: 0 } };
  const me = await fbGet('/me', token, { fields: 'id,name' }, preRt);
  const acct = await fbGet(`/${normAcct}`, token, {
    fields: 'id,name,account_id,account_status,business_country_code,currency,timezone_name,amount_spent,balance,spend_cap,disable_reason',
  }, preRt);

  runtime = {
    token,
    tokenMask: maskToken(token),
    accountId: normAcct,
    emit,
    me,
    account: acct,
    connectedAt: Date.now(),
    lastErrorLogAt: 0,
    stopped: false,
    pollTimer: null,
    resyncTimer: null,
    persisted: {},
    deepBackfillDoneAt: null,
    lastPollAt: null,
    pollIntervalMs: POLL_INTERVAL_MS,
    resyncIntervalMs: DEEP_RESYNC_MS,
    rateLimit: preRt.rateLimit,
    lastManualBackfillAt: 0,
  };

  console.log(`[meta] connected · ${normAcct} · "${acct.name}" · token=${maskToken(token)} · poll=${Math.round(POLL_INTERVAL_MS/1000)}s · resync=${Math.round(DEEP_RESYNC_MS/60000)}min`);

  if (typeof dataCore.markSourceLive === 'function') dataCore.markSourceLive('meta_ads');

  deepBackfill(runtime).catch((err) => {
    if (isAuthError(err)) { disconnect(); return; }
    logErrorThrottled(runtime, 'deep backfill failed', err);
  });

  runtime.pollTimer = setTimeout(() => tick(runtime), POLL_INTERVAL_MS);
  runtime.pollTimer?.unref?.();

  runtime.resyncTimer = setInterval(() => {
    const rt = runtime;
    if (!rt || rt.stopped) return;
    // Skip scheduled resyncs when we're paused or running hot. Letting a
    // deep resync (~50 calls) fire while already at >=75% usage is the
    // single most likely way to push us into a server-side throttle.
    if (isPaused(rt)) {
      console.log(`[meta] scheduled deep resync skipped — cooldown ${Math.round(msRemainingInCooldown(rt)/1000)}s remaining`);
      return;
    }
    if ((rt.rateLimit?.worstPct || 0) >= 75) {
      console.log(`[meta] scheduled deep resync skipped — rate-limit usage at ${rt.rateLimit.worstPct}%`);
      return;
    }
    rt.persisted = {};
    rt.deepBackfillDoneAt = null;
    console.log('[meta] scheduled deep resync starting');
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
  console.log('[meta] disconnected');
  runtime = null;
}

export function getStatus() {
  if (!runtime) return { connected: false };
  const rl = runtime.rateLimit || {};
  const cooldownRemainingMs = isPaused(runtime) ? msRemainingInCooldown(runtime) : 0;
  return {
    connected: true,
    account_id: runtime.account?.id,
    account_name: runtime.account?.name,
    currency: runtime.account?.currency,
    country: runtime.account?.business_country_code,
    token_mask: runtime.tokenMask,
    me_name: runtime.me?.name,
    connected_at: runtime.connectedAt,
    persisted: runtime.persisted || {},
    deep_backfill_done_at: runtime.deepBackfillDoneAt,
    last_poll_at: runtime.lastPollAt,
    poll_interval_ms: runtime.pollIntervalMs,
    resync_interval_ms: runtime.resyncIntervalMs,
    rate_limit: {
      worst_pct: rl.worstPct || 0,
      tier: rl.tier || null,
      paused: cooldownRemainingMs > 0,
      cooldown_remaining_s: Math.ceil(cooldownRemainingMs / 1000),
      last_throttle_at: rl.lastThrottleAt || null,
      last_throttle_code: rl.lastThrottleCode || null,
      throttle_count: rl.throttleCount || 0,
      seen_at: rl.seenAt || null,
      app_usage: rl.appUsage || null,
      buc_usage: rl.bucUsage || null,
      ad_account_usage: rl.adAcctUsage || null,
    },
  };
}

// ──────────────────────────────────────────────────────── poll loop

// Compute the delay before the next tick based on current rate-limit
// state. A 10s buffer past the cooldown end keeps us from hammering the
// very edge of the window; usage-based multipliers keep headroom before
// we ever get cut off.
function nextPollDelayMs(rt) {
  const base = rt.pollIntervalMs || POLL_INTERVAL_MS;
  if (isPaused(rt)) return Math.max(base, msRemainingInCooldown(rt) + 10_000);
  const pct = rt.rateLimit?.worstPct || 0;
  if (pct >= 90) return base * 4;
  if (pct >= 75) return base * 2;
  return base;
}

async function tick(rt) {
  if (!runtime || runtime !== rt || rt.stopped) return;
  // Short-circuit the work entirely while cooling down. The finally block
  // will reschedule for (cooldown + buffer).
  if (isPaused(rt)) {
    if (runtime === rt && !rt.stopped) {
      rt.pollTimer = setTimeout(() => tick(rt), nextPollDelayMs(rt));
      rt.pollTimer?.unref?.();
    }
    return;
  }
  try {
    // Cheap poll: today's adset-level insights. Adset granularity is more
    // actionable than campaign-level (one campaign often has multiple
    // targeting variants worth watching independently). Full drift
    // correction happens in the scheduled resync.
    const today = new Date().toISOString().slice(0, 10);
    const ins = await fbGetAll(`/${rt.accountId}/insights`, rt.token, {
      level: 'adset',
      fields: 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions,action_values,purchase_roas,outbound_clicks,date_start,date_stop',
      time_range: { since: today, until: today },
    }, 500, rt);
    const currency = rt.account?.currency || 'USD';
    const rows = ins.map((i) => ({
      source: 'meta', kind: 'insight', external_id: `${i.adset_id || i.campaign_id || 'acct'}:${i.date_start}:${i.date_stop}`,
      ts: new Date(), data: i, ...renderInsight(i, currency, i.campaign_name),
    }));
    await integrationDb.upsertMany(rows);

    // Emit a few events onto the shared bus so /hq ticks the meta panel.
    for (const i of ins) {
      rt.emit({
        source: 'meta_ads', kind: 'insight_poll', ts: Date.now(),
        title: i.adset_name || i.campaign_name || 'adset',
        summary: `spend ${money(i.spend, currency)} · CTR ${pct(i.ctr)}`,
        data: { adset: i.adset_name, campaign: i.campaign_name, spend: parseFloat(i.spend || 0), ctr: parseFloat(i.ctr || 0), clicks: parseInt(i.clicks || 0, 10) },
      });
    }
    rt.lastPollAt = Date.now();
  } catch (err) {
    if (isAuthError(err)) { disconnect(); return; }
    // Throttle errors are already converted to a cooldown inside fbGet /
    // fbGetAll — we just log once and fall through to rescheduling.
    logErrorThrottled(rt, 'poll failed', err);
  } finally {
    if (runtime === rt && !rt.stopped) {
      rt.pollTimer = setTimeout(() => tick(rt), nextPollDelayMs(rt));
      rt.pollTimer?.unref?.();
    }
  }
}

// ──────────────────────────────────────────────────────── env-based boot

export async function start({ emit }) {
  const token = process.env.FB_ACCESS_TOKEN;
  const accountId = process.env.FB_AD_ACCOUNT_ID;
  if (!token || !accountId) {
    console.log('[meta] skipped (missing FB_ACCESS_TOKEN or FB_AD_ACCOUNT_ID)');
    return;
  }
  try {
    await connect({ emit, token, accountId });
  } catch (err) {
    console.error('[meta] start failed:', err?.message || err);
  }
}

// ──────────────────────────────────────────────────────── routes

export function mountRoutes(app, { emit }) {
  app.get('/omo/api/integrations/meta/status', (_req, res) => {
    res.json(getStatus());
  });

  app.post('/omo/api/integrations/meta/connect', express.json(), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const accountId = String(req.body?.account_id || req.body?.accountId || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
    if (!accountId) return res.status(400).json({ ok: false, error: 'Missing ad account id (e.g. act_123...)' });
    try {
      const status = await connect({ emit, token, accountId });
      res.json({ ok: true, status });
    } catch (err) {
      const code = err?.statusCode || 500;
      res.status(code >= 400 && code < 500 ? 400 : 500).json({ ok: false, error: err?.message || String(err), fb: err?.fb || null });
    }
  });

  app.post('/omo/api/integrations/meta/disconnect', (_req, res) => {
    disconnect();
    res.json({ ok: true });
  });

  // Manual backfill debounce: a deep backfill is ~50 API calls. The /hq
  // UI can trigger this via a button click, so we must prevent a user
  // from spamming it past the app's hourly BUC budget. `force=1` lets us
  // override for tests or recovery after a long outage.
  const MANUAL_BACKFILL_MIN_GAP_MS = 5 * 60_000;
  app.post('/omo/api/integrations/meta/backfill', async (req, res) => {
    if (!runtime) return res.status(409).json({ ok: false, error: 'Not connected — connect first.' });
    const rt = runtime;
    const force = req.query.force === '1' || req.query.force === 'true';
    if (isPaused(rt) && !force) {
      return res.status(429).json({
        ok: false,
        error: `Meta rate-limit cooldown in effect. Retry in ${Math.ceil(msRemainingInCooldown(rt)/1000)}s or pass ?force=1.`,
        cooldown_remaining_s: Math.ceil(msRemainingInCooldown(rt)/1000),
      });
    }
    const since = Date.now() - (rt.lastManualBackfillAt || 0);
    if (!force && rt.lastManualBackfillAt && since < MANUAL_BACKFILL_MIN_GAP_MS) {
      return res.status(429).json({
        ok: false,
        error: `Manual backfill was run ${Math.round(since/1000)}s ago. Wait at least ${Math.round(MANUAL_BACKFILL_MIN_GAP_MS/1000)}s between runs, or pass ?force=1.`,
        next_allowed_in_s: Math.ceil((MANUAL_BACKFILL_MIN_GAP_MS - since)/1000),
      });
    }
    const prune = req.query.prune === '1' || req.query.prune === 'true';
    const waitForDone = req.query.wait === '1' || req.query.wait === 'true';
    rt.lastManualBackfillAt = Date.now();
    try {
      if (prune) {
        const n = await integrationDb.pruneSource('meta');
        console.log(`[meta] pruned ${n} existing row(s) before backfill`);
      }
      rt.persisted = {};
      rt.deepBackfillDoneAt = null;
      const p = deepBackfill(rt).catch((err) => {
        if (isAuthError(err)) { disconnect(); return; }
        logErrorThrottled(rt, 'manual backfill failed', err);
      });
      if (waitForDone) await p;
      res.json({ ok: true, pruned: prune, waited: waitForDone, status: getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // Compact aggregated summary for the /hq META panel — no mock. Reads
  // directly from integration_data and returns today + 30d totals plus
  // the top campaigns by spend, account context, and a live ROAS if the
  // insights carried purchase_roas.
  // 5s in-memory cache keyed by `?include=` so the compact view's default
  // body and the fullscreen view's enriched body don't poison each other.
  let summaryCache = {}; // { [includeKey]: { at, body } }
  // 30s TTL: panel summary recompute walks 5000+ insight rows synchronously
  // (~250–500ms). Under heavy backfill this serializes behind upserts on
  // the same Postgres pool and the panel sits "loading" for tens of
  // seconds. 30s is short enough to feel live; the trend chart still
  // refreshes within one breath.
  const SUMMARY_TTL_MS = 30_000;
  // Action types that count as a "conversion" for CPA / volume rollups.
  // Meta returns dozens of variants depending on the pixel/CAPI setup; we
  // accept any of these. Keep this list module-shared so /summary's hero
  // strip and the per-campaign detail use the same definition of "conversion".
  const CONVERSION_ACTIONS = new Set([
    'purchase',
    'omni_purchase',
    'offsite_conversion.fb_pixel_purchase',
    'complete_registration',
    'lead',
    'onsite_conversion.lead_grouped',
    'onsite_conversion.purchase',
    'offsite_conversion.fb_pixel_lead',
    'offsite_conversion.fb_pixel_complete_registration',
  ]);
  const VALUE_ACTION_TYPES = new Set([
    'purchase',
    'omni_purchase',
    'offsite_conversion.fb_pixel_purchase',
    'onsite_conversion.purchase',
  ]);

  app.get('/omo/api/integrations/meta/summary', async (req, res) => {
    const includeTokens = String(req.query.include || '')
      .split(/[,\s]+/)
      .filter(Boolean);
    const includeSet = new Set(includeTokens);
    const wantTrend = includeSet.has('trend') || includeSet.has('focus');
    const wantCampaignsDetail = includeSet.has('campaigns_detail') || includeSet.has('focus');
    const wantFocus = includeSet.has('focus');
    const wantObjectives = wantFocus || includeSet.has('objectives');
    const wantStatus = wantFocus || includeSet.has('status');
    const wantCreatives = wantFocus || includeSet.has('creatives');
    const wantAudience = wantFocus || includeSet.has('audience');
    const wantDow = wantFocus || includeSet.has('dow') || includeSet.has('day_of_week');
    const wantAnomalies = wantFocus || includeSet.has('anomalies');
    const wantTopAds = wantFocus || includeSet.has('top_ads');
    // Optional custom date range — voice-driven via meta_dashboard_command
    // op="time_scope". When present, the response carries an additional
    // `custom` aggregate plus top_campaigns_custom / top_adsets_custom
    // computed over the chosen range. The fixed today/last7/all stay so
    // the page can keep showing them on the headline strip if needed.
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const since = ISO.test(String(req.query.since || '')) ? String(req.query.since) : null;
    const until = ISO.test(String(req.query.until || '')) ? String(req.query.until) : null;
    const customKey = (since && until) ? `${since}_${until}` : 'none';
    const includeKey = (includeTokens.slice().sort().join(',') || 'base') + '|' + customKey;
    const cached = summaryCache[includeKey];
    if (cached && cached.body && (Date.now() - cached.at) < SUMMARY_TTL_MS) {
      return res.json(cached.body);
    }
    try {
      const rawRows = await integrationDb.listBySource('meta', { kind: 'insight', limit: 5000 });
      const account = (await integrationDb.listBySource('meta', { kind: 'account', limit: 1 }))[0] || null;
      const campaignRows = await integrationDb.listBySource('meta', { kind: 'campaign', limit: 1000 });
      const adsetRows = await integrationDb.listBySource('meta', { kind: 'adset', limit: 2000 });
      // Ad + creative rows only when something needs them (saves a query
      // on the cheap-poll cadence).
      const adRows = (wantTopAds || wantStatus) ? await integrationDb.listBySource('meta', { kind: 'ad', limit: 5000 }) : [];
      const creativeRows = wantCreatives ? await integrationDb.listBySource('meta', { kind: 'creative', limit: 2000 }) : [];
      const campaignNameById = {};
      const campaignObjectiveById = {};
      for (const c of campaignRows) {
        const d = c.data || {};
        if (d.id) {
          campaignNameById[d.id] = d.name;
          if (d.objective) campaignObjectiveById[d.id] = d.objective;
        }
      }
      const adsetNameById = {};
      const adsetCampaignById = {};
      for (const s of adsetRows) {
        const d = s.data || {};
        if (d.id) {
          adsetNameById[d.id] = d.name;
          if (d.campaign_id) adsetCampaignById[d.id] = d.campaign_id;
        }
      }
      // Prefer adset-level rows (presence of adset_id in data). Any legacy
      // campaign-only rows from earlier versions are ignored here so totals
      // don't double-count. Also drop multi-day aggregate rows (where
      // date_start !== date_stop) left over from when the backfill used
      // `time_increment: 'all_days'` — they'd otherwise get summed on top
      // of the per-day rows for the same adset.
      const adsetOnly = rawRows.filter((r) => r.data?.adset_id);
      const daily = adsetOnly.filter((r) => r.data?.date_start && r.data?.date_start === r.data?.date_stop);
      const rows = daily.length > 0 ? daily : (adsetOnly.length > 0 ? adsetOnly : rawRows);
      const today = new Date().toISOString().slice(0, 10);
      const agg = (items) => {
        let spend = 0, impressions = 0, clicks = 0, reach = 0, ctrClicks = 0, ctrImpr = 0;
        let roasNumSpend = 0, roasNumReturn = 0;
        let outboundClicks = 0;
        let conversions = 0, conversionValue = 0;
        let freqSum = 0, freqN = 0;
        for (const it of items) {
          const d = it?.data || it;
          if (!d) continue;
          const s = parseFloat(d.spend || 0);
          const i = parseInt(d.impressions || 0, 10);
          const c = parseInt(d.clicks || 0, 10);
          const r = parseInt(d.reach || 0, 10);
          spend += s; impressions += i; clicks += c; reach += r;
          ctrClicks += c; ctrImpr += i;
          // purchase_roas is an array: [{ action_type, value }]. Use the
          // first numeric value if present, weighted by spend so a small
          // campaign can't skew the account-level ROAS.
          const roas = Array.isArray(d.purchase_roas) ? parseFloat(d.purchase_roas[0]?.value) : null;
          if (roas && !Number.isNaN(roas) && s > 0) {
            roasNumSpend += s;
            roasNumReturn += s * roas;
          }
          // outbound_clicks is also an array — sum the first entry's value
          // (Meta returns one row per action_type; for non-broken-down
          // queries like ours, it's a single { action_type, value } pair).
          if (Array.isArray(d.outbound_clicks)) {
            for (const oc of d.outbound_clicks) {
              const v = parseFloat(oc?.value || 0);
              if (!Number.isNaN(v)) outboundClicks += v;
            }
          }
          if (Array.isArray(d.actions)) {
            for (const act of d.actions) {
              if (!act?.action_type) continue;
              if (CONVERSION_ACTIONS.has(act.action_type)) {
                const v = parseFloat(act.value || 0);
                if (!Number.isNaN(v)) conversions += v;
              }
            }
          }
          if (Array.isArray(d.action_values)) {
            for (const av of d.action_values) {
              if (!av?.action_type) continue;
              if (VALUE_ACTION_TYPES.has(av.action_type)) {
                const v = parseFloat(av.value || 0);
                if (!Number.isNaN(v)) conversionValue += v;
              }
            }
          }
          const f = parseFloat(d.frequency || 0);
          if (f > 0 && !Number.isNaN(f)) { freqSum += f; freqN += 1; }
        }
        const ctr = ctrImpr > 0 ? (ctrClicks / ctrImpr) * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;
        const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
        const roas = roasNumSpend > 0 ? roasNumReturn / roasNumSpend : null;
        const outboundCtr = ctrImpr > 0 ? (outboundClicks / ctrImpr) * 100 : 0;
        const cpa = conversions > 0 ? spend / conversions : null;
        const frequency = freqN > 0 ? freqSum / freqN : 0;
        return {
          spend, impressions, clicks, reach, ctr, cpc, cpm, roas,
          outbound_clicks: outboundClicks, outbound_ctr: outboundCtr,
          conversions, conversion_value: conversionValue, cpa,
          frequency,
        };
      };
      const byCampaign = {};
      const byAdset = {};
      const addCampaign = (bucket, d) => {
        const id = d.campaign_id || 'acct';
        const name = d.campaign_name || campaignNameById[id] || id;
        if (!bucket[id]) bucket[id] = { id, name, spend: 0, clicks: 0, impressions: 0 };
        bucket[id].spend += parseFloat(d.spend || 0);
        bucket[id].clicks += parseInt(d.clicks || 0, 10);
        bucket[id].impressions += parseInt(d.impressions || 0, 10);
      };
      const addAdset = (bucket, d) => {
        const id = d.adset_id || 'unknown';
        const name = d.adset_name || adsetNameById[id] || id;
        const campaignId = d.campaign_id || adsetCampaignById[id] || null;
        const campaignName = d.campaign_name || (campaignId ? campaignNameById[campaignId] : null) || null;
        if (!bucket[id]) bucket[id] = {
          id, name, campaign_id: campaignId, campaign_name: campaignName,
          spend: 0, clicks: 0, impressions: 0,
          conversions: 0, conversion_value: 0,
          roas_spend_num: 0, roas_return_num: 0,   // weighted ROAS accumulators
          freq_sum: 0, freq_n: 0,
        };
        const b = bucket[id];
        const s = parseFloat(d.spend || 0);
        b.spend += s;
        b.clicks += parseInt(d.clicks || 0, 10);
        b.impressions += parseInt(d.impressions || 0, 10);
        if (Array.isArray(d.actions)) {
          for (const act of d.actions) {
            if (act?.action_type && CONVERSION_ACTIONS.has(act.action_type)) {
              const v = parseFloat(act.value || 0);
              if (!Number.isNaN(v)) b.conversions += v;
            }
          }
        }
        if (Array.isArray(d.action_values)) {
          for (const av of d.action_values) {
            if (av?.action_type && VALUE_ACTION_TYPES.has(av.action_type)) {
              const v = parseFloat(av.value || 0);
              if (!Number.isNaN(v)) b.conversion_value += v;
            }
          }
        }
        const roas = Array.isArray(d.purchase_roas) ? parseFloat(d.purchase_roas[0]?.value) : null;
        if (roas && !Number.isNaN(roas) && s > 0) {
          b.roas_spend_num += s;
          b.roas_return_num += s * roas;
        }
        const f = parseFloat(d.frequency || 0);
        if (f > 0 && !Number.isNaN(f)) { b.freq_sum += f; b.freq_n += 1; }
      };
      // Cutoff for the "last 7 days" window — inclusive of today. Dates
      // are compared as YYYY-MM-DD strings since that's how Meta returns
      // date_start / date_stop.
      const d7 = new Date(Date.now() - 6 * 86400 * 1000).toISOString().slice(0, 10);
      const todayRows = [];
      const last7Rows = [];
      const allRows = [];
      const byCampaignLast7 = {};
      const byAdsetLast7 = {};
      for (const r of rows) {
        const d = r.data || {};
        if (!d.date_start) continue;
        if (d.date_start === today) {
          todayRows.push(d);
          addCampaign(byCampaign, d);
          addAdset(byAdset, d);
        }
        if (d.date_start >= d7) {
          last7Rows.push(d);
          addCampaign(byCampaignLast7, d);
          addAdset(byAdsetLast7, d);
        }
        allRows.push(d);
      }
      const byCampaignAll = {};
      const byAdsetAll = {};
      for (const d of allRows) { addCampaign(byCampaignAll, d); addAdset(byAdsetAll, d); }

      // Custom-range aggregate. Filter daily rows by date_start within the
      // requested [since, until] window and roll up campaign/adset bucks.
      const customRows = [];
      const byCampaignCustom = {};
      const byAdsetCustom = {};
      if (since && until) {
        const lo = since, hi = until;
        for (const d of allRows) {
          if (d.date_start && d.date_start >= lo && d.date_start <= hi) {
            customRows.push(d);
            addCampaign(byCampaignCustom, d);
            addAdset(byAdsetCustom, d);
          }
        }
      }
      // Return every entry with non-zero spend, ordered by spend desc.
      // Cap at 200 to keep the payload bounded for pathological accounts.
      // Adsets carry ROAS/CPA/conversions/frequency from the enriched
      // accumulator (campaigns just have spend/clicks/impressions for
      // backwards compat — campaigns_detail covers the deeper view).
      const topN = (bucket, n = 200) => Object.values(bucket)
        .map((c) => {
          const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
          const cpc = c.clicks > 0 ? c.spend / c.clicks : 0;
          const cpm = c.impressions > 0 ? (c.spend / c.impressions) * 1000 : 0;
          // Adset-only fields (presence of roas_spend_num signals it's an
          // adset bucket; campaigns omit these accumulators).
          const out = { ...c, ctr, cpc, cpm };
          if (typeof c.roas_spend_num === 'number') {
            out.roas = c.roas_spend_num > 0 ? c.roas_return_num / c.roas_spend_num : null;
            out.cpa = c.conversions > 0 ? c.spend / c.conversions : null;
            out.frequency = c.freq_n > 0 ? c.freq_sum / c.freq_n : 0;
            // Drop accumulator fields from the wire shape.
            delete out.roas_spend_num; delete out.roas_return_num;
            delete out.freq_sum; delete out.freq_n;
          }
          return out;
        })
        .filter((c) => c.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, n);
      const body = {
        connected: !!runtime,
        account: account ? {
          id: account.data?.id || account.external_id,
          name: account.data?.name,
          currency: account.data?.currency,
          country: account.data?.business_country_code,
          amount_spent: account.data?.amount_spent != null ? parseFloat(account.data.amount_spent) / 100 : null,
          balance: account.data?.balance != null ? parseFloat(account.data.balance) / 100 : null,
        } : null,
        today: agg(todayRows),
        last7: agg(last7Rows),
        all: agg(allRows),
        custom: (since && until) ? agg(customRows) : null,
        range: (since && until) ? { start: since, end: until, days: 1 + Math.floor((Date.parse(until) - Date.parse(since)) / 86400000) } : null,
        top_campaigns_today: topN(byCampaign),
        top_campaigns_last7: topN(byCampaignLast7),
        top_campaigns_all: topN(byCampaignAll),
        top_campaigns_custom: (since && until) ? topN(byCampaignCustom) : null,
        top_adsets_today: topN(byAdset),
        top_adsets_last7: topN(byAdsetLast7),
        top_adsets_all: topN(byAdsetAll),
        top_adsets_custom: (since && until) ? topN(byAdsetCustom) : null,
        counts: {
          campaigns: campaignRows.length,
          adsets: adsetRows.length,
          insight_rows: rows.length,
          today_rows: todayRows.length,
          last7_rows: last7Rows.length,
          custom_rows: (since && until) ? customRows.length : null,
        },
        last_poll_at: getStatus().last_poll_at,
        deep_backfill_done_at: getStatus().deep_backfill_done_at,
      };

      // Optional enrichment: 30-day daily trend derived from the same
      // insight rows (pre-seeded with zero entries so the x-axis is
      // continuous even on days with no spend).
      if (wantTrend) {
        try {
          const byDay = {};
          // Pre-seed all 30 days ending today (inclusive) so the client
          // always has 30 entries in chronological order.
          for (let k = 29; k >= 0; k--) {
            const date = new Date(Date.now() - k * 86400 * 1000)
              .toISOString()
              .slice(0, 10);
            byDay[date] = [];
          }
          for (const r of rows) {
            const d = r.data || {};
            const day = d.date_start;
            if (!day) continue;
            if (!byDay[day]) continue; // outside the 30-day window
            byDay[day].push(d);
          }
          const trend = Object.keys(byDay)
            .sort() // ISO strings sort chronologically, oldest first
            .map((date) => {
              const items = byDay[date];
              if (!items.length) {
                return {
                  date,
                  spend: 0,
                  impressions: 0,
                  clicks: 0,
                  ctr: 0,
                  cpc: 0,
                  cpm: 0,
                  roas: 0,
                  reach: 0,
                };
              }
              const a = agg(items);
              return {
                date,
                spend: a.spend,
                impressions: a.impressions,
                clicks: a.clicks,
                ctr: a.ctr,
                cpc: a.cpc,
                cpm: a.cpm,
                roas: a.roas || 0,
                reach: a.reach,
              };
            });
          body.trend = trend;
        } catch (err) {
          console.warn('[meta] trend build failed:', err?.message || err);
          body.trend = null;
        }
      }

      // Optional enrichment: per-campaign detail that merges campaignRows
      // (raw config) with an aggregate over rawRows (spend/roas/conv).
      if (wantCampaignsDetail) {
        try {
          const detailAgg = {}; // campaign_id -> { spend, roasNumSpend, roasNumReturn, conversions }
          for (const r of rows) {
            const d = r.data || {};
            const cid = d.campaign_id;
            if (!cid) continue;
            if (!detailAgg[cid]) {
              detailAgg[cid] = {
                spend: 0,
                roasNumSpend: 0,
                roasNumReturn: 0,
                conversions: 0,
              };
            }
            const bucket = detailAgg[cid];
            const s = parseFloat(d.spend || 0);
            bucket.spend += s;
            const roasVal = Array.isArray(d.purchase_roas)
              ? parseFloat(d.purchase_roas[0]?.value)
              : null;
            if (roasVal && !Number.isNaN(roasVal) && s > 0) {
              bucket.roasNumSpend += s;
              bucket.roasNumReturn += s * roasVal;
            }
            if (Array.isArray(d.actions)) {
              for (const act of d.actions) {
                if (!act || !act.action_type) continue;
                if (CONVERSION_ACTIONS.has(act.action_type)) {
                  const v = parseFloat(act.value || 0);
                  if (!Number.isNaN(v)) bucket.conversions += v;
                }
              }
            }
          }
          const campaignsDetail = campaignRows.map((row) => {
            const d = row.data || {};
            const agg = detailAgg[d.id] || null;
            const roas = agg && agg.roasNumSpend > 0
              ? agg.roasNumReturn / agg.roasNumSpend
              : null;
            const conversions = agg ? agg.conversions : 0;
            return {
              id: d.id || row.external_id,
              name: d.name || null,
              status: d.status || null,
              effective_status: d.effective_status || null,
              objective: d.objective || null,
              buying_type: d.buying_type || null,
              daily_budget: d.daily_budget != null ? parseFloat(d.daily_budget) : null,
              lifetime_budget: d.lifetime_budget != null ? parseFloat(d.lifetime_budget) : null,
              created_time: d.created_time || null,
              start_time: d.start_time || null,
              stop_time: d.stop_time || null,
              roas,
              conversions,
            };
          });
          body.campaigns_detail = campaignsDetail;
        } catch (err) {
          console.warn('[meta] campaigns_detail build failed:', err?.message || err);
          body.campaigns_detail = null;
        }
      }

      // Optional: spend & conversions per objective. Joins insights to
      // campaigns via campaign_id → objective. The resulting rollup is the
      // primary input for the funnel-by-objective card on the focus page.
      if (wantObjectives) {
        try {
          const byObj = {}; // OUTCOME_TRAFFIC -> { spend, conversions, conversion_value, campaigns:Set }
          for (const r of rows) {
            const d = r.data || {};
            const cid = d.campaign_id;
            const obj = (cid && campaignObjectiveById[cid]) || 'UNKNOWN';
            if (!byObj[obj]) byObj[obj] = { objective: obj, spend: 0, conversions: 0, conversion_value: 0, campaigns: new Set() };
            const b = byObj[obj];
            b.spend += parseFloat(d.spend || 0);
            if (cid) b.campaigns.add(cid);
            if (Array.isArray(d.actions)) {
              for (const act of d.actions) {
                if (!act?.action_type) continue;
                if (CONVERSION_ACTIONS.has(act.action_type)) {
                  const v = parseFloat(act.value || 0);
                  if (!Number.isNaN(v)) b.conversions += v;
                }
              }
            }
            if (Array.isArray(d.action_values)) {
              for (const av of d.action_values) {
                if (!av?.action_type) continue;
                if (VALUE_ACTION_TYPES.has(av.action_type)) {
                  const v = parseFloat(av.value || 0);
                  if (!Number.isNaN(v)) b.conversion_value += v;
                }
              }
            }
          }
          body.objectives = Object.values(byObj)
            .map((b) => ({
              objective: b.objective,
              spend: b.spend,
              conversions: b.conversions,
              conversion_value: b.conversion_value,
              campaigns: b.campaigns.size,
              roas: b.spend > 0 ? b.conversion_value / b.spend : null,
              cpa: b.conversions > 0 ? b.spend / b.conversions : null,
            }))
            .sort((a, b) => b.spend - a.spend);
        } catch (err) {
          console.warn('[meta] objectives build failed:', err?.message || err);
          body.objectives = null;
        }
      }

      // Optional: live entity status counts. Counts effective_status across
      // campaigns / adsets / ads so the focus page can show how many are
      // active vs paused vs flagged. Mirrors the breakdown that's most
      // useful on the Ads Manager dashboard's left rail.
      if (wantStatus) {
        try {
          const tally = (rowsArr) => {
            const out = {};
            for (const r of rowsArr) {
              const k = (r.data?.effective_status || r.data?.status || 'UNKNOWN');
              out[k] = (out[k] || 0) + 1;
            }
            return out;
          };
          body.status_breakdown = {
            campaigns: tally(campaignRows),
            adsets: tally(adsetRows),
            ads: tally(adRows),
          };
          // Buying type rollup (AUCTION vs RESERVED) — useful when an
          // account mixes brand reservations with auction campaigns.
          const buying = {};
          for (const c of campaignRows) {
            const k = c.data?.buying_type || 'UNKNOWN';
            buying[k] = (buying[k] || 0) + 1;
          }
          body.status_breakdown.buying_types = buying;
        } catch (err) {
          console.warn('[meta] status build failed:', err?.message || err);
          body.status_breakdown = null;
        }
      }

      // Optional: creative gallery. Joins ad rows → creative rows so each
      // creative carries the spend/impressions of every ad that ran with it.
      // Sorted by spend desc, capped at 24 for the focus gallery card.
      if (wantCreatives) {
        try {
          const creativeById = {};
          for (const cr of creativeRows) {
            const d = cr.data || {};
            if (!d.id) continue;
            creativeById[d.id] = {
              id: d.id,
              name: d.name || null,
              title: d.title || null,
              body: d.body || null,
              call_to_action_type: d.call_to_action_type || null,
              thumbnail_url: d.thumbnail_url || null,
              image_url: d.image_url || null,
              link_url: d.link_url || null,
              spend: 0,
              impressions: 0,
              clicks: 0,
              ad_count: 0,
            };
          }
          // Build ad-level spend/impressions from insight rows that carry an
          // ad_id (we currently fetch level=adset, so this is empty for most
          // accounts — tolerate that). Where it isn't, distribute to the
          // creative attached to the ad.
          const adById = {};
          for (const a of adRows) {
            const d = a.data || {};
            if (!d.id) continue;
            adById[d.id] = { creative_id: d.creative?.id || null };
          }
          for (const r of rows) {
            const d = r.data || {};
            const adId = d.ad_id;
            if (!adId) continue;
            const creativeId = adById[adId]?.creative_id;
            if (!creativeId || !creativeById[creativeId]) continue;
            const c = creativeById[creativeId];
            c.spend += parseFloat(d.spend || 0);
            c.impressions += parseInt(d.impressions || 0, 10);
            c.clicks += parseInt(d.clicks || 0, 10);
          }
          // Tally how many distinct ads use each creative (independent of
          // whether we have ad-level insights for them).
          for (const a of adRows) {
            const cid = a.data?.creative?.id;
            if (cid && creativeById[cid]) creativeById[cid].ad_count += 1;
          }
          body.creatives = Object.values(creativeById)
            .map((c) => ({
              ...c,
              ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
            }))
            .sort((a, b) => (b.spend - a.spend) || (b.ad_count - a.ad_count))
            .slice(0, 24);
          body.creatives_total = creativeRows.length;
        } catch (err) {
          console.warn('[meta] creatives build failed:', err?.message || err);
          body.creatives = null;
        }
      }

      // Optional: audience / targeting summary. Reads adset.targeting, then
      // attributes adset spend (from insights) to each country / age band /
      // gender so the focus page can show "where the money is going".
      if (wantAudience) {
        try {
          const adsetSpend = {};
          for (const r of rows) {
            const d = r.data || {};
            if (!d.adset_id) continue;
            adsetSpend[d.adset_id] = (adsetSpend[d.adset_id] || 0) + parseFloat(d.spend || 0);
          }
          const countries = {};   // ISO country code -> spend
          const ageBands = {};    // "25-34" -> spend
          const genders = { all: 0, male: 0, female: 0 };
          const platforms = {};   // FB / IG / Audience Network / Messenger -> spend
          let targetedAdsets = 0;
          for (const s of adsetRows) {
            const t = s.data?.targeting;
            if (!t) continue;
            targetedAdsets += 1;
            const sp = adsetSpend[s.data?.id] || 0;
            // Countries (geo_locations.countries is an ISO-2 array).
            const cs = t.geo_locations?.countries || [];
            for (const cc of cs) countries[cc] = (countries[cc] || 0) + (sp / Math.max(1, cs.length));
            // Age band.
            const aMin = t.age_min || null;
            const aMax = t.age_max || null;
            if (aMin || aMax) {
              const band = `${aMin || '?'}–${aMax || '?'}`;
              ageBands[band] = (ageBands[band] || 0) + sp;
            }
            // Gender. Meta uses [1]=male, [2]=female; both/missing = "all".
            if (Array.isArray(t.genders) && t.genders.length === 1) {
              if (t.genders[0] === 1) genders.male += sp;
              else if (t.genders[0] === 2) genders.female += sp;
              else genders.all += sp;
            } else genders.all += sp;
            // Platforms / publisher placements when explicitly set.
            const pubs = t.publisher_platforms || [];
            for (const p of pubs) platforms[p] = (platforms[p] || 0) + (sp / Math.max(1, pubs.length));
          }
          const sortToArr = (obj) => Object.entries(obj)
            .map(([k, v]) => ({ key: k, spend: v }))
            .sort((a, b) => b.spend - a.spend);
          body.audience = {
            countries: sortToArr(countries).slice(0, 12),
            age_bands: sortToArr(ageBands).slice(0, 8),
            genders,
            platforms: sortToArr(platforms),
            targeted_adsets: targetedAdsets,
            total_adsets: adsetRows.length,
          };
        } catch (err) {
          console.warn('[meta] audience build failed:', err?.message || err);
          body.audience = null;
        }
      }

      // Optional: day-of-week heatmap input. Buckets the daily-trend rows
      // into Mon–Sun and reports avg spend, avg ROAS, total spend per day
      // of week so the focus page can render a 7-cell strip.
      if (wantDow) {
        try {
          const buckets = Array.from({ length: 7 }, () => []);
          for (const r of rows) {
            const d = r.data || {};
            if (!d.date_start) continue;
            // Date.parse on "YYYY-MM-DD" treats it as UTC midnight; we use
            // UTC day-of-week so the bucket is stable across the user's
            // locale.
            const dow = new Date(d.date_start + 'T00:00:00Z').getUTCDay();
            buckets[dow].push(d);
          }
          // ISO/Mon-first order (1..6, then 0=Sun) for the chart's x-axis.
          const order = [1, 2, 3, 4, 5, 6, 0];
          const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
          body.day_of_week = order.map((dow, idx) => {
            const items = buckets[dow];
            const a = agg(items);
            return {
              dow,
              label: labels[idx],
              days: items.length,
              spend: a.spend,
              avg_spend: items.length > 0 ? a.spend / items.length : 0,
              ctr: a.ctr,
              roas: a.roas || 0,
              conversions: a.conversions,
            };
          });
        } catch (err) {
          console.warn('[meta] day_of_week build failed:', err?.message || err);
          body.day_of_week = null;
        }
      }

      // Optional: anomaly alerts. Compares yesterday vs the average of the
      // 6 days before that for spend / CTR / ROAS / conversions. >25% delta
      // either way is flagged. Used for the "alerts" strip on the focus page.
      if (wantAnomalies) {
        try {
          const lastN = (n) => {
            const out = [];
            for (let k = n; k >= 1; k--) {
              const d = new Date(Date.now() - k * 86400 * 1000).toISOString().slice(0, 10);
              out.push(d);
            }
            return out;
          };
          const yesterday = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
          const baselineDays = lastN(7).slice(0, 6); // d-7 .. d-2
          const yRows = rows.filter((r) => r.data?.date_start === yesterday);
          const bRows = rows.filter((r) => baselineDays.includes(r.data?.date_start));
          const ya = agg(yRows);
          const ba = agg(bRows);
          const baseDays = Math.max(1, baselineDays.length);
          // Volume metrics (spend, conversions) compare yesterday to the
          // per-day average over the baseline window. Rate metrics (CTR,
          // ROAS, CPA, frequency) are already weighted aggregates so we
          // compare them directly. >25% delta either way is flagged.
          const cmpVolume = (yv, bvTotal, kind) => {
            const bv = bvTotal / baseDays;
            if (bv <= 0 && yv <= 0) return null;
            const delta = bv > 0 ? (yv - bv) / bv : (yv > 0 ? 1 : 0);
            return { kind, yesterday: yv, baseline_avg: bv, delta_pct: delta * 100, flagged: Math.abs(delta) >= 0.25 && (yv > 0 || bv > 0) };
          };
          const cmpRate = (yv, bv, kind) => {
            if ((bv == null || bv <= 0) && (yv == null || yv <= 0)) return null;
            const yClean = yv || 0;
            const bClean = bv || 0;
            const delta = bClean > 0 ? (yClean - bClean) / bClean : (yClean > 0 ? 1 : 0);
            return { kind, yesterday: yClean, baseline_avg: bClean, delta_pct: delta * 100, flagged: Math.abs(delta) >= 0.25 && (yClean > 0 || bClean > 0) };
          };
          body.anomalies = [
            cmpVolume(ya.spend, ba.spend, 'spend'),
            cmpRate(ya.ctr, ba.ctr, 'ctr'),
            cmpRate(ya.roas, ba.roas, 'roas'),
            cmpVolume(ya.conversions, ba.conversions, 'conversions'),
            cmpRate(ya.cpa, ba.cpa, 'cpa'),
            cmpRate(ya.frequency, ba.frequency, 'frequency'),
          ].filter(Boolean);
        } catch (err) {
          console.warn('[meta] anomalies build failed:', err?.message || err);
          body.anomalies = null;
        }
      }

      // Optional: top ads. Builds an ad-level rollup keyed by ad_id when
      // insights carry one, falling back to listing the most-recent ads
      // by name/effective_status for accounts where insights are adset-only.
      if (wantTopAds) {
        try {
          const adAgg = {};
          for (const r of rows) {
            const d = r.data || {};
            const id = d.ad_id;
            if (!id) continue;
            if (!adAgg[id]) adAgg[id] = { id, name: d.ad_name || id, spend: 0, impressions: 0, clicks: 0, conversions: 0, campaign_id: d.campaign_id || null, adset_id: d.adset_id || null };
            const a = adAgg[id];
            a.spend += parseFloat(d.spend || 0);
            a.impressions += parseInt(d.impressions || 0, 10);
            a.clicks += parseInt(d.clicks || 0, 10);
            if (Array.isArray(d.actions)) {
              for (const act of d.actions) {
                if (act?.action_type && CONVERSION_ACTIONS.has(act.action_type)) {
                  const v = parseFloat(act.value || 0);
                  if (!Number.isNaN(v)) a.conversions += v;
                }
              }
            }
          }
          let topAds = Object.values(adAgg)
            .map((a) => ({
              ...a,
              ctr: a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0,
              cpa: a.conversions > 0 ? a.spend / a.conversions : null,
            }))
            .filter((a) => a.spend > 0)
            .sort((a, b) => b.spend - a.spend)
            .slice(0, 20);
          // Fallback: when adAgg is empty (insights are adset-level only,
          // which is our default backfill), surface ad names/status from
          // adRows so the table isn't blank.
          if (!topAds.length && adRows.length) {
            topAds = adRows.slice(0, 20).map((row) => {
              const d = row.data || {};
              return {
                id: d.id || row.external_id,
                name: d.name || null,
                effective_status: d.effective_status || d.status || null,
                campaign_id: d.campaign_id || null,
                adset_id: d.adset_id || null,
                creative_id: d.creative?.id || null,
                spend: 0, impressions: 0, clicks: 0, conversions: 0, ctr: 0, cpa: null,
                no_insights: true,
              };
            });
          }
          body.top_ads = topAds;
          body.counts = body.counts || {};
          body.counts.ads = adRows.length;
        } catch (err) {
          console.warn('[meta] top_ads build failed:', err?.message || err);
          body.top_ads = null;
        }
      }

      // ── Marketer brain: per-adset multi-window rollups + action ──────
      // classification (SCALE / KILL / WATCH). This is the panel a real
      // performance marketer opens the dashboard for: which adsets to push
      // money into, which to pause, which to flag for fatigue. We compute
      // 3-day, 7-day, 14-day windows per adset, benchmark against the
      // account's 7-day ROAS / CPA, and apply the rules from the spec.
      if (wantFocus) {
        try {
          const lastNDates = (n) => {
            const out = new Set();
            for (let k = 0; k < n; k++) {
              out.add(new Date(Date.now() - k * 86400 * 1000).toISOString().slice(0, 10));
            }
            return out;
          };
          const W3 = lastNDates(3);
          const W7 = lastNDates(7);
          const W14 = lastNDates(14);

          const byAdset = {};
          for (const r of rows) {
            const d = r.data || {};
            const aid = d.adset_id;
            if (!aid || !d.date_start) continue;
            if (!byAdset[aid]) byAdset[aid] = { d3: [], d7: [], d14: [], all: [] };
            byAdset[aid].all.push(d);
            if (W3.has(d.date_start)) byAdset[aid].d3.push(d);
            if (W7.has(d.date_start)) byAdset[aid].d7.push(d);
            if (W14.has(d.date_start)) byAdset[aid].d14.push(d);
          }
          const adsetMetaById = {};
          for (const s of adsetRows) if (s.data?.id) adsetMetaById[s.data.id] = s.data;

          const acct7 = agg(last7Rows);
          const acctRoas = acct7.roas || 0;
          const acctCpa = acct7.cpa || 0;

          // Classify each adset.
          //   SCALE   → ROAS > acct × 1.3 AND spend ≥ 3× CPA AND freq < 2.5
          //   KILL    → conversions ≤ 1 on 2× CPA-spend, OR ROAS < acct × 0.5
          //   WATCH   → freq > 3.5, OR CTR_7d < CTR_14d × 0.7
          // Adsets with no spend in 3d are skipped (idle).
          const adsetActions = [];
          for (const [aid, w] of Object.entries(byAdset)) {
            const a3 = agg(w.d3);
            const a7 = agg(w.d7);
            const a14 = agg(w.d14);
            if ((a3.spend || 0) <= 0) continue;
            const meta = adsetMetaById[aid] || {};
            let action = null;
            let reason = '';

            const minSpend = Math.max(acctCpa * 3, 25); // floor so $5 spend can't trigger SCALE
            if (acctRoas > 0 && a3.roas != null && a3.roas > acctRoas * 1.3
                && a3.spend >= minSpend && a3.frequency < 2.5) {
              action = 'SCALE';
              reason = `ROAS ${a3.roas.toFixed(2)}× vs ${acctRoas.toFixed(2)}× · freq ${a3.frequency.toFixed(2)}`;
            } else if ((a3.conversions <= 1 && a3.spend >= Math.max(acctCpa * 2, 15))
                    || (acctRoas > 0 && a3.roas != null && a3.roas < acctRoas * 0.5 && a3.spend >= Math.max(acctCpa * 1.5, 10))) {
              action = 'KILL';
              reason = a3.conversions <= 1
                ? `${a3.conversions || 0} purchases on ${a3.spend.toFixed(0)} spend`
                : `ROAS ${a3.roas.toFixed(2)}× < 0.5× acct`;
            } else if (a3.frequency > 3.5
                    || (a7.ctr > 0 && a14.ctr > 0 && a7.ctr < a14.ctr * 0.7 && a7.spend >= 10)) {
              action = 'WATCH';
              reason = a3.frequency > 3.5
                ? `freq ${a3.frequency.toFixed(2)} (saturation)`
                : `CTR ${(((a7.ctr / a14.ctr) - 1) * 100).toFixed(0)}% w/w`;
            }

            if (action) {
              adsetActions.push({
                id: aid,
                name: meta.name || aid,
                campaign_id: meta.campaign_id || null,
                campaign_name: meta.campaign_id ? campaignNameById[meta.campaign_id] : null,
                effective_status: meta.effective_status || meta.status || null,
                action,
                reason,
                spend_3d: a3.spend,
                conversions_3d: a3.conversions,
                roas_3d: a3.roas,
                cpa_3d: a3.cpa,
                ctr_3d: a3.ctr,
                cpc_3d: a3.cpc,
                frequency_3d: a3.frequency,
                spend_7d: a7.spend,
                roas_7d: a7.roas,
                ctr_7d: a7.ctr,
                ctr_14d: a14.ctr,
              });
            }
          }
          // KILL first (urgent), then SCALE (opportunity), then WATCH.
          // Within bucket, biggest spend wins so the marketer can act on
          // the highest-leverage rows first.
          const ORDER = { KILL: 0, SCALE: 1, WATCH: 2 };
          adsetActions.sort((a, b) => (ORDER[a.action] - ORDER[b.action]) || (b.spend_3d - a.spend_3d));
          body.adset_actions = adsetActions.slice(0, 30);
          body.adset_actions_summary = {
            scale: adsetActions.filter((x) => x.action === 'SCALE').length,
            kill: adsetActions.filter((x) => x.action === 'KILL').length,
            watch: adsetActions.filter((x) => x.action === 'WATCH').length,
          };

          // Creative fatigue list. Wider net than the WATCH bucket:
          // surface anything with freq > 3.0 AND CTR_7d < CTR_14d × 0.75.
          // Sorted by 7d spend (most leverage first).
          const fatigue = [];
          for (const [aid, w] of Object.entries(byAdset)) {
            const a7 = agg(w.d7);
            const a14 = agg(w.d14);
            if (a7.spend <= 0 || a7.frequency <= 3.0) continue;
            if (a14.ctr > 0 && a7.ctr < a14.ctr * 0.75) {
              const meta = adsetMetaById[aid] || {};
              fatigue.push({
                id: aid,
                name: meta.name || aid,
                campaign_name: meta.campaign_id ? campaignNameById[meta.campaign_id] : null,
                frequency: a7.frequency,
                ctr_7d: a7.ctr,
                ctr_14d: a14.ctr,
                ctr_drop_pct: ((a7.ctr / a14.ctr) - 1) * 100,
                spend_7d: a7.spend,
                roas_7d: a7.roas,
              });
            }
          }
          fatigue.sort((a, b) => b.spend_7d - a.spend_7d);
          body.fatigue = fatigue.slice(0, 12);

          // Today / yesterday / 7d-per-day-avg deltas for the headline strip.
          // 7d avg is computed per-day for volume metrics (spend, conversions),
          // and as the weighted aggregate for rate metrics (ROAS, CPA, CTR).
          const yest = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
          const yestRows = rows.filter((r) => r.data?.date_start === yest);
          const t = agg(todayRows);
          const y = agg(yestRows);
          const l7 = acct7;
          body.deltas = {
            today: { spend: t.spend, conversions: t.conversions, roas: t.roas, cpa: t.cpa, ctr: t.ctr, cpc: t.cpc },
            yesterday: { spend: y.spend, conversions: y.conversions, roas: y.roas, cpa: y.cpa, ctr: y.ctr, cpc: y.cpc },
            last7_avg: {
              spend: (l7.spend || 0) / 7,
              conversions: (l7.conversions || 0) / 7,
              roas: l7.roas,           // rate — already weighted
              cpa: l7.cpa,             // rate — already weighted
              ctr: l7.ctr,             // rate
              cpc: l7.cpc,             // rate
            },
          };

          // Top adsets with thumbnail. For each top-spend adset (last 7d),
          // pick the first ad we have that points at a creative we have a
          // thumbnail for. Lets the overview show "what's actually being
          // shown to customers" — pattern recognition is half the job.
          try {
            const adsByAdset = {};
            for (const a of adRows) {
              const aid = a.data?.adset_id;
              if (!aid) continue;
              if (!adsByAdset[aid]) adsByAdset[aid] = [];
              adsByAdset[aid].push(a.data);
            }
            const creativesById = {};
            for (const cr of (creativeRows || [])) {
              const cd = cr.data || {};
              if (cd.id) creativesById[cd.id] = cd;
            }
            const adsetSpend7 = {};
            for (const r of rows) {
              const d = r.data || {};
              if (!d.adset_id || !W7.has(d.date_start)) continue;
              adsetSpend7[d.adset_id] = (adsetSpend7[d.adset_id] || 0) + parseFloat(d.spend || 0);
            }
            const top = Object.entries(adsetSpend7)
              .filter(([, sp]) => sp > 0)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8);
            body.top_adsets_with_creative = top.map(([aid, sp]) => {
              const meta = adsetMetaById[aid] || {};
              const ads = adsByAdset[aid] || [];
              let thumb = null, headline = null;
              for (const ad of ads) {
                const cid = ad?.creative?.id;
                const cr = cid ? creativesById[cid] : null;
                if (cr && (cr.thumbnail_url || cr.image_url)) {
                  thumb = cr.thumbnail_url || cr.image_url;
                  headline = cr.title || cr.name || null;
                  break;
                }
              }
              const a7 = agg((byAdset[aid] && byAdset[aid].d7) || []);
              const a3 = agg((byAdset[aid] && byAdset[aid].d3) || []);
              return {
                id: aid,
                name: meta.name || aid,
                campaign_name: meta.campaign_id ? campaignNameById[meta.campaign_id] : null,
                effective_status: meta.effective_status || meta.status || null,
                thumbnail_url: thumb,
                headline,
                spend_3d: a3.spend,
                spend_7d: a7.spend,
                roas_3d: a3.roas,
                roas_7d: a7.roas,
                ctr_7d: a7.ctr,
                cpc_7d: a7.cpc,
                cpa_7d: a7.cpa,
                conversions_7d: a7.conversions,
                frequency: a7.frequency,
              };
            });
          } catch (err) {
            console.warn('[meta] top_adsets_with_creative build failed:', err?.message || err);
            body.top_adsets_with_creative = null;
          }

          // Tracking health: Meta-reported purchases vs Stripe charges over
          // last 7 days. If Meta < Stripe × 0.6, the pixel/CAPI is under-
          // reporting and ROAS on the dashboard is understated. We surface
          // a single coral alert on the overview when this trips. Tolerate
          // missing Stripe entirely (returns null tracking → no alert).
          try {
            const stripeRows = await integrationDb.listBySource('stripe', { kind: 'charge_succeeded', limit: 5000 });
            const cutoff = Date.now() - 7 * 86400 * 1000;
            let stripeCount7 = 0;
            for (const r of stripeRows) {
              const t = r.ts ? new Date(r.ts).getTime() : 0;
              if (t >= cutoff) stripeCount7 += 1;
            }
            const metaConv7 = Math.round(l7.conversions || 0);
            const ratio = stripeCount7 > 0 ? metaConv7 / stripeCount7 : null;
            body.tracking_health = {
              meta_purchases_7d: metaConv7,
              stripe_charges_7d: stripeCount7,
              ratio,
              alert: ratio != null && ratio < 0.6 && stripeCount7 >= 3,
            };
          } catch (err) {
            body.tracking_health = null;
          }
        } catch (err) {
          console.warn('[meta] adset_actions build failed:', err?.message || err);
          body.adset_actions = null;
          body.fatigue = null;
        }
      }

      // Always include a slim rate-limit snapshot so the focus health card
      // has something to render without a second fetch.
      try {
        const st = getStatus();
        body.rate_limit = st.rate_limit;
      } catch {}

      summaryCache[includeKey] = { at: Date.now(), body };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.get('/omo/api/integrations/meta/plaintext', async (req, res) => {
    try {
      const limitPerKind = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
      const status = getStatus();
      const counts = await integrationDb.countsBySource('meta');
      const totalRows = Object.values(counts).reduce((s, n) => s + n, 0);
      const ageMin = (t) => (t ? Math.round((Date.now() - t) / 60000) + 'm ago' : '—');
      const header = [
        '='.repeat(72),
        `META ADS DATA DUMP`,
        `generated: ${new Date().toISOString()}`,
        status.connected
          ? `account: ${status.account_name || status.account_id} (${status.account_id}) · ${status.currency || '—'} · ${status.country || '—'}`
          : `account: (connector not currently connected — showing last persisted data)`,
        `poll: every ${Math.round((status.poll_interval_ms || 0) / 1000)}s · last_poll: ${ageMin(status.last_poll_at)}`,
        `deep resync: every ${Math.round((status.resync_interval_ms || 0) / 60000)}min · last_deep: ${ageMin(status.deep_backfill_done_at)}`,
        `rows: ${totalRows} across ${Object.keys(counts).length} kind(s) · limit per kind: ${limitPerKind}`,
        '='.repeat(72),
        '',
      ].join('\n');
      const order = ['account', 'campaign', 'adset', 'ad', 'creative', 'insight'];
      const body = await integrationDb.plaintextBySource('meta', { kindOrder: order, limitPerKind, header });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(body);
    } catch (err) {
      res.status(500).type('text/plain').send(`ERROR: ${err?.message || err}`);
    }
  });

  // Single Meta object by id (campaign, adset, ad, creative). When the
  // entity is a campaign/adset/ad we also fold in any aggregated insight
  // rows we have for it, so the reader can show spend / impressions /
  // clicks without a second hop.
  // Single Meta object detail with full FB-Ads-Manager-style metrics.
  // Returns:
  //   data            — the underlying campaign/adset/ad/creative object
  //   insights        — aggregated all-time totals + computed rates +
  //                     conversion-aware metrics (leads, conversions,
  //                     cost-per-lead, CPA, AOV, outbound CTR, frequency)
  //   insights.daily  — last 14 days of per-day rows for the trend chart
  //   insights.windows — 3-day, 7-day, 14-day rollups
  //   children        — for kind=adset: ads inside this adset (with creative
  //                     thumbnail); for kind=campaign: adsets inside this
  //                     campaign; for kind=ad: sibling ads in the same adset
  //   parent          — quick-link summary for the parent entity
  app.get('/omo/api/integrations/meta/object/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'missing id' });
      const row = await integrationDb.getByExternalId('meta', id);
      if (!row) return res.status(404).json({ error: 'not found' });
      const kind = row.kind;
      const objData = row.data || {};

      // Reuse the agg() helper logic inline so we share the conversion
      // rules with the /summary endpoint.
      const aggregate = (items) => {
        let spend = 0, impressions = 0, clicks = 0, reach = 0;
        let outboundClicks = 0;
        let conversions = 0, conversionValue = 0, leads = 0;
        let roasNumSpend = 0, roasNumReturn = 0;
        let freqSum = 0, freqN = 0;
        for (const r of items) {
          const d = r.data || r;
          if (!d) continue;
          const s = parseFloat(d.spend || 0);
          const i = parseInt(d.impressions || 0, 10);
          const c = parseInt(d.clicks || 0, 10);
          const rch = parseInt(d.reach || 0, 10);
          spend += s; impressions += i; clicks += c; reach += rch;
          const roas = Array.isArray(d.purchase_roas) ? parseFloat(d.purchase_roas[0]?.value) : null;
          if (roas && !Number.isNaN(roas) && s > 0) {
            roasNumSpend += s; roasNumReturn += s * roas;
          }
          if (Array.isArray(d.outbound_clicks)) {
            for (const oc of d.outbound_clicks) {
              const v = parseFloat(oc?.value || 0);
              if (!Number.isNaN(v)) outboundClicks += v;
            }
          }
          if (Array.isArray(d.actions)) {
            for (const act of d.actions) {
              if (!act?.action_type) continue;
              const v = parseFloat(act.value || 0);
              if (Number.isNaN(v)) continue;
              if (CONVERSION_ACTIONS.has(act.action_type)) conversions += v;
              if (act.action_type === 'lead' || act.action_type === 'onsite_conversion.lead_grouped' || act.action_type === 'offsite_conversion.fb_pixel_lead') leads += v;
            }
          }
          if (Array.isArray(d.action_values)) {
            for (const av of d.action_values) {
              if (!av?.action_type) continue;
              if (VALUE_ACTION_TYPES.has(av.action_type)) {
                const v = parseFloat(av.value || 0);
                if (!Number.isNaN(v)) conversionValue += v;
              }
            }
          }
          const f = parseFloat(d.frequency || 0);
          if (f > 0 && !Number.isNaN(f)) { freqSum += f; freqN += 1; }
        }
        const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;
        const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
        const roas = roasNumSpend > 0 ? roasNumReturn / roasNumSpend : null;
        const outboundCtr = impressions > 0 ? (outboundClicks / impressions) * 100 : 0;
        const cpa = conversions > 0 ? spend / conversions : null;
        const costPerLead = leads > 0 ? spend / leads : null;
        const aov = conversions > 0 ? conversionValue / conversions : null;
        const frequency = freqN > 0 ? freqSum / freqN : 0;
        return {
          spend, impressions, clicks, reach, ctr, cpc, cpm, roas,
          outbound_clicks: outboundClicks, outbound_ctr: outboundCtr,
          conversions, conversion_value: conversionValue, cpa,
          leads, cost_per_lead: costPerLead, aov,
          frequency,
          rows: items.length,
        };
      };

      let insights = null;
      let daily = [];
      let windows = null;
      try {
        const all = await integrationDb.listBySource('meta', { kind: 'insight', limit: 5000 });
        const matched = all.filter((r) => {
          const d = r.data || {};
          return d.campaign_id === id || d.adset_id === id || d.ad_id === id;
        });
        if (matched.length) {
          // Total rollup across all matched rows.
          const total = aggregate(matched);
          let firstStart = null, lastStop = null;
          for (const r of matched) {
            const d = r.data || {};
            if (d.date_start && (!firstStart || d.date_start < firstStart)) firstStart = d.date_start;
            if (d.date_stop && (!lastStop || d.date_stop > lastStop)) lastStop = d.date_stop;
          }
          insights = { ...total, date_start: firstStart, date_stop: lastStop };

          // 3 / 7 / 14 day rolling windows for the detail header chips.
          const lastN = (n) => {
            const set = new Set();
            for (let k = 0; k < n; k++) set.add(new Date(Date.now() - k * 86400 * 1000).toISOString().slice(0, 10));
            return set;
          };
          const W3 = lastN(3), W7 = lastN(7), W14 = lastN(14);
          const filterByWindow = (W) => matched.filter((r) => W.has(r.data?.date_start));
          windows = {
            d3: aggregate(filterByWindow(W3)),
            d7: aggregate(filterByWindow(W7)),
            d14: aggregate(filterByWindow(W14)),
          };

          // Per-day rows over the last 14 days (chronological), pre-seeded
          // so the trend table/chart has a continuous x-axis even on quiet
          // days. Each row carries spend/clicks/impressions/conversions/
          // ROAS/leads/CPA so the detail page can render a sortable table.
          const byDate = {};
          for (let k = 13; k >= 0; k--) {
            const date = new Date(Date.now() - k * 86400 * 1000).toISOString().slice(0, 10);
            byDate[date] = [];
          }
          for (const r of matched) {
            const dt = r.data?.date_start;
            if (dt && byDate[dt] !== undefined) byDate[dt].push(r);
          }
          daily = Object.keys(byDate).sort().map((dt) => {
            const items = byDate[dt];
            if (!items.length) return { date: dt, spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, conversions: 0, leads: 0, roas: null, cpa: null, cost_per_lead: null };
            const a = aggregate(items);
            return {
              date: dt,
              spend: a.spend,
              impressions: a.impressions,
              clicks: a.clicks,
              reach: a.reach,
              ctr: a.ctr,
              cpc: a.cpc,
              cpm: a.cpm,
              frequency: a.frequency,
              conversions: a.conversions,
              leads: a.leads,
              roas: a.roas,
              cpa: a.cpa,
              cost_per_lead: a.cost_per_lead,
            };
          });
          insights.daily = daily;
          insights.windows = windows;
        }
      } catch (err) {
        console.warn('[meta] /object insights build failed:', err?.message || err);
      }

      // Children + parent join. Pulls a slim projection of related entities
      // so the detail pane can render an "ads in this adset" strip without
      // a second hop. We attach creative thumbnails when we have them.
      let children = null;
      let parent = null;
      try {
        const adsetRows = await integrationDb.listBySource('meta', { kind: 'adset', limit: 2000 });
        const adRows = await integrationDb.listBySource('meta', { kind: 'ad', limit: 5000 });
        const creativeRows = await integrationDb.listBySource('meta', { kind: 'creative', limit: 2000 });
        const campaignRows = await integrationDb.listBySource('meta', { kind: 'campaign', limit: 1000 });
        const creativesById = {};
        for (const cr of creativeRows) {
          const cd = cr.data || {};
          if (cd.id) creativesById[cd.id] = cd;
        }
        const adsetById = {};
        for (const a of adsetRows) if (a.data?.id) adsetById[a.data.id] = a.data;
        const campaignById = {};
        for (const c of campaignRows) if (c.data?.id) campaignById[c.data.id] = c.data;

        const slimAd = (ad) => {
          const cid = ad?.creative?.id;
          const cr = cid ? creativesById[cid] : null;
          return {
            id: ad.id,
            name: ad.name,
            effective_status: ad.effective_status || ad.status,
            adset_id: ad.adset_id,
            campaign_id: ad.campaign_id,
            creative_id: cid || null,
            thumbnail_url: cr?.thumbnail_url || cr?.image_url || null,
            creative_title: cr?.title || cr?.name || null,
            creative_body: (cr?.body || '').slice(0, 240),
            cta: cr?.call_to_action_type || null,
            link_url: cr?.link_url || null,
          };
        };

        if (kind === 'adset') {
          const ads = adRows.filter((a) => a.data?.adset_id === id).map((a) => slimAd(a.data));
          children = { kind: 'ads', items: ads };
          if (objData.campaign_id && campaignById[objData.campaign_id]) {
            parent = {
              kind: 'campaign',
              id: objData.campaign_id,
              name: campaignById[objData.campaign_id].name,
              effective_status: campaignById[objData.campaign_id].effective_status || campaignById[objData.campaign_id].status,
              objective: campaignById[objData.campaign_id].objective,
            };
          }
        } else if (kind === 'campaign') {
          const adsets = adsetRows.filter((s) => s.data?.campaign_id === id).map((s) => ({
            id: s.data.id,
            name: s.data.name,
            effective_status: s.data.effective_status || s.data.status,
            optimization_goal: s.data.optimization_goal,
            daily_budget: s.data.daily_budget,
            lifetime_budget: s.data.lifetime_budget,
          }));
          children = { kind: 'adsets', items: adsets };
        } else if (kind === 'ad') {
          if (objData.adset_id && adsetById[objData.adset_id]) {
            const sib = adRows.filter((a) => a.data?.adset_id === objData.adset_id && a.data?.id !== id).slice(0, 12).map((a) => slimAd(a.data));
            children = { kind: 'siblings', items: sib };
            parent = {
              kind: 'adset',
              id: objData.adset_id,
              name: adsetById[objData.adset_id].name,
              effective_status: adsetById[objData.adset_id].effective_status || adsetById[objData.adset_id].status,
              optimization_goal: adsetById[objData.adset_id].optimization_goal,
              daily_budget: adsetById[objData.adset_id].daily_budget,
            };
          }
        }
      } catch (err) {
        console.warn('[meta] /object children build failed:', err?.message || err);
      }

      res.json({
        id: row.external_id,
        kind: row.kind,
        ts: row.ts,
        title: row.title,
        summary: row.summary,
        data: objData,
        insights,
        children,
        parent,
      });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });
}

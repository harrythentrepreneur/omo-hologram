// open_hq_detail — voice-driven "open the email from Sarah" / "show me
// the Jane Doe charge" / "open the Spring Launch campaign" / "open the
// Q3 pitch doc". The tool resolves what the user meant into a concrete
// {panel, kind, id} triple and returns it; the browser's show_pane
// dispatcher posts it into the HQ iframe via postMessage, which routes
// to the panel-specific opener (gmail reader, stripe detail, etc.).
//
// Design: stays "lightweight" by NOT implementing any opening itself —
// the actual DOM state change happens client-side. This tool just
// answers "which id does the user mean?" using the persisted
// integration_data rows, then the UI takes over.

import * as integrationDb from '../../store/integration_db.js';
import * as momoView from '../../momo/view.js';

const PANEL_KINDS = {
  gmail: new Set(['email', 'message', 'thread']),
  stripe: new Set(['charge', 'customer', 'plan', 'payout', 'dispute', 'risk']),
  meta: new Set(['campaign', 'adset', 'ad']),
  drive: new Set(['file', 'doc', 'sheet', 'slides']),
};

export const definition = {
  type: 'function',
  name: 'open_hq_detail',
  description:
    'Voice-drive the HQ UI to open a specific card — email, charge, customer, campaign, doc, etc. Use when the user says "open the email from Sarah", "show me that charge from Kate", "pull up the Spring Launch campaign", "open the Q3 pitch doc". If you already know the exact id, pass it; otherwise pass a natural-language `query` and the tool will look it up from persisted data. The browser then zooms the right panel and opens the drill-down — you then speak a short follow-up sentence.',
  parameters: {
    type: 'object',
    properties: {
      panel: {
        type: 'string',
        description: 'Which HQ panel the item lives in.',
        enum: ['gmail', 'stripe', 'meta', 'drive'],
      },
      kind: {
        type: 'string',
        description:
          'Item kind. gmail: email. stripe: charge | customer | plan | payout | dispute. meta: campaign | adset | ad. drive: file.',
      },
      id: {
        type: 'string',
        description: 'Exact identifier if known (Gmail messageId, Stripe charge/customer/price id, Meta campaign/adset/ad id, Drive fileId). If omitted, `query` is required.',
      },
      query: {
        type: 'string',
        description: 'Natural-language description ("Sarah\'s email about pricing", "Jane Doe charge", "Spring Launch campaign"). Used only when `id` is not provided.',
      },
      account_id: {
        type: 'string',
        description: 'For panel="gmail", optionally scope the lookup to one connected Gmail account (the address). Omit to search across every account.',
      },
    },
    required: ['panel', 'kind'],
  },
};

// "open this / that / 这个 / 那个" — referential queries that should bind
// to whatever the user is already drilled into on /hq. The view reporter
// in public/hq.html pushes a `drilldown: { kind: "gmail_message"|... , id }`
// snapshot, so we short-circuit by reading it instead of fuzzy-searching.
const REFERENTIAL_RE = /^(this|that|it|the\s+(?:current|focused|open|one)|this\s+one|that\s+one|the\s+one\s+(?:i'?m\s+looking\s+at|in\s+focus|opened)|这个|那个|它|当前(?:这个|那个)?|刚打开的|刚才那个)$/i;

function drilldownToTriple() {
  const v = momoView.getView();
  const d = v && v.drilldown;
  if (!d || !d.kind || !d.id) return null;
  // Map the view reporter's kind strings to (panel, kind).
  const k = String(d.kind).toLowerCase();
  if (k === 'gmail_message') return { panel: 'gmail', kind: 'message', id: d.id, label: d.label || null };
  if (k === 'drive_file') return { panel: 'drive', kind: 'file', id: d.id, label: d.label || null };
  if (k.startsWith('stripe_')) {
    const sub = k.slice('stripe_'.length);
    if (['charge', 'customer', 'plan', 'payout', 'dispute'].includes(sub)) {
      return { panel: 'stripe', kind: sub, id: d.id, label: d.label || null };
    }
  }
  if (k === 'meta_campaign' || k === 'meta_adset' || k === 'meta_ad') {
    return { panel: 'meta', kind: k.slice('meta_'.length), id: d.id, label: d.label || null };
  }
  return null;
}

export async function run({ panel, kind, id, query, account_id } = {}) {
  // ─── State-aware short-circuit ───────────────────────────────────────
  // If the user said "this / that / 这个" and they're already drilled into
  // a card on /hq, skip the search and return the focused id. Mirrors the
  // HQ pattern where errors carry the screen context; here, the query
  // resolves to whatever the user is staring at — no fuzzy match needed.
  const qStr = String(query || '').trim();
  if (!id && qStr && REFERENTIAL_RE.test(qStr)) {
    const focused = drilldownToTriple();
    if (focused) {
      // Honour an explicit panel arg only when it matches; otherwise the
      // user's "this" outranks any guessed panel.
      if (!panel || String(panel).toLowerCase() === focused.panel) {
        return {
          ok: true,
          panel: focused.panel,
          kind: focused.kind,
          id: focused.id,
          label: focused.label,
          resolved_from: 'drilldown',
        };
      }
    }
    // Referential query but nothing drilled in — fall through to normal
    // search (often returns nothing, which is the honest answer).
  }

  const p = String(panel || '').trim().toLowerCase();
  if (!PANEL_KINDS[p]) return { ok: false, error: `unknown panel: ${panel}` };
  const k = String(kind || '').trim().toLowerCase();
  if (!PANEL_KINDS[p].has(k)) return { ok: false, error: `panel=${p} does not support kind=${k}` };

  const normKind = k === 'email' || k === 'message' ? 'message'
    : k === 'doc' || k === 'sheet' || k === 'slides' ? 'file'
    : k === 'thread' ? 'thread'
    : k;

  if (id) {
    return { ok: true, panel: p, kind: normKind, id: String(id), resolved_from: 'id', ...(account_id ? { account_id } : {}) };
  }

  if (!query) return { ok: false, error: 'provide `id` or `query`' };
  const needle = qStr.toLowerCase();
  if (!needle) return { ok: false, error: 'empty query' };

  try {
    const match = await resolveByQuery(p, normKind, needle, account_id);
    if (!match) return { ok: false, error: `no match for "${query}" in ${p}` };
    return {
      ok: true,
      panel: p,
      kind: normKind,
      id: match.id,
      label: match.label,
      ...(match.account_id ? { account_id: match.account_id } : {}),
      resolved_from: match.low_confidence ? 'fallback_latest' : 'query',
      ...(match.low_confidence ? { low_confidence: true } : {}),
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ─── query resolution ────────────────────────────────────────────────
//
// IMPORTANT: this tool runs on the synchronous voice path — the model
// blocks on it before it can speak. Anything that takes >500ms here
// stalls Momo and the user perceives a freeze. Two rules:
//
//   1. Use integrationDb.listSlimBySource (NOT listBySource) — the slim
//      projection skips the `data` JSON column. A Gmail message row with
//      `data` can be 50–500KB; without it, ~200 bytes. 500 rows × 50KB
//      = 25MB pulled per call (was a 5s freeze in prod logs).
//   2. Match against the pre-rendered `title` / `summary` columns the
//      connectors populate at write time. They already contain subject,
//      sender, customer name, etc. — no JSON parsing needed.
//
// Short-circuit: "latest / last / most recent / 最新 / 最近 / latest email"
// queries skip scoring entirely and return the most-recent row, since
// the rows already come back ts-DESC-ordered.

const LATEST_HINTS = [
  'latest', 'last', 'most recent', 'newest', 'recent',
  '最新', '最近', '最新的', '最近的',
];

function isLatestQuery(needle) {
  const n = String(needle || '').trim().toLowerCase();
  if (!n) return false;
  // Match if the query contains a "latest" hint AND no specific identifier
  // (no quoted strings, no @ symbols, no obvious proper-noun fragments).
  if (!LATEST_HINTS.some((h) => n.includes(h))) return false;
  if (/[@"]/.test(n)) return false;
  // Reject queries with too many words — those carry real content.
  const words = n.split(/\s+/).filter((w) => w.length >= 2);
  return words.length <= 4;
}

async function resolveByQuery(panel, kind, needle, accountId) {
  if (panel === 'gmail') return resolveGmail(needle, accountId);
  if (panel === 'stripe') return resolveStripe(kind, needle);
  if (panel === 'meta') return resolveMeta(kind, needle);
  if (panel === 'drive') return resolveDrive(needle);
  return null;
}

function scoreMatch(haystack, needle) {
  const h = String(haystack || '').toLowerCase();
  if (!h) return 0;
  if (h.includes(needle)) return 100 + (needle.length / Math.max(1, h.length)) * 10;
  // Token overlap fallback. Filter ≥2 (not ≥3) so 2-char Chinese tokens
  // like 妈妈 / 老板 / 张三 still participate — dropping them was a big
  // source of "no email when there is" when the user spoke Chinese.
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 2);
  let hits = 0;
  for (const t of tokens) if (h.includes(t)) hits++;
  return tokens.length ? (hits / tokens.length) * 50 : 0;
}

async function resolveGmail(needle, accountId) {
  // Multi-account aware: when an explicit account_id is provided, scope
  // the search to that mailbox. Otherwise we look across every connected
  // account (Gmail message ids are globally unique, so no collision).
  const opts = { kind: 'message', limit: 200 };
  if (accountId) opts.account_id = accountId;
  const rows = await integrationDb.listSlimBySource('gmail', opts);
  if (rows.length === 0) return null;
  if (isLatestQuery(needle)) {
    const r = rows[0];
    return { id: r.external_id, label: r.title || r.summary || r.external_id, account_id: r.account_id || null, score: 100 };
  }
  let best = null;
  for (const r of rows) {
    const score = Math.max(scoreMatch(r.title, needle), scoreMatch(r.summary, needle) * 0.8);
    if (score > 0 && (!best || score > best.score)) {
      best = { id: r.external_id, label: r.title || r.summary || r.external_id, account_id: r.account_id || null, score };
    }
  }
  if (!best) {
    const r = rows[0];
    return {
      id: r.external_id,
      label: r.title || r.summary || r.external_id,
      account_id: r.account_id || null,
      score: 0,
      low_confidence: true,
    };
  }
  return best;
}

async function resolveStripe(kind, needle) {
  if (kind === 'charge') {
    const rows = await integrationDb.listSlimBySource('stripe', { kind: 'charge', limit: 300 });
    if (rows.length === 0) return null;
    if (isLatestQuery(needle)) {
      const r = rows[0];
      return { id: r.external_id, label: r.title || r.summary || r.external_id, score: 100 };
    }
    let best = null;
    for (const r of rows) {
      const score = Math.max(scoreMatch(r.title, needle), scoreMatch(r.summary, needle));
      if (score > 0 && (!best || score > best.score)) {
        best = { id: r.external_id, label: r.title || r.summary || r.external_id, score };
      }
    }
    return best;
  }
  if (kind === 'customer') {
    const rows = await integrationDb.listSlimBySource('stripe', { kind: 'customer', limit: 1000 });
    if (rows.length === 0) return null;
    if (isLatestQuery(needle)) {
      const r = rows[0];
      return { id: r.external_id, label: r.title || r.summary || r.external_id, score: 100 };
    }
    let best = null;
    for (const r of rows) {
      const score = Math.max(scoreMatch(r.title, needle), scoreMatch(r.summary, needle));
      if (score > 0 && (!best || score > best.score)) {
        best = { id: r.external_id, label: r.title || r.summary || r.external_id, score };
      }
    }
    return best;
  }
  if (kind === 'plan') {
    const rows = await integrationDb.listSlimBySource('stripe', { kind: 'price', limit: 300 });
    if (rows.length === 0) return null;
    let best = null;
    for (const r of rows) {
      const score = Math.max(scoreMatch(r.title, needle), scoreMatch(r.summary, needle));
      if (score > 0 && (!best || score > best.score)) {
        best = { id: r.external_id, label: r.title || r.summary || r.external_id, score };
      }
    }
    return best;
  }
  // payout / dispute resolution — low value; rely on id path.
  return null;
}

async function resolveMeta(kind, needle) {
  const kindMap = { campaign: 'campaign', adset: 'adset', ad: 'ad' };
  const k = kindMap[kind];
  if (!k) return null;
  const rows = await integrationDb.listSlimBySource('meta', { kind: k, limit: 1000 });
  if (rows.length === 0) return null;
  if (isLatestQuery(needle)) {
    const r = rows[0];
    return { id: r.external_id, label: r.title || r.summary || r.external_id, score: 100 };
  }
  let best = null;
  for (const r of rows) {
    const score = Math.max(scoreMatch(r.title, needle), scoreMatch(r.summary, needle));
    if (score > 0 && (!best || score > best.score)) {
      best = { id: r.external_id, label: r.title || r.summary || r.external_id, score };
    }
  }
  return best;
}

async function resolveDrive(needle) {
  const rows = await integrationDb.listSlimBySource('drive', { kind: 'file', limit: 1000 });
  if (rows.length === 0) return null;
  if (isLatestQuery(needle)) {
    const r = rows[0];
    return { id: r.external_id, label: r.title || r.summary || r.external_id, score: 100 };
  }
  let best = null;
  for (const r of rows) {
    const score = Math.max(scoreMatch(r.title, needle), scoreMatch(r.summary, needle) * 0.8);
    if (score > 0 && (!best || score > best.score)) {
      best = { id: r.external_id, label: r.title || r.summary || r.external_id, score };
    }
  }
  return best;
}

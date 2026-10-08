// show_pane — mounts a full-stage iframe of an internal Momo page
// (/hq or /agents-grid) onto the hologram. Avatar shrinks to the corner.
// The page allow-list is the security boundary; the client uses the
// returned URL as an iframe src, so never accept arbitrary URLs.

import * as dataCore from '../../data_core.js';
import * as hermes from '../../hermes/index.js';

const PAGES = {
  hq:             { url: '/hq',           title: 'HQ // CONTROL CENTER' },
  squad:          { url: '/squad',        title: 'SQUAD // PIXEL OFFICE' },
  // 'preview-diff' takes an `agent` param — voice ("preview Reed's
  // changes") routes through here so the user sees the worktree diff
  // before voice-committing 'ship it'. URL is built dynamically below.
  'preview-diff': { url: '/preview-diff', title: 'PREVIEW // AGENT DIFF' },
  // 'hermes-dashboard' projects the built-in Hermes web dashboard (served
  // by `hermes dashboard --no-open` at http://localhost:9119) onto the
  // hologram. The omo page at /hermes-dashboard wraps that URL in an
  // iframe and shows a friendly overlay if the daemon isn't running.
  'hermes-dashboard': { url: '/hermes-dashboard', title: 'HERMES // DASHBOARD' },
  // 'automation' is the Holo3 vision-agent lab (/automation). Voice:
  // "open automation / show the lab / 打开 automation / show me holo3".
  automation:     { url: '/automation',   title: 'AUTOMATION // HOLO3 LAB' },
  // 'agents' (/agents-grid) was retired; "show me the agents" now opens
  // /squad. Old aliases below redirect there so old voice phrasing still
  // works without surprising the user.
};

// Agent-grid slot aliases. Mirrors src/agents/terminals.js SLOT_DEFS:
//   0 = top-left  (ATLAS / research)
//   1 = top-right (CINDER / code)
//   2 = bottom-left (PRISM / data)
//   3 = bottom-right (QUILL / writing)
const AGENT_SLOT_ALIASES = {
  'top-left': 0, 'topleft': 0, 'tl': 0, 'upper-left': 0, 'upperleft': 0,
  '左上': 0, '左上角': 0, '左上方': 0,
  'top-right': 1, 'topright': 1, 'tr': 1, 'upper-right': 1, 'upperright': 1,
  '右上': 1, '右上角': 1, '右上方': 1,
  'bottom-left': 2, 'bottomleft': 2, 'bl': 2, 'lower-left': 2, 'lowerleft': 2,
  '左下': 2, '左下角': 2, '左下方': 2,
  'bottom-right': 3, 'bottomright': 3, 'br': 3, 'lower-right': 3, 'lowerright': 3,
  '右下': 3, '右下角': 3, '右下方': 3,
  atlas: 0, cinder: 1, prism: 2, quill: 3,
};

const AGENT_SLOT_TITLES = ['ATLAS · RESEARCH', 'CINDER · CODE', 'PRISM · DATA', 'QUILL · WRITING'];

// HQ panel aliases — each value is the canonical panel key used in
// hq.html (keyed by the panel's data-integration attribute).
const HQ_PANEL_ALIASES = {
  // stripe / revenue
  stripe: 'stripe', revenue: 'stripe', sales: 'stripe', money: 'stripe',
  payments: 'stripe', mrr: 'stripe', charges: 'stripe',
  '收入': 'stripe', '营收': 'stripe', '付款': 'stripe', '支付': 'stripe',
  // meta / fb ads
  meta: 'meta', 'meta-ads': 'meta', metaads: 'meta', 'meta_ads': 'meta',
  fb: 'meta', 'fb-ads': 'meta', fbads: 'meta', facebook: 'meta',
  'facebook-ads': 'meta', 'facebookads': 'meta', ads: 'meta', advertising: 'meta',
  '广告': 'meta', '脸书': 'meta', '脸书广告': 'meta',
  // gmail
  gmail: 'gmail', mail: 'gmail', email: 'gmail', inbox: 'gmail',
  '邮件': 'gmail', '邮箱': 'gmail', '收件箱': 'gmail',
  // drive
  drive: 'drive', docs: 'drive', 'google-drive': 'drive', googledrive: 'drive',
  documents: 'drive', files: 'drive',
  '文档': 'drive', '网盘': 'drive',
  // transcript
  transcript: 'transcript', overheard: 'transcript', listening: 'transcript',
  conversation: 'transcript', audio: 'transcript',
  '转录': 'transcript', '偷听': 'transcript', '对话': 'transcript',
  // github
  github: 'github', gh: 'github', git: 'github', code: 'github',
  prs: 'github', 'pull-requests': 'github', pullrequests: 'github',
  pr: 'github', repo: 'github', repos: 'github', repository: 'github',
  ci: 'github', actions: 'github', 'github-actions': 'github',
  '代码': 'github', '代码库': 'github', '仓库': 'github',
  '拉取请求': 'github', 'github': 'github',
};

const HQ_PANEL_TITLES = {
  stripe:     'HQ // REVENUE · STRIPE',
  meta:       'HQ // ADS · META',
  gmail:      'HQ // INBOX · GMAIL',
  drive:      'HQ // DOCS · DRIVE',
  transcript: 'HQ // OVERHEARD',
  github:     'HQ // CODE · GITHUB',
};

function resolveAgentSlot(slot) {
  if (slot === null || slot === undefined || slot === '') return null;
  if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot <= 3) return slot;
  const key = String(slot).trim().toLowerCase();
  if (/^[0-3]$/.test(key)) return Number(key);
  return Object.prototype.hasOwnProperty.call(AGENT_SLOT_ALIASES, key) ? AGENT_SLOT_ALIASES[key] : null;
}

function resolveHqPanel(slot) {
  if (slot === null || slot === undefined || slot === '') return null;
  // Normalise "facebook ads" / "FB Ads" / "fb_ads" → "facebook-ads" / "fb-ads"
  // so the alias table doesn't have to enumerate every punctuation variant.
  const key = String(slot).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (Object.prototype.hasOwnProperty.call(HQ_PANEL_ALIASES, key)) return HQ_PANEL_ALIASES[key];
  const flat = key.replace(/-/g, '');
  return Object.prototype.hasOwnProperty.call(HQ_PANEL_ALIASES, flat) ? HQ_PANEL_ALIASES[flat] : null;
}

export const definition = {
  type: 'function',
  name: 'show_pane',
  description:
    'Project a full-stage view of an internal Momo page onto the hologram. The avatar shrinks to a corner so the page takes over. Use when the user says things like "show me HQ", "open the control center", "show me the squad / agents / pixel office". Pages: "hq" = /hq command center; "squad" = /squad pixel office — a small room with 4 chairs that fills dynamically whenever Momo (or anyone) dispatches a hermes agent task. Each task spawns a freshly-named worker who walks in, sits down, and starts typing; they linger for a few minutes after the task ends, then leave. For page="hq" you can zoom a single panel fullscreen via `slot`: stripe/revenue, meta/fb-ads/facebook-ads, gmail/inbox, drive/docs, github/code/prs, transcript. The Meta, Stripe, and Gmail dashboards each fit one 1920×1080 stage with no scrolling; voice drives subtab navigation. Pair `slot=meta` with `view` (overview/scaling/creative/audience/diagnostics) and optionally `filter` (scale/kill/watch). Pair `slot=stripe` with `view` (overview/subscriptions/customers/payments/payouts/catalog/risk). Pair `slot=gmail` with `view` (overview/inbox/threads/senders/labels/attachments). Examples: "what should I kill" → slot=meta view=overview filter=kill; "show me churn" → slot=stripe view=subscriptions; "open the disputes" → slot=stripe view=risk; "show me all my emails" → slot=gmail view=inbox; "show me github" → slot=github; "show me the squad" / "watch the agents work" → page=squad. Use page="hermes-dashboard" for "show me hermes", "open hermes dashboard", "open the hermes console / control panel", "hermes config", "给我看 hermes", "打开 hermes 控制台" — it projects the built-in Hermes web dashboard (localhost:9119) onto the holo. Always pair with dismiss_pane when the user moves on.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'string',
        description: '"hq" = /hq control center. "squad" = /squad pixel office — a 4-seat room that fills dynamically when work is dispatched. "preview-diff" = full-stage diff viewer for an agent\'s worktree changes; REQUIRES the `agent` param. "hermes-dashboard" = the built-in Hermes web dashboard (localhost:9119) wrapped in an iframe — use for "show me hermes / open the hermes dashboard / hermes config / 给我看 hermes / 打开 hermes 控制台". Use page="hq" for "show me the control center / dashboard". Use page="squad" for "show me the agents / pixel office / who\'s working". Use page="preview-diff" for "preview Reed\'s changes / show me the diff / let me review before shipping".',
        enum: ['hq', 'squad', 'preview-diff', 'hermes-dashboard', 'automation'],
      },
      agent: {
        type: 'string',
        description: 'Agent reference (callsign or agent_id) — required for page="preview-diff". Identifies whose worktree to render. Ignored on other pages.',
      },
      slot: {
        type: 'string',
        description:
          'Zoom one panel fullscreen. For page="hq": "stripe"/"revenue", "meta"/"fb-ads"/"facebook-ads", "gmail"/"inbox"/"email", "drive"/"docs", "github"/"code"/"prs", "transcript"/"overheard". Omit to show the full page.',
      },
      view: {
        type: 'string',
        description: 'Sub-tab to open inside the panel. \n• Meta (slot=meta): "overview" (default — Adsets-to-Action + headlines + top adsets + campaign ROAS), "scaling" (full Adsets-to-Action with the campaign leaderboard and 30d trend), "creative" (top ads, creative gallery, fatigue list), "audience" (geo/age/gender/platform + day-of-week), "diagnostics" (pacing, account health, rate-limit, objectives, status, trend).\n• Stripe (slot=stripe): "overview" (default — chart, plans, recent charges, payouts, alerts), "subscriptions" (plans, status counts, churn, trial-ending), "customers" (top 30d, lifetime top, country breakdown, oldest customer), "payments" (full live charge feed, biggest charges, card brands, currencies, failure codes), "payouts" (payouts list, balance, gross/fees/net, open + paid invoices), "catalog" (products & their prices), "risk" (active disputes, refunds, failed charges, fail-rate KPIs).\n• Gmail (slot=gmail): "overview" (default — needs-reply + top senders + 24h arrival timeline + label snapshot), "inbox" (full message list with search), "threads" (active threads ranked by message count), "senders" (top senders + needs-reply side-by-side), "labels" (every system + user label with total/unread counts), "attachments" (recent attachments grid).\nIgnored by drive/transcript slots.',
        enum: ['overview', 'scaling', 'creative', 'audience', 'diagnostics', 'subscriptions', 'customers', 'payments', 'payouts', 'catalog', 'risk', 'inbox', 'threads', 'senders', 'labels', 'attachments'],
      },
      filter: {
        type: 'string',
        description: 'Pre-filter the Adsets-to-Action list to one bucket. Use when the user asks "what should I kill / scale / watch". "kill" = high-spend losers to pause. "scale" = high-ROAS adsets to duplicate at higher budget. "watch" = creative-fatigue / saturation flags. Default "all" shows the ranked union (KILL → SCALE → WATCH). Only meaningful for slot=meta with view=overview or view=scaling.',
        enum: ['all', 'scale', 'kill', 'watch'],
      },
      title: { type: 'string', description: 'Optional header override.' },
    },
    required: ['page'],
  },
};

export function run({ page, slot, view, filter, title, agent } = {}) {
  // Back-compat: "agents" was the old 2×2 terminal grid (/agents-grid).
  // It's been retired; route the alias to /squad so old voice phrasing
  // ("show me the agents grid") still works.
  if (page === 'agents') page = 'squad';
  // Normalise "preview" / "preview_diff" / "diff" aliases.
  if (page === 'preview' || page === 'diff' || page === 'preview_diff') page = 'preview-diff';

  const entry = PAGES[page];
  if (!entry) return { ok: false, error: `unknown page: ${page}` };

  // preview-diff has its own param contract: needs an agent reference.
  if (page === 'preview-diff') {
    const ref = String(agent || '').trim();
    if (!ref) return { ok: false, error: 'page="preview-diff" requires an agent reference (callsign or agent_id)' };
    const url = `/preview-diff?agent=${encodeURIComponent(ref)}`;
    const finalTitle = (title && title.trim()) || `PREVIEW // ${ref.toUpperCase()}`;
    return {
      ok: true,
      kind: 'pane',
      projectable_id: `pane_preview-diff_${ref.replace(/[^A-Za-z0-9]/g, '')}_${Date.now().toString(36)}`,
      page,
      url,
      title: finalTitle,
      agent: ref,
      note: 'Tell the user the preview is up; offer accept / discard / "on a branch instead".',
    };
  }

  let slotKey = null;     // string used in ?focus=<slotKey>
  let resolvedTitle = null;

  if (page === 'hq') {
    const key = resolveHqPanel(slot);
    if (key) {
      slotKey = key;
      resolvedTitle = HQ_PANEL_TITLES[key];
    }
  }

  // Optional sub-view — deep-links into a specific tab on a focus dashboard.
  // Each slot defines its own valid set; unknown values are ignored.
  const META_VIEW_KEYS = new Set(['overview', 'scaling', 'creative', 'audience', 'diagnostics']);
  const STRIPE_VIEW_KEYS = new Set(['overview', 'subscriptions', 'customers', 'payments', 'payouts', 'catalog', 'risk']);
  const GMAIL_VIEW_KEYS = new Set(['overview', 'inbox', 'threads', 'senders', 'labels', 'attachments']);
  let viewKey = null;
  if (page === 'hq' && view) {
    const v = String(view).toLowerCase();
    if (slotKey === 'meta' && META_VIEW_KEYS.has(v)) viewKey = v;
    else if (slotKey === 'stripe' && STRIPE_VIEW_KEYS.has(v)) viewKey = v;
    else if (slotKey === 'gmail' && GMAIL_VIEW_KEYS.has(v)) viewKey = v;
  }
  // Optional bucket filter for the Adsets-to-Action panel.
  const FILTER_KEYS = new Set(['scale', 'kill', 'watch']);
  const filterKey = (page === 'hq' && slotKey === 'meta' && filter && FILTER_KEYS.has(String(filter).toLowerCase()))
    ? String(filter).toUpperCase()
    : null;

  let url = entry.url;
  if (slotKey !== null) {
    url += `?focus=${encodeURIComponent(slotKey)}`;
    if (viewKey) url += `&view=${encodeURIComponent(viewKey)}`;
    if (filterKey) url += `&action=${encodeURIComponent(filterKey)}`;
  }
  const finalTitle = (title && title.trim()) || resolvedTitle || entry.title;

  return {
    ok: true,
    kind: 'pane',
    projectable_id: `pane_${page}${slotKey !== null ? `_${slotKey}` : ''}${viewKey ? `_${viewKey}` : ''}${filterKey ? `_${filterKey}` : ''}_${Date.now().toString(36)}`,
    page,
    url,
    title: finalTitle,
    slot: slotKey,
    view: viewKey,
    filter: filterKey,
  };
}

export const dismissDefinition = {
  type: 'function',
  name: 'dismiss_pane',
  description:
    'Exit whatever Momo has projected on the stage in ONE step and show the page behind. ' +
    'Hologram pages: dismounts the projected pane (HQ, /squad, preview, raw data, etc.) and the avatar pops back from the corner. ' +
    'On /squad: closes whatever surface is on top — the grid terminal overlay AND/OR the floating agent monitor — so the squad room (hologram + sprites) reappears immediately. ' +
    'Voice triggers: "exit / close it / close the terminals / back / go back / out / zoom out (when already in mosaic) / dismiss / hide it / show me the squad / back to the room / show me the page behind / 出去 / 出来 / 退出 / 关掉终端 / 回去 / 回到房间 / 收起来 / 关掉那个". ' +
    'This is a ONE-SHOT exit, not a cascade — it always reveals what is underneath in one call. ' +
    'Safe to call repeatedly (no-op if nothing is projected). ' +
    'For zoom-out-but-stay-in-grid (single tile → all tiles), use feather_focus({mode:"mosaic"}) instead.',
  parameters: { type: 'object', properties: {} },
};

// Broadcast on the two channels /squad's surfaces listen on. The grid
// overlay (squad-grid.js) reads omoWS events with kind:'action' +
// action:'close'; the floating agent monitor (squad.html) reads the
// hermes ui_close_screen broadcast. Holo pages still get their dismount
// from the tool-result handler in holo_cylinder.html / holo_avatar.html.
// All three handlers are idempotent, so emitting both here is safe even
// when only one surface is open.
export function runDismiss() {
  const ts = Date.now();
  try {
    dataCore.emit({
      source: 'squad_grid',
      kind: 'action',
      ts,
      data: { action: 'close' },
    });
  } catch {}
  try {
    hermes.broadcast({ type: 'ui_close_screen', ts });
  } catch {}
  return { ok: true };
}

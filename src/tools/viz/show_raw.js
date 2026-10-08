// show_raw_data — voice-callable raw-data dump. Mounts /raw/<target> as a
// full-stage pane on the hologram via the generic `result.pane` auto-mount
// hint (see holo_cylinder.html dispatcher).
//
// Accepts either an integration source alias (stripe / gmail / meta / drive)
// or any live projectable / dataset id (chrt_*, orde_*, etc.) — the /raw
// route in server.js handles all three cases.

const SOURCE_ALIASES = {
  // stripe
  stripe: 'stripe', revenue: 'stripe', sales: 'stripe', money: 'stripe',
  payments: 'stripe', mrr: 'stripe', charges: 'stripe',
  '收入': 'stripe', '营收': 'stripe', '付款': 'stripe', '支付': 'stripe', 'stripe数据': 'stripe',
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
};

const TITLES = {
  stripe: 'RAW · STRIPE',
  gmail:  'RAW · GMAIL',
  meta:   'RAW · META ADS',
  drive:  'RAW · DRIVE',
};

// Live id pattern from store mintIds (4-char prefix + underscore + base36).
const ID_RE = /^[a-z]{2,5}_[a-z0-9]{4,}$/i;

function resolveTarget(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase().replace(/[\s_]+/g, '-');
  if (Object.prototype.hasOwnProperty.call(SOURCE_ALIASES, key)) {
    return { kind: 'source', value: SOURCE_ALIASES[key] };
  }
  const flat = key.replace(/-/g, '');
  if (Object.prototype.hasOwnProperty.call(SOURCE_ALIASES, flat)) {
    return { kind: 'source', value: SOURCE_ALIASES[flat] };
  }
  if (ID_RE.test(trimmed)) {
    return { kind: 'id', value: trimmed };
  }
  return null;
}

export const definition = {
  type: 'function',
  name: 'show_raw_data',
  description:
    'Open the full raw plaintext data dump on the hologram as a full-stage pane (avatar shrinks to the corner). Use whenever the user asks to "see the raw data", "show me the dump", "open the raw text", "view the raw stripe data", "看看原始数据", "把转储打开" — for any of: a live integration (stripe / gmail / meta / drive), or a previously-rendered chart (pass its viz_id / projectable_id), or a dataset id from a recent data-tool call. Returns immediately; the pane mounts on the client. Pair with dismiss_pane when the user moves on.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description:
          'What to dump. Either an integration alias ("stripe"/"revenue"/"收入", "gmail"/"inbox"/"邮件", "meta"/"fb-ads"/"广告", "drive"/"docs"/"文档") OR a live id you already have (viz_id / projectable_id like "chrt_…", or a dataset id like "orde_…", "cust_…", "ads_…").',
      },
    },
    required: ['target'],
  },
};

export function run({ target } = {}) {
  const resolved = resolveTarget(target);
  if (!resolved) {
    return { ok: false, error: `unknown raw-data target: ${target}` };
  }
  const url = `/raw/${encodeURIComponent(resolved.value)}`;
  const title = resolved.kind === 'source'
    ? (TITLES[resolved.value] || `RAW · ${resolved.value.toUpperCase()}`)
    : `RAW · ${resolved.value.toUpperCase()}`;

  return {
    ok: true,
    target: resolved.value,
    target_kind: resolved.kind,
    pane: { url, title, page: 'raw' },
  };
}

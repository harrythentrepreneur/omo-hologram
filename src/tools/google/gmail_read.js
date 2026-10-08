// Gmail read tools — Momo's voice-accessible hooks for "what's in my
// inbox?" and "show me the thread from Sarah". Mirrors the data-tool
// pattern in src/tools/orders.js: compute a clean shape, store it with
// datasets.put, return { id, ...summary }. These tools do NOT call
// broadcastProjection — the model chains render_viz itself.
//
// Data source: `src/data_core.js::listEvents({ source:'gmail' })` is the
// single source of truth. In mock mode the mock producer fills the
// ring; in live OAuth mode the connector poll loop does the same. The
// shape we read back is identical either way, so these tools work in
// both modes with no special-casing.
//
// If a real Gmail reader helper is ever exported from
// src/connectors/gmail.js, swap `loadRecent()` below to prefer it and
// fall back to listEvents. The dataset shapes returned here already
// match what email_card / email_thread consume.

import * as datasets from '../../store/datasets.js';
import * as dc from '../../data_core.js';

// ───────────────────────── shared helpers ─────────────────────────

function parseFromHeader(raw) {
  if (!raw) return { name: '', email: null };
  if (typeof raw === 'object') {
    return {
      name:  raw.name || raw.display_name || raw.email || '',
      email: raw.email || null,
    };
  }
  const s = String(raw);
  const m = s.match(/^\s*"?([^"<]+?)"?\s*<([^>]+@[^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const at = s.indexOf('@');
  if (at > 0) return { name: s.slice(0, at), email: s.trim() };
  return { name: s.trim(), email: null };
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

function isPromotional(ev) {
  const labels = ev?.data?.labels;
  if (!Array.isArray(labels)) return false;
  return labels.some((l) => {
    const u = String(l || '').toUpperCase();
    return u === 'PROMOTIONS' || u === 'CATEGORY_PROMOTIONS'
        || u === 'SPAM' || u === 'TRASH';
  });
}

// Pull Gmail events out of the Data Core ring, filter to inbox arrivals
// (both the mock and live connector use kind:'email_received'), and map
// them into a compact normalised form. Ordered newest-first.
function loadRecent({ limit, includePromotional = false } = {}) {
  const cap = Math.max(1, Math.min(50, limit | 0 || 5));
  // Ring is already newest-first; pull extra so post-filtering still
  // leaves us with enough rows after drop-outs.
  const raw = dc.listEvents({ source: 'gmail', limit: Math.max(cap * 4, 25) });
  const mapped = [];
  for (const ev of raw) {
    if (ev.kind !== 'email_received' && ev.kind !== 'email_new') continue;
    if (!includePromotional && isPromotional(ev)) continue;
    const d = ev.data || {};
    const sender = parseFromHeader(d.from || d.sender);
    mapped.push({
      id:        d.messageId || d.message_id || ev.id,
      threadId:  d.threadId || d.thread_id || null,
      subject:   String(d.subject || ev.title || '(no subject)'),
      snippet:   truncate(d.snippet || d.preview || d.body || '', 200),
      sender,
      timestamp: ev.ts ? new Date(ev.ts).toISOString() : null,
      labels:    Array.isArray(d.labels)
                   ? d.labels.filter(Boolean).map(String)
                             .filter((l) => l.toUpperCase() !== 'INBOX')
                             .slice(0, 4)
                   : [],
      unread:    Array.isArray(d.labels)
                   ? d.labels.some((l) => String(l).toUpperCase() === 'UNREAD')
                   : true,
      starred:   Array.isArray(d.labels)
                   ? d.labels.some((l) => String(l).toUpperCase() === 'STARRED')
                   : false,
    });
    if (mapped.length >= cap) break;
  }
  return mapped;
}

// ───────────────────────── get_inbox_recent ─────────────────────────

export const inboxRecentDefinition = {
  type: 'function',
  name: 'get_inbox_recent',
  description:
    "Fetch the last N emails from the user's inbox. Returns a dataset id that routes through render_viz to an email_card (most recent) or an email-list view when asked for a roll-up. Promotional / bulk mail is filtered out by default.",
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'How many recent emails to return (default 5).',
      },
      include_promotional: {
        type: 'boolean',
        description: 'Include promotional / bulk labels. Default false.',
      },
    },
    additionalProperties: false,
  },
};

export async function runInboxRecent(args = {}) {
  const limit = Math.max(1, Math.min(20, args.limit | 0 || 5));
  const includePromotional = !!args.include_promotional;
  const emails = loadRecent({ limit, includePromotional });

  if (!emails.length) {
    return {
      id: datasets.put('email_received', {
        subject: 'Inbox is quiet',
        snippet: 'No recent emails in the ring.',
        sender: null,
        timestamp: new Date().toISOString(),
        unread: false,
        labels: [],
      }),
      count: 0,
      summary: 'inbox empty',
    };
  }

  // Single-email ask → the card-single shape. This is the common case
  // (limit=1 or the user wants "the latest one"), and email_card handles
  // it natively. The dataset kind 'email_received' routes to email_card
  // via pickChartType.
  if (emails.length === 1) {
    const e = emails[0];
    const id = datasets.put('email_received', {
      sender:    e.sender,
      subject:   e.subject,
      snippet:   e.snippet,
      timestamp: e.timestamp,
      unread:    e.unread,
      starred:   e.starred,
      labels:    e.labels,
      threadId:  e.threadId,
      messageId: e.id,
    });
    return {
      id,
      count: 1,
      latest: {
        from: e.sender?.name || e.sender?.email || '(unknown)',
        subject: e.subject,
        timestamp: e.timestamp,
      },
      summary: `1 email · ${e.sender?.name || 'unknown'} · "${truncate(e.subject, 40)}"`,
    };
  }

  // List ask → a thread-like roll-up so the render_viz call lands on
  // email_thread. The kitchen's pickChartType routes any kind containing
  // 'email_thread' to the thread template. Messages are ordered
  // earliest-first to match the template's reading order.
  const messages = emails
    .slice()
    .reverse()
    .map((e) => ({
      sender:    e.sender,
      snippet:   e.snippet,
      timestamp: e.timestamp,
    }));

  const participants = [];
  const seen = new Set();
  for (const e of emails) {
    const key = (e.sender?.email || e.sender?.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    participants.push({ name: e.sender?.name || '', email: e.sender?.email || null });
    if (participants.length >= 8) break;
  }

  const unreadCount = emails.filter((e) => e.unread).length;

  const id = datasets.put('email_thread_inbox', {
    subject: `Inbox · last ${emails.length}`,
    participants,
    messages,
    unread_count: unreadCount,
    starred: emails.some((e) => e.starred),
  });

  return {
    id,
    count: emails.length,
    unread: unreadCount,
    latest: {
      from: emails[0].sender?.name || emails[0].sender?.email || '(unknown)',
      subject: emails[0].subject,
      timestamp: emails[0].timestamp,
    },
    senders: participants.slice(0, 5).map((p) => p.name || p.email).filter(Boolean),
    summary: `${emails.length} emails · ${unreadCount} unread`,
  };
}

// ───────────────────────── get_email_thread ─────────────────────────

export const threadDefinition = {
  type: 'function',
  name: 'get_email_thread',
  description:
    'Fetch the messages in a single email thread. Accepts a Gmail thread_id OR a short `from` filter (match on name or email local-part). Returns a dataset id that routes to email_thread via render_viz.',
  parameters: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description: 'Gmail thread id (preferred when known).',
      },
      from: {
        type: 'string',
        description:
          "Substring match against sender name or email (used when thread_id isn't known — e.g. 'sarah' or 'acme.co').",
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Max messages to pull into the thread view (default 10).',
      },
    },
    additionalProperties: false,
  },
};

export async function runThread(args = {}) {
  const threadId = args.thread_id ? String(args.thread_id).trim() : '';
  const fromFilter = args.from ? String(args.from).trim().toLowerCase() : '';
  const limit = Math.max(1, Math.min(20, args.limit | 0 || 10));

  if (!threadId && !fromFilter) {
    return { error: 'get_email_thread needs either thread_id or from' };
  }

  // Pull a wide window — the ring holds at most 1000 so we can afford
  // to inspect most of it to find a matching thread.
  const raw = dc.listEvents({ source: 'gmail', limit: 500 })
    .filter((ev) => ev.kind === 'email_received' || ev.kind === 'email_new');

  let matches = raw;
  if (threadId) {
    matches = matches.filter((ev) => {
      const t = ev?.data?.threadId || ev?.data?.thread_id;
      return t && String(t) === threadId;
    });
  } else if (fromFilter) {
    matches = matches.filter((ev) => {
      const from = String(ev?.data?.from || ev?.data?.sender || '').toLowerCase();
      return from.includes(fromFilter);
    });
  }

  if (!matches.length) {
    return {
      error: threadId
        ? `no messages found for thread_id ${threadId}`
        : `no messages matched from="${args.from}"`,
    };
  }

  // Earliest-first, cap at limit.
  const trimmed = matches.slice(0, limit).reverse();

  const messages = trimmed.map((ev) => {
    const d = ev.data || {};
    return {
      sender:    parseFromHeader(d.from || d.sender),
      snippet:   truncate(d.snippet || d.preview || d.body || '', 200),
      timestamp: ev.ts ? new Date(ev.ts).toISOString() : null,
    };
  });

  const participants = [];
  const seen = new Set();
  for (const m of messages) {
    const key = (m.sender?.email || m.sender?.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    participants.push({ name: m.sender?.name || '', email: m.sender?.email || null });
  }

  const subject = trimmed.find((ev) => ev?.data?.subject || ev?.title)
                  ?.data?.subject
                || trimmed[0]?.title
                || '(no subject)';

  const unreadCount = matches.filter((ev) => {
    const labels = ev?.data?.labels;
    return Array.isArray(labels)
      && labels.some((l) => String(l).toUpperCase() === 'UNREAD');
  }).length;

  const id = datasets.put('email_thread', {
    subject,
    participants,
    messages,
    unread_count: unreadCount,
    starred: matches.some((ev) => {
      const labels = ev?.data?.labels;
      return Array.isArray(labels)
        && labels.some((l) => String(l).toUpperCase() === 'STARRED');
    }),
  });

  return {
    id,
    subject,
    message_count: messages.length,
    participant_count: participants.length,
    unread: unreadCount,
    summary: `${messages.length} msg · "${truncate(subject, 40)}"`,
  };
}

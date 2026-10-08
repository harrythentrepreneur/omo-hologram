// Gmail live projector. Subscribes to the Data Core event bus, filters
// for Gmail inbox arrivals, and calls broadcastProjection to put an
// email_card inside Momo's hologram WITHOUT a model round-trip.
//
// Contract:
//   - Self-registering via install() — call once from the boot script.
//     Returns an unsubscribe fn so tests / hot-reload can detach.
//   - Never throws from the subscribe handler. Log warnings instead.
//   - Debounces bursts: if 3+ relevant emails arrive within `debounceMs`,
//     only the most recent gets projected (the preceding ones are
//     silently coalesced so the card doesn't spam-flash).
//   - Skips promotional / bulk mail heuristically before rendering.
//
// The live connector (src/connectors/gmail.js) emits kind:'email_received',
// so we only gate on that. We also accept 'email_new' defensively in case a
// future connector lands a different spelling.

import * as datasets from '../store/datasets.js';
import * as dc from '../data_core.js';
import { broadcastProjection } from './broadcast.js';

const RELEVANT_KINDS = new Set(['email_received', 'email_new']);

// Subjects that almost certainly aren't worth interrupting for. These
// match the mock pool loosely + typical transactional/marketing noise.
const TRANSACTIONAL_SUBJECT_RE = /\b(unsubscribe|newsletter|sale|deal|% off|promo(?:tion|code)?|marketing|deploy(?:ment)? succeeded|renews|your (?:invoice|receipt|subscription)|weekly digest|digest)\b/i;

function hasPromotionalLabel(labels) {
  if (!Array.isArray(labels)) return false;
  return labels.some((raw) => {
    const l = String(raw || '').toUpperCase();
    return l === 'PROMOTIONS'
        || l === 'CATEGORY_PROMOTIONS'
        || l === 'SPAM'
        || l === 'TRASH'
        || l === 'UPDATES'
        || l === 'CATEGORY_UPDATES';
  });
}

function shouldSkip(event) {
  const data = event?.data || {};
  if (hasPromotionalLabel(data.labels)) return 'promotional-label';
  const subject = String(data.subject || event?.title || '');
  if (subject && TRANSACTIONAL_SUBJECT_RE.test(subject)) return 'transactional-subject';
  return null;
}

// Pull a clean {name,email} out of either a structured sender object or
// a raw "Name <addr@host>" header string. Matches the parser the
// email_card template uses so both sides agree on what "sender" means.
function coerceSenderLite(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*"?([^"<]+?)"?\s*<([^>]+@[^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), email: m[2].trim() };
    const at = raw.indexOf('@');
    if (at > 0) return { name: raw.slice(0, at), email: raw.trim() };
    return { name: raw.trim(), email: null };
  }
  if (typeof raw === 'object') {
    return {
      name:  raw.name || raw.display_name || raw.email || '',
      email: raw.email || null,
    };
  }
  return null;
}

function truncate(s, n) {
  const str = String(s || '');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

// Shape the stored dataset to match src/kitchen/templates/email_card.js.
// Body snippet capped at 180 chars per the mission brief — the card has
// room for a snippet, not the whole email.
function buildEmailDataset(event) {
  const d = event?.data || {};
  const sender = coerceSenderLite(d.sender || d.from);
  const subject = String(d.subject || event?.title || '').trim();
  const snippet = truncate(d.snippet || d.preview || d.body || '', 180);
  const labels = Array.isArray(d.labels)
    ? d.labels.filter(Boolean).map(String).filter((l) => l.toUpperCase() !== 'INBOX').slice(0, 4)
    : [];
  const unread = Array.isArray(d.labels)
    ? d.labels.some((l) => String(l).toUpperCase() === 'UNREAD')
    : true; // inbox arrival defaults to unread if we can't tell
  const starred = Array.isArray(d.labels)
    ? d.labels.some((l) => String(l).toUpperCase() === 'STARRED')
    : !!d.starred;

  return {
    sender,
    subject: subject || '(no subject)',
    snippet,
    timestamp: event?.ts ? new Date(event.ts).toISOString() : undefined,
    unread,
    starred,
    labels,
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    threadId: d.threadId || d.thread_id || null,
    messageId: d.messageId || d.message_id || null,
  };
}

// Build the headline that goes in `intent`. Never include literal
// numbers or raw subject text — viz.js server-side guards against
// number-heavy intents, and anything quotable belongs in the dataset.
function buildIntent(dataset) {
  const name = dataset?.sender?.name
            || dataset?.sender?.email?.split('@')[0]
            || '';
  const trimmedName = name ? String(name).trim().slice(0, 40) : '';
  return trimmedName ? `New email from ${trimmedName}` : 'New email';
}

export function install({ debounceMs = 8000 } = {}) {
  let pending = null;          // { event, ts }
  let burstCount = 0;          // events seen in the current debounce window
  let flushTimer = null;
  let windowStart = 0;

  async function project(event) {
    try {
      const shape = buildEmailDataset(event);
      if (!shape.sender && !shape.subject) {
        console.warn('[gmail_live] skipping: no sender or subject');
        return;
      }
      const id = datasets.put('email_received', shape);
      const intent = buildIntent(shape);
      const reason = shape.sender?.name
        ? `new email · ${shape.sender.name}`
        : 'new email';
      const res = await broadcastProjection({
        intent,
        data_refs: [id],
        chart_type: 'email_card',
        size: 'wide',
        reason,
        producer: 'projection',
        ttlMs: 0,
      });
      if (!res?.ok) {
        console.warn('[gmail_live] broadcast failed:', res?.error);
      }
    } catch (err) {
      console.warn('[gmail_live] projection error:', err?.message || err);
    }
  }

  function flush() {
    flushTimer = null;
    const toProject = pending;
    const coalesced = burstCount;
    pending = null;
    burstCount = 0;
    windowStart = 0;
    if (!toProject) return;
    if (coalesced > 1) {
      console.log(`[gmail_live] debounced ${coalesced} emails; projecting most recent`);
    }
    project(toProject.event);
  }

  const unsubscribe = dc.subscribe((event) => {
    try {
      if (!event || event.source !== 'gmail') return;
      if (!RELEVANT_KINDS.has(event.kind)) return;

      const skipReason = shouldSkip(event);
      if (skipReason) {
        console.log(`[gmail_live] skip (${skipReason}):`, event?.data?.subject || event?.title || '');
        return;
      }

      const now = Date.now();

      // First arrival: schedule a next-tick flush so single emails fire
      // promptly. A burst that lands before the tick runs will coalesce
      // into a single projection of the most recent event.
      if (!pending) {
        pending = { event, ts: now };
        burstCount = 1;
        windowStart = now;
        flushTimer = setTimeout(flush, 0);
        if (flushTimer?.unref) flushTimer.unref();
        return;
      }

      burstCount += 1;
      pending = { event, ts: now };

      // Inside a burst (>=3 events) — hold the card until the window
      // elapses so viewers see the latest one instead of flashing
      // through the earlier arrivals.
      const elapsed = now - windowStart;
      if (burstCount >= 3 && elapsed < debounceMs) {
        if (flushTimer) clearTimeout(flushTimer);
        const remaining = Math.max(250, debounceMs - elapsed);
        flushTimer = setTimeout(flush, remaining);
        if (flushTimer?.unref) flushTimer.unref();
      }
    } catch (err) {
      // Never throw from the subscribe handler — the bus fans out to
      // many consumers and one broken one should not kill the rest.
      console.warn('[gmail_live] handler error:', err?.message || err);
    }
  });

  return () => {
    try { unsubscribe?.(); } catch {}
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pending = null;
    burstCount = 0;
  };
}

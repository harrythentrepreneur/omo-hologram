// hq_query — Momo's read-only lens onto the /hq live event streams.
//
// The Data Core keeps a 1000-deep in-memory ring of everything coming
// in over gmail / stripe / meta / drive / transcript / audio. This tool
// lets Momo query that ring directly so she can answer questions like
// "what emails did I get today?" or "any Stripe charges over $200 this
// week?" without fabricating — she's reading the same events /hq is
// rendering.
//
// Shape contract mirrors the other data tools: push the full event list
// into the dataset store under `hq_events_<source>` and return a short
// summary + the dataset id. Downstream render_viz then picks email_thread
// / timeline / notification_card based on the widget catalog.

import * as datasets from '../../store/datasets.js';
import * as dc from '../../data_core.js';

const VALID_SOURCES = new Set([
  'gmail', 'stripe', 'meta', 'meta_ads', 'drive',
  'transcript', 'audio', 'system', 'all',
]);

// Normalise the caller's alias to what's in the ring.
function resolveSource(src) {
  if (!src || src === 'all') return 'all';
  if (src === 'meta') return 'meta_ads';
  return src;
}

// A trimmed projection of the event for the model's `sample` field. Full
// events go to the dataset store under the returned id — the model only
// needs enough to decide whether to narrate or chart.
function trimForSample(ev) {
  const d = ev?.data || {};
  return {
    id: ev.id,
    source: ev.source,
    kind: ev.kind,
    ts: ev.ts,
    title: ev.title,
    summary: ev.summary,
    data: {
      // Fields the model might want to quote; intentionally narrow.
      from: d.from, sender: d.sender, subject: d.subject, snippet: d.snippet,
      amount: d.amount, currency: d.currency, customer_email: d.customer_email,
      product: d.product, campaign: d.campaign, spend: d.spend,
      clicks: d.clicks, impressions: d.impressions,
      text: d.text,
    },
  };
}

// Shape the dataset payload to fit whichever widget the kitchen's
// `pickChartType` is most likely to pick for this source. Kind names
// route via WIDGET_CATALOG (see src/kitchen/templates.js): gmail →
// email_thread, stripe/meta/all → timeline | notification_card.
function shapePayload(source, events) {
  if (source === 'gmail') {
    // email_thread expects { subject, participants, messages[] } — roll
    // the inbox up into one "Inbox · last N" thread newest-first.
    const msgs = events.map((ev) => {
      const d = ev.data || {};
      const senderRaw = d.from || d.sender;
      const sender = typeof senderRaw === 'string'
        ? { name: senderRaw.split('@')[0], email: senderRaw }
        : senderRaw || { name: 'unknown', email: null };
      return {
        sender,
        subject: d.subject || ev.title || '',
        snippet: d.snippet || d.preview || d.body || ev.summary || '',
        timestamp: ev.ts ? new Date(ev.ts).toISOString() : null,
        labels: Array.isArray(d.labels) ? d.labels : [],
      };
    });
    const participants = [];
    const seen = new Set();
    for (const m of msgs) {
      const key = (m.sender?.email || m.sender?.name || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      participants.push({ name: m.sender.name || '', email: m.sender.email || null });
      if (participants.length >= 8) break;
    }
    return {
      kind: 'email_thread',
      payload: {
        subject: `Inbox · last ${msgs.length}`,
        participants,
        messages: msgs,
        unread_count: msgs.length,
      },
    };
  }

  if (source === 'stripe') {
    // timeline expects { events: [{ ts, label, detail? }] }.
    return {
      kind: 'timeline_stripe',
      payload: {
        events: events.map((ev) => ({
          ts: ev.ts,
          label: ev.title,
          detail: ev.summary,
          amount: ev.data?.amount,
          currency: ev.data?.currency || 'usd',
          customer_email: ev.data?.customer_email,
        })),
      },
    };
  }

  if (source === 'meta_ads' || source === 'meta') {
    return {
      kind: 'timeline_meta',
      payload: {
        events: events.map((ev) => ({
          ts: ev.ts,
          label: ev.title,
          detail: ev.summary,
          spend: ev.data?.spend,
          impressions: ev.data?.impressions,
          clicks: ev.data?.clicks,
          ctr: ev.data?.ctr,
        })),
      },
    };
  }

  if (source === 'transcript' || source === 'audio') {
    return {
      kind: 'timeline_transcript',
      payload: {
        events: events.map((ev) => ({
          ts: ev.ts,
          label: ev.data?.text || ev.summary,
          detail: ev.kind,
        })),
      },
    };
  }

  // 'all' / 'drive' / 'system' → notification_card { items:[...] }.
  return {
    kind: 'notification_card',
    payload: {
      items: events.map((ev) => ({
        source: ev.source,
        kind: ev.kind,
        ts: ev.ts,
        title: ev.title,
        summary: ev.summary,
      })),
    },
  };
}

export const definition = {
  type: 'function',
  name: 'hq_query',
  description:
    "Read the live /hq event ring — emails, Stripe charges, Meta ads, Drive activity, audio transcripts. Returns a dataset id you can pass straight to render_viz (email_thread for gmail, timeline for stripe/meta, notification_card for mixed). Use this BEFORE fabricating — if the user asks what's landed today, query the ring.",
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['gmail', 'stripe', 'meta', 'drive', 'transcript', 'audio', 'all'],
        description:
          "Which stream to read. 'all' mixes every source ordered newest-first.",
      },
      since_minutes: {
        type: 'integer',
        minimum: 1,
        maximum: 10080,
        description:
          'Window in minutes back from now (default 1440 = last 24h, max 10080 = 7 days).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Max events to return (default 50).',
      },
      query: {
        type: 'string',
        description:
          'Optional case-insensitive substring filter across title / subject / body / preview / sender. Leave empty to match all.',
      },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const rawSource = String(args.source || 'all');
  if (!VALID_SOURCES.has(rawSource)) {
    return { error: `unknown source "${rawSource}"` };
  }
  const source = resolveSource(rawSource);
  const sinceMinutes = Math.max(1, Math.min(10080, args.since_minutes | 0 || 1440));
  const limit = Math.max(1, Math.min(200, args.limit | 0 || 50));
  const query = args.query ? String(args.query).trim() : '';

  const sinceMs = Date.now() - sinceMinutes * 60 * 1000;

  const events = dc.getEvents({
    source: rawSource === 'all' ? undefined : rawSource,
    sinceMs,
    limit,
    query: query || undefined,
  });

  if (!events.length) {
    return {
      id: null,
      source: rawSource,
      count: 0,
      summary: query
        ? `no ${rawSource} events matched "${query}" in the last ${sinceMinutes} min`
        : `no ${rawSource} events in the last ${sinceMinutes} min`,
      sample: [],
    };
  }

  const { kind, payload } = shapePayload(source, events);
  const id = datasets.put(`hq_events_${source}`, payload);

  // Short natural-language summary the model can narrate directly.
  const parts = [`${events.length} ${rawSource} event${events.length === 1 ? '' : 's'}`];
  if (query) parts.push(`matching "${query}"`);
  parts.push(`in last ${sinceMinutes} min`);
  const summary = parts.join(' ');

  return {
    id,
    source: rawSource,
    count: events.length,
    kind, // tells the model which render_viz chart_type is shape-matched
    window_minutes: sinceMinutes,
    query: query || null,
    summary,
    sample: events.slice(0, 3).map(trimForSample),
  };
}

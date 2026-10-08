// Smoke test for every entry in WIDGET_CATALOG. Runs each widget type
// once with hand-authored fake data, prints `OK <type> <bytes>` for each
// success, and exits non-zero if any render fails.
//
//   $ node src/kitchen/__smoke.js
//
// This is not a test-runner test — no tap/mocha/jest — just a standalone
// script the kitchen sub-agent can eyeball. Add a case here when adding
// a widget to the catalog.

import { renderViz, WIDGET_CATALOG } from './index.js';
import { SIZES } from '../sizes.js';
import * as store from '../store/datasets.js';

// Fake data per widget type. Keys match WIDGET_CATALOG keys. Each entry
// provides { kind, data, size? } so we put() it into the dataset store and
// then call renderViz({ chart_type, data_refs, intent, size }).
const FIXTURES = {
  // ─── Chart family ────────────────────────────────────────────────
  line: {
    kind: 'orders_timeseries',
    data: {
      series: Array.from({ length: 14 }, (_, i) => ({
        t: `2026-04-${String(i + 1).padStart(2, '0')}`,
        value: 100 + i * 8 + (i % 3 === 0 ? 30 : 0),
      })),
      unit: 'GBP',
    },
    intent: 'Last 14 days revenue',
    size: SIZES.wide,
  },
  bar: {
    kind: 'revenue_breakdown',
    data: {
      slices: [
        { label: 'Meta',   value: 1280 },
        { label: 'Google', value: 940  },
        { label: 'Email',  value: 620  },
        { label: 'TikTok', value: 310  },
        { label: 'Organic', value: 180 },
      ],
      unit: 'GBP',
    },
    intent: 'Revenue by channel',
    size: SIZES.wide,
  },
  donut: {
    kind: 'channel_mix',
    data: {
      slices: [
        { label: 'Meta',   value: 45 },
        { label: 'Google', value: 28 },
        { label: 'Email',  value: 17 },
        { label: 'Other',  value: 10 },
      ],
      unit: '%',
    },
    intent: 'Traffic mix',
    size: SIZES.square,
  },
  stat: {
    kind: 'orders_timeseries',
    data: {
      series: Array.from({ length: 10 }, (_, i) => ({ t: `D${i + 1}`, value: 40 + i * 5 })),
      unit: 'GBP',
    },
    intent: 'Orders this week',
    size: SIZES.stat,
  },
  hbar_rank: {
    kind: 'top_products',
    data: {
      products: [
        { name: 'Coral Jumpsuit', revenue: 1820, units: 42 },
        { name: 'Linen Shirt',    revenue: 1430, units: 65 },
        { name: 'Wide Jeans',     revenue: 1110, units: 38 },
        { name: 'Silk Scarf',     revenue: 720,  units: 22 },
        { name: 'Leather Belt',   revenue: 510,  units: 18 },
      ],
      unit: 'GBP',
    },
    intent: 'Top products this month',
    size: SIZES.wide,
  },
  comparison: {
    kind: 'orders_timeseries_comparison',
    data: {
      current:  Array.from({ length: 7 }, (_, i) => ({ t: `D${i + 1}`, value: 100 + i * 10 })),
      previous: Array.from({ length: 7 }, (_, i) => ({ t: `D${i + 1}`, value: 80  + i * 8  })),
      unit: 'GBP',
    },
    intent: 'This week vs last',
    size: SIZES.wide,
  },
  kpi_grid: {
    kind: 'orders_timeseries',
    data: {
      series: Array.from({ length: 12 }, (_, i) => ({ t: `D${i + 1}`, value: 300 + i * 24 })),
      unit: 'GBP',
    },
    intent: 'Three stat overview',
    size: SIZES.wide,
  },
  funnel: {
    kind: 'checkout_funnel',
    data: {
      steps: [
        { label: 'Visited', count: 10000 },
        { label: 'Added',   count: 4200  },
        { label: 'Checkout', count: 2100 },
        { label: 'Paid',    count: 820   },
      ],
    },
    intent: 'Checkout funnel',
    size: SIZES.wide,
  },
  gauge: {
    kind: 'revenue_goal',
    data: { value: 72_400, target: 100_000, unit: 'GBP', label: 'Monthly target' },
    intent: 'Revenue to goal',
    size: SIZES.square,
  },
  heatmap: {
    kind: 'orders_timeseries',
    data: {
      series: Array.from({ length: 21 }, (_, i) => ({
        t: `2026-04-${String(i + 1).padStart(2, '0')}`,
        value: 50 + (i % 7) * 20 + Math.round(Math.random() * 15),
      })),
      unit: 'GBP',
    },
    intent: 'Pattern by day of week',
    size: SIZES.wide,
  },
  waterfall: {
    kind: 'revenue_waterfall',
    data: {
      steps: [
        { label: 'Start',   value: 1000, kind: 'total' },
        { label: 'New',     value: 280,  kind: 'pos'   },
        { label: 'Upsell',  value: 120,  kind: 'pos'   },
        { label: 'Churn',   value: -180, kind: 'neg'   },
        { label: 'Refunds', value: -60,  kind: 'neg'   },
        { label: 'End',     value: 1160, kind: 'total' },
      ],
      unit: 'GBP',
    },
    intent: 'What moved revenue',
    size: SIZES.wide,
  },
  scatter: {
    kind: 'ads_performance',
    data: {
      points: Array.from({ length: 18 }, (_, i) => ({
        x: 50 + i * 6 + Math.round(Math.random() * 20),
        y: 100 + i * 9 + Math.round(Math.random() * 40),
        label: `Campaign ${i + 1}`,
      })),
    },
    intent: 'Spend vs revenue',
    size: SIZES.wide,
  },
  stacked_area: {
    kind: 'revenue_by_channel_over_time',
    data: {
      xs: Array.from({ length: 10 }, (_, i) => `D${i + 1}`),
      series: [
        { name: 'META',   values: [120, 140, 130, 160, 180, 220, 200, 240, 260, 280] },
        { name: 'GOOGLE', values: [80,  90,  95,  110, 130, 140, 155, 170, 175, 200] },
        { name: 'EMAIL',  values: [40,  45,  60,  55,  70,  75,  80,  85,  90,  95] },
        { name: 'OTHER',  values: [20,  22,  24,  28,  30,  32,  34,  35,  38,  40] },
      ],
    },
    intent: 'Channel mix over time',
    size: SIZES.wide,
  },
  daily_brief: {
    kind: 'daily_snapshot',
    data: {
      greeting: 'Morning, Alex',
      date: 'APR 24 · THU',
      kpis: [
        { title: 'REVENUE', value: 4830, trend: [3800, 3900, 4200, 4100, 4500, 4600, 4830], currency: 'GBP' },
        { title: 'ORDERS',  value: 142,  trend: [100, 110, 125, 120, 130, 138, 142] },
        { title: 'AOV',     value: 34,   trend: [32, 33, 33, 34, 34, 33, 34], currency: 'GBP' },
      ],
      flags: [
        { kind: 'good', text: 'Meta ROAS up 18%' },
        { kind: 'warn', text: 'Checkout drop-off at step 3' },
      ],
      leader: {
        title: 'TOP SKUS',
        rows: [
          { label: 'Coral Jumpsuit', value: 1820 },
          { label: 'Linen Shirt',    value: 1430 },
          { label: 'Wide Jeans',     value: 1110 },
        ],
      },
    },
    intent: "Morning brief",
    size: SIZES.wide,
  },

  // ─── Hologram-widget family ──────────────────────────────────────
  email_thread: {
    kind: 'email_thread',
    data: {
      emails: [
        { from: 'Sarah Chen <sarah@acme.co>', subject: 'Re: the deck',   preview: 'Hey, love the intro slide. Can we sharpen the ask on slide 12?', time: '2026-04-24T09:42:00Z', unread: true },
        { from: 'Jules <jules@acme.co>',      subject: 'Re: the deck',   preview: 'Agreed — dropped a Figma comment.', time: '2026-04-24T09:15:00Z' },
        { from: 'Alex <alex@example.com>',       subject: 'The deck',       preview: 'Sharing the v3 — wanted your eyes before Monday.', time: '2026-04-23T18:02:00Z' },
      ],
    },
    intent: 'Inbox preview',
    size: SIZES.wide,
  },
  email_detail: {
    kind: 'email_detail',
    data: {
      from: 'Sarah Chen <sarah@acme.co>',
      to: [{ name: 'Alex', email: 'alex@example.com' }, { name: 'Jules', email: 'jules@acme.co' }],
      subject: 'Re: the deck — can we sharpen slide 12?',
      time: '2026-04-24T09:42:00Z',
      body_html: `<p>Hey Alex,</p>
<p>Love the intro slide — it lands hard. I do think we can sharpen the ask on slide 12 though:</p>
<ul>
  <li>The three numbers are good but we should lead with the ARR growth rate.</li>
  <li>The call-to-action is a bit soft. "Discuss next steps" → "$250k pilot, 6-week diagnostic".</li>
  <li>Maybe drop the footnote? It competes with the main point.</li>
</ul>
<p>Happy to jump on a 15 min sync if easier — <a href="https://example.com/sarah">cal link here</a>.</p>
<p><script>alert('xss')</script></p>
<p><img src="https://tracker.example.com/pixel.gif?u=alex" onload="steal()"> — please ignore the tracker pixel above.</p>
<p>Sarah</p>`,
    },
    intent: 'Email from Sarah',
    size: SIZES.wide,
  },
  kpi_card: {
    kind: 'single_kpi',
    data: {
      label: 'REVENUE · TODAY',
      value: 4830,
      unit: 'GBP',
      delta: '+18.2%',
      trend: 'up',
    },
    intent: 'Revenue today',
    size: SIZES.stat,
  },
  timeline: {
    kind: 'activity_feed',
    data: {
      events: [
        { time: '9:42 AM', label: 'Sarah replied to "the deck"', source: 'gmail',   icon: 'mail' },
        { time: '9:15 AM', label: 'Stripe payout £4,830 landed',  source: 'stripe',  icon: 'money' },
        { time: '8:50 AM', label: 'Meta Ads ROAS crossed 3.2x',   source: 'meta',    icon: 'bolt' },
        { time: 'Yesterday', label: 'Weekly plan approved',        source: 'system',  icon: 'check' },
      ],
    },
    intent: 'This morning',
    size: SIZES.wide,
  },
  notification_card: {
    kind: 'notifications_feed',
    data: {
      items: [
        { source: 'gmail',  title: 'Sarah Chen replied',  body: 'Re: the deck — sharpen slide 12?', time: '9:42 AM' },
        { source: 'stripe', title: 'Payout landed',       body: '£4,830 to Barclays ****2104',      time: '9:15 AM' },
        { source: 'meta',   title: 'ROAS alert',          body: 'META campaign ROAS up 18%',        time: '8:50 AM' },
        { source: 'system', title: 'Weekly plan ready',   body: 'Review Monday tasks',              time: 'YESTERDAY' },
      ],
    },
    intent: 'Recent notifications',
    size: SIZES.wide,
  },
  status_ring: {
    kind: 'service_status',
    data: { label: 'CHECKOUT HEALTH', value_pct: 72, status: 'warn' },
    intent: 'Checkout health',
    size: SIZES.square,
  },

  // ─── Existing card family ───────────────────────────────────────
  email_card: {
    kind: 'email',
    data: {
      sender: { name: 'Sarah Chen', email: 'sarah@acme.co', role: 'Head of Design' },
      subject: 'Re: the deck',
      snippet: 'Hey — the intro slide is great but we should sharpen the ask on slide 12...',
      timestamp: '2026-04-24T09:42:00Z',
      unread: true,
      labels: ['WORK'],
    },
    intent: 'Email from Sarah',
    size: SIZES.wide,
  },
  message_card: {
    kind: 'message',
    data: {
      sender: { name: 'Jules' },
      body: 'just dropped a comment on v3',
      timestamp: '2026-04-24T09:45:00Z',
      channel: 'Slack · #omo',
    },
    intent: 'Slack from Jules',
    size: SIZES.wide,
  },
  payout_card: {
    kind: 'stripe_payout',
    data: { amount: 4830, currency: 'GBP', status: 'paid', period: 'Apr 24', source: 'Stripe Balance' },
    intent: 'Today payout',
    size: SIZES.wide,
  },
  invoice_card: {
    kind: 'invoice',
    data: {
      vendor: { name: 'Omo Ltd' },
      buyer:  { name: 'Acme Inc' },
      items:  [{ description: 'Retainer · April', amount: 5000 }],
      total: 5000, currency: 'GBP', due_date: '2026-05-01',
    },
    intent: 'Invoice #INV-0042',
    size: SIZES.wide,
  },
  receipt_card: {
    kind: 'order_receipt',
    data: {
      merchant: 'Omo Store',
      items: [
        { name: 'Coral Jumpsuit', qty: 1, price: 82 },
        { name: 'Silk Scarf',     qty: 2, price: 28 },
      ],
      total: 138, currency: 'GBP', order_id: 'OMO-1042',
    },
    intent: 'Latest order receipt',
    size: SIZES.wide,
  },
  event_card: {
    kind: 'calendar_event',
    data: {
      title: 'Deck review with Sarah',
      start: '2026-04-24T14:00:00Z',
      end:   '2026-04-24T14:30:00Z',
      location: 'Zoom',
      attendees: [{ name: 'Sarah Chen' }, { name: 'Jules' }],
    },
    intent: 'Next meeting',
    size: SIZES.wide,
  },
  agenda_card: {
    kind: 'calendar_day',
    data: {
      date: '2026-04-24',
      events: [
        { time: '10:00', title: 'Standup',           location: 'Zoom' },
        { time: '14:00', title: 'Deck review · Sarah', location: 'Zoom' },
        { time: '16:00', title: 'Focus · customer calls' },
      ],
    },
    intent: 'Today',
    size: SIZES.wide,
  },
  task_card: {
    kind: 'task',
    data: {
      title: 'Sharpen slide 12 before Monday',
      priority: 'high', due: '2026-04-27', owner: 'Alex', status: 'in_progress',
    },
    intent: 'Top task',
    size: SIZES.wide,
  },
  checklist_card: {
    kind: 'checklist',
    data: {
      title: 'Pre-launch checklist',
      items: [
        { label: 'Finalise pricing',       done: true },
        { label: 'Update landing copy',    done: true },
        { label: 'Queue Meta ads',         done: false },
        { label: 'Warm-up email sequence', done: false },
      ],
    },
    intent: 'Pre-launch',
    size: SIZES.wide,
  },
  profile_card: {
    kind: 'contact',
    data: { name: 'Sarah Chen', role: 'Head of Design · Acme', email: 'sarah@acme.co', phone: '+44 7700 900123' },
    intent: 'Sarah at Acme',
    size: SIZES.wide,
  },
  article_card: {
    kind: 'article',
    data: {
      title: 'How we rebuilt the checkout from scratch',
      excerpt: 'Six lessons from shipping a rebuilt checkout over six weeks — the tradeoffs, the wins, the almost-disasters.',
      source: 'stripe.com', reading_time: 8,
    },
    intent: 'Checkout rebuild article',
    size: SIZES.wide,
  },
  quote_card: {
    kind: 'quote',
    data: { text: "We should lead with the ARR growth rate, not the logos.", author: 'Sarah Chen', source: 'Deck review' },
    intent: 'Pull quote',
    size: SIZES.wide,
  },
  report_card: {
    kind: 'report',
    data: {
      title: 'Weekly revenue report',
      summary: 'Revenue up 14% w/w, driven by a Meta ROAS jump and a better-timed newsletter.',
      sections: [
        { heading: 'What moved', body: 'Meta ROAS crossed 3.2x. Email CTR held at 4.1%. Google Ads flat.' },
        { heading: 'What to watch', body: 'Checkout drop-off at step 3 climbed 4pts — needs a session replay pass.' },
      ],
      recommendation: 'Ship the checkout step-3 fix before doubling Meta spend.',
    },
    intent: 'Weekly report',
    size: SIZES.wide,
  },
  memo_card: {
    kind: 'memo',
    data: {
      title: 'Paused Google Shopping campaign',
      body: 'CTR hit 0.4% for three days running. Pausing while we rework creative; resuming Monday with new hooks.',
      cta: 'Review paused campaigns in Ads Manager',
    },
    intent: 'Memo on paused campaigns',
    size: SIZES.wide,
  },
  meeting_notes: {
    kind: 'meeting_notes',
    data: {
      title: 'Deck review',
      attendees: ['Alex', 'Sarah Chen', 'Jules'],
      decisions: ['Lead with ARR growth rate', 'Drop the footnote on slide 12'],
      actions: [{ who: 'Alex', what: 'Rework slide 12' }, { who: 'Jules', what: 'Re-check typography' }],
    },
    intent: 'Deck review notes',
    size: SIZES.wide,
  },
  changelog_card: {
    kind: 'changelog',
    data: {
      version: 'v0.4.2',
      date: '2026-04-24',
      entries: [
        { kind: 'feature', text: 'Scatter, stacked-area, timeline, status-ring widgets.' },
        { kind: 'fix',     text: 'email_thread now accepts connector-fed inbox lists.' },
      ],
    },
    intent: 'Whats new',
    size: SIZES.wide,
  },
  pros_cons_card: {
    kind: 'pros_cons',
    data: {
      question: 'Should we double Meta spend?',
      pros: ['ROAS trending up 3.2x', 'Creative pipeline stocked for 4 weeks'],
      cons: ['Checkout step-3 drop-off unresolved', 'Payback period stretches past 90d'],
    },
    intent: 'Should we double Meta spend?',
    size: SIZES.wide,
  },
  swot_card: {
    kind: 'swot',
    data: {
      strengths: ['Product loved by early users'],
      weaknesses: ['Thin ops team'],
      opportunities: ['TikTok creator partnerships'],
      threats: ['Rising CAC on Meta'],
    },
    intent: 'SWOT on current quarter',
    size: SIZES.wide,
  },
  comparison_table: {
    kind: 'vendor_compare',
    data: {
      columns: ['Feature', 'Stripe', 'Adyen', { label: 'Custom', highlight: true }],
      rows: [
        ['Time to integrate', '1 week', '3 weeks', '2 weeks'],
        ['Fee',               '2.9%+30p', '1.9%+20p', '1.2%+15p'],
        ['Fraud tooling',     'built-in', 'built-in', 'external'],
      ],
      highlight_column: 3,
    },
    intent: 'Payments provider comparison',
    size: SIZES.wide,
  },
  faq_card: {
    kind: 'faq',
    data: {
      title: 'Pre-launch FAQ',
      items: [
        { q: 'When does it go live?',     a: 'Monday at 9am UK.' },
        { q: 'Who is the target buyer?',  a: 'Series-A founders with < 20 staff.' },
      ],
    },
    intent: 'Pre-launch FAQ',
    size: SIZES.wide,
  },
  bio_card: {
    kind: 'biography',
    data: {
      name: 'Sarah Chen',
      headline: 'Head of Design · Acme',
      facts: ['10y product design', 'Led checkout rebuild at Shopify'],
      summary: 'Design systems lead turned product exec. Advises Omo on interaction and hologram typography.',
    },
    intent: 'Meet Sarah',
    size: SIZES.wide,
  },
  case_study_card: {
    kind: 'case_study',
    data: {
      title: 'How Coral Jumpsuit hit £1.8k/day',
      problem: 'Strong creative but flat conversion on paid.',
      approach: 'Paired Meta creative refresh with landing-page rebuild and a friction-free size picker.',
      outcome: '3.4x ROAS sustained for 30 days; AOV up 12%.',
      metrics: [{ label: 'ROAS', value: '3.4x' }, { label: 'AOV', value: '+12%' }],
    },
    intent: 'Coral Jumpsuit case study',
    size: SIZES.wide,
  },
  how_to_card: {
    kind: 'how_to',
    data: {
      title: 'Reset your Stripe API key',
      steps: [
        { title: 'Open Stripe → Developers → API keys', body: 'Use the account you want to rotate.' },
        { title: 'Roll the secret key',                 body: 'Old key keeps working for 12h grace.' },
        { title: 'Update your .env',                    body: 'Paste new key into `.env`, restart.' },
      ],
    },
    intent: 'How to rotate Stripe key',
    size: SIZES.wide,
  },
  glossary_card: {
    kind: 'glossary',
    data: {
      title: 'Ads glossary',
      terms: [
        { term: 'ROAS', def: 'Return on ad spend — revenue / spend.' },
        { term: 'CAC',  def: 'Customer acquisition cost.' },
        { term: 'AOV',  def: 'Average order value.' },
      ],
    },
    intent: 'Ads glossary',
    size: SIZES.wide,
  },

  // ─── Primitives ─────────────────────────────────────────────────
  notification_pill: {
    kind: 'notification',
    data: { icon: 'email', title: 'SARAH CHEN', detail: 'Replied to “the deck”', accent: 'cyan' },
    intent: 'Sarah replied',
    size: SIZES.stat,
  },
  qr_code: {
    kind: 'qr',
    data: { text: 'https://omo.co', label: 'omo.co' },
    intent: 'Share omo.co',
    size: SIZES.square,
  },
  map_snippet: {
    kind: 'location',
    data: { lat: 51.5074, lng: -0.1278, label: 'London HQ' },
    intent: 'London HQ',
    size: SIZES.wide,
  },
  timer_ring: {
    kind: 'timer',
    data: { ends_at: '2026-04-24T17:00:00Z', label: 'End of day' },
    intent: 'End of day',
    size: SIZES.square,
  },
  now_playing: {
    kind: 'now_playing',
    data: { title: 'Lost in Yesterday', artist: 'Tame Impala', progress_pct: 42 },
    intent: 'Now playing',
    size: SIZES.wide,
  },
  approval_dial: {
    kind: 'approval',
    data: { action: 'Delete 12 emails', detail: 'from the “Daily Deals” folder', risk: 'med' },
    intent: 'Confirm delete',
    size: SIZES.wide,
  },
};

// `custom` is an explicit Gemini-only path (no template, no fixtures).
// Smoke runs without network access, so we skip it here — the generator
// fallback path is exercised separately when the model actually calls it.
const SMOKE_SKIP = new Set(['custom']);

async function run() {
  const catalogKeys = Object.keys(WIDGET_CATALOG).filter((k) => !SMOKE_SKIP.has(k));
  const missingFixtures = catalogKeys.filter((k) => !FIXTURES[k]);
  if (missingFixtures.length) {
    console.error(`MISSING FIXTURES for: ${missingFixtures.join(', ')}`);
    process.exit(2);
  }
  const extraFixtures = Object.keys(FIXTURES).filter((k) => !WIDGET_CATALOG[k]);
  if (extraFixtures.length) {
    console.error(`WARNING: fixtures for unknown widgets: ${extraFixtures.join(', ')}`);
  }

  let failed = 0;
  for (const type of catalogKeys) {
    const fx = FIXTURES[type];
    const id = store.put(fx.kind, fx.data);
    let result;
    try {
      result = await renderViz({
        intent: fx.intent,
        data_refs: [id],
        size: fx.size || SIZES.wide,
        chart_type: type,
      });
    } catch (err) {
      console.error(`FAIL ${type} — threw: ${err?.message || err}`);
      failed += 1;
      continue;
    }
    if (!result?.ok) {
      console.error(`FAIL ${type} — ${result?.error || 'unknown error'}`);
      failed += 1;
      continue;
    }
    const bytes = result.html.length;
    console.log(`OK ${type} ${bytes}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} widget(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${catalogKeys.length} widgets rendered.`);
}

run().catch((err) => {
  console.error('smoke runner crashed:', err);
  process.exit(3);
});

// Template catalog entry point. Each chart template lives in its own
// file; this index wires them into the registry and owns the auto-pick
// heuristic that runs when render_viz doesn't get an explicit chart_type.
//
// Adding a new chart kind:
//   1. Drop a file in this directory that exports a pure
//      ({ dataset, datasets, intent, size }) → { body, exposedData }
//      function.
//   2. Import + register below.
//   3. Add a route to pickChartType() if the kind should ever be auto-
//      selected (otherwise it's explicit-only).
//
// Every template script is sandboxed by the iframe shell (see
// src/kitchen/index.js::assembleDocument), so the security boundary
// lives there — not in this catalog.

import { lineTemplate }       from './line.js';
import { barTemplate }        from './bar.js';
import { donutTemplate }      from './donut.js';
import { statTemplate }       from './stat.js';
import { hbarRankTemplate }   from './hbar_rank.js';
import { comparisonTemplate } from './comparison.js';
import { kpiGridTemplate }    from './kpi_grid.js';
import { funnelTemplate }     from './funnel.js';
import { gaugeTemplate }      from './gauge.js';
import { heatmapTemplate }    from './heatmap.js';
import { waterfallTemplate }  from './waterfall.js';
import { dailyBriefTemplate } from './daily_brief.js';
import { scatterTemplate }    from './scatter.js';
import { stackedAreaTemplate } from './stacked_area.js';

// ── Text-card family ────────────────────────────────────────────────
// Data-light projectables for emails, tasks, events, payouts, profiles
// — everything that isn't a chart. Each sets needsEcharts:false so the
// kitchen skips the ECharts CDN fetch for a ~300 KB/card saving.
import { emailCardTemplate }     from './email_card.js';
import { emailThreadTemplate }   from './email_thread.js';
import { messageCardTemplate }   from './message_card.js';
import { payoutCardTemplate }    from './payout_card.js';
import { invoiceCardTemplate }   from './invoice_card.js';
import { receiptCardTemplate }   from './receipt_card.js';
import { eventCardTemplate }     from './event_card.js';
import { agendaCardTemplate }    from './agenda_card.js';
import { taskCardTemplate }      from './task_card.js';
import { checklistCardTemplate } from './checklist_card.js';
import { profileCardTemplate }   from './profile_card.js';
import { articleCardTemplate }   from './article_card.js';
import { quoteCardTemplate }     from './quote_card.js';
import { googleDocCardTemplate } from './google_doc_card.js';

// ── Long-form text family ───────────────────────────────────────────
// Structured write-ups: reports, memos, meeting notes, analyses, bios,
// how-tos. Denser than the snippet cards; each template fits inside the
// 720×420 wide card with disciplined truncation.
import { reportCardTemplate }       from './report_card.js';
import { memoCardTemplate }         from './memo_card.js';
import { meetingNotesTemplate }     from './meeting_notes.js';
import { changelogCardTemplate }    from './changelog_card.js';
import { prosConsCardTemplate }     from './pros_cons_card.js';
import { swotCardTemplate }         from './swot_card.js';
import { comparisonTableTemplate }  from './comparison_table.js';
import { faqCardTemplate }          from './faq_card.js';
import { bioCardTemplate }          from './bio_card.js';
import { caseStudyCardTemplate }    from './case_study_card.js';
import { howToCardTemplate }        from './how_to_card.js';
import { glossaryCardTemplate }     from './glossary_card.js';

// ── Primitive family ────────────────────────────────────────────────
// Small utility cards — notification pill, QR code, map snippet, timer
// ring, now-playing, approval dial. Each one targeted by its own
// server tool (render_notification / show_qr / show_map / render_timer
// / render_now_playing / request_approval), so routing is usually
// explicit via chart_type rather than inferred from dataset kind.
import { notificationPillTemplate } from './notification_pill.js';
import { qrCodeTemplate }           from './qr_code.js';
import { mapSnippetTemplate }       from './map_snippet.js';
import { timerRingTemplate }        from './timer_ring.js';
import { nowPlayingTemplate }       from './now_playing.js';
import { approvalDialTemplate }     from './approval_dial.js';

// ── Hologram-widget family ──────────────────────────────────────────
// New-in-catalog non-chart widgets. email_detail is the expanded sibling
// of email_card (a single email read) with aggressive body_html
// sanitization. kpi_card is a sparkline-less counterpart to stat. timeline
// is a vertical event ladder. notification_card is a stack of recent
// items (the multi-row sibling of notification_pill). status_ring is a
// circular progress dial with an ok/warn/error status chip.
import { emailDetailTemplate }      from './email_detail.js';
import { kpiCardTemplate }          from './kpi_card.js';
import { timelineTemplate }         from './timeline.js';
import { notificationCardTemplate } from './notification_card.js';
import { statusRingTemplate }       from './status_ring.js';
import { prCardTemplate }           from './pr_card.js';
import { agentReviewCardTemplate }  from './agent_review_card.js';

export const TEMPLATES = {
  // Chart family (data-vis)
  line:        lineTemplate,
  bar:         barTemplate,
  donut:       donutTemplate,
  stat:        statTemplate,
  hbar_rank:   hbarRankTemplate,
  comparison:  comparisonTemplate,
  kpi_grid:    kpiGridTemplate,
  funnel:      funnelTemplate,
  gauge:       gaugeTemplate,
  heatmap:     heatmapTemplate,
  waterfall:   waterfallTemplate,
  daily_brief: dailyBriefTemplate,
  scatter:     scatterTemplate,
  stacked_area: stackedAreaTemplate,

  // Text-card family (no ECharts needed)
  email_card:     emailCardTemplate,
  email_thread:   emailThreadTemplate,
  message_card:   messageCardTemplate,
  payout_card:    payoutCardTemplate,
  invoice_card:   invoiceCardTemplate,
  receipt_card:   receiptCardTemplate,
  event_card:     eventCardTemplate,
  agenda_card:    agendaCardTemplate,
  task_card:      taskCardTemplate,
  checklist_card: checklistCardTemplate,
  profile_card:   profileCardTemplate,
  article_card:   articleCardTemplate,
  quote_card:     quoteCardTemplate,
  google_doc_card: googleDocCardTemplate,

  // Long-form text family (reports, analysis, bios)
  report_card:       reportCardTemplate,
  memo_card:         memoCardTemplate,
  meeting_notes:     meetingNotesTemplate,
  changelog_card:    changelogCardTemplate,
  pros_cons_card:    prosConsCardTemplate,
  swot_card:         swotCardTemplate,
  comparison_table:  comparisonTableTemplate,
  faq_card:          faqCardTemplate,
  bio_card:          bioCardTemplate,
  case_study_card:   caseStudyCardTemplate,
  how_to_card:       howToCardTemplate,
  glossary_card:     glossaryCardTemplate,

  // Primitive family (notification, QR, map, timer, now-playing, dial)
  notification_pill: notificationPillTemplate,
  qr_code:           qrCodeTemplate,
  map_snippet:       mapSnippetTemplate,
  timer_ring:        timerRingTemplate,
  now_playing:       nowPlayingTemplate,
  approval_dial:     approvalDialTemplate,

  // Hologram-widget family (new in catalog)
  email_detail:      emailDetailTemplate,
  kpi_card:          kpiCardTemplate,
  timeline:          timelineTemplate,
  notification_card: notificationCardTemplate,
  status_ring:       statusRingTemplate,

  // GitHub
  pr_card:           prCardTemplate,

  // Agent review (auto-projected on task_complete; carries PREVIEW/SHIP/SCRAP)
  agent_review_card: agentReviewCardTemplate,
};

export const CHART_TYPES = Object.keys(TEMPLATES);

// ─── Auto-pick logic ──────────────────────────────────────────────────
// Heuristic: route by intent keywords first (they beat shape routing for
// ambiguous data), then dataset kind, then size. Returns a CHART_TYPES key.
export function pickChartType({ datasets = [], size, intent = '' } = {}) {
  const primary = datasets[0];
  const kind = String(primary?.kind || '').toLowerCase();
  const sizeName = size && size.width === 360 ? 'stat'
                 : size && size.width === 480 ? 'square'
                 : 'wide';
  const intentLc = String(intent || '').toLowerCase();

  // ── Hologram-widget family: explicit-kind routing first so these win
  // over the chart-family fallbacks.
  if (kind.includes('notification') || kind.includes('alerts_feed')) return 'notification_card';
  if (kind.includes('timeline') || kind.includes('activity_feed'))   return 'timeline';
  if (kind.includes('status_ring') || kind.includes('service_status')) return 'status_ring';
  if (kind.includes('kpi_card') || kind.includes('single_kpi'))      return 'kpi_card';
  if (kind.includes('email_detail') || kind === 'email_open')        return 'email_detail';

  // GitHub-shaped routing: a single PR object → pr_card; a list of PRs
  // routes through notification_card via the connector's slim list shape.
  if (kind === 'github_pr' || kind === 'pr')                         return 'pr_card';

  // ── Text-card family: match dataset kind first, then explicit intent ─
  // These routes cover the connector-fed shapes (Gmail, calendar, Stripe,
  // tasks) so future data tools just need to pick a kind and pickChartType
  // routes the projection automatically.
  if (kind === 'google_doc' || kind.includes('google_doc'))  return 'google_doc_card';
  if (kind.includes('email_thread'))           return 'email_thread';
  if (kind.includes('email') || kind.includes('gmail'))      return 'email_card';
  if (kind.includes('message') || kind.includes('chat') || kind.includes('dm')) return 'message_card';
  if (kind.includes('payout') || kind.includes('stripe_payout'))  return 'payout_card';
  if (kind.includes('invoice'))                return 'invoice_card';
  if (kind.includes('receipt') || kind.includes('order_receipt')) return 'receipt_card';
  if (kind.includes('agenda') || kind.includes('calendar_day'))   return 'agenda_card';
  if (kind.includes('event') || kind.includes('calendar_event')) return 'event_card';
  if (kind.includes('checklist'))              return 'checklist_card';
  if (kind.includes('task'))                   return 'task_card';
  if (kind.includes('bio') || kind.includes('biography'))         return 'bio_card';
  if (kind.includes('profile') || kind.includes('contact'))       return 'profile_card';
  if (kind.includes('case_study'))             return 'case_study_card';
  if (kind.includes('how_to') || kind.includes('walkthrough') || kind.includes('guide')) return 'how_to_card';
  if (kind.includes('glossary') || kind.includes('definitions'))  return 'glossary_card';
  if (kind.includes('memo'))                   return 'memo_card';
  if (kind.includes('meeting_notes') || kind.includes('minutes')) return 'meeting_notes';
  if (kind.includes('changelog') || kind.includes('release_notes') || kind === 'github_release') return 'changelog_card';
  if (kind.includes('faq'))                    return 'faq_card';
  if (kind.includes('swot'))                   return 'swot_card';
  if (kind.includes('pros_cons') || kind.includes('decision'))    return 'pros_cons_card';
  if (kind.includes('comparison_table') || kind.includes('vendor_compare')) return 'comparison_table';
  if (kind.includes('report'))                 return 'report_card';
  if (kind.includes('article') || kind.includes('document'))      return 'article_card';
  if (kind.includes('quote'))                  return 'quote_card';

  // Intent keywords for text cards — only if dataset shape didn't route.
  // Long-form intents checked FIRST (more specific phrases shouldn't fall
  // into the short-card path — "meeting notes" must beat "meeting").
  // Walkthrough phrases ("how to X", "step by step") win over any noun in
  // X — "how to export the report" asks for a guide, not a report.
  if (/\b(how[-\s]?to|walk[-\s]?through|step[-\s]?by[-\s]?step|tutorial)\b/.test(intentLc)) return 'how_to_card';
  if (/\b(meeting\s+notes|minutes|action\s+items|notes\s+from\s+(?:the\s+)?meeting)\b/.test(intentLc)) return 'meeting_notes';
  if (/\b(changelog|release\s+notes|what['']?s\s+new)\b/.test(intentLc)) return 'changelog_card';
  if (/\b(memo|memorandum)\b/.test(intentLc))                        return 'memo_card';
  if (/\b(weekly\s+report|post[-\s]?mortem|executive\s+report|write[-\s]?up|report\s+on|this\s+week['']?s\s+report|(?:the\s+)?report\b)/.test(intentLc)) return 'report_card';
  if (/\b(pros\s+(?:and\s+)?cons|for\s+(?:and|vs)\s+against|should\s+we)\b/.test(intentLc)) return 'pros_cons_card';
  if (/\b(swot|strengths?\s+weaknesses?)\b/.test(intentLc))          return 'swot_card';
  if (/\b(compare|vs\.?|versus|side[-\s]?by[-\s]?side|comparison\s+table)\b/.test(intentLc)) return 'comparison_table';
  if (/\b(faq|frequently\s+asked|q\s*&\s*a)\b/.test(intentLc))       return 'faq_card';
  if (/\b(bio(graphy)?|introduce|intro\s+on)\b/.test(intentLc))      return 'bio_card';
  if (/\b(case\s+study|success\s+story|how\s+(?:we|they)\s+(?:solved|did))\b/.test(intentLc)) return 'case_study_card';
  if (/\b(glossary|cheat[-\s]?sheet|terminology|definitions?)\b/.test(intentLc)) return 'glossary_card';

  // Snippet-card intents (these still need to beat the chart-family fallback).
  if (/\b(email\s+thread|thread|conversation)\b/.test(intentLc))     return 'email_thread';
  if (/\b(email|inbox|gmail)\b/.test(intentLc))                      return 'email_card';
  if (/\b(pull\s+request|\bpr\b|\bpr\s*#?\s*\d+)\b/.test(intentLc) && (kind === 'github_pr' || kind === 'pr')) return 'pr_card';
  if (/\b(message|slack|dm|text(\s+message)?|sms)\b/.test(intentLc)) return 'message_card';
  if (/\b(payout|payment|transfer)\b/.test(intentLc))                return 'payout_card';
  if (/\binvoice\b/.test(intentLc))                                  return 'invoice_card';
  if (/\b(receipt|order(\s+confirmation)?)\b/.test(intentLc))        return 'receipt_card';
  if (/\b(agenda|day\s+plan|schedule)\b/.test(intentLc))             return 'agenda_card';
  if (/\b(event|meeting|calendar)\b/.test(intentLc))                 return 'event_card';
  if (/\b(checklist|to[-\s]?do\s+list)\b/.test(intentLc))            return 'checklist_card';
  if (/\b(task|todo|to[-\s]do)\b/.test(intentLc))                    return 'task_card';
  if (/\b(profile|contact|about\s+(me|them)|person)\b/.test(intentLc)) return 'profile_card';
  if (/\b(article|doc|document|summary\s+of)\b/.test(intentLc))      return 'article_card';
  if (/\b(quote|testimonial)\b/.test(intentLc))                      return 'quote_card';

  // Dataset-kind overrides first: daily_snapshot → daily_brief, always.
  if (kind.includes('daily_snapshot')) return 'daily_brief';

  // Intent keywords beat shape routing for ambiguous data.
  if (/\b(daily\s+brief|ceo\s+report|morning\s+report|executive\s+summary|brief)\b/.test(intentLc)) {
    return 'daily_brief';
  }
  if (/\b(notifications?\s+feed|recent\s+notifications|alerts?\s+feed)\b/.test(intentLc)) {
    return 'notification_card';
  }
  if (/\b(timeline|activity\s+feed|recent\s+activity|event\s+log)\b/.test(intentLc)) {
    return 'timeline';
  }
  if (/\b(status|health|uptime|service\s+status|sync\s+progress)\b/.test(intentLc)) {
    return 'status_ring';
  }
  if (/\b(single\s+kpi|one\s+(metric|number)|headline\s+(number|metric))\b/.test(intentLc)) {
    return 'kpi_card';
  }
  if (/\b(scatter|correlation|dot\s+plot|cloud\s+of\s+points)\b/.test(intentLc)) {
    return 'scatter';
  }
  if (/\b(stacked\s+area|stacked\s+over\s+time|mix\s+over\s+time|share\s+over\s+time)\b/.test(intentLc)) {
    return 'stacked_area';
  }
  if (/\b(funnel|conversion|drop[-\s]?off|checkout\s+flow)\b/.test(intentLc)) {
    return 'funnel';
  }
  if (/\b(gauge|target|goal|progress|on\s+track|to\s+goal)\b/.test(intentLc)) {
    return 'gauge';
  }
  if (/\b(heatmap|calendar|day[-\s]?of[-\s]?week|weekly\s+pattern|when\s+do)\b/.test(intentLc)) {
    return 'heatmap';
  }
  if (/\b(waterfall|bridge|movement|what\s+moved|contribution|decomposition)\b/.test(intentLc)) {
    return 'waterfall';
  }
  if (/\b(vs|versus|compare|comparison|last\s+week|previous|prior)\b/.test(intentLc)) {
    return 'comparison';
  }
  if (/\b(top\s*\d*|leaderboard|ranking|best|largest|biggest)\b/.test(intentLc)) {
    return 'hbar_rank';
  }
  if (/\b(overview|snapshot|summary|dashboard|three[-\s]stat|kpi)\b/.test(intentLc)) {
    return 'kpi_grid';
  }
  if (/\b(breakdown|split|share|mix|composition|proportion|donut|pie|ring)\b/.test(intentLc)) {
    return 'donut';
  }

  if (kind.includes('timeseries')) return sizeName === 'stat' ? 'stat' : 'line';
  if (kind.includes('breakdown') || kind.includes('channel_mix') || kind.includes('customer_stats')) {
    return 'donut';
  }
  if (kind.includes('top_products')) return 'hbar_rank';
  if (kind.includes('ads_performance')) {
    return sizeName === 'wide' ? 'hbar_rank' : 'bar';
  }

  if (sizeName === 'stat') return 'stat';
  if (sizeName === 'square') return 'donut';
  return 'bar';
}

// Re-exports for callers that used to reach into templates.js directly.
export {
  lineTemplate, barTemplate, donutTemplate, statTemplate,
  hbarRankTemplate, comparisonTemplate, kpiGridTemplate,
  funnelTemplate, gaugeTemplate, heatmapTemplate, waterfallTemplate,
  dailyBriefTemplate,
  scatterTemplate, stackedAreaTemplate,
  emailCardTemplate, emailThreadTemplate, messageCardTemplate,
  payoutCardTemplate, invoiceCardTemplate, receiptCardTemplate,
  eventCardTemplate, agendaCardTemplate, taskCardTemplate, checklistCardTemplate,
  profileCardTemplate, articleCardTemplate, quoteCardTemplate,
  googleDocCardTemplate,
  reportCardTemplate, memoCardTemplate, meetingNotesTemplate, changelogCardTemplate,
  prosConsCardTemplate, swotCardTemplate, comparisonTableTemplate, faqCardTemplate,
  bioCardTemplate, caseStudyCardTemplate, howToCardTemplate, glossaryCardTemplate,
  notificationPillTemplate, qrCodeTemplate, mapSnippetTemplate,
  timerRingTemplate, nowPlayingTemplate, approvalDialTemplate,
  emailDetailTemplate, kpiCardTemplate, timelineTemplate,
  notificationCardTemplate, statusRingTemplate,
  prCardTemplate,
};
export { jsonForScript } from '../../util.js';

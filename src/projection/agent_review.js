// src/projection/agent_review.js — auto-project the "review needed" card
// onto the hologram the moment a background agent finishes a task that
// touched any files. Closes the silent-failure gap where task_complete
// fires, the squad UI updates a badge, and Momo says nothing — leaving
// the user to wonder whether anything actually happened.
//
// Flow:
//   1. Subscribe to agents/bus events (kind=task_complete).
//   2. Look up the agent's worktree diff via hermes.peekAgentDiff.
//   3. Empty diff → tiny notification_pill ("Sora wrapped — nothing changed").
//      Non-empty → build a dataset + broadcastProjection an
//      agent_review_card with PREVIEW / SHIP IT / scrap buttons.
//   4. Pre-compute a preview URL:
//        • If any public/*.html file is in the diff → /preview-agent/<id>/<file>
//        • Otherwise → /preview-diff?agent=<id>
//      The card's PREVIEW button posts the URL up; the client wraps it
//      with show_preview / show_pane.
//
// Dedup / debounce: we don't dedup here. Each task_complete maps to one
// fresh card. continue_agent_task → new card replacing the prior. The
// client-side auto-project layer already throttles bursts.
//
// Wire once from server boot:
//   import { install as installAgentReview } from './projection/agent_review.js';
//   installAgentReview();

import { randomUUID } from 'node:crypto';
import * as datasets from '../store/datasets.js';
import * as agentBus from '../agents/bus.js';
import { peekAgentDiff, listAgents } from '../hermes/index.js';
import { broadcastProjection } from './broadcast.js';
import { emit } from '../data_core.js';

function pickPreviewUrl(agent_id /*, files */) {
  // Always send the user to the rich review screen — file tabs +
  // LIVE/DIFF toggle + SHIP/SCRAP buttons all in one view. The screen
  // auto-picks the most visible HTML file as the default tab; the user
  // can tab through every changed file from there.
  return `/preview-agent/${encodeURIComponent(agent_id)}`;
}

function topFiles(files, n = 4) {
  if (!Array.isArray(files)) return [];
  // Sort by total churn (added + removed) DESC, biggest changes first.
  return [...files]
    .sort((a, b) => (Number(b.added || 0) + Number(b.removed || 0)) - (Number(a.added || 0) + Number(a.removed || 0)))
    .slice(0, n);
}

function shortPrompt(prompt) {
  if (!prompt) return '';
  const flat = String(prompt).replace(/\s+/g, ' ').trim();
  return flat.split(/[,.!?;:\n]/)[0].slice(0, 80);
}

// Tiny status card for the "no diff" case — much less obtrusive than the
// full review card. Bypasses broadcastProjection's data_refs requirement
// by emitting directly with a status payload that auto-project doesn't
// match (it filters kind='project'); instead we rely on the agents bus
// fanout so the squad UI knows. Keeps the hologram clean.
function emitQuietNotice(ev) {
  // Could project a notification_pill here if we want louder confirmation.
  // For now just log — task_complete already shows in the squad UI.
  console.log(`[agent_review] ${ev.data?.agentName || ev.agent_id} wrapped with no file changes — skipping projection`);
}

async function handleTaskComplete(ev) {
  const data = ev?.data || {};
  // task_complete fires whether the run succeeded, errored, or was
  // stopped. Project whenever there's salvageable work in the worktree —
  // partial output from an errored/stopped run is often still worth
  // shipping or scrapping, and silently swallowing it would let it
  // expire with linger. The status is forwarded into the dataset so
  // the card can render a "⚠️ errored partway" label.
  const status = data.status || 'done';

  const agent_id = data.agentId || data.agent_id;
  if (!agent_id) return;

  // Worktree may have been reaped (long-running tasks, server restart).
  let diff;
  try {
    diff = peekAgentDiff(agent_id);
  } catch (err) {
    console.warn('[agent_review] peekAgentDiff threw:', err?.message || err);
    return;
  }
  if (!diff?.ok) {
    // Agent finished but we can't see their workspace (NO_WORKTREE etc).
    // Don't project — but log so this is debuggable.
    console.log(`[agent_review] ${data.agentName} complete but no worktree: ${diff?.code || diff?.error || 'unknown'}`);
    return;
  }

  if (!diff.hasChanges || diff.stat?.fileCount === 0) {
    return emitQuietNotice(ev);
  }

  const files = topFiles(diff.files, 4);
  const preview_url = pickPreviewUrl(agent_id);

  // Pull the agent's color + sigil from the live roster so the card
  // matches what the squad UI shows. Falls back to defaults on miss.
  let agentMeta = null;
  try {
    agentMeta = (listAgents() || []).find((a) => a.agent_id === agent_id) || null;
  } catch {}

  // Stash the structured payload in the dataset store so the card
  // template can read it through window.__DATA (the kitchen pipeline's
  // standard id-referencing path — never let raw fields slip into the
  // template arg).
  const dataset = {
    agent_id,
    agent_name: diff.agent_name || data.agentName || 'agent',
    agent_sigil: agentMeta?.sigil || data.agent_sigil || '◆',
    agent_color: agentMeta?.color || data.agent_color || '#F2C464',
    stat: {
      fileCount: diff.stat?.fileCount || 0,
      added: diff.stat?.added || 0,
      removed: diff.stat?.removed || 0,
    },
    files: files.map((f) => ({
      path: f.path,
      added: Number(f.added || 0),
      removed: Number(f.removed || 0),
      status: f.status || 'M',
    })),
    preview_url,
    task_label: shortPrompt(data.task || data.label || ''),
    runtime: data.runtime || '',
    status,
    error: status !== 'done' ? (data.error || null) : null,
  };

  const datasetId = datasets.put('agent_review', dataset);

  const intentVerb = status === 'done' ? 'drafted' : (status === 'stopped' ? 'partially wrote' : 'errored after writing');
  try {
    const result = await broadcastProjection({
      intent: `${dataset.agent_name} ${intentVerb} ${dataset.stat.fileCount} file${dataset.stat.fileCount === 1 ? '' : 's'}`,
      data_refs: [datasetId],
      chart_type: 'agent_review_card',
      size: 'wide',
      reason: `agent ${dataset.agent_name} task ${status}`,
      producer: 'agent_review',
      ttlMs: 0,
    });
    if (!result.ok) {
      console.warn('[agent_review] broadcastProjection failed:', result.error);
      return;
    }
    // Also fan a typed event the client-side handler can use to track
    // pending reviews (so the user can later say "what's pending?" and
    // we have an answer without re-scanning all agents).
    emit({
      id: randomUUID(),
      ts: Date.now(),
      source: 'agent_review',
      kind: 'pending',
      title: `${dataset.agent_name} awaiting review`,
      summary: `${dataset.stat.fileCount} files +${dataset.stat.added} −${dataset.stat.removed}`,
      data: {
        agent_id,
        agent_name: dataset.agent_name,
        projectable_id: result.projectable_id,
        preview_url: dataset.preview_url,
        stat: dataset.stat,
      },
    });
  } catch (err) {
    console.warn('[agent_review] broadcast threw:', err?.message || err);
  }
}

let unsub = null;

export function install() {
  if (unsub) return unsub;
  unsub = agentBus.subscribe((ev) => {
    if (ev?.kind !== 'task_complete') return;
    // Fire-and-forget; we never want to block the bus on a render.
    handleTaskComplete(ev).catch((err) =>
      console.warn('[agent_review] handler threw:', err?.message || err),
    );
  });
  return unsub;
}

export function uninstall() {
  if (typeof unsub === 'function') unsub();
  unsub = null;
}

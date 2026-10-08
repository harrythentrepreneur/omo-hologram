// agent_review_card — projected automatically when a background agent
// finishes a task with a non-empty diff. The whole point is to make
// "the agent did the thing, now what do I do" obvious and one-tap:
//
//   ┌──────────────────────────────────────┐
//   │  ◆ SAGE · DRAFTED                    │
//   │  4 files  +56 −12  ·  via claude     │
//   │                                      │
//   │  public/welcome-2.html      +247 −0  │
//   │  server.js                    +3 −0  │
//   │  src/tools/show_pane.js      +14 −5  │
//   │                                      │
//   │  [ PREVIEW ]   [ SHIP IT → ]  scrap  │
//   └──────────────────────────────────────┘
//
// Voice still works ("ship Sage's work") but the buttons close the
// loop with one tap for non-technical users.
//
// Button click → parent.postMessage({omo_agent_action:true, action,
//   agent_id, ...}, '*'). public/agent-review-handler.js (loaded by the
// hologram pages) catches the message and turns it into a /tool POST.
//
// Data shape:
//   {
//     agent_id, agent_name, agent_sigil, agent_color,
//     stat: { fileCount, added, removed },
//     files: [{ path, added, removed, status }],
//     preview_url: string | null,    // pre-computed best preview URL
//     task_label: string,             // human-readable task title
//     runtime: 'claude' | 'hermes',
//   }

import { escapeHtml, emptyStateBody } from './shared.js';
import { jsonForScript } from '../../util.js';

// Local — shared.js doesn't export this; kitchen/index.js keeps it private.
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function coerce(data) {
  if (!data) return null;
  const agent_id = String(data.agent_id || '').trim();
  const agent_name = String(data.agent_name || 'agent').trim();
  if (!agent_id) return null;
  const stat = data.stat || {};
  const files = Array.isArray(data.files) ? data.files.slice(0, 4) : [];
  return {
    agent_id,
    agent_name,
    agent_sigil: String(data.agent_sigil || '◆'),
    agent_color: String(data.agent_color || '#F2C464'),
    stat: {
      fileCount: Number(stat.fileCount || files.length || 0),
      added: Number(stat.added || 0),
      removed: Number(stat.removed || 0),
    },
    files,
    preview_url: data.preview_url ? String(data.preview_url) : null,
    task_label: String(data.task_label || '').slice(0, 80),
    runtime: String(data.runtime || ''),
    status: String(data.status || 'done'),
    error: data.error ? String(data.error).slice(0, 140) : null,
  };
}

export function agentReviewCardTemplate({ dataset, intent }) {
  const r = coerce(dataset?.data);
  if (!r) {
    return { body: emptyStateBody(intent, 'Need an agent_id and diff stat.'), exposedData: {}, needsEcharts: false };
  }

  const fileRows = r.files.length
    ? r.files.map((f) => {
        const path = String(f.path || '').slice(0, 60);
        const added = Number(f.added || 0);
        const removed = Number(f.removed || 0);
        const status = String(f.status || 'M').toUpperCase();
        return `<div class="row">
  <span class="status status-${escapeAttr(status[0] || 'M')}">${escapeHtml(status[0] || 'M')}</span>
  <span class="path">${escapeHtml(path)}</span>
  <span class="delta"><span class="add">+${added}</span><span class="rem">−${removed}</span></span>
</div>`;
      }).join('')
    : '<div class="row muted">no file changes</div>';

  const stat = r.stat;
  const taskLabel = r.task_label ? `<div class="task">${escapeHtml(r.task_label)}</div>` : '';
  const previewBtn = r.preview_url
    ? `<button type="button" class="btn btn-preview" data-action="preview">PREVIEW</button>`
    : `<button type="button" class="btn btn-preview" data-action="diff">VIEW DIFF</button>`;

  // Inline the action payload as JSON; the client handler reads
  // dataset.omoAgentAction* attrs OR window.__OMO_REVIEW.
  const payload = {
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    preview_url: r.preview_url,
  };

  const body = `<div id="viz" class="holo-review">
  <style>
    .holo-review {
      width: 100%; height: 100%;
      display: flex;
      flex-direction: column;
      padding: 14px 16px 12px;
      box-sizing: border-box;
      font-family: "SF Pro Text", system-ui, -apple-system, sans-serif;
      color: rgba(255, 255, 255, 0.94);
      gap: 10px;
      --amber: #ffcf66;
      --amber-glow: rgba(255, 207, 102, 0.6);
      --cyan: #00e5ff;
      --cyan-glow: rgba(0, 229, 255, 0.55);
      --pink: #ff66b3;
      --pink-glow: rgba(255, 102, 179, 0.55);
      --muted: rgba(255, 255, 255, 0.55);
      --hair: rgba(255, 255, 255, 0.12);
    }
    .head {
      display: flex; align-items: baseline; gap: 8px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--hair);
    }
    .sigil {
      color: ${escapeAttr(r.agent_color)};
      font-size: 13px;
      text-shadow: 0 0 6px ${escapeAttr(r.agent_color)};
    }
    .who {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--amber);
      text-shadow: 0 0 6px var(--amber-glow);
    }
    .tag {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9.5px;
      letter-spacing: 0.18em;
      color: var(--muted);
      margin-left: auto;
    }
    .summary {
      display: flex; gap: 14px; align-items: baseline;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11.5px;
      color: rgba(255, 255, 255, 0.85);
    }
    .summary .count {
      color: white;
      font-size: 14px;
      font-weight: 600;
    }
    .summary .add { color: var(--cyan); text-shadow: 0 0 5px var(--cyan-glow); }
    .summary .rem { color: var(--pink); text-shadow: 0 0 5px var(--pink-glow); }
    .summary .via { color: var(--muted); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; margin-left: auto; }
    .task {
      font-size: 11.5px;
      color: rgba(255, 255, 255, 0.7);
      line-height: 1.45;
      font-style: italic;
      max-height: 2.9em;
      overflow: hidden;
    }
    .files {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
    }
    .row {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      gap: 8px;
      align-items: center;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      padding: 3px 0;
    }
    .row.muted { color: var(--muted); }
    .row .status {
      display: inline-block;
      text-align: center;
      font-size: 9px;
      letter-spacing: 0.1em;
      color: var(--muted);
      font-weight: 600;
    }
    .row .status-A { color: var(--cyan); }
    .row .status-M { color: var(--amber); }
    .row .status-D { color: var(--pink); }
    .row .path {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: rgba(255, 255, 255, 0.9);
    }
    .row .delta {
      font-size: 10px;
      display: inline-flex;
      gap: 6px;
    }
    .row .delta .add { color: var(--cyan); }
    .row .delta .rem { color: var(--pink); }
    .actions {
      display: flex;
      gap: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--hair);
      align-items: center;
    }
    .btn {
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      padding: 8px 14px;
      background: transparent;
      color: white;
      border: 1px solid var(--hair);
      cursor: pointer;
      transition: all 140ms ease;
      border-radius: 0;
    }
    .btn:hover {
      border-color: rgba(255, 255, 255, 0.4);
      background: rgba(255, 255, 255, 0.05);
    }
    .btn-preview {
      border-color: color-mix(in srgb, var(--cyan) 50%, transparent);
      color: var(--cyan);
      text-shadow: 0 0 6px var(--cyan-glow);
    }
    .btn-preview:hover {
      background: rgba(0, 229, 255, 0.1);
      border-color: var(--cyan);
      box-shadow: 0 0 14px var(--cyan-glow);
    }
    .btn-ship {
      border-color: var(--amber);
      color: var(--amber);
      text-shadow: 0 0 6px var(--amber-glow);
      box-shadow: 0 0 0 1px var(--amber-glow), 0 0 14px var(--amber-glow);
      margin-left: auto;
      font-weight: 700;
    }
    .btn-ship:hover {
      background: var(--amber);
      color: #0A0E14;
      text-shadow: none;
      box-shadow: 0 0 0 1px var(--amber), 0 0 24px var(--amber-glow);
    }
    .btn-scrap {
      color: var(--muted);
      border-color: transparent;
      padding: 8px 10px;
      font-size: 9.5px;
    }
    .btn-scrap:hover {
      color: var(--pink);
      text-shadow: 0 0 6px var(--pink-glow);
      border-color: color-mix(in srgb, var(--pink) 30%, transparent);
    }
    .btn:disabled { opacity: 0.5; cursor: progress; }
    .toast {
      position: absolute;
      bottom: 8px; left: 50%;
      transform: translateX(-50%);
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.16em;
      padding: 4px 12px;
      background: rgba(10, 14, 20, 0.92);
      border: 1px solid var(--amber);
      color: var(--amber);
      text-shadow: 0 0 6px var(--amber-glow);
      opacity: 0;
      pointer-events: none;
      transition: opacity 220ms ease;
    }
    .toast[data-show="1"] { opacity: 1; }
    .toast[data-tone="err"] { border-color: var(--pink); color: var(--pink); text-shadow: 0 0 6px var(--pink-glow); }
  </style>
  <div class="head">
    <span class="sigil">${escapeHtml(r.agent_sigil)}</span>
    <span class="who">${escapeHtml(r.agent_name)} · ${r.status === 'done' ? 'DRAFTED' : (r.status === 'stopped' ? '⚠ STOPPED PARTWAY' : '⚠ ERRORED PARTWAY')}</span>
    ${r.runtime ? `<span class="tag">via ${escapeHtml(r.runtime)}</span>` : ''}
  </div>
  ${r.error ? `<div class="task" style="color: var(--pink); text-shadow: 0 0 6px var(--pink-glow);">${escapeHtml(r.error)}</div>` : ''}
  <div class="summary">
    <span><span class="count">${stat.fileCount}</span> file${stat.fileCount === 1 ? '' : 's'}</span>
    <span class="add">+${stat.added}</span>
    <span class="rem">−${stat.removed}</span>
  </div>
  ${taskLabel}
  <div class="files">${fileRows}</div>
  <div class="actions">
    ${previewBtn}
    <button type="button" class="btn btn-ship" data-action="ship">SHIP IT →</button>
    <button type="button" class="btn btn-scrap" data-action="scrap">scrap</button>
  </div>
  <div class="toast" id="toast"></div>
  <script>
  (function(){
    var PAYLOAD = ${jsonForScript(payload)};
    var card = document.getElementById('viz');
    var toast = document.getElementById('toast');
    function showToast(msg, tone) {
      toast.textContent = msg;
      toast.dataset.tone = tone || 'ok';
      toast.dataset.show = '1';
      clearTimeout(showToast._t);
      showToast._t = setTimeout(function(){ toast.dataset.show = '0'; }, 2400);
    }
    function lock(btn) {
      var btns = card.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
      if (btn) btn.disabled = true;
    }
    card.addEventListener('click', function(e){
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var payload = {
        omo_agent_action: true,
        action: action,
        agent_id: PAYLOAD.agent_id,
        agent_name: PAYLOAD.agent_name,
        preview_url: PAYLOAD.preview_url,
      };
      try {
        parent.postMessage(payload, '*');
      } catch (err) {
        showToast('post failed', 'err');
        return;
      }
      if (action === 'ship') { lock(btn); showToast('shipping…'); }
      else if (action === 'scrap') { lock(btn); showToast('scrapping…'); }
      else if (action === 'preview' || action === 'diff') { showToast('opening…'); }
    });
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('agent_review_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: payload, needsEcharts: false };
}

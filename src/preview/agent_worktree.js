// src/preview/agent_worktree.js — serve files directly out of an agent's
// isolated worktree so the user can SEE the agent's pending work without
// merging it first.
//
// Why this exists:
//   Agents (Claude / Hermes) run in git worktrees under ~/.omo/worktrees/.
//   When an agent edits public/foo.html, the change is real and on disk —
//   but the main `npm start` server doesn't know about it. Voice flow
//   "show me what Sora built" → previously required accepting the diff
//   first. With this mount, the holo can iframe
//     /preview-agent/<agent_id_or_name>/foo.html
//   and the user sees the live file rendering immediately.
//
// Surface area:
//   /preview-agent/:agentRef                 → directory listing
//   /preview-agent/:agentRef/*               → static file from <worktree>/public/
//   /preview-agent/:agentRef/__worktree__/*  → static file from <worktree>/ root
//
// Security:
//   - Resolves :agentRef through hermes only — never trusts the URL for
//     paths; the worktree path comes from the in-memory agent registry.
//   - express.static handles path traversal protection.
//   - Cache-Control: no-store so edits show up on refresh.
//   - The mount lives inside the same sandboxed /preview iframe the user
//     already trusts; no new CSP/sandbox surface is opened.

import express from 'express';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getAgentWorktreePath, peekAgentDiff, listAgents } from '../hermes/index.js';

const NO_CACHE = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') };

// Endpoint: every agent that has unshipped work in their worktree.
// Powers the "pending reviews" dock at the bottom of /preview so the
// user can see what's stacked up — regardless of which URL they're
// previewing — and ship/scrap directly. Cheap (in-memory roster + a
// `git status --porcelain` per agent).
async function listPendingReviews() {
  const out = [];
  let agents = [];
  try { agents = listAgents() || []; } catch { return out; }
  for (const a of agents) {
    if (!a.has_worktree) continue;
    let diff;
    try { diff = peekAgentDiff(a.agent_id); } catch { continue; }
    if (!diff?.ok || !diff.hasChanges) continue;
    out.push({
      agent_id: a.agent_id,
      agent_name: a.name,
      sigil: a.sigil || '◆',
      color: a.color || '#F2C464',
      runtime: a.last_task?.runtime || a.current_task?.runtime || null,
      is_busy: !!a.current_task,
      stat: {
        fileCount: diff.stat?.fileCount || 0,
        added: diff.stat?.added || 0,
        removed: diff.stat?.removed || 0,
      },
      preview_url: `/preview-agent/${encodeURIComponent(a.agent_id)}`,
      // Most-recently-active first.
      _ts: a.last_activity_at || 0,
    });
  }
  out.sort((a, b) => (b._ts || 0) - (a._ts || 0));
  return out.map(({ _ts, ...rest }) => rest);
}

export function mountRoutes(app) {
  app.get('/omo/api/pending-reviews', async (_req, res) => {
    try {
      const items = await listPendingReviews();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ items, count: items.length });
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // List the worktree's public/ dir as JSON (handy for "what files did
  // Sora touch?" + for the holo to build a quick navigation menu).
  app.get('/preview-agent/:agentRef/__list__', async (req, res) => {
    const wt = getAgentWorktreePath(req.params.agentRef);
    if (!wt) return res.status(404).json({ error: 'agent has no worktree' });
    try {
      const dir = join(wt, 'public');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      return res.json({ agent_ref: req.params.agentRef, worktree: wt, files });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Review screen — the rich UI you land on when you tap PREVIEW on the
  // agent_review_card OR voice-nav "show me what Sage built". One slim
  // header strip (agent badge + ship/scrap), a row of file-tabs with
  // status badges + line counts, a [LIVE | DIFF] toggle, and a big
  // iframe below loading either the rendered HTML file or the diff page.
  app.get(['/preview-agent/:agentRef', '/preview-agent/:agentRef/'], async (req, res) => {
    const ref = req.params.agentRef;
    const wt = getAgentWorktreePath(ref);
    if (!wt) return res.status(404).send(notFoundHtml(ref));

    // Pull the structured diff so the file-tabs carry +/− stats.
    let diff = null;
    try { diff = peekAgentDiff(ref); } catch {}
    let agentMeta = null;
    try { agentMeta = (listAgents() || []).find((a) => a.agent_id === diff?.agent_id || a.name === diff?.agent_name) || null; } catch {}

    res.setHeader('Cache-Control', 'no-store');
    res.send(reviewScreenHtml({ ref, diff: diff?.ok ? diff : null, agentMeta }));
  });

  // Per-request static handler. We resolve the worktree on every request
  // (cheap — in-memory map lookup) so reaping / re-mounting agents
  // doesn't leave a dangling middleware closure.
  app.use('/preview-agent/:agentRef', (req, res, next) => {
    const wt = getAgentWorktreePath(req.params.agentRef);
    if (!wt) return res.status(404).send(notFoundHtml(req.params.agentRef));
    const rootRequested = req.path.startsWith('/__worktree__/');
    const rel = rootRequested ? req.path.replace('/__worktree__', '') : req.path;
    const base = rootRequested ? wt : join(wt, 'public');
    // Strip the prefix so express.static sees a path relative to `base`.
    req.url = rel || '/';
    return express.static(base, NO_CACHE)(req, res, next);
  });
}

function notFoundHtml(ref) {
  const safe = String(ref).replace(/[<>&"']/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
  return `<!doctype html><meta charset=utf-8><title>preview · not found</title>
<style>body{margin:0;padding:48px;background:#0A0E14;color:#E87D7D;font:14px/1.5 "JetBrains Mono",ui-monospace,Menlo,monospace;text-align:center}
h1{color:#F2C464;font-weight:700;letter-spacing:.08em;margin:6px 0 14px}
code{background:#131924;padding:2px 6px;border:1px solid rgba(184,228,201,.2)}</style>
<h1>NO WORKTREE</h1>
<p>No agent worktree found for <code>${safe}</code>.</p>
<p>This usually means the agent was reaped, or never had an isolated workspace.</p>`;
}

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
}

// Pick which file should be the default "live render" tab. Public-facing
// HTML wins; otherwise the file with the most line changes.
function pickDefaultRenderFile(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const publicHtml = files.find((f) => /^public\/.+\.html?$/i.test(String(f.path || '')));
  if (publicHtml) return publicHtml;
  // Largest churn first.
  const sorted = [...files].sort((a, b) =>
    (Number(b.added || 0) + Number(b.removed || 0)) - (Number(a.added || 0) + Number(a.removed || 0)),
  );
  return sorted[0] || null;
}

// What URL inside this mount renders the given file's current state.
// HTML files in public/ are served live. Anything else falls through to
// the file's raw contents under /__worktree__/.
function renderUrlFor(ref, file) {
  const path = String(file?.path || '');
  if (!path) return null;
  if (/^public\/.+/.test(path)) {
    const rel = path.replace(/^public\//, '');
    return `/preview-agent/${encodeURIComponent(ref)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }
  return `/preview-agent/${encodeURIComponent(ref)}/__worktree__/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function statusBadge(status) {
  const s = String(status || 'M').toUpperCase()[0];
  return s === 'A' ? 'A' : s === 'D' ? 'D' : s === 'R' ? 'R' : 'M';
}

function reviewScreenHtml({ ref, diff, agentMeta }) {
  const safeRef = esc(ref);
  const agentName = esc(agentMeta?.name || diff?.agent_name || 'agent');
  const sigil = esc(agentMeta?.sigil || '◆');
  const color = String(agentMeta?.color || '#F2C464').replace(/[^a-zA-Z0-9#(),.\s%-]/g, '');
  const stat = diff?.stat || { fileCount: 0, added: 0, removed: 0 };
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const defaultFile = pickDefaultRenderFile(files);
  const defaultUrl = defaultFile ? renderUrlFor(ref, defaultFile) : '';
  const diffUrl = `/preview-diff?agent=${encodeURIComponent(ref)}`;

  const tabs = files.length
    ? files.map((f, i) => {
        const url = renderUrlFor(ref, f);
        const path = esc(f.path);
        const isDefault = defaultFile && f.path === defaultFile.path;
        const badge = statusBadge(f.status);
        const renderable = /^public\/.+\.html?$/i.test(String(f.path));
        return `<button class="tab ${isDefault ? 'active' : ''}" data-url="${esc(url)}" data-renderable="${renderable ? '1' : '0'}" data-index="${i}">
          <span class="b b-${badge}">${badge}</span>
          <span class="path">${path}</span>
          <span class="delta"><span class="add">+${Number(f.added || 0)}</span><span class="rem">−${Number(f.removed || 0)}</span></span>
        </button>`;
      }).join('')
    : '<div class="empty">no changes in this worktree</div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>review · ${agentName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg:#0A0E14; --bg-2:#0E131B; --bg-3:#131924;
    --phosphor:#B8E4C9; --phosphor-dim:#7FA48C; --phosphor-faint:rgba(184,228,201,0.28);
    --amber:#F2C464; --amber-dim:#A68644; --amber-glow:rgba(242,196,100,0.45);
    --coral:#E87D7D; --periwinkle:#9EAAF2; --cyan:#00e5ff; --pink:#ff66b3;
    --edge:rgba(184,228,201,0.16); --scan:rgba(184,228,201,0.035);
    --agent:${color};
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;background:var(--bg);color:var(--phosphor);font:13px/1.5 "JetBrains Mono",ui-monospace,Menlo,monospace;overflow:hidden}
  body{display:grid;grid-template-rows:46px 44px 1fr;animation:flicker 7.8s infinite ease-in-out}
  @keyframes flicker{0%,100%{opacity:1}48%{opacity:.985}50%{opacity:.97}52%{opacity:.99}}
  body::before{content:"";position:fixed;inset:0;background:repeating-linear-gradient(0deg,var(--scan) 0,var(--scan) 1px,transparent 1px,transparent 3px);pointer-events:none;z-index:5;mix-blend-mode:screen}
  body::after{content:"";position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 60%,rgba(0,0,0,.45) 100%);pointer-events:none;z-index:4}

  /* Header */
  .head{display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px dashed var(--edge);background:var(--bg-2);position:relative;z-index:6}
  .sigil{color:var(--agent);font-size:14px;text-shadow:0 0 6px var(--agent)}
  .who{font-weight:700;font-size:12px;letter-spacing:.18em;color:var(--amber);text-shadow:0 0 6px var(--amber-glow)}
  .meta{font-size:10.5px;color:var(--phosphor-dim);letter-spacing:.1em;text-transform:uppercase}
  .meta .num{color:var(--phosphor);font-weight:500}
  .meta .add{color:var(--cyan)}
  .meta .rem{color:var(--pink)}
  .head .spacer{flex:1}
  .btn{font-family:inherit;font-size:10px;letter-spacing:.16em;text-transform:uppercase;padding:6px 12px;background:transparent;color:var(--phosphor);border:1px solid var(--phosphor-faint);cursor:pointer;transition:all .14s ease}
  .btn:hover{background:rgba(184,228,201,.06);border-color:var(--phosphor)}
  .btn-ship{border-color:var(--amber);color:var(--amber);text-shadow:0 0 6px var(--amber-glow);box-shadow:0 0 0 1px var(--amber-glow),0 0 12px var(--amber-glow);font-weight:700}
  .btn-ship:hover{background:var(--amber);color:var(--bg);text-shadow:none}
  .btn-scrap{color:var(--phosphor-dim);border-color:transparent}
  .btn-scrap:hover{color:var(--coral);border-color:rgba(232,125,125,.4);background:transparent}
  .btn:disabled{opacity:.5;cursor:progress}

  /* Tabs row */
  .tabs{display:flex;align-items:center;gap:6px;padding:0 12px;border-bottom:1px solid var(--edge);background:var(--bg-3);overflow-x:auto;white-space:nowrap;position:relative;z-index:6}
  .tabs::-webkit-scrollbar{height:4px}
  .tabs::-webkit-scrollbar-thumb{background:rgba(184,228,201,.2)}
  .tab{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;background:transparent;border:1px solid transparent;color:var(--phosphor-dim);font-family:inherit;font-size:11px;cursor:pointer;transition:all .12s ease;border-radius:0;flex:0 0 auto}
  .tab:hover{color:var(--phosphor);background:rgba(184,228,201,.04)}
  .tab.active{color:var(--amber);background:var(--bg-2);border-color:var(--amber-dim);box-shadow:0 0 0 1px rgba(242,196,100,.15)}
  .tab .b{display:inline-block;width:14px;text-align:center;font-size:9px;font-weight:700;letter-spacing:.06em}
  .tab .b-A{color:var(--cyan)}.tab .b-M{color:var(--amber)}.tab .b-D{color:var(--pink)}.tab .b-R{color:var(--periwinkle)}
  .tab .path{font-weight:500}
  .tab .delta{font-size:9.5px;color:var(--phosphor-dim)}
  .tab .delta .add{color:var(--cyan);margin-right:4px}
  .tab .delta .rem{color:var(--pink)}
  .tab.diff{margin-left:auto;border-color:var(--periwinkle);color:var(--periwinkle);font-weight:700;letter-spacing:.16em;padding:6px 14px}
  .tab.diff.active{background:rgba(158,170,242,.08);color:var(--periwinkle);box-shadow:0 0 0 1px rgba(158,170,242,.25)}
  .empty{padding:14px;color:var(--phosphor-dim);font-size:11px;letter-spacing:.1em;text-transform:uppercase}

  /* Frame */
  .frame{position:relative;background:var(--bg);min-height:0;overflow:hidden}
  .frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:white}
  .frame .none{display:flex;align-items:center;justify-content:center;height:100%;color:var(--phosphor-dim);font-size:12px;letter-spacing:.08em}
  .url-chip{position:absolute;top:10px;left:10px;background:rgba(10,14,20,.85);color:var(--phosphor-dim);font-size:10px;letter-spacing:.08em;padding:4px 10px;border:1px solid var(--edge);z-index:3;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .non-html{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg-2);color:var(--phosphor-dim);font-size:12px;line-height:1.6;text-align:center;padding:0 32px}
  .non-html .small{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--amber);margin-bottom:8px}
  .non-html a{color:var(--phosphor);border-bottom:1px dashed var(--phosphor-faint)}

  /* Toast */
  .toast{position:fixed;top:60px;right:20px;z-index:30;background:rgba(10,14,20,.94);color:var(--amber);border:1px solid var(--amber);font-size:10.5px;letter-spacing:.16em;padding:9px 14px;text-transform:uppercase;text-shadow:0 0 6px var(--amber-glow);box-shadow:0 0 0 1px var(--amber-glow),0 0 22px var(--amber-glow);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease;transform:translateY(-4px)}
  .toast[data-show="1"]{opacity:1;transform:translateY(0)}
  .toast[data-tone="err"]{color:var(--coral);border-color:var(--coral);text-shadow:0 0 6px rgba(232,125,125,.6);box-shadow:0 0 0 1px rgba(232,125,125,.2),0 0 22px rgba(232,125,125,.35)}
</style>
</head>
<body>
  <div class="head">
    <span class="sigil">${sigil}</span>
    <span class="who">${agentName} · DRAFTED</span>
    <span class="meta"><span class="num">${stat.fileCount}</span> file${stat.fileCount === 1 ? '' : 's'} · <span class="add">+${stat.added}</span> <span class="rem">−${stat.removed}</span></span>
    <span class="spacer"></span>
    <button class="btn btn-scrap" data-action="scrap">scrap</button>
    <button class="btn btn-ship" data-action="ship">SHIP IT →</button>
  </div>
  <div class="tabs" id="tabs">
    ${tabs}
    ${files.length ? `<button class="tab diff" data-url="${esc(diffUrl)}" data-renderable="1" data-kind="diff">▢ DIFF</button>` : ''}
  </div>
  <div class="frame" id="frame">
    ${defaultUrl
      ? `<div class="url-chip" id="urlChip">${esc(defaultUrl)}</div>
         <iframe id="iframe" src="${esc(defaultUrl)}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>`
      : `<div class="none">nothing to preview yet</div>`}
  </div>
  <div class="toast" id="toast"></div>

  <script>
  (function(){
    var AGENT_REF = ${JSON.stringify(ref)};
    var tabsEl = document.getElementById('tabs');
    var frameEl = document.getElementById('frame');
    var toastEl = document.getElementById('toast');

    function toast(msg, tone) {
      toastEl.textContent = msg;
      toastEl.dataset.tone = tone || 'ok';
      toastEl.dataset.show = '1';
      clearTimeout(toast._t);
      toast._t = setTimeout(function(){ toastEl.dataset.show = '0'; }, 2600);
    }

    function setActive(btn) {
      var prev = tabsEl.querySelector('.tab.active');
      if (prev) prev.classList.remove('active');
      btn.classList.add('active');
    }

    function showInFrame(url, renderable) {
      if (renderable === false || renderable === '0') {
        frameEl.innerHTML =
          '<div class="non-html">' +
          '<div class="small">RAW FILE</div>' +
          '<div>This file isn&rsquo;t HTML &mdash; you can&rsquo;t preview it visually, ' +
          'but the DIFF tab shows what changed.</div>' +
          '<div style="margin-top:12px"><a href="' + url + '" target="_blank" rel="noopener">Open raw &rarr;</a></div>' +
          '</div>';
        return;
      }
      frameEl.innerHTML =
        '<div class="url-chip">' + url + '</div>' +
        '<iframe src="' + url + '" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>';
    }

    tabsEl.addEventListener('click', function(e){
      var btn = e.target.closest('.tab');
      if (!btn || btn.classList.contains('active')) return;
      setActive(btn);
      showInFrame(btn.dataset.url, btn.dataset.renderable);
    });

    function lockButtons(disabled) {
      document.querySelectorAll('.btn').forEach(function(b){ b.disabled = !!disabled; });
    }

    async function callTool(name, args) {
      var r = await fetch('/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, arguments: args || {} }),
      });
      if (!r.ok) throw new Error(name + ' ' + r.status);
      var j = await r.json().catch(function(){ return {}; });
      if (j && j.error) throw new Error(j.error);
      return j;
    }

    document.querySelector('[data-action="ship"]').addEventListener('click', async function(){
      lockButtons(true);
      toast('shipping…');
      try {
        var j = await callTool('accept_agent_work', { agent: AGENT_REF, mode: 'apply' });
        var stat = j && j.stat;
        var summary = stat ? (stat.fileCount + ' file' + (stat.fileCount === 1 ? '' : 's') + ' · +' + stat.added + ' −' + stat.removed) : 'shipped';
        toast('shipped — ' + summary);
        // Dismiss the preview pane on the hologram so the user lands
        // back on the avatar. Same-origin → just call dismiss_pane via
        // /tool. Best-effort — if it fails the user can press ESC.
        setTimeout(function(){ callTool('dismiss_pane', {}).catch(function(){}); }, 600);
      } catch (err) {
        toast(err.message || 'ship failed', 'err');
        lockButtons(false);
      }
    });

    document.querySelector('[data-action="scrap"]').addEventListener('click', async function(){
      if (!confirm('Throw away all of ${agentName}\\'s changes? This can\\'t be undone.')) return;
      lockButtons(true);
      toast('scrapping…');
      try {
        await callTool('discard_agent_work', { agent: AGENT_REF });
        toast('scrapped');
        setTimeout(function(){ callTool('dismiss_pane', {}).catch(function(){}); }, 600);
      } catch (err) {
        toast(err.message || 'scrap failed', 'err');
        lockButtons(false);
      }
    });
  })();
  </script>
</body>
</html>`;
}

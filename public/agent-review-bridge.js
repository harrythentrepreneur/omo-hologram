// public/agent-review-bridge.js — receives postMessages from the
// agent_review_card (mounted via auto-project on task_complete) and
// translates them into /tool calls.
//
// Message shape (from the card template):
//   { omo_agent_action: true,
//     action: 'ship' | 'scrap' | 'preview' | 'diff',
//     agent_id, agent_name, preview_url }
//
// Actions:
//   ship    → accept_agent_work (mode='apply')   then dismiss card
//   scrap   → discard_agent_work                  then dismiss card
//   preview → show_preview({ url: preview_url })  (keeps the card)
//   diff    → show_pane({ page: 'preview-diff', agent: agent_id })
//             (the diff visualiser page is already routed in server.js)
//
// Idempotent install: re-running attaches no extra listeners. Safe to
// inject on any HTML page; on pages without a hologram the actions still
// fire (the /tool round-trip handles UI dismounting through projection
// channels). On pages where /tool isn't reachable (different origin) the
// fetch quietly fails and the user sees an error toast.

(function () {
  if (window.__omoAgentReviewBridge) return;
  window.__omoAgentReviewBridge = true;

  function toast(msg, tone) {
    // Lightweight toast: floats top-right, auto-dismisses after 2.6s.
    // Doesn't depend on the card (which lives in an iframe).
    let el = document.getElementById('omo-agent-review-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'omo-agent-review-toast';
      el.style.cssText = [
        'position:fixed', 'top:24px', 'right:24px', 'z-index:99999',
        'padding:10px 16px',
        'background:rgba(10,14,20,0.94)', 'color:#F2C464',
        'border:1px solid #F2C464',
        'font:11px/1.4 "JetBrains Mono",ui-monospace,monospace',
        'letter-spacing:0.16em', 'text-transform:uppercase',
        'text-shadow:0 0 6px rgba(242,196,100,0.6)',
        'box-shadow:0 0 0 1px rgba(242,196,100,0.2), 0 0 22px rgba(242,196,100,0.35)',
        'opacity:0', 'pointer-events:none',
        'transition:opacity 200ms ease, transform 200ms ease',
        'transform:translateY(-6px)',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    if (tone === 'err') {
      el.style.borderColor = '#E87D7D';
      el.style.color = '#E87D7D';
      el.style.textShadow = '0 0 6px rgba(232,125,125,0.6)';
      el.style.boxShadow = '0 0 0 1px rgba(232,125,125,0.2), 0 0 22px rgba(232,125,125,0.35)';
    } else {
      el.style.borderColor = '#F2C464';
      el.style.color = '#F2C464';
      el.style.textShadow = '0 0 6px rgba(242,196,100,0.6)';
      el.style.boxShadow = '0 0 0 1px rgba(242,196,100,0.2), 0 0 22px rgba(242,196,100,0.35)';
    }
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
    }, 2600);
  }

  async function callTool(name, args) {
    const r = await fetch('/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args || {} }),
    });
    if (!r.ok) throw new Error(`tool ${name} ${r.status}`);
    const j = await r.json().catch(() => ({}));
    if (j?.error) throw new Error(j.error);
    return j;
  }

  function dismissCurrentCard() {
    // Two paths to a clean dismount, in order of robustness:
    // 1. __holoStage.dismount() — the chart-layer's API.
    // 2. dismiss_viz tool — covers the "no holoStage handle" case.
    try {
      if (window.__holoStage && typeof window.__holoStage.dismount === 'function') {
        window.__holoStage.dismount();
        return;
      }
    } catch {}
    try { callTool('dismiss_viz', {}); } catch {}
  }

  async function handleShip(agent_id, agent_name) {
    toast(`shipping ${agent_name || 'work'}…`);
    try {
      const j = await callTool('accept_agent_work', { agent: agent_id, mode: 'apply' });
      const stat = j?.stat;
      const summary = stat
        ? `${stat.fileCount} file${stat.fileCount === 1 ? '' : 's'} · +${stat.added} −${stat.removed}`
        : 'changes applied';
      toast(`shipped — ${summary}`);
      dismissCurrentCard();
    } catch (err) {
      toast(err.message || 'ship failed', 'err');
    }
  }

  async function handleScrap(agent_id, agent_name) {
    toast(`scrapping ${agent_name || 'work'}…`);
    try {
      await callTool('discard_agent_work', { agent: agent_id });
      toast('scrapped');
      dismissCurrentCard();
    } catch (err) {
      toast(err.message || 'scrap failed', 'err');
    }
  }

  async function handlePreview(preview_url, agent_id) {
    if (!preview_url) {
      toast('no preview available', 'err');
      return;
    }
    try {
      // Preview is an http path on omo itself; use show_preview with the
      // full origin so it round-trips through the sandboxed /preview iframe.
      const full = preview_url.startsWith('http') ? preview_url
        : `${location.origin}${preview_url}`;
      await callTool('show_preview', { url: full, title: `PREVIEW · ${agent_id || ''}`.trim() });
    } catch (err) {
      toast(err.message || 'preview failed', 'err');
    }
  }

  async function handleDiff(agent_id) {
    try {
      await callTool('show_pane', { page: 'preview-diff', agent: agent_id });
    } catch (err) {
      // show_pane may not accept page='preview-diff' as a known page —
      // fall back to show_preview with the diff URL directly.
      try {
        await callTool('show_preview', {
          url: `${location.origin}/preview-diff?agent=${encodeURIComponent(agent_id)}`,
          title: 'DIFF',
        });
      } catch (err2) {
        toast(err2.message || err.message || 'diff failed', 'err');
      }
    }
  }

  window.addEventListener('message', (e) => {
    const d = e?.data;
    if (!d || d.omo_agent_action !== true) return;
    const { action, agent_id, agent_name, preview_url } = d;
    if (!agent_id) return;
    if (action === 'ship')         return handleShip(agent_id, agent_name);
    if (action === 'scrap')        return handleScrap(agent_id, agent_name);
    if (action === 'preview')      return handlePreview(preview_url, agent_id);
    if (action === 'diff')         return handleDiff(agent_id);
  });
})();

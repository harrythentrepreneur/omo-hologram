// Agent dock — always-visible compact view of the 4-slot agent grid,
// pinned to a corner of /holo so the user never loses sight of what the
// agents are doing while talking to Momo.
//
// Self-contained: own WebSocket to /agents/ws, no shared state with
// auto-project. Click any cell to open the full /agents-grid focused on
// that slot in the pane layer (window.__holoPane).
//
// What gets rendered per cell:
//   · status dot (idle / dispatching / running / done / error)
//   · slot display name + role (CINDER · CODE)
//   · the most recent line of agent output (truncated)
//   · live edit counter (how many distinct files the watcher has seen)
//   · diff stat (+adds / -dels) when running a code task
//
// The dock auto-collapses to a tiny 4-dot strip when no slot is active,
// and expands when at least one is dispatching/running. The user can
// pin/un-pin via the gear button — pinned state persists in localStorage.

const CELLS = [
  { slot: 0, key: "atlas",  display: "ATLAS",  role: "RESEARCH", tone: "var(--amber, #F2C464)" },
  { slot: 1, key: "cinder", display: "CINDER", role: "CODE",     tone: "var(--periwinkle, #9EAAF2)" },
  { slot: 2, key: "prism",  display: "PRISM",  role: "DATA",     tone: "var(--periwinkle, #9EAAF2)" },
  { slot: 3, key: "quill",  display: "QUILL",  role: "WRITING",  tone: "var(--coral, #E87D7D)" },
];

const STORAGE_PIN = "omo.dock.pinned";

let installed = false;
let dockEl = null;
let socket = null;
let retryDelay = 800;
const slotState = new Map(); // slot.slot → state object

export function installAgentDock() {
  if (installed) return;
  installed = true;
  buildDock();
  connectWs();
}

// ─── DOM ───────────────────────────────────────────────────────────

function buildDock() {
  if (document.getElementById("omo-agent-dock")) return;

  const css = document.createElement("style");
  css.textContent = `
    #omo-agent-dock {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 320;
      font-family: "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace;
      color: #B8E4C9;
      background: rgba(14, 19, 27, 0.86);
      border: 1px solid rgba(184, 228, 201, 0.18);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: 200px;
      max-width: 320px;
      font-size: 11px;
      line-height: 1.35;
      letter-spacing: 0.02em;
      box-shadow: 0 6px 22px rgba(0,0,0,0.55);
      transition: opacity .25s ease, transform .25s ease;
      opacity: 0.85;
    }
    #omo-agent-dock:hover { opacity: 1; }
    #omo-agent-dock[data-collapsed="true"] {
      min-width: auto;
      max-width: none;
      padding: 4px 6px;
    }
    #omo-agent-dock[data-collapsed="true"] .od-cells { gap: 5px; }
    #omo-agent-dock[data-collapsed="true"] .od-cell { padding: 2px 4px; min-width: 0; }
    #omo-agent-dock[data-collapsed="true"] .od-cell .od-line,
    #omo-agent-dock[data-collapsed="true"] .od-cell .od-stat,
    #omo-agent-dock[data-collapsed="true"] .od-cell .od-name { display: none; }
    #omo-agent-dock[data-collapsed="true"] .od-cell .od-dot { margin: 0; }
    #omo-agent-dock .od-head {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 9.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(184, 228, 201, 0.55);
    }
    #omo-agent-dock .od-head .od-title { flex: 1; }
    #omo-agent-dock .od-head .od-btn {
      cursor: pointer;
      color: rgba(184, 228, 201, 0.6);
      padding: 0 4px;
      user-select: none;
    }
    #omo-agent-dock .od-head .od-btn:hover { color: #F2C464; }
    #omo-agent-dock .od-cells {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    #omo-agent-dock[data-collapsed="true"] .od-cells {
      flex-direction: row;
      gap: 6px;
    }
    #omo-agent-dock .od-cell {
      display: grid;
      grid-template-columns: 14px 1fr auto;
      grid-template-rows: auto auto;
      gap: 4px 8px;
      padding: 4px 6px;
      border-left: 2px solid transparent;
      cursor: pointer;
      align-items: center;
      transition: background .15s ease;
    }
    #omo-agent-dock .od-cell:hover { background: rgba(184, 228, 201, 0.06); }
    #omo-agent-dock .od-cell .od-dot {
      grid-row: 1 / span 2;
      width: 8px; height: 8px;
      border-radius: 50%;
      background: rgba(184, 228, 201, 0.25);
    }
    #omo-agent-dock .od-cell[data-status="dispatching"] .od-dot,
    #omo-agent-dock .od-cell[data-status="running"]      .od-dot {
      background: #F2C464;
      box-shadow: 0 0 8px rgba(242,196,100,0.7);
      animation: od-pulse 1.4s infinite ease-in-out;
    }
    #omo-agent-dock .od-cell[data-status="done"]   .od-dot { background: #B8E4C9; }
    #omo-agent-dock .od-cell[data-status="error"]  .od-dot { background: #E87D7D; }
    #omo-agent-dock .od-cell[data-active="true"] {
      border-left-color: #F2C464;
      background: rgba(242,196,100,0.06);
    }
    #omo-agent-dock .od-name {
      font-size: 10.5px;
      letter-spacing: 0.12em;
      color: #B8E4C9;
      font-weight: 600;
    }
    #omo-agent-dock .od-name .od-role {
      color: rgba(184, 228, 201, 0.5);
      font-weight: 400;
      margin-left: 4px;
      letter-spacing: 0.08em;
    }
    #omo-agent-dock .od-stat {
      font-size: 9.5px;
      letter-spacing: 0.06em;
      color: rgba(184, 228, 201, 0.7);
      grid-column: 3;
      grid-row: 1 / span 2;
      text-align: right;
      white-space: nowrap;
    }
    #omo-agent-dock .od-stat .add { color: #B8E4C9; }
    #omo-agent-dock .od-stat .del { color: #E87D7D; }
    #omo-agent-dock .od-stat .files { color: rgba(184, 228, 201, 0.55); }
    #omo-agent-dock .od-line {
      grid-column: 2;
      font-size: 10px;
      color: rgba(184, 228, 201, 0.55);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      font-style: italic;
    }
    #omo-agent-dock .od-cell[data-status="error"] .od-line { color: #E87D7D; }
    @keyframes od-pulse {
      0%,100% { opacity: 1; transform: scale(1); }
      50%     { opacity: 0.55; transform: scale(0.85); }
    }
  `;
  document.head.appendChild(css);

  const root = document.createElement("aside");
  root.id = "omo-agent-dock";
  root.dataset.collapsed = readPinned() ? "false" : "true";
  root.innerHTML = `
    <div class="od-head">
      <span class="od-title">AGENTS</span>
      <span class="od-btn" data-act="open" title="Open full agent grid">⤢</span>
      <span class="od-btn" data-act="pin" title="Toggle expanded">${readPinned() ? "▾" : "▸"}</span>
    </div>
    <div class="od-cells">
      ${CELLS.map((c) => `
        <div class="od-cell" data-slot="${c.slot}" data-status="idle" title="open ${c.display}">
          <span class="od-dot"></span>
          <span class="od-name">${c.display}<span class="od-role">· ${c.role}</span></span>
          <span class="od-stat">—</span>
          <span class="od-line">awaiting dispatch</span>
        </div>
      `).join("")}
    </div>
  `;
  document.body.appendChild(root);
  dockEl = root;

  root.addEventListener("click", (e) => {
    const btn = e.target.closest(".od-btn");
    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === "pin") togglePinned();
      else if (act === "open") openFullGrid();
      return;
    }
    const cell = e.target.closest(".od-cell");
    if (cell) openFullGrid(Number(cell.dataset.slot));
  });

  // Auto-expand when any slot becomes active. The user's pinned setting
  // wins after they manually toggle.
  // (Handled in render() via state checks.)
}

function readPinned() {
  try { return localStorage.getItem(STORAGE_PIN) === "1"; }
  catch { return false; }
}
function togglePinned() {
  const next = !readPinned();
  try { localStorage.setItem(STORAGE_PIN, next ? "1" : "0"); } catch {}
  if (dockEl) {
    dockEl.dataset.collapsed = next ? "false" : "true";
    const btn = dockEl.querySelector('.od-btn[data-act="pin"]');
    if (btn) btn.textContent = next ? "▾" : "▸";
  }
}

// Auto-expand when there's active work. Keeps the dock low-noise when
// agents are idle (just 4 dots) and gets out of the way of the avatar.
function autoCollapseIfQuiet() {
  if (!dockEl) return;
  if (readPinned()) return; // user override
  const active = [...slotState.values()].some((s) => s.status === "running" || s.status === "dispatching");
  dockEl.dataset.collapsed = active ? "false" : "true";
}

function openFullGrid(slotIdx) {
  // /agents-grid was retired; clicking a dock cell now opens /squad
  // (pixel office). The focus param is no longer meaningful — /squad
  // shows all four agents at once — so we drop it.
  const url = "/squad";
  if (window.__holoPane && typeof window.__holoPane.mount === "function") {
    try {
      window.__holoPane.mount({
        url,
        page: "squad",
        title: "SQUAD // PIXEL OFFICE",
      });
      return;
    } catch (err) { console.warn("[agent-dock] pane mount failed", err); }
  }
  // Fallback — open in a new tab if the pane layer isn't installed.
  window.open(url, "_blank", "noopener");
}

// ─── WebSocket ─────────────────────────────────────────────────────

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/agents/ws`;
  try { socket = new WebSocket(url); }
  catch (err) { console.warn("[agent-dock] ws construct failed", err); return scheduleReconnect(); }

  socket.addEventListener("open", () => {
    console.log("[agent-dock] ws open");
    retryDelay = 800;
  });
  socket.addEventListener("message", (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    handleMsg(m);
  });
  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    try { socket?.close(); } catch {}
  });
}

function scheduleReconnect() {
  setTimeout(() => {
    retryDelay = Math.min(retryDelay * 1.7, 8000);
    connectWs();
  }, retryDelay);
}

function handleMsg(m) {
  if (m.type === "snapshot") {
    for (const s of m.slots || []) {
      slotState.set(s.slot, normaliseSlot(s));
      // Replay buffer to seed last-line.
      const last = (s.buffer || []).at(-1);
      if (last) {
        const cur = slotState.get(s.slot);
        cur.lastLine = lineForKind(last.kind, last.line);
      }
    }
    renderAll();
    return;
  }
  if (m.type === "state") {
    slotState.set(m.slot, { ...slotState.get(m.slot), ...normaliseSlot(m.state) });
    renderSlot(m.slot);
    return;
  }
  if (m.type === "line") {
    const cur = slotState.get(m.slot) || { slot: m.slot, status: "idle" };
    cur.lastLine = lineForKind(m.entry?.kind, m.entry?.line || "");
    slotState.set(m.slot, cur);
    renderSlot(m.slot);
    return;
  }
  if (m.type === "dispatch") {
    const cur = slotState.get(m.slot) || { slot: m.slot };
    cur.status = "dispatching";
    cur.lastLine = m.label || (m.task || "").slice(0, 60);
    slotState.set(m.slot, cur);
    renderSlot(m.slot);
    return;
  }
}

function normaliseSlot(s) {
  return {
    slot: s.slot,
    status: s.status || "idle",
    display: s.display || "",
    role: s.role || "",
    diffStat: s.diffStat || null,
    fileChangesCount: (s.fileChanges || []).length,
    todosCount: (s.todos || []).length,
    cwd: s.cwd || null,
  };
}

function lineForKind(kind, line) {
  if (!line) return "";
  if (kind === "tool_use") return `▸ ${line}`;
  if (kind === "tool_err" || kind === "error") return `✗ ${line}`;
  if (kind === "file_change") return `✎ ${line}`;
  if (kind === "conclusion") return `▣ ${line}`;
  if (kind === "plan") return `→ ${line}`;
  if (kind === "finding") return `✓ ${line}`;
  if (kind === "done") return line;
  return line;
}

// ─── Render ────────────────────────────────────────────────────────

function renderAll() {
  for (const cell of CELLS) renderSlot(cell.slot);
  autoCollapseIfQuiet();
}

function renderSlot(slotIdx) {
  if (!dockEl) return;
  const s = slotState.get(slotIdx);
  const cell = dockEl.querySelector(`.od-cell[data-slot="${slotIdx}"]`);
  if (!cell) return;
  if (!s) { cell.dataset.status = "idle"; return; }
  cell.dataset.status = s.status || "idle";
  const name = cell.querySelector(".od-name");
  if (name && s.display) name.firstChild.textContent = s.display;
  const role = cell.querySelector(".od-role");
  if (role && s.role) role.textContent = "· " + s.role;
  const lineEl = cell.querySelector(".od-line");
  if (lineEl) lineEl.textContent = s.lastLine || (s.status === "idle" ? "awaiting dispatch" : "—");
  const stat = cell.querySelector(".od-stat");
  if (stat) {
    if (s.diffStat && (s.diffStat.adds || s.diffStat.dels)) {
      stat.innerHTML = `<span class="add">+${s.diffStat.adds || 0}</span>/<span class="del">-${s.diffStat.dels || 0}</span> <span class="files">${s.diffStat.files || 0}f</span>`;
    } else if (s.fileChangesCount) {
      stat.innerHTML = `<span class="files">${s.fileChangesCount} edit${s.fileChangesCount === 1 ? "" : "s"}</span>`;
    } else if (s.todosCount) {
      stat.innerHTML = `<span class="files">${s.todosCount} todo${s.todosCount === 1 ? "" : "s"}</span>`;
    } else {
      stat.textContent = "—";
    }
  }
  autoCollapseIfQuiet();
}

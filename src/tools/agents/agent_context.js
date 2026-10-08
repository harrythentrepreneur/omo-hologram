// Shared helpers for voice tools that should default to the agent the user
// is currently looking at. The /squad grid overlay (public/squad-grid.js,
// formerly /feather) pushes this snapshot via /omo/ingest/view. We accept
// both legacy `page: 'feather'` snapshots and the new `'squad_grid'` tag
// so old saved snapshots + new live snapshots both light up the helpers.

import * as momoView from "../../momo/view.js";

export function currentView() {
  try { return momoView.getView() || null; }
  catch { return null; }
}

// Returns the multi-terminal view's snapshot (grid overlay or legacy
// /feather page) if that's what the user is looking at; null otherwise.
// Name kept for back-compat with feather_*/grid_* tools that consume it.
export function featherView() {
  const v = currentView();
  if (!v) return null;
  return (v.page === "feather" || v.page === "squad_grid") ? v : null;
}
// Alias under the new name.
export const gridView = featherView;

export function focusedAgent() {
  const v = currentView();
  const fa = v && v.focused_agent;
  if (!fa || typeof fa !== "object") return null;
  const agent_id = fa.agent_id || fa.id || null;
  const name = fa.name || null;
  if (!agent_id && !name) return null;
  return {
    ...fa,
    agent_id,
    id: agent_id || fa.id || null,
    name,
  };
}

export function focusedAgentRef() {
  const fa = focusedAgent();
  return fa ? String(fa.agent_id || fa.id || fa.name || "").trim() : "";
}

export function refOrFocused(ref) {
  const explicit = String(ref || "").trim();
  return explicit || focusedAgentRef();
}

export function awaitingAgent() {
  const v = featherView();
  const aa = v && v.awaiting_agent;
  if (!aa || typeof aa !== "object") return null;
  const agent_id = aa.agent_id || aa.id || null;
  const name = aa.name || null;
  if (!agent_id && !name) return null;
  return {
    ...aa,
    agent_id,
    id: agent_id || aa.id || null,
    name,
  };
}

export function awaitingAgentRef() {
  const aa = awaitingAgent();
  return aa ? String(aa.agent_id || aa.id || aa.name || "").trim() : "";
}

// show_agent_terminals — open the squad page in split-view multi-pane mode
// with N agents' live Claude Code terminals visible side-by-side. The
// natural voice trigger is phrases like:
//   "show me Cinder and Reed side by side"
//   "open all the terminals"
//   "let me watch Cinder, Reed, and Atlas at the same time"
//   "split view"
//
// This replaces the retired /claude-deck war room — its functionality has
// been folded into /squad. The tool returns a pane/url for show_pane-style
// projection onto the hologram, but the same URL works in any browser tab.
//
// Layout is auto-picked from the count (1 → 1×, 2 → 2×, 3 → 3×, 4+ → 4×)
// unless the user explicitly requests a different one.

import * as hermes from "../../hermes/index.js";

function resolveOne(ref) {
  const matches = hermes.resolveActiveAgents(ref);
  if (matches.length === 1) return { ok: true, agent: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `ambiguous: "${ref}" matches ${matches.length} agents`,
      candidates: matches.map((m) => ({ name: m.name, agent_id: m.agent_id })),
    };
  }
  return { ok: false, error: `no active agent matches "${ref}"` };
}

function autoLayoutFor(n) {
  if (n <= 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

export const definition = {
  type: "function",
  name: "show_agent_terminals",
  description:
    "Open the /squad page with the MULTI-PANE live terminal split view, " +
    "binding TWO or MORE agents to side-by-side xterm panes. Use when the " +
    'user wants several terminals at once: "show me Cinder and Reed side ' +
    'by side", "open all the terminals", "split view", "war room", ' +
    '"把所有终端打开". For a SINGLE agent ("show me her terminal", "open ' +
    'Cinder\'s PTY"), use show_agent_terminal (singular) instead — it flips ' +
    "to @live in the existing squad monitor without a separate split view. " +
    "Each pane streams the actual TUI; voice types into a specific pane via " +
    "agent_send_text. If no agents are given, auto-binds every currently-" +
    "active agent. Pair with dismiss_pane when the user moves on.",
  parameters: {
    type: "object",
    properties: {
      agents: {
        type: "array",
        items: { type: "string" },
        description:
          "Agent names or ids to bind (in pane order, left-to-right, " +
          "top-to-bottom). Omit to auto-bind all active claude agents.",
      },
      layout: {
        type: "string",
        enum: ["auto", "1", "2", "3", "4"],
        description:
          'Grid layout: "1" (single), "2" (side-by-side), "3" (three across), ' +
          '"4" (2×2). Default "auto" picks the smallest grid that fits all ' +
          "requested agents.",
      },
      focus: {
        type: "string",
        description:
          "Name or id of the agent that should be the initially-focused pane " +
          "(receives keystrokes). Defaults to the first pane.",
      },
    },
    additionalProperties: false,
  },
};

export function run({ agents, layout, focus } = {}) {
  // Resolve each requested agent. If none given, auto-pick all active.
  let resolved = [];
  const unresolved = [];

  if (Array.isArray(agents) && agents.length > 0) {
    const seen = new Set();
    for (const ref of agents) {
      const r = resolveOne(String(ref || "").trim());
      if (r.ok && !seen.has(r.agent.agent_id)) {
        seen.add(r.agent.agent_id);
        resolved.push(r.agent);
      } else if (!r.ok) {
        unresolved.push({ ref, error: r.error, candidates: r.candidates || null });
      }
    }
  } else {
    try {
      const list = hermes.listAgents ? hermes.listAgents() : [];
      for (const a of list) {
        if (!a || !a.agent_id) continue;
        if (a.runtime && String(a.runtime).toLowerCase() !== "claude") continue;
        resolved.push({ agent_id: a.agent_id, name: a.name || a.agent_id });
      }
      resolved = resolved.slice(0, 4);
    } catch {}
  }

  if (resolved.length === 0) {
    return {
      ok: false,
      error: "no agents to show",
      unresolved,
      note:
        "Tell the user no claude agents are active right now. Offer to spawn one " +
        "with spawn_agent_task, or to pick from the squad sidebar.",
    };
  }

  // Pick layout.
  const n = resolved.length;
  const requested = String(layout || "auto").toLowerCase();
  let split;
  if (requested === "auto") split = autoLayoutFor(n);
  else split = Math.max(1, Math.min(4, parseInt(requested, 10) || autoLayoutFor(n)));

  // Build the URL. The squad page reads ?term=<refs>&split=<n>&focus=<ref>
  // on load and opens the monitor in split mode pre-bound to those agents.
  const refList = resolved.map((a) => a.name || a.agent_id).join(",");
  let focusRef = "";
  if (focus) {
    const fr = resolveOne(String(focus).trim());
    if (fr.ok) focusRef = fr.agent.name || fr.agent.agent_id;
  }
  const params = new URLSearchParams();
  params.set("term", refList);
  params.set("split", String(split));
  if (focusRef) params.set("focus", focusRef);
  const url = `/squad?${params.toString()}`;

  const names = resolved.map((a) => a.name || a.agent_id);
  const finalTitle = names.length === 1
    ? `CLAUDE // ${names[0].toUpperCase()}`
    : `CLAUDE // ${names.map((n) => n.toUpperCase()).join(" + ")}`;

  return {
    ok: true,
    kind: "pane",
    projectable_id: `pane_squad-term_${names.map((s) => s.replace(/[^A-Za-z0-9]/g, "")).join("_")}_${Date.now().toString(36)}`,
    page: "claude-deck",
    url,
    title: finalTitle,
    agents: resolved.map((a) => ({ name: a.name || a.agent_id, agent_id: a.agent_id })),
    layout: split,
    focus: focusRef || null,
    unresolved: unresolved.length ? unresolved : undefined,
    note: names.length === 1
      ? `Tell the user ${names[0]}'s terminal is up. They can type at the keyboard or voice via claude_send_text.`
      : `Tell the user the split view is up with ${names.join(", ")}. ` +
        "Voice can target any pane with claude_send_text(agent=name).",
  };
}

// feather_focus — drive the layout of the /feather coding-loop UI by voice.
//
// One tool, four modes:
//   mosaic — every agent shown as a peek tile in the stage (no xterms)
//   zoom1  — one agent zoomed full-stage as a live xterm; others slide
//            into the left sidebar as peek tiles
//   zoom2  — two side-by-side xterms in the stage
//   zoom4  — 2×2 xterms in the stage
//
// `agents` is an ordered list of agent name/id refs (first = primary slot).
// The tool resolves names to ids server-side so the page doesn't have to.
//
// The page (public/feather.html) subscribes to /omo/ws and listens for
// events with source='feather' + kind='focus'. The data payload mirrors
// the tool's input shape (with refs resolved).
//
// Examples voice would call:
//   "show me everyone"      → { mode: 'mosaic' }
//   "zoom into atlas"       → { mode: 'zoom1', agents: ['atlas'] }
//   "split atlas and cinder"→ { mode: 'zoom2', agents: ['atlas','cinder'] }
//   "show four on stage"    → { mode: 'zoom4', agents: ['atlas','cinder','prism','quill'] }

import * as dataCore from '../../data_core.js';
import * as hermes from '../../hermes/index.js';
import * as momoView from '../../momo/view.js';
import { focusedAgentRef } from './agent_context.js';

const VALID_MODES = new Set(['mosaic', 'zoom1', 'zoom2', 'zoom4']);
const MODE_CAP = { mosaic: 0, zoom1: 1, zoom2: 2, zoom4: 4 };

export const definition = {
  name: 'feather_focus',
  description: [
    "Drive the multi-terminal grid layout (legacy /feather page AND the",
    "/squad grid overlay — same module under the hood). **This is the tool",
    "for 'zoom into X' / 'show me X' / 'show X bigger' / 'open X's terminal' /",
    "'让我看 Claude-6' / '把 X 放大' / 'show me everyone' / 'back to the grid'.**",
    "On /squad: if the grid overlay is closed, a zoom-mode call AUTO-OPENS",
    "it, so 'zoom into Atlas' works even from the hologram view. Prefer this",
    "tool over show_agent_terminal whenever the user is already looking at",
    "agent tiles (or wants to switch to that view). Modes:",
    "  • mosaic — overview, every agent shown as a small peek tile",
    "  • zoom1  — one agent zoomed full-stage; the rest slide into a sidebar",
    "  • zoom2  — two agents side-by-side; the rest in the sidebar",
    "  • zoom4  — four agents in a 2×2 grid; the rest in the sidebar",
    "Voice → mode mapping:",
    "  • 'zoom into atlas' / 'show me atlas' / 'open atlas' / 'make her",
    "    terminal bigger' → zoom1, [atlas]",
    "  • 'split atlas and cinder' / 'show both' → zoom2, [atlas, cinder]",
    "  • 'show 4 / war room / 2 by 2' → zoom4, [a, b, c, d]",
    "  • 'show all' / 'back to grid' / 'mosaic' / 'overview' / 'zoom out' →",
    "    mosaic",
    "For 'exit / close it / back / out / 出去 / 退出 / 回去 / show me the",
    "squad / back to the room' (close the overlay entirely so the squad",
    "page behind reappears) use dismiss_pane — it's ONE-SHOT, not a",
    "layout change. mosaic stays in the grid; dismiss_pane leaves it.",
    "`agents` is an ordered list of agent names or ids; the first goes to",
    "the primary stage slot. Omitted in a zoom mode → defaults to the",
    "currently-focused agent.",
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['mosaic', 'zoom1', 'zoom2', 'zoom4'],
        description: 'Layout mode. mosaic = everyone, zoom1/zoom2/zoom4 = N agents on stage.',
      },
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered agent name or id refs. First slot is the primary stage tile. Optional for mosaic.',
      },
    },
    required: ['mode'],
  },
};

export async function run({ mode, agents }) {
  if (!VALID_MODES.has(mode)) {
    return { ok: false, error: `unknown mode '${mode}' — try one of mosaic / zoom1 / zoom2 / zoom4` };
  }
  const cap = MODE_CAP[mode];
  const refs = Array.isArray(agents) ? agents.map(String) : [];
  if (mode !== 'mosaic' && refs.length === 0) {
    const focused = focusedAgentRef();
    if (focused) refs.push(focused);
  }

  // Resolve every ref to a real agent_id via hermes. If a ref doesn't
  // match anyone seated, drop it but report so the model can apologise.
  const seated = safeListAgents();
  const resolved = [];
  const dropped = [];
  for (const ref of refs) {
    const match = resolveRef(ref, seated);
    if (match) resolved.push(match);
    else dropped.push(ref);
  }
  // Cap to the mode's slot count and de-dupe while preserving order.
  const seen = new Set();
  const primaries = [];
  for (const id of resolved) {
    if (seen.has(id)) continue;
    seen.add(id);
    primaries.push(id);
    if (cap > 0 && primaries.length >= cap) break;
  }

  // Map primary ids → names so the toast on the page can read naturally
  // and Momo can name them in her spoken reply.
  const names = primaries
    .map((id) => seated.find((a) => a.agent_id === id)?.name)
    .filter(Boolean);

  // Emit onto the shared event bus. /squad's grid overlay (or the legacy
  // /feather page) picks it up via /omo/ws.
  try {
    dataCore.emit({
      source: 'feather',
      kind: 'focus',
      data: { mode, agents: primaries, names },
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  const who = names.join(' + ');
  const note =
    mode === 'mosaic'
      ? "Say one short cute line in the user's language: '好嘞~ 回到大网格啦~' / 'back to the grid ✨'. Don't describe the terminals."
      : primaries.length === 0
        ? "No agents matched — apologise once and stay in mosaic. Don't list ids."
        : `Say one short cute line in the user's language naming ${who}, e.g. '好嘞~ 放大 ${who} 啦~' / 'zoomed into ${who} ✨'. Don't read the terminal contents.`;

  // If the user is NOT already on /squad or /feather, also return a pane
  // hint so the hologram navigates to /squad with the grid overlay open and
  // pre-zoomed on the requested agent. This lets "zoom into Atlas" work
  // from the hologram view in a single tool call. URL is whitelisted by
  // /squad's own deep-link handler (?grid=1&focus=<id|name>).
  let paneHint = null;
  const pageNow = momoView.getView()?.page;
  const alreadyHere = pageNow === 'squad' || pageNow === 'squad_grid' || pageNow === 'feather';
  if (!alreadyHere) {
    const params = new URLSearchParams({ grid: '1' });
    if (mode !== 'mosaic' && (primaries[0] || refs[0])) {
      params.set('focus', String(primaries[0] || refs[0]));
    }
    paneHint = {
      url: `/squad?${params.toString()}`,
      title: mode === 'mosaic'
        ? 'SQUAD // GRID'
        : `SQUAD // ${who || 'ZOOM'}`.toUpperCase(),
      page: 'squad',
    };
  }

  return {
    ok: true,
    mode,
    agents: primaries,
    names,
    dropped: dropped.length ? dropped : undefined,
    pane: paneHint || undefined,
    note,
  };
}

function safeListAgents() {
  try { return hermes.listAgents() || []; }
  catch { return []; }
}

// Match a user-supplied ref against the seated agent list. Matches by id
// first (exact), then by name (case-insensitive), then by name prefix.
// Returns the agent_id or null.
function resolveRef(ref, seated) {
  if (!ref) return null;
  const r = String(ref).trim();
  if (!r) return null;
  if (/^(?:this|that|her|him|it|focused|current|这个|那个|她|他|当前)$/.test(r.toLowerCase())) {
    const focused = focusedAgentRef();
    if (focused) {
      const match = resolveRef(focused, seated);
      if (match) return match;
    }
  }
  // Exact id?
  const byId = seated.find((a) => a.agent_id === r);
  if (byId) return byId.agent_id;
  // Case-insensitive exact name?
  const lower = r.toLowerCase();
  const byName = seated.find((a) => (a.name || '').toLowerCase() === lower);
  if (byName) return byName.agent_id;
  // Name prefix?
  const byPrefix = seated.find((a) => (a.name || '').toLowerCase().startsWith(lower));
  if (byPrefix) return byPrefix.agent_id;
  return null;
}

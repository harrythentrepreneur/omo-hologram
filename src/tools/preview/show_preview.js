// src/tools/show_preview.js — mount a live web preview onto the hologram.
//
// Wraps the user's running dev server (or any http(s) URL) inside the
// /preview surface, then projects that surface as a full-stage pane
// through the same pane-layer machinery as show_pane. The outer pane is
// internal (/preview?url=…) so the holo client's same-origin assumptions
// hold; the inner iframe inside /preview is the actual app.
//
// Voice intent: "show me the app", "open localhost 3000", "look at the
// staging build", "let me see what it looks like", "preview Atlas's work".

import { getAgentWorktreePath, listAgents } from "../../hermes/index.js";

// Default preview target. omo itself runs on :8080, which is also the
// most useful default for dogfooding ("show me the app" → preview omo).
// Override via OMO_DEV_URL when working on an external project.
const DEFAULT_PREVIEW_URL = process.env.OMO_DEV_URL || "http://localhost:8080";

// Resolve an agent ref (callsign / id) to the http URL that serves
// their worktree's public/ directory via /preview-agent/<ref>/. When
// worktrees are off (the current default — see CLAUDE.md), the agent
// is editing the user's checkout directly, so there's no isolated
// preview URL to point at — return null and let the caller fall
// through to DEFAULT_PREVIEW_URL. Same-origin URLs only.
function resolveAgentPreviewUrl(agentRef) {
  const ref = String(agentRef || "").trim();
  if (!ref) return null;
  try {
    const wt = getAgentWorktreePath(ref);
    if (!wt) return null;
  } catch { return null; }
  return `http://localhost:${process.env.PORT || 8080}/preview-agent/${encodeURIComponent(ref)}/`;
}

function resolveAgentName(agentRef) {
  const ref = String(agentRef || "").trim();
  if (!ref) return "";
  try {
    const list = listAgents() || [];
    const hit = list.find((a) => a.agent_id === ref || a.name?.toLowerCase() === ref.toLowerCase());
    if (hit?.name) return hit.name;
  } catch {}
  return ref;
}

// Light validation. We don't gate by host (a Vercel preview at a real
// domain is a legit target), but we do reject anything that isn't http
// or https — the iframe sandbox blocks most exotic schemes, but better
// to fail fast with a clean message than mount a useless pane.
function normaliseTargetUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  // Tolerate the common "localhost:3000" voice phrasing — no scheme.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function deriveTitle(url, explicit) {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 80);
  try {
    const u = new URL(url);
    const port = u.port ? `:${u.port}` : "";
    return `PREVIEW // ${u.hostname}${port}`;
  } catch {
    return "PREVIEW";
  }
}

export const definition = {
  type: "function",
  name: "show_preview",
  description:
    "Project a live web preview onto the hologram stage — typically the user's local dev server, but any http(s) URL works (Vercel preview, staging, production). The avatar shrinks to the corner; the page takes over the stage with a quiet chrome (URL chip, reload). Use when the user says \"show me the app\", \"open the preview\", \"let me see the site\", \"look at the live site\", \"show the preview\", \"what does it look like\", \"打开本地预览\", \"看一下网站\", \"show me port 3000\". Also accepts an `agent` ref to preview that agent's worktree-served site (\"preview Atlas's work\", \"show me what Sora built\"); when worktrees are off the call falls back to OMO_DEV_URL with a note in the result. The actual app runs in a sandboxed nested iframe so any errors in the user's code never leak into omo. Pair with dismiss_pane when the user moves on.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "The http(s) URL to load. \"localhost:3000\" works (scheme inferred). Omit to use the configured default (env OMO_DEV_URL, falls back to http://localhost:8080). Reject if the user wants something cross-origin into a non-http(s) target — quote the error plainly.",
      },
      agent: {
        type: "string",
        description:
          "Agent reference (callsign or agent_id) — when set, point the preview at /preview-agent/<ref>/ so the user sees that agent's worktree-served site. Use for \"preview Atlas's work\", \"show me what Sora built\", \"看看 Atlas 做的东西\". If the agent has no worktree (the current default), falls back to OMO_DEV_URL and the result carries a note explaining the fallback. Ignored if `url` is also passed.",
      },
      title: {
        type: "string",
        description:
          "Optional short title shown in the pane chrome. Auto-derived from the URL (\"PREVIEW // localhost:3000\") when omitted.",
      },
    },
    additionalProperties: false,
  },
};

export function run(args = {}) {
  let requested = args.url ? String(args.url) : null;
  let agentNote = null;
  let agentName = null;
  if (!requested && args.agent) {
    agentName = resolveAgentName(args.agent);
    const wtUrl = resolveAgentPreviewUrl(args.agent);
    if (wtUrl) {
      requested = wtUrl;
    } else {
      // Worktrees-off (the current product default) — the agent is
      // editing the user's checkout, so the "live site" IS the dev
      // server. Fall through and tell the model why.
      requested = DEFAULT_PREVIEW_URL;
      agentNote = `No isolated worktree for ${agentName} — agents currently edit the user's checkout directly, so the live preview IS the dev server. Open it normally.`;
    }
  }
  const target = normaliseTargetUrl(requested || DEFAULT_PREVIEW_URL);
  if (!target) {
    return {
      ok: false,
      error: `invalid preview url: ${requested}`,
      note:
        "Tell the user that URL isn't http(s) — ask them to repeat with a localhost port or a real http(s) URL.",
    };
  }
  const finalTitle = deriveTitle(target, args.title || (agentName ? `PREVIEW // ${agentName.toUpperCase()}` : null));
  // The pane-layer mounts internal URLs only; we encode the real target
  // into ?url= so /preview can load it inside a sandboxed iframe.
  const internalUrl = `/preview?url=${encodeURIComponent(target)}` +
    (args.title ? `&title=${encodeURIComponent(String(args.title).slice(0, 80))}` : "");
  return {
    ok: true,
    kind: "pane",
    page: "preview",
    projectable_id: `pane_preview_${Date.now().toString(36)}`,
    url: internalUrl,
    target_url: target,
    title: finalTitle,
    agent: agentName || undefined,
    note:
      agentNote ||
      "Say one short cute line in the same language the user just used (例 \"好嘞~ 已经把预览铺出来啦\" / \"here's the preview ✨\"). Don't read the URL out — the user can see it.",
  };
}

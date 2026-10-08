// src/tools/add_preview_bridge.js — install the omo preview bridge into
// a user's app so voice control works on it.
//
// Two modes:
//   • with `repo` → dispatch a Claude task to inject the <script> tag
//     into the project's HTML entry point. The prompt is intentionally
//     framework-aware (Vite/Next/SvelteKit/plain HTML) so Claude
//     doesn't ask back.
//   • without `repo` → return the snippet + manual-install instructions
//     for omo to read out. Useful when the user is on a deployed site,
//     someone else's app, or just wants to copy/paste once.
//
// Why this tool exists: bridge_timeout errors on cross-origin previews
// are uninformative without a clear remediation. omo can now offer
// "want me to add the bridge?" and the user can say yes → done in one
// Claude round-trip.

import * as hermes from '../../hermes/index.js';

const BRIDGE_TAG = '<script src="http://localhost:8080/preview-bridge.js" async></script>';

const FRAMEWORK_HINT = {
  next:        `For Next.js (app router) edit \`app/layout.tsx\` — add the tag inside the <head> via the metadata.other field, or via next/script in the root layout. For pages router, edit \`pages/_document.tsx\`.`,
  vite:        `For Vite, edit \`index.html\` at the project root. Add the script tag right before </head>.`,
  react:       `For a Create-React-App-style project, edit \`public/index.html\`. Add the script tag right before </head>.`,
  vue:         `For a Vue / Nuxt project, the entry HTML is usually \`index.html\` (Vite-based) or \`app.vue\` head config (Nuxt). Add the script tag in whichever serves the document head.`,
  svelte:      `For SvelteKit, edit \`src/app.html\` — add the script tag inside the %sveltekit.head% block (or right before </head>).`,
  plain:       `Find the main HTML file (index.html, public/index.html, or whatever you're serving) and add the script tag right before </head>.`,
};

function frameworkPrompt(framework) {
  const norm = String(framework || '').toLowerCase();
  if (FRAMEWORK_HINT[norm]) return FRAMEWORK_HINT[norm];
  return null;
}

function buildClaudePrompt({ framework, url }) {
  const hint = frameworkPrompt(framework);
  return [
    "Add the omo preview-bridge script to this project so /preview can voice-control its pages.",
    "",
    "Inject this exact tag inside the <head> of the project's main HTML entry point:",
    "",
    BRIDGE_TAG,
    "",
    hint || "Find the main HTML file in this project (e.g. index.html, public/index.html, app/layout.tsx for Next.js, src/app.html for SvelteKit). The bridge needs to load on every page, so prefer the layout / document file that wraps every route over a single page.",
    "",
    "Rules:",
    "  • Don't add it twice — if the project already has `<script src=\"http://localhost:8080/preview-bridge.js\"` anywhere, leave it alone and report 'already installed'.",
    "  • Don't modify any other files. One injection, end of task.",
    "  • Don't import or bundle the script — it MUST be a plain script tag with the src URL above. Bundling defeats the live-reload of the bridge.",
    "  • Verify by reading the file back after the edit.",
    url ? `\nContext: the user is currently previewing ${url} from inside omo, and voice control isn't working because the bridge isn't loaded.` : '',
  ].filter(Boolean).join("\n");
}

export const definition = {
  type: 'function',
  name: 'add_preview_bridge',
  description:
    "Install the omo preview bridge into an external app so voice control (click / type / scroll / describe) works on it. Use after a bridge_timeout error, OR when the user asks \"hook up the bridge\", \"make this voice-controllable\", \"添加 bridge\". With a repo path, this dispatches a Claude task that injects the right <script> tag into the project's HTML entry — usually one-shot. Without a repo path, returns the snippet + instructions for the user to add manually (omo reads it out).",
  parameters: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: "Absolute path to the project to modify. If you have it from earlier context (the user said 'in my app at ~/projects/foo'), pass it. Without this we fall back to instructions-only.",
      },
      framework: {
        type: 'string',
        description: "Optional framework hint to focus Claude's edit. Skipping is fine — Claude will detect it from the repo's package.json.",
        enum: ['next', 'vite', 'react', 'vue', 'svelte', 'plain'],
      },
      url: {
        type: 'string',
        description: "Optional: the URL currently shown in /preview. Used only as context in the Claude prompt.",
      },
      name: {
        type: 'string',
        description: "Optional agent callsign to use for the dispatched task. Defaults to whatever the pool picks.",
      },
    },
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const repo = args.repo ? String(args.repo).trim() : null;
  const framework = args.framework ? String(args.framework).toLowerCase() : null;
  const url = args.url ? String(args.url) : null;

  // ── Instructions-only mode ────────────────────────────────────────
  if (!repo) {
    return {
      ok: true,
      mode: 'instructions',
      snippet: BRIDGE_TAG,
      where:
        frameworkPrompt(framework) ||
        "Find the main HTML file (e.g. index.html, public/index.html, app/layout.tsx for Next.js, src/app.html for SvelteKit) and paste this inside <head>.",
      note:
        "Tell the user to paste the snippet into their <head>. Read the snippet OUT (one line). If they want you to do it for them, ask for the repo path and call this tool again with `repo:`.",
    };
  }

  // ── Claude-dispatch mode ──────────────────────────────────────────
  const prompt = buildClaudePrompt({ framework, url });
  let dispatched;
  try {
    dispatched = hermes.dispatchTask({
      name: args.name ? String(args.name) : null,
      prompt,
      repoPath: repo,
      runtime: 'claude',
      // The user just authorised this specific change. Bypass worktree
      // isolation so the bridge lands in their real repo immediately —
      // no follow-up accept_agent_work needed. (Worktree isolation is
      // the right default for exploratory edits; not here.)
      worktree: 'off',
    });
  } catch (err) {
    const code = err?.code;
    if (code === 'AGENT_BUSY') {
      return {
        ok: false,
        error: `${err.message || 'agent already busy'}`,
        note: 'Tell the user that agent is mid-task; offer to wait or pick a fresh callsign.',
      };
    }
    if (code === 'NO_SEAT') {
      return {
        ok: false,
        error: err.message,
        note: 'Tell the user the office is full. Suggest waiting for one to free up.',
      };
    }
    if (code === 'NOT_INSTALLED') {
      return {
        ok: false,
        error: 'claude is not installed',
        note: 'Tell the user Claude Code isn\'t available and offer the manual install path — call add_preview_bridge again without `repo:` to get the snippet to dictate.',
      };
    }
    return {
      ok: false,
      error: String(err?.message || err),
      note: 'Tell the user we couldn\'t dispatch the bridge installer and quote the error plainly.',
    };
  }

  return {
    ok: true,
    mode: 'dispatched',
    task_id: dispatched.task_id,
    agent_id: dispatched.agent_id,
    agent_name: dispatched.agent_name,
    color: dispatched.color,
    sigil: dispatched.sigil,
    seat: dispatched.seat,
    session_id: dispatched.session_id,
    runtime: dispatched.runtime,
    repo,
    framework: framework || null,
    note:
      "Say one short cute line — name the agent (`agent_name`), tell the user they're hooking up the bridge, and mention they can watch on /squad. Don't claim it's done — wait for task_complete. Once it finishes, the user can reload /preview and you should see 'bridge live' in the address bar.",
  };
}

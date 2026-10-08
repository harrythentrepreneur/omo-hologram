// src/tools/preview_nav.js — voice-driven control of the preview pane.
//
// Each tool follows the same pattern:
//   1. Build a command envelope with a fresh id.
//   2. Register a pending ack in the server-side registry.
//   3. Broadcast the envelope to the holo via /omo/preview/ws.
//   4. Await the bridge's real reply (or a timeout).
//   5. Return the truthful result to the model.
//
// This makes omo's narration honest: she sees the same { ok, result,
// error, suggestions } the bridge produced, not an optimistic placeholder.

import { dispatch, newId } from '../../preview/dispatch.js';

export { dispatch, newId };       // re-exported so do_preview can reuse

// ────────────────────────────────────────────────────────────────────
// navigate_preview — change URL / back / forward / reload
// ────────────────────────────────────────────────────────────────────

export const navigateDefinition = {
  type: 'function',
  name: 'navigate_preview',
  description:
    "Drive the preview pane like a browser: change the URL, go back, go forward, reload. Use when the user says \"go to /squad\", \"open /landing\", \"back\", \"forward\", \"reload\", \"refresh\", \"开 /hq\", \"回去\". Returns the truthful result from the bridge — if the preview pane isn't open, omo will get an `error: 'no_preview'` and should pair this with show_preview first.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path on the same host as the current preview (e.g. "/squad", "/landing"). Preferred when the user gives a route name.' },
      url:  { type: 'string', description: 'Full http(s) URL to navigate to. Use when the user names a different host.' },
      action: {
        type: 'string',
        description: '"back" / "forward" go through browser history. "reload" force-refreshes the current page.',
        enum: ['back', 'forward', 'reload'],
      },
    },
    additionalProperties: false,
  },
};

export async function runNavigate(args = {}) {
  const { path, url, action } = args;
  if (!path && !url && !action) return { ok: false, error: 'pass path, url, or action' };
  // Navigate has no DOM-side reply to speak of (browser unloads); the
  // bridge sends a quick ack and then the next page's bridge re-announces
  // ready on load. Keep timeout short — a slow reply means the bridge
  // isn't loaded, not that the page is mid-flight.
  return dispatch({
    command: 'navigate',
    path: path || undefined,
    url:  url  || undefined,
    action: action || undefined,
  }, { timeoutMs: 2000 });
}

// ────────────────────────────────────────────────────────────────────
// interact_preview — click / type / submit / focus
// ────────────────────────────────────────────────────────────────────

export const interactDefinition = {
  type: 'function',
  name: 'interact_preview',
  description:
    "Click a button, type into a field, submit a form, or focus an element on the preview page. Use when the user says \"click sign in\", \"hit submit\", \"type hello in the search box\", \"focus the email field\", \"点登录\", \"在搜索框输入\". The bridge does smart matching by accessible name → exact text → contains → role+text fuzzy. **If no exact match exists, the reply carries `suggestions` (3-5 closest labels) — omo should ask the user to pick one of those instead of guessing.**",
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '"click" — click a button/link/clickable. "type" — type text into a field; pair with `text`. "submit" — submit the current form. "focus" — move focus to an element (handy before "type" without a target).',
        enum: ['click', 'type', 'submit', 'focus'],
      },
      target: {
        type: 'string',
        description: 'What to click / type into / focus, in the user\'s words ("Sign In", "the search box", "email"). Pass the natural label. Omit for action:"submit", or when typing into the already-focused field.',
      },
      text: {
        type: 'string',
        description: 'Text to type. Only used for action:"type".',
      },
      index: {
        type: 'integer',
        description: 'Nth match when multiple targets share the same label (1-based; "click the second result").',
        minimum: 1,
      },
      replace: {
        type: 'boolean',
        description: 'For action:"type" — clear the field before typing instead of appending. Default false.',
      },
      submit: {
        type: 'boolean',
        description: 'For action:"type" — submit the form immediately after typing. Default false.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export async function runInteract(args = {}) {
  const { action } = args;
  if (!action) return { ok: false, error: 'action is required' };
  return dispatch({
    command: action,
    target: args.target || undefined,
    text:   args.text   ?? undefined,
    index:  args.index  || undefined,
    replace: args.replace ?? undefined,
    submit:  args.submit  ?? undefined,
  });
}

// ────────────────────────────────────────────────────────────────────
// scroll_preview — by direction / amount / to-text
// ────────────────────────────────────────────────────────────────────

export const scrollDefinition = {
  type: 'function',
  name: 'scroll_preview',
  description:
    "Scroll the preview page. Use when the user says \"scroll down\", \"go to the top\", \"scroll to pricing\", \"scroll up a little\", \"往下滑\", \"滚到底\". `direction` for direction-based scrolls; `to` for text-anchored scrolls; `amount` (pixels) for precise control. The matched element flashes briefly so the user can see what was scrolled to.",
  parameters: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        description: '"up" / "down" scrolls one viewport (or `amount` px). "top" / "bottom" jumps to the edge.',
        enum: ['up', 'down', 'top', 'bottom'],
      },
      to: {
        type: 'string',
        description: 'Text on the page to scroll to ("pricing", "FAQ", "the contact form"). Bridge picks the nearest matching heading/landmark.',
      },
      amount: {
        type: 'integer',
        description: 'Pixels for direction-based scroll. Default ~85% of viewport.',
        minimum: 10,
      },
    },
    additionalProperties: false,
  },
};

export async function runScroll(args = {}) {
  const { direction, to, amount } = args;
  if (!direction && !to) return { ok: false, error: 'pass direction or to' };
  return dispatch({
    command: 'scroll',
    direction: direction || undefined,
    to: to || undefined,
    amount: amount || undefined,
  });
}

// ────────────────────────────────────────────────────────────────────
// describe_preview — read the page (headings, links, buttons, fields)
// ────────────────────────────────────────────────────────────────────

export const describeDefinition = {
  type: 'function',
  name: 'describe_preview',
  description:
    "Ask the preview page what's on it — headings, links, buttons, form fields, landmarks. Use when the user says \"what's on this page\", \"what can I click\", \"read it out\", \"这页面有什么\", \"哪些按钮\". The bridge returns a compact structured summary; narrate the most relevant 2-4 items, don't recite the full list.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

export async function runDescribe() {
  // describe walks the DOM; give it a bit more room than the
  // direct-action commands.
  return dispatch({ command: 'describe' }, { timeoutMs: 4000 });
}

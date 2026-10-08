// Holo3 — H Company's vision-language model wired up as an *optional*
// agent loop for omo. The /automation page is the only consumer; nothing
// else in omo depends on this module.
//
// Layout:
//   index.js  — proxies the Holo3 chat API + assembles the system prompt
//               per "profile" (mac | browser | desktop). Exposes
//               POST /omo/api/holo3/step → next {note,thought,tool_call}.
//   browser.js — Browserbase Chromium "body": same loop, remote browser.
//   mac.js     — Local macOS "body" via bin/holo3_mac.py + pyautogui.
//
// `mountRoutes(app)` wires all three so server.js stays a one-liner.
// Holo3 key stays server-side (HAI_API_KEY); the browser never talks
// to api.hcompany.ai directly.

import * as browser from './browser.js';
import * as mac from './mac.js';

const HOLO3_URL = 'https://api.hcompany.ai/v1/chat/completions';
const DEFAULT_MODEL = process.env.HOLO3_MODEL || 'holo3-35b-a3b';
const MAX_IMAGES_DEFAULT = 3; // H Company recommends ≤3 screenshots in history

export function isConfigured() {
  return !!process.env.HAI_API_KEY;
}

function notConfigured(res) {
  return res.status(503).json({
    ok: false,
    error: 'holo3_not_configured',
    hint: 'Set HAI_API_KEY in .env (generate one at hub.hcompany.ai), then restart.',
  });
}

// Per-tool JSON-schema fragments. We compose them per-profile so the
// browser model isn't tempted to call desktop-only shortcuts (and vice
// versa). Coordinates are normalized to [0, 1000] over the screenshot.
const TOOL_SCHEMAS = {
  click: {
    type: 'object', required: ['tool_name','element','x','y'], additionalProperties: false,
    properties: {
      tool_name: { const: 'click' },
      element: { type: 'string' },
      x: { type: 'integer', minimum: 0, maximum: 1000 },
      y: { type: 'integer', minimum: 0, maximum: 1000 },
      button: { type: 'string', enum: ['left','right','middle'] },
    },
  },
  write: {
    type: 'object', required: ['tool_name','content'], additionalProperties: false,
    properties: {
      tool_name: { const: 'write' },
      content: { type: 'string' },
      press_enter: { type: 'boolean' },
      overwrite: { type: 'boolean' },
    },
  },
  scroll: {
    type: 'object', required: ['tool_name','direction','amount'], additionalProperties: false,
    properties: {
      tool_name: { const: 'scroll' },
      direction: { type: 'string', enum: ['up','down','left','right'] },
      amount: { type: 'integer', minimum: 1, maximum: 5000 },
    },
  },
  press_keys: {
    type: 'object', required: ['tool_name','keys'], additionalProperties: false,
    properties: {
      tool_name: { const: 'press_keys' },
      keys: { type: 'string', description: 'e.g. "Return", "ctrl+t"' },
    },
  },
  navigate: {
    type: 'object', required: ['tool_name','url'], additionalProperties: false,
    properties: {
      tool_name: { const: 'navigate' },
      url: { type: 'string', description: 'Absolute URL to load in the current tab.' },
    },
  },
  answer: {
    type: 'object', required: ['tool_name','content'], additionalProperties: false,
    properties: {
      tool_name: { const: 'answer' },
      content: { type: 'string' },
    },
  },
};

const PROFILES = {
  desktop: {
    env: 'a Linux desktop (Ubuntu) inside a cloud VM',
    tools: ['click','write','scroll','press_keys','answer'],
    extra: [
      '  - press_keys is great for shortcuts like "ctrl+alt+t" (terminal) or "super" (activities).',
    ],
  },
  browser: {
    env: 'a Chromium browser tab in a cloud session (no desktop, no native apps)',
    tools: ['click','write','scroll','press_keys','navigate','answer'],
    extra: [
      '  - Prefer `navigate(url)` over clicking the address bar — it is one step instead of three.',
      '  - press_keys works for in-page shortcuts ("ctrl+f", "Return", "Escape"), not OS-level ones.',
      '  - There is no taskbar, dock, or other windows — only the current page. Scroll within the page; do not try to find an app launcher.',
    ],
  },
  mac: {
    env: "the user's own macOS desktop (real machine — actions move the real cursor and type real keystrokes)",
    tools: ['click','write','scroll','press_keys','answer'],
    extra: [
      '  - Modifier key is `cmd` (Meta), not `ctrl`. Use "cmd+space" for Spotlight, "cmd+t" for new tab, "cmd+w" to close window, "cmd+tab" to switch apps.',
      '  - Fastest way to launch any app: `press_keys("cmd+space")` → wait for Spotlight → `write("App Name", press_enter=true)`. Always prefer Spotlight over hunting through the Dock.',
      '  - The dock is at the bottom; the menu bar is at the top. The macOS Finder window-close/minimize/maximize buttons are in the top-left.',
      "  - This is the user's real Mac, so move deliberately: read the screen carefully before each action, and call `answer` as soon as you have what was asked for.",
    ],
  },
};

function buildStepSchema(profile = 'desktop') {
  const tools = (PROFILES[profile] || PROFILES.desktop).tools;
  return {
    type: 'object',
    required: ['note','thought','tool_call'],
    additionalProperties: false,
    properties: {
      note: { type: 'string', description: 'Task-relevant info from the previous observation.' },
      thought: { type: 'string', description: 'One-line reasoning about the next action.' },
      tool_call: { oneOf: tools.map(t => TOOL_SCHEMAS[t]) },
    },
  };
}

const TOOL_BLURBS = {
  click: '  - click(element, x, y, button="left") — click at normalized coords [0,1000].',
  write: '  - write(content, press_enter=false, overwrite=false) — type text at the current focus.',
  scroll: '  - scroll(direction, amount) — scroll the active surface in pixels.',
  press_keys: '  - press_keys(keys) — keyboard shortcut, e.g. "Return", "ctrl+t", "Escape".',
  navigate: '  - navigate(url) — load an absolute URL in the current tab.',
  answer: '  - answer(content) — finish the task with a final answer or status.',
};

function systemPrompt(goal, profile = 'desktop') {
  const p = PROFILES[profile] || PROFILES.desktop;
  const schema = buildStepSchema(profile);
  const schemaBlock = '```json\n' + JSON.stringify(schema, null, 2) + '\n```';
  const toolLines = p.tools.map(t => TOOL_BLURBS[t]);
  return [
    `You are an autonomous computer-use agent operating ${p.env}.`,
    'You receive a screenshot at each turn and choose ONE action to make progress.',
    '',
    `GOAL: ${goal}`,
    '',
    'Available tools:',
    ...toolLines,
    '',
    'Rules:',
    '  * Coordinates are integers in [0, 1000], normalized to the screenshot you see (top-left origin).',
    '  * Always include `element` describing what you are clicking ("the Sign-in button, top right").',
    '  * One action per turn. The next screenshot will reflect the result.',
    '  * When the task is complete (or you cannot make further progress), call `answer`.',
    ...p.extra,
    '',
    '<output_format>',
    schemaBlock,
    '</output_format>',
  ].join('\n');
}

function buildMessages({ goal, history, screenshotB64, profile, maxImages = MAX_IMAGES_DEFAULT }) {
  const messages = [{ role: 'system', content: systemPrompt(goal, profile) }];

  // Replay prior turns. Older screenshots get replaced with text placeholders
  // so we only ever ship the most recent `maxImages` images to the model.
  const turns = Array.isArray(history) ? history : [];
  const imageTurnIdxs = turns
    .map((t, i) => (t.screenshot_b64 ? i : -1))
    .filter((i) => i >= 0);
  const keepFromIdx = imageTurnIdxs.length > maxImages - 1
    ? imageTurnIdxs[imageTurnIdxs.length - (maxImages - 1)]
    : -1;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const includeImage = turn.screenshot_b64 && i >= keepFromIdx;
    const obsContent = [
      { type: 'text', text: '<observation>\n' },
      ...(includeImage
        ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${turn.screenshot_b64}` } }]
        : [{ type: 'text', text: '[screenshot omitted — see later turns]' }]),
      { type: 'text', text: '\n</observation>' },
    ];
    messages.push({ role: 'user', content: obsContent });
    if (turn.step) {
      messages.push({ role: 'assistant', content: JSON.stringify(turn.step) });
    }
    if (turn.tool_output != null) {
      messages.push({
        role: 'user',
        content: `<tool_output tool="${turn.step?.tool_call?.tool_name || 'unknown'}">\n${turn.tool_output}\n</tool_output>`,
      });
    }
  }

  // Current observation (newest screenshot, no assistant response yet).
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: '<observation>\n' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotB64}` } },
      { type: 'text', text: '\n</observation>' },
    ],
  });

  return messages;
}

async function callHolo3({ messages, schema, signal }) {
  const resp = await fetch(HOLO3_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.HAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.8,
      messages,
      structured_outputs: { json: schema },
    }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`holo3 ${resp.status}: ${text.slice(0, 400) || resp.statusText}`);
  }
  return resp.json();
}

function mountStepRoutes(app) {
  app.get('/omo/api/holo3/status', (_req, res) => {
    res.json({
      configured: isConfigured(),
      model: DEFAULT_MODEL,
    });
  });

  app.post('/omo/api/holo3/step', async (req, res) => {
    if (!isConfigured()) return notConfigured(res);
    try {
      const {
        goal,
        history = [],
        screenshot_b64,
        screen_width,
        screen_height,
        max_images,
        profile = 'desktop',
      } = req.body || {};
      if (!goal || typeof goal !== 'string') {
        return res.status(400).json({ ok: false, error: 'missing goal' });
      }
      if (!screenshot_b64) {
        return res.status(400).json({ ok: false, error: 'missing screenshot_b64' });
      }
      const w = Number(screen_width) || 0;
      const h = Number(screen_height) || 0;

      const stepSchema = buildStepSchema(profile);
      const messages = buildMessages({
        goal,
        history,
        screenshotB64: screenshot_b64,
        profile,
        maxImages: Number(max_images) || MAX_IMAGES_DEFAULT,
      });

      const data = await callHolo3({ messages, schema: stepSchema });
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw) {
        return res.status(502).json({ ok: false, error: 'empty holo3 response', data });
      }
      let step;
      try { step = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch (e) {
        return res.status(502).json({ ok: false, error: 'invalid json from holo3', raw });
      }

      // Map normalized [0,1000] → pixel coords for click, so the caller
      // can hand the action straight to the body backend without
      // re-deriving the scale.
      let pixel_xy = null;
      if (step?.tool_call?.tool_name === 'click' && w && h) {
        pixel_xy = {
          x: Math.round((step.tool_call.x / 1000) * w),
          y: Math.round((step.tool_call.y / 1000) * h),
        };
      }

      res.json({ ok: true, step, pixel_xy, usage: data.usage || null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
}

// Single entry point for server.js — mounts /omo/api/holo3/* plus both
// backend bodies (browser + mac). Each is independently feature-gated on
// the env keys it needs, so it's fine to mount all three unconditionally.
export function mountRoutes(app) {
  mountStepRoutes(app);
  browser.mountRoutes(app);
  mac.mountRoutes(app);
}

// Holo3-piloted browser sessions — the "body" is a Browserbase Chromium
// tab driven via Playwright over CDP. Endpoints under
// /omo/api/holo3-browser/* mirror the action-message shape used by the
// mac backend so /automation only has to swap its base URL when the
// user picks "remote browser" instead of "your mac".

import { chromium } from 'playwright-core';
import * as bb from '../agents/browserbase.js';

const SESSIONS = new Map(); // id → { browser, context, page, debugUrl, width, height, createdAt, startedUrl }
const DEFAULT_START_URL = process.env.HOLO3_BROWSER_START_URL || 'https://www.google.com';
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT_SEC = Number(process.env.HOLO3_BROWSER_TIMEOUT_SEC || 900);

export function isConfigured() {
  return bb.isConfigured();
}

function notConfigured(res) {
  return res.status(503).json({
    ok: false,
    error: 'browserbase_not_configured',
    hint: bb.missingConfigReason() || 'Set BROWSER_API_KEY and BROWSER_PROJECT_ID in .env.',
  });
}

async function attach(id, connectUrl) {
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => {});
  return { browser, context, page };
}

async function ensureStartUrl(page, url) {
  try {
    if (!url) return;
    const current = page.url();
    if (current === url || current.startsWith(url)) return;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  } catch (err) {
    // Non-fatal — leave the page wherever it landed; Holo3 can navigate later.
    console.warn(`[holo3-browser] start navigation failed: ${err.message}`);
  }
}

// Map a single key string ("ctrl", "Return", "super") to Playwright's
// keyboard naming. Chords ("ctrl+t") pass through as "Control+t".
const KEY_ALIASES = {
  ctrl: 'Control', control: 'Control',
  cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta',
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  shift: 'Shift',
  enter: 'Enter', return: 'Enter',
  esc: 'Escape', escape: 'Escape',
  tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};
function remapKey(k) {
  const lower = String(k).trim().toLowerCase();
  return KEY_ALIASES[lower] || k;
}
function normalizeKeys(raw) {
  if (Array.isArray(raw)) raw = raw.join('+');
  return String(raw).split(/[+,]\s*/).filter(Boolean).map(remapKey).join('+');
}

async function execAction(sess, body) {
  const { page } = sess;
  const t = body?.type;
  switch (t) {
    case 'screenshot': {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
      const vp = page.viewportSize() || DEFAULT_VIEWPORT;
      sess.width = vp.width; sess.height = vp.height;
      return { base64_image: buf.toString('base64'), width: vp.width, height: vp.height };
    }
    case 'click_mouse': {
      const x = Number(body.x), y = Number(body.y);
      const button = body.button || 'left';
      const clicks = Number(body.num_of_clicks) || 1;
      await page.mouse.click(x, y, { button, clickCount: clicks });
      return { output: `click ${button} (${x},${y})` };
    }
    case 'move_mouse': {
      await page.mouse.move(Number(body.x), Number(body.y));
      return { output: `move (${body.x},${body.y})` };
    }
    case 'scroll': {
      const amt = Number(body.amount) || 200;
      const dir = body.direction || 'down';
      const [dx, dy] = dir === 'up' ? [0, -amt]
                    : dir === 'down' ? [0, amt]
                    : dir === 'left' ? [-amt, 0]
                    : dir === 'right' ? [amt, 0] : [0, amt];
      await page.mouse.wheel(dx, dy);
      return { output: `scroll ${dir} ${amt}` };
    }
    case 'type': {
      // insertText handles emoji + non-Latin better than .type(); fall
      // back to .type() if focused element rejects it.
      try { await page.keyboard.insertText(String(body.text)); }
      catch { await page.keyboard.type(String(body.text), { delay: 10 }); }
      return { output: `typed ${JSON.stringify(String(body.text).slice(0, 60))}` };
    }
    case 'press_keys': {
      const combo = normalizeKeys(body.keys);
      if (!combo) throw new Error('press_keys: empty');
      await page.keyboard.press(combo);
      return { output: `keys ${combo}` };
    }
    case 'navigate': {
      const url = String(body.url || '').trim();
      if (!url) throw new Error('navigate: missing url');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { output: `nav ${url}` };
    }
    case 'wait': {
      const ms = Math.max(0, Math.min(15_000, Number(body.ms) || 500));
      await new Promise(r => setTimeout(r, ms));
      return { output: `wait ${ms}ms` };
    }
    case 'url': {
      return { output: page.url() };
    }
    default:
      throw new Error(`unknown action type: ${t}`);
  }
}

export function mountRoutes(app) {
  app.get('/omo/api/holo3-browser/status', (_req, res) => {
    res.json({
      configured: isConfigured(),
      hint: isConfigured() ? null : (bb.missingConfigReason() || 'Browserbase keys missing'),
      start_url: DEFAULT_START_URL,
    });
  });

  app.post('/omo/api/holo3-browser/launch', async (req, res) => {
    if (!isConfigured()) return notConfigured(res);
    try {
      const region = process.env.BROWSERBASE_REGION || 'us-west-2';
      const timeoutSec = Number(req.body?.timeout_sec) || DEFAULT_TIMEOUT_SEC;
      const startUrl = String(req.body?.start_url || DEFAULT_START_URL);
      const viewport = req.body?.viewport || DEFAULT_VIEWPORT;

      const session = await bb.createSession({ viewport, region, timeoutSec });
      const { browser, context, page } = await attach(session.id, session.connectUrl);
      await ensureStartUrl(page, startUrl);

      SESSIONS.set(session.id, {
        browser, context, page,
        debugUrl: session.debuggerFullscreenUrl || session.debugUrl,
        width: viewport.width, height: viewport.height,
        createdAt: Date.now(),
        startedUrl: startUrl,
      });

      res.json({
        ok: true,
        data: {
          id: session.id,
          status: 'running',
          stream_url: session.debuggerFullscreenUrl || session.debugUrl,
          width: viewport.width,
          height: viewport.height,
          url: page.url(),
        },
      });
    } catch (err) {
      console.error('[holo3-browser] launch failed:', err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get('/omo/api/holo3-browser/:id', async (req, res) => {
    const sess = SESSIONS.get(req.params.id);
    if (!sess) return res.status(404).json({ ok: false, error: 'unknown session' });
    let currentUrl = null;
    try { currentUrl = sess.page.url(); } catch {}
    res.json({
      ok: true,
      data: {
        id: req.params.id,
        status: 'running',
        stream_url: sess.debugUrl,
        width: sess.width,
        height: sess.height,
        url: currentUrl,
        age_ms: Date.now() - sess.createdAt,
      },
    });
  });

  app.post('/omo/api/holo3-browser/:id/action', async (req, res) => {
    const sess = SESSIONS.get(req.params.id);
    if (!sess) return res.status(404).json({ ok: false, error: 'unknown session' });
    try {
      const out = await execAction(sess, req.body || {});
      res.json({ ok: true, data: out });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/holo3-browser/:id/stop', async (req, res) => {
    const sess = SESSIONS.get(req.params.id);
    if (!sess) return res.json({ ok: true, data: { status: 'terminated' } });
    try { await sess.browser.close(); } catch {}
    SESSIONS.delete(req.params.id);
    res.json({ ok: true, data: { status: 'terminated' } });
  });
}

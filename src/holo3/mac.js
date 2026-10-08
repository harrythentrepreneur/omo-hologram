// Holo3-piloted LOCAL Mac control. Same /automation loop as the
// browserbase variant, but the "body" is the user's actual desktop.
//
// Performance: we keep a long-running Python helper process per session
// so the ~400 ms pyautogui import cost is paid ONCE at /launch, not on
// every action. Without this, each step pays ~800 ms of Python
// cold-start overhead (one screenshot + one action).
//
// Safety contract:
//   * pyautogui FAILSAFE on: slam the mouse into the top-left screen
//     corner to abort any action and refuse further ones.
//   * macOS will block clicks until Python has Accessibility permission.
//   * One in-flight command per session; pyautogui is single-threaded.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HELPER_PATH = join(process.cwd(), 'bin', 'holo3_mac.py');
const PYTHON_CANDIDATES = [
  process.env.HOLO3_MAC_PYTHON,
  join(homedir(), 'holo3-trial', '.venv', 'bin', 'python'),
  join(homedir(), '.omo', 'holo3-venv', 'bin', 'python'),
].filter(Boolean);

function findPython() {
  for (const p of PYTHON_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export function isConfigured() {
  return !!(findPython() && existsSync(HELPER_PATH));
}

function missingHint() {
  if (!existsSync(HELPER_PATH)) return `bin/holo3_mac.py not found at ${HELPER_PATH}`;
  if (!findPython()) {
    return 'No pyautogui-equipped Python found. Run: ' +
      'python3 -m venv ~/.omo/holo3-venv && ~/.omo/holo3-venv/bin/pip install pyautogui pillow';
  }
  return 'Holo3-mac helper not available.';
}

// Persistent helper subprocess. One per session — actions are serialized
// in submission order because pyautogui can only do one thing at a time.
class Helper {
  constructor(pythonPath) {
    this.queue = [];      // pending { resolve, reject } in submission order
    this.buf = '';        // unflushed stdout fragment
    this.ready = false;
    this.dead = false;
    this.readyWaiters = [];
    this.proc = spawn(pythonPath, [HELPER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.proc.stdout.on('data', (c) => this._onStdout(c));
    this.proc.stderr.on('data', (c) => process.stderr.write(`[holo3-mac] ${c}`));
    this.proc.on('exit', (code, sig) => this._onExit(code, sig));
  }

  _onStdout(chunk) {
    this.buf += chunk.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }
      if (msg.event === 'ready') {
        this.ready = true;
        const ws = this.readyWaiters; this.readyWaiters = [];
        ws.forEach((w) => w.resolve());
        continue;
      }
      const pending = this.queue.shift();
      if (!pending) continue;
      if (msg.ok === false) pending.reject(new Error(msg.error || 'helper error'));
      else pending.resolve(msg.data);
    }
  }

  _onExit(code, sig) {
    this.dead = true;
    const err = new Error(`helper exited (code=${code} sig=${sig})`);
    this.queue.splice(0).forEach((p) => p.reject(err));
    this.readyWaiters.splice(0).forEach((w) => w.reject(err));
  }

  awaitReady(timeoutMs = 8000) {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('helper ready timeout')), timeoutMs);
      this.readyWaiters.push({
        resolve: () => { clearTimeout(timer); resolve(); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  run(action) {
    if (this.dead) return Promise.reject(new Error('helper not running'));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(JSON.stringify(action) + '\n');
    });
  }

  kill() {
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
  }
}

const SESSIONS = new Map(); // id → { helper, width, height, createdAt }

export function mountRoutes(app) {
  app.get('/omo/api/holo3-mac/status', (_req, res) => {
    res.json({
      configured: isConfigured(),
      hint: isConfigured() ? null : missingHint(),
      python_path: findPython(),
      helper_path: HELPER_PATH,
    });
  });

  app.post('/omo/api/holo3-mac/launch', async (_req, res) => {
    if (!isConfigured()) return res.status(503).json({ ok: false, error: missingHint() });
    const py = findPython();
    let helper;
    try {
      helper = new Helper(py);
      await helper.awaitReady(10_000);
      const probe = await helper.run({ type: 'screenshot' });
      const id = randomUUID();
      SESSIONS.set(id, {
        helper,
        width: probe.width,
        height: probe.height,
        createdAt: Date.now(),
      });
      res.json({
        ok: true,
        data: {
          id,
          status: 'running',
          stream_url: null,
          width: probe.width,
          height: probe.height,
          base64_image: probe.base64_image,
        },
      });
    } catch (err) {
      try { helper && helper.kill(); } catch {}
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.get('/omo/api/holo3-mac/:id', (req, res) => {
    const sess = SESSIONS.get(req.params.id);
    if (!sess) return res.status(404).json({ ok: false, error: 'unknown session' });
    res.json({
      ok: true,
      data: {
        id: req.params.id,
        status: sess.helper.dead ? 'terminated' : 'running',
        stream_url: null,
        width: sess.width,
        height: sess.height,
        age_ms: Date.now() - sess.createdAt,
      },
    });
  });

  app.post('/omo/api/holo3-mac/:id/action', async (req, res) => {
    const sess = SESSIONS.get(req.params.id);
    if (!sess) return res.status(404).json({ ok: false, error: 'unknown session' });
    try {
      const data = await sess.helper.run(req.body || {});
      if (data?.width && data?.height) {
        sess.width = data.width; sess.height = data.height;
      }
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/holo3-mac/:id/stop', (req, res) => {
    const sess = SESSIONS.get(req.params.id);
    if (sess) {
      try { sess.helper.kill(); } catch {}
      SESSIONS.delete(req.params.id);
    }
    res.json({ ok: true, data: { status: 'terminated' } });
  });
}

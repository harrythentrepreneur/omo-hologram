/* squad-grid.js — multi-terminal grid overlay for /squad.
 *
 * A full-screen overlay that summons /feather's tiled terminal view on top
 * of /squad. Ported wholesale from public/feather.html (the original /feather
 * page is now retired and redirects here). Same lifecycle, same scrubber,
 * same WS contract — just packaged as a mountable module so /squad can show
 * it on demand without losing its hologram + sprite identity.
 *
 *   import { mountSquadGrid } from '/squad-grid.js';
 *   const grid = await mountSquadGrid();      // injects DOM + CSS, returns handle
 *   grid.open();    // show the overlay (lazy WS connect on first open)
 *   grid.close();   // hide it (WSs stay alive so re-open is instant)
 *   grid.toggle();
 *   grid.isOpen();
 *
 * The module owns its own WSs, PeekStreams, and xterms — independent of the
 * /squad monitor's single-xterm session pool. The server-side PTY supports
 * multiple attachments, so having both surfaces open at once is fine.
 *
 * All DOM IDs/classes are prefixed `sg-` to avoid collisions with /squad.
 */

import { Terminal } from 'https://esm.sh/@xterm/xterm@5.5.0';
import { FitAddon } from 'https://esm.sh/@xterm/addon-fit@0.10.0';

// ─── scoped CSS ──────────────────────────────────────────────────────
// Injected once on module load. All selectors are nested under `.sg-root`
// so we don't bleed into /squad's stylesheet. Variables shadow /feather's
// palette — same hex codes, just locally scoped.
const CSS = `
/* Variables shared by .sg-root (the overlay) and .sg-floats (the always-on
   banner + toast container at body level). Keeping them on both selectors
   instead of :root keeps the namespace contained. */
.sg-root, .sg-floats {
  --sg-bg:        #faf9f6;
  --sg-bg-tile:   #ffffff;
  --sg-bg-soft:   #f3f1ec;
  --sg-ink:       rgba(45, 42, 38, 0.92);
  --sg-ink-soft:  rgba(45, 42, 38, 0.62);
  --sg-ink-mute:  rgba(45, 42, 38, 0.42);
  --sg-line:      rgba(45, 42, 38, 0.10);
  --sg-line-soft: rgba(45, 42, 38, 0.06);
  --sg-accent:    rgba(227, 117, 83, 0.95);
  --sg-accent-dim:rgba(227, 117, 83, 0.18);
  --sg-good:      rgba(70, 156, 105, 0.95);
  --sg-bad:       rgba(196, 92, 92, 0.95);
  --sg-term-bg:   #1d1b18;
  --sg-term-fg:   #ece9e1;
  --sg-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --sg-sans: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
}
.sg-root {
  position: fixed; inset: 0;
  z-index: 90;
  background: var(--sg-bg);
  color: var(--sg-ink);
  font-family: var(--sg-sans);
  display: none;
  /* Single row — chrome-less, voice-driven view. The topbar + compose
     footer are intentionally absent; G toggles open/close, Esc cycles
     mosaic→close, ⌘1/2/4 + plain 1-9 + [ / ] drive layout, and tiles
     receive xterm input directly. */
  grid-template-rows: 1fr;
}
.sg-root.sg-open { display: grid; }
.sg-root * { box-sizing: border-box; }

/* /squad's stylesheet has a tag-level header { grid-area: header } rule
   that would contaminate any <header>/<aside>/<section> inside .sg-root.
   Even though the chrome-less view no longer renders those tags, this
   defensive reset ensures any future child element flows in DOM order. */
.sg-root > .sg-workspace,
.sg-workspace > .sg-sidebar,
.sg-workspace > .sg-stage {
  grid-area: auto;
}

/* Always-on floats container — banner + toast live here so they pop above
   the /squad monitor even when the grid overlay itself is hidden. */
.sg-floats { pointer-events: none; }
.sg-floats > * { pointer-events: auto; }
.sg-chip.sg-rt-chip button.sg-on { background: var(--sg-ink); color: var(--sg-bg); }

.sg-rt-tag {
  font-family: var(--sg-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--sg-ink-mute);
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(45, 42, 38, 0.06);
}
.sg-rt-tag[data-rt="hermes"] {
  color: rgba(70, 110, 160, 0.95);
  background: rgba(70, 110, 160, 0.10);
}
.sg-sidebar .sg-rt-tag { display: none; }

/* workspace */
.sg-workspace {
  position: relative;
  height: 100%;
  display: grid;
  grid-template-columns: 0 1fr;
  transition: grid-template-columns 0.22s ease;
  gap: 10px;
  padding: 14px;
  overflow: hidden;
  min-height: 0;
}
.sg-root[data-mode="zoom1"] .sg-workspace,
.sg-root[data-mode="zoom2"] .sg-workspace,
.sg-root[data-mode="zoom4"] .sg-workspace { grid-template-columns: 92px 1fr; }

.sg-sidebar {
  overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 8px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
  min-height: 0;
}
.sg-root[data-mode="zoom1"] .sg-sidebar,
.sg-root[data-mode="zoom2"] .sg-sidebar,
.sg-root[data-mode="zoom4"] .sg-sidebar { opacity: 1; pointer-events: auto; }
.sg-sidebar::-webkit-scrollbar { width: 4px; }
.sg-sidebar::-webkit-scrollbar-thumb { background: var(--sg-line); border-radius: 2px; }

.sg-stage {
  position: relative;
  overflow: hidden;
  min-height: 0;
}
.sg-grid {
  display: grid;
  gap: 12px;
  height: 100%;
}
.sg-root[data-mode="mosaic"] .sg-grid[data-count="0"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="1"] { grid-template-columns: 1fr; grid-template-rows: 1fr; }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="2"] { grid-template-columns: 1fr 1fr; }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="3"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="4"]  { grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(2, 1fr); }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="5"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="6"]  { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(2, 1fr); }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="7"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="8"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="9"]  { grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="10"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="11"],
.sg-root[data-mode="mosaic"] .sg-grid[data-count="12"] { grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(3, 1fr); }
.sg-root[data-mode="zoom1"] .sg-grid { grid-template-columns: 1fr; grid-template-rows: 1fr; }
.sg-root[data-mode="zoom2"] .sg-grid { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
.sg-root[data-mode="zoom4"] .sg-grid { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }

/* tile */
.sg-tile {
  display: grid;
  grid-template-rows: auto 1fr;
  background: var(--sg-bg-tile);
  border: 1px solid var(--sg-line);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color .18s ease, box-shadow .18s ease;
  min-height: 0;
}
.sg-tile.sg-focused {
  border-color: var(--sg-accent-dim);
  box-shadow: 0 0 0 3px rgba(227, 117, 83, 0.08);
}
.sg-tile.sg-voice-pulse { animation: sg-tile-voice-pulse 0.6s ease-out; }
@keyframes sg-tile-voice-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(227, 117, 83, 0.55); }
  60%  { box-shadow: 0 0 0 10px rgba(227, 117, 83, 0.00); }
  100% { box-shadow: 0 0 0 3px rgba(227, 117, 83, 0.08); }
}
.sg-tile-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sg-line-soft);
  background: var(--sg-bg-soft);
  font-family: var(--sg-mono);
  font-size: 11px;
}
.sg-sigil {
  width: 18px; height: 18px; border-radius: 4px;
  display: grid; place-items: center;
  color: white; font-weight: 700; font-size: 10px;
  background: var(--sg-accent);
}
.sg-tile-name { color: var(--sg-ink); letter-spacing: 0.05em; }
.sg-tile-status {
  color: var(--sg-ink-mute); font-size: 10px;
  letter-spacing: 0.12em; text-transform: uppercase;
}
.sg-tile-status.sg-alive { color: var(--sg-good); }
.sg-tile-status.sg-busy  { color: var(--sg-accent); }
.sg-tile-actions { margin-left: auto; display: flex; gap: 4px; }
.sg-tile-actions button {
  font-family: var(--sg-mono);
  font-size: 10px; letter-spacing: 0.10em;
  padding: 4px 8px;
  background: transparent;
  color: var(--sg-ink-soft);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  text-transform: uppercase;
  transition: all .12s ease;
}
.sg-tile-actions button:hover {
  color: var(--sg-ink);
  border-color: var(--sg-line);
  background: var(--sg-bg-tile);
}
.sg-tile-actions button.sg-close-btn {
  font-size: 15px; font-weight: 600;
  line-height: 1; padding: 3px 8px;
  margin-left: 2px;
  color: var(--sg-ink-mute);
  letter-spacing: 0;
}
.sg-tile-actions button.sg-close-btn:hover {
  color: var(--sg-bad);
  background: rgba(196, 92, 92, 0.08);
  border-color: rgba(196, 92, 92, 0.24);
}
.sg-tile-body {
  background: var(--sg-term-bg);
  position: relative;
  overflow: hidden;
}
.sg-tile-body .sg-xterm-wrap {
  position: absolute; inset: 0;
  padding: 8px 10px;
}
.sg-tile-body .xterm,
.sg-tile-body .xterm-viewport,
.sg-tile-body .xterm-screen { background: transparent !important; }
.sg-tile-empty {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  background: rgba(20, 18, 16, 0.42);
  backdrop-filter: blur(10px) saturate(120%);
  cursor: pointer;
  transition: background 0.18s ease;
}
.sg-tile-empty:hover { background: rgba(20, 18, 16, 0.28); }
.sg-tile-empty > div {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 12px 20px;
  border-radius: 999px;
  background: rgba(34, 30, 26, 0.72);
  border: 1px solid rgba(236, 233, 225, 0.10);
  color: rgba(236, 233, 225, 0.78);
  font-family: var(--sg-mono); font-size: 11.5px;
  letter-spacing: 0.18em; text-transform: uppercase;
}

.sg-tile.sg-peek  [data-xterm] { display: none; }
.sg-tile.sg-stage [data-peek]  { display: none; }
.sg-tile.sg-peek  [data-launch]{ display: none !important; }

/* peek */
.sg-tile.sg-peek .sg-tile-body { background: var(--sg-term-bg); cursor: pointer; }
.sg-tile.sg-peek .sg-tile-body:hover { background: #25221e; }
.sg-peek-pre {
  margin: 0; padding: 8px 10px;
  width: 100%; height: 100%;
  box-sizing: border-box;
  color: rgba(236, 233, 225, 0.78);
  font-family: var(--sg-mono);
  font-size: 11px;
  line-height: 1.4;
  overflow: hidden;
  white-space: pre;
  display: flex; flex-direction: column-reverse;
}
.sg-root[data-mode="mosaic"] .sg-grid[data-count="1"]  .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="2"]  .sg-peek-pre { font-size: 12.5px; padding: 10px 12px; }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="3"]  .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="4"]  .sg-peek-pre { font-size: 11.5px; padding: 9px 11px; }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="5"]  .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="6"]  .sg-peek-pre { font-size: 10.5px; padding: 7px 9px; }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="7"]  .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="8"]  .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="9"]  .sg-peek-pre { font-size: 9.5px;  padding: 6px 8px; line-height: 1.3; }
.sg-root[data-mode="mosaic"] .sg-grid[data-count="10"] .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="11"] .sg-peek-pre,
.sg-root[data-mode="mosaic"] .sg-grid[data-count="12"] .sg-peek-pre { font-size: 8.5px;  padding: 5px 7px; line-height: 1.25; }

/* sidebar mini-tiles */
.sg-sidebar .sg-tile {
  flex: 0 0 auto;
  border-radius: 8px;
  min-height: 72px;
  grid-template-rows: 22px 1fr;
}
.sg-sidebar .sg-tile-head {
  padding: 3px 6px;
  gap: 5px;
  font-size: 9px;
  border-bottom: 0;
}
.sg-sidebar .sg-tile-head .sg-sigil {
  width: 14px; height: 14px; font-size: 8px;
  border-radius: 3px;
}
.sg-sidebar .sg-tile-head .sg-tile-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sg-sidebar .sg-tile-head .sg-tile-status,
.sg-sidebar .sg-tile-head .sg-tile-actions { display: none; }
.sg-sidebar .sg-peek-pre { font-size: 8.5px; padding: 4px 6px; line-height: 1.25; }
.sg-sidebar .sg-tile-head::after {
  content: '';
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--sg-ink-mute);
  margin-left: auto;
}
.sg-sidebar .sg-tile[data-alive="1"] .sg-tile-head::after { background: var(--sg-good); }
.sg-sidebar .sg-tile[data-busy="1"]  .sg-tile-head::after { background: var(--sg-accent); animation: sg-peek-blink 1.2s ease-in-out infinite; }
@keyframes sg-peek-blink {
  0%, 50% { opacity: 0.5; }
  51%, 100% { opacity: 0.0; }
}

/* empty stage */
.sg-stage-empty {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  pointer-events: none;
}
.sg-stage-empty .sg-pitch {
  text-align: center;
  font-family: var(--sg-mono);
  color: var(--sg-ink-soft);
  letter-spacing: 0.10em;
  font-size: 12px;
  pointer-events: auto;
}
.sg-stage-empty .sg-pitch h2 {
  font-family: var(--sg-sans);
  font-size: 22px;
  color: var(--sg-ink);
  margin: 0 0 10px;
  letter-spacing: 0.005em;
  text-transform: none;
}
.sg-stage-empty .sg-pitch p { margin: 0 0 18px; line-height: 1.65; color: var(--sg-ink-mute); }

/* awaiting */
.sg-tile[data-awaiting="1"] {
  border-color: var(--sg-accent);
  box-shadow: 0 0 0 3px rgba(227, 117, 83, 0.16);
  animation: sg-tile-await 1.8s ease-in-out infinite;
}
@keyframes sg-tile-await {
  0%, 100% { box-shadow: 0 0 0 3px rgba(227, 117, 83, 0.10); }
  50%      { box-shadow: 0 0 0 5px rgba(227, 117, 83, 0.24); }
}
.sg-tile .sg-await-badge {
  display: none;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--sg-accent);
  color: white;
  font-size: 9px; font-weight: 700;
  align-items: center; justify-content: center;
  margin-left: 4px;
  animation: sg-badge-blink 1.2s ease-in-out infinite;
}
.sg-tile[data-awaiting="1"] .sg-await-badge { display: inline-flex; }
@keyframes sg-badge-blink {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.18); }
}

/* banner */
.sg-banner {
  position: fixed;
  top: 76px; left: 50%;
  transform: translate(-50%, -16px);
  width: min(720px, calc(100vw - 28px));
  padding: 10px 14px;
  display: flex; align-items: center; gap: 10px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--sg-accent-dim);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(45, 42, 38, 0.16), 0 2px 6px rgba(45, 42, 38, 0.06);
  backdrop-filter: blur(10px);
  font-family: var(--sg-sans);
  font-size: 13px; color: var(--sg-ink);
  z-index: 180;
  opacity: 0;
  pointer-events: none;
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.sg-banner.sg-show {
  opacity: 1;
  transform: translate(-50%, 0);
  pointer-events: auto;
}
.sg-banner .sg-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--sg-accent);
  animation: sg-badge-blink 1.2s ease-in-out infinite;
  flex: 0 0 auto;
}
.sg-banner .sg-who { font-weight: 600; }
.sg-banner .sg-what {
  flex: 1; min-width: 0;
  color: var(--sg-ink-soft);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--sg-mono);
  font-size: 12px;
}
.sg-banner .sg-what::before { content: '"'; opacity: 0.5; }
.sg-banner .sg-what::after  { content: '"'; opacity: 0.5; }
.sg-banner .sg-more {
  font-size: 10px; color: var(--sg-ink-mute);
  letter-spacing: 0.10em; text-transform: uppercase;
  white-space: nowrap;
}
.sg-banner .sg-actions {
  display: flex; gap: 6px;
  flex: 0 0 auto;
}
.sg-banner .sg-actions button {
  font-family: var(--sg-mono);
  font-size: 11px; letter-spacing: 0.10em;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--sg-line);
  background: var(--sg-bg-tile);
  color: var(--sg-ink);
  cursor: pointer;
  text-transform: uppercase;
  transition: all .12s ease;
}
.sg-banner .sg-actions button:hover { border-color: var(--sg-accent-dim); color: var(--sg-accent); }
.sg-banner .sg-actions button[data-choice="yes"] {
  background: var(--sg-accent); color: white; border-color: var(--sg-accent);
}
.sg-banner .sg-actions button[data-choice="yes"]:hover { background: rgba(227, 117, 83, 0.86); color: white; }
.sg-banner .sg-actions button[data-choice="no"]:hover {
  color: var(--sg-bad); border-color: rgba(196, 92, 92, 0.30);
}

/* toast */
.sg-toast {
  position: fixed;
  top: 76px; left: 50%;
  transform: translate(-50%, -20px);
  background: var(--sg-ink);
  color: white;
  padding: 10px 16px;
  border-radius: 8px;
  font-family: var(--sg-mono);
  font-size: 11px;
  letter-spacing: 0.10em;
  opacity: 0;
  pointer-events: none;
  transition: all 0.18s ease;
  z-index: 200;
}
.sg-toast.sg-show { opacity: 1; transform: translate(-50%, 0); }
.sg-toast.sg-err { background: var(--sg-bad); }
.sg-toast.sg-ok  { background: var(--sg-good); }
`;

function injectCss() {
  if (document.getElementById('sg-style')) return;
  const s = document.createElement('style');
  s.id = 'sg-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ─── PeekStream — byte ring + ANSI-scrubbed visible tail ────────────
const RAW_CAP = 16 * 1024;
const PEEK_LINES = 20;
const PEEK_LINE_MAX = 240;
const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;
class PeekStream {
  constructor() {
    this.raw = new Uint8Array(RAW_CAP);
    this.rawLen = 0;
    this.lines = [''];
    this._cache = '';
    this._dirty = true;
  }
  push(bytes) {
    if (bytes.length >= RAW_CAP) {
      this.raw.set(bytes.subarray(bytes.length - RAW_CAP));
      this.rawLen = RAW_CAP;
    } else {
      const need = this.rawLen + bytes.length - RAW_CAP;
      if (need > 0) {
        this.raw.copyWithin(0, need, this.rawLen);
        this.rawLen -= need;
      }
      this.raw.set(bytes, this.rawLen);
      this.rawLen += bytes.length;
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
    catch { text = ''; }
    text = text.replace(ANSI_RE, '');
    let cur = this.lines[this.lines.length - 1];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') {
        this.lines[this.lines.length - 1] = cur;
        this.lines.push('');
        cur = '';
        if (this.lines.length > PEEK_LINES) this.lines.shift();
      } else if (ch === '\r') {
        cur = '';
      } else if (ch === '\b') {
        cur = cur.slice(0, -1);
      } else if (ch === '\t') {
        cur += '    ';
      } else if (ch >= ' ') {
        cur += ch;
        if (cur.length > PEEK_LINE_MAX) cur = cur.slice(-PEEK_LINE_MAX);
      }
    }
    this.lines[this.lines.length - 1] = cur;
    this._dirty = true;
  }
  tail() {
    if (!this._dirty) return this._cache;
    this._cache = this.lines.join('\n');
    this._dirty = false;
    return this._cache;
  }
  replay() { return this.raw.subarray(0, this.rawLen); }
}

// ─── prompt detection ───────────────────────────────────────────────
const PROMPT_QUESTION_RE = /\b(?:Do you want to|Proceed with|May I|Should I|Allow|Run|Continue)\b[^?\n]{0,140}\?/i;
const PROMPT_MENU_RE     = /(?:^|\n)\s*[❯>›]\s*1\.\s+\S/m;
const PROMPT_NUMBERED_RE = /(?:^|\n)\s*1\.\s+\S[\s\S]{0,200}?\n\s*2\.\s+\S/;
const PROMPT_YN_RE       = /\(\s*y\s*\/\s*n\s*\)\s*[:?]?\s*$|\[\s*y\s*\/\s*N?\s*\]\s*[:?]?\s*$/im;

function detectPrompt(tail) {
  if (!tail) return null;
  const last = tail.split('\n').slice(-14).join('\n');
  const hasMenu = PROMPT_MENU_RE.test(last);
  const hasNum  = PROMPT_NUMBERED_RE.test(last);
  const hasYN   = PROMPT_YN_RE.test(last);
  const hasQ    = PROMPT_QUESTION_RE.test(last);
  let kind = null;
  if (hasMenu || (hasNum && hasQ)) kind = 'menu';
  else if (hasYN) kind = 'yn';
  else if (hasQ && /^[›>❯]/m.test(last)) kind = 'menu';
  if (!kind) return null;
  const lines = last.split('\n').map((l) => l.trim()).filter(Boolean);
  let question = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\?$/.test(lines[i])) { question = lines[i]; break; }
  }
  if (!question) question = kind === 'menu' ? 'Claude is asking for permission.' : 'Claude is waiting on yes/no.';
  question = question.replace(/^[❯>›]\s*/, '').slice(0, 140);
  return { kind, question };
}

const XTERM_FONT_BY_MODE = { mosaic: 12, zoom1: 13, zoom2: 11.5, zoom4: 10.5 };
const xtermFontFor = (mode) => XTERM_FONT_BY_MODE[mode] ?? 12.5;
const MODE_CAPACITY = { mosaic: 0, zoom1: 1, zoom2: 2, zoom4: 4 };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ─── factory ─────────────────────────────────────────────────────────
// Returns a handle. The DOM is appended to document.body, hidden until
// open() is called. Idempotent — calling mountSquadGrid() twice returns
// the existing handle.
let _instance = null;
export async function mountSquadGrid(opts = {}) {
  if (_instance) return _instance;
  injectCss();

  // ─── build DOM ─────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.className = 'sg-root';
  root.setAttribute('data-mode', 'mosaic');
  root.innerHTML = `
    <main class="sg-workspace">
      <aside class="sg-sidebar" aria-label="other terminals"></aside>
      <section class="sg-stage">
        <div class="sg-grid" data-count="0"></div>
        <div class="sg-stage-empty">
          <div class="sg-pitch">
            <h2>no terminals yet</h2>
            <p>say "spawn an agent" to start one,<br>or "open Atlas" once she's running.</p>
          </div>
        </div>
      </section>
    </main>
  `;
  document.body.appendChild(root);

  // Always-on floats container — banner + toast live OUTSIDE the overlay
  // so they show even when the grid is hidden (e.g. an agent hits a
  // permission prompt while the user is in the monitor; the banner pops
  // over the monitor with yes/always/no/show-me buttons).
  const floats = document.createElement('div');
  floats.className = 'sg-floats';
  floats.innerHTML = `
    <div class="sg-toast"></div>
    <div class="sg-banner" role="status" aria-live="polite">
      <span class="sg-dot"></span>
      <span><b class="sg-who">agent</b> needs you</span>
      <span class="sg-what">…</span>
      <span class="sg-more"></span>
      <span class="sg-actions">
        <button data-choice="yes" title="approve (option 1)">yes</button>
        <button data-choice="always" title="approve + don't ask again (option 2)">always</button>
        <button data-choice="no" title="decline (option 3)">no</button>
        <button data-choice="zoom" title="zoom into this terminal">show me</button>
      </span>
    </div>
  `;
  document.body.appendChild(floats);

  const $ = (sel) => root.querySelector(sel);
  const grid = $('.sg-grid');
  const sidebar = $('.sg-sidebar');
  const stageEmpty = $('.sg-stage-empty');
  const toast = floats.querySelector('.sg-toast');
  const banner = floats.querySelector('.sg-banner');
  const bannerWho = banner.querySelector('.sg-who');
  const bannerWhat = banner.querySelector('.sg-what');
  const bannerMore = banner.querySelector('.sg-more');

  // ─── state ──────────────────────────────────────────────────────────
  const agents = new Map();
  let focusedId = null;
  const layout = { mode: 'mosaic', primaries: [] };
  let isOpen = false;

  // ─── toast ──────────────────────────────────────────────────────────
  let toastTimer = null;
  function flash(msg, kind = '') {
    toast.textContent = msg;
    toast.className = 'sg-toast sg-show ' + (kind ? 'sg-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'sg-toast ' + (kind ? 'sg-' + kind : ''); }, 2200);
  }

  // ─── peek scheduler ─────────────────────────────────────────────────
  const peekDirty = new Set();
  let peekRafScheduled = false;
  function schedulePeek(id) {
    peekDirty.add(id);
    if (peekRafScheduled) return;
    peekRafScheduled = true;
    requestAnimationFrame(() => {
      peekRafScheduled = false;
      for (const id of peekDirty) {
        const a = agents.get(id);
        if (!a) continue;
        if (a._peekSpan) a._peekSpan.textContent = a.stream.tail();
        checkAwaitingState(a);
      }
      peekDirty.clear();
    });
  }

  // ─── awaiting detection ─────────────────────────────────────────────
  function checkAwaitingState(a) {
    const next = detectPrompt(a.stream.tail());
    const prev = a.awaiting || null;
    const nextKey = next ? `${next.kind}::${next.question}` : '';
    const prevKey = prev ? `${prev.kind}::${prev.question}` : '';
    if (nextKey === prevKey) return;
    a.awaiting = next;
    if (a._el) a._el.dataset.awaiting = next ? '1' : '0';
    if (next && !prev) onPromptAppeared(a, next);
    refreshBanner();
  }

  function awaitingList() { return [...agents.values()].filter((a) => a.awaiting); }
  function refreshBanner() {
    const waiting = awaitingList();
    if (waiting.length === 0) {
      banner.classList.remove('sg-show');
      pushFocusedView();
      return;
    }
    const target = waiting.find((a) => a.id === focusedId) || waiting[0];
    bannerWho.textContent = target.name;
    bannerWhat.textContent = target.awaiting?.question || 'needs your input';
    bannerMore.textContent = waiting.length > 1 ? `+${waiting.length - 1} more` : '';
    banner.dataset.agent = target.id;
    banner.classList.add('sg-show');
    pushFocusedView();
  }

  let audioCtx = null;
  function playChime() {
    try {
      if (window.omoVoiceMode?.current === 'on') return;
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const now = ctx.currentTime;
      for (const [freq, delay] of [[880, 0], [1318.5, 0.10]]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, now + delay);
        g.gain.linearRampToValueAtTime(0.06, now + delay + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.42);
        o.connect(g).connect(ctx.destination);
        o.start(now + delay);
        o.stop(now + delay + 0.5);
      }
    } catch {}
  }

  function onPromptAppeared(a, prompt) {
    const cur = focusedId ? agents.get(focusedId) : null;
    if (!cur?.awaiting) focus(a.id);
    playChime();
    try {
      fetch('/omo/api/feather/awaiting-input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: a.id, name: a.name, kind: prompt.kind, question: prompt.question,
        }),
      }).catch(() => {});
    } catch {}
  }

  banner.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const choice = btn.dataset.choice;
    const id = banner.dataset.agent;
    const a = id ? agents.get(id) : null;
    if (!a) return;
    if (choice === 'zoom') {
      // "show me" — open the grid overlay (if not already) and zoom-1
      // into the requesting agent. Works from any /squad surface.
      if (!isOpen) open();
      setLayout({ mode: 'zoom1', primaries: [a.id] });
      focus(a.id);
      return;
    }
    try {
      const r = await fetch('/tool', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'approve_agent', arguments: { agent: a.id, choice } }),
      });
      const j = await r.json();
      if (j?.result?.ok || j?.ok) flash(`✓ ${choice} → ${a.name}`, 'ok');
      else flash(j?.result?.error || j?.error || 'approval failed', 'err');
    } catch (err) { flash(String(err?.message || err), 'err'); }
  });

  // ─── tile DOM ───────────────────────────────────────────────────────
  function tileEl(a) {
    const el = document.createElement('div');
    el.className = 'sg-tile sg-peek';
    el.dataset.agent = a.id;
    const initials = (a.name || '?').slice(0, 2);
    el.innerHTML = `
      <div class="sg-tile-head">
        <span class="sg-sigil" style="background:${a.color || 'rgba(227,117,83,0.95)'}">${escapeHtml(a.sigil || initials.toUpperCase())}</span>
        <span class="sg-tile-name">${escapeHtml(a.name || 'agent')}</span>
        <span class="sg-rt-tag" data-rt-tag data-rt="${a.runtime || 'claude'}">${a.runtime || 'claude'}</span>
        <span class="sg-await-badge" title="awaiting your input">?</span>
        <span class="sg-tile-status" data-status>idle</span>
        <span class="sg-tile-actions">
          <button data-action="close" class="sg-close-btn" title="close terminal (reap agent)">×</button>
        </span>
      </div>
      <div class="sg-tile-body">
        <div class="sg-xterm-wrap" data-xterm></div>
        <pre class="sg-peek-pre" data-peek><span data-peek-span></span></pre>
        <div class="sg-tile-empty" data-launch>
          <div>no terminal yet · click to launch</div>
        </div>
      </div>
    `;
    a._peekSpan = el.querySelector('[data-peek-span]');
    a._xtermHost = el.querySelector('[data-xterm]');

    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      if (el.classList.contains('sg-peek')) {
        focus(a.id);
        if (layout.mode === 'mosaic') setLayout({ mode: 'zoom1', primaries: [a.id] });
        else promoteToStage(a.id);
      } else {
        focus(a.id);
      }
    });

    el.querySelector('[data-launch]').addEventListener('click', (e) => {
      e.stopPropagation();
      focus(a.id);
      requestSpawn(a.id);
    });
    el.querySelector('[data-action="close"]').addEventListener('click', (e) => {
      e.stopPropagation(); closeAgent(a.id);
    });
    return el;
  }

  const tileRO = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const tile = entry.target.closest('.sg-tile');
      if (!tile) continue;
      const id = tile.dataset.agent;
      const a = agents.get(id);
      if (!a?.term) continue;
      try { a.fit?.fit(); } catch {}
      if (a.ws?.readyState === 1) {
        try { a.ws.send(JSON.stringify({ type: 'resize', cols: a.term.cols, rows: a.term.rows })); } catch {}
      }
    }
  });

  // ─── layout controller ─────────────────────────────────────────────
  function ensureTile(a) {
    if (!a._el) {
      a._el = tileEl(a);
      const body = a._el.querySelector('.sg-tile-body');
      if (body) tileRO.observe(body);
    }
    ensureStream(a);
  }

  function setLayout(next) {
    const mode = next?.mode || layout.mode;
    const cap = MODE_CAPACITY[mode] ?? 0;
    let primaries = (next?.primaries || []).slice(0, cap);
    if (mode !== 'mosaic') {
      const seen = new Set(primaries);
      const order = [];
      if (focusedId && agents.has(focusedId)) order.push(focusedId);
      for (const a of agents.values()) if (!order.includes(a.id)) order.push(a.id);
      for (const id of order) {
        if (primaries.length >= cap) break;
        if (!seen.has(id) && agents.has(id)) { primaries.push(id); seen.add(id); }
      }
      if (primaries.length === 0 && agents.size > 0) {
        layout.mode = 'mosaic'; layout.primaries = []; renderLayout(); return;
      }
    }
    layout.mode = mode;
    layout.primaries = primaries;
    if (mode !== 'mosaic') {
      if (!primaries.includes(focusedId)) focusedId = primaries[0] || null;
    }
    renderLayout();
  }

  function promoteToStage(id) {
    if (layout.mode === 'mosaic') { setLayout({ mode: 'zoom1', primaries: [id] }); return; }
    const cap = MODE_CAPACITY[layout.mode];
    const cur = layout.primaries.slice(0, cap);
    if (cur.includes(id)) { focus(id); return; }
    const evictId = cur.includes(focusedId) ? focusedId : cur[cur.length - 1];
    const swapped = cur.map((x) => (x === evictId ? id : x));
    setLayout({ mode: layout.mode, primaries: swapped });
    focus(id);
  }

  function renderLayout() {
    const list = [...agents.values()];
    const present = new Set(list.map((a) => a.id));
    for (const parent of [grid, sidebar]) {
      for (const child of [...parent.children]) {
        if (!present.has(child.dataset.agent)) child.remove();
      }
    }
    for (const a of list) ensureTile(a);

    const onStage = layout.mode === 'mosaic'
      ? list.map((a) => a.id)
      : layout.primaries.filter((id) => present.has(id));
    const onStageSet = new Set(onStage);
    const onSidebar = layout.mode === 'mosaic'
      ? []
      : list.map((a) => a.id).filter((id) => !onStageSet.has(id));

    placeTiles(grid, onStage);
    placeTiles(sidebar, onSidebar);

    for (const a of list) {
      const isStage = onStageSet.has(a.id);
      if (a._el) {
        a._el.classList.toggle('sg-stage', isStage);
        a._el.classList.toggle('sg-peek', !isStage);
        a._el.dataset.alive = a.alive ? '1' : '0';
        a._el.dataset.busy  = a.currentTask ? '1' : '0';
      }
      if (isStage) mountXterm(a);
      else dismountXterm(a);
      updateTileStatus(a.id);
    }

    root.dataset.mode = layout.mode;
    grid.dataset.count = String(layout.mode === 'mosaic'
      ? Math.min(list.length, 12)
      : onStage.length);

    stageEmpty.style.display = list.length === 0 ? 'grid' : 'none';

    if (!focusedId && list.length) focus(list[0].id);
    if (focusedId && !present.has(focusedId)) focus(list[0]?.id || null);

    refreshBanner();

    const targetFont = xtermFontFor(layout.mode);
    requestAnimationFrame(() => {
      for (const a of agents.values()) {
        if (!a.term) continue;
        try {
          if (a.term.options.fontSize !== targetFont) a.term.options.fontSize = targetFont;
        } catch {}
        try { a.fit?.fit(); } catch {}
        if (a.ws?.readyState === 1) {
          try { a.ws.send(JSON.stringify({ type: 'resize', cols: a.term.cols, rows: a.term.rows })); } catch {}
        }
      }
      for (const a of agents.values()) {
        if (a._peekSpan && a.stream) a._peekSpan.textContent = a.stream.tail();
      }
      pushFocusedView();
    });
  }

  function placeTiles(parent, ids) {
    let prev = null;
    for (const id of ids) {
      const a = agents.get(id);
      const el = a?._el;
      if (!el) continue;
      const expected = prev ? prev.nextSibling : parent.firstChild;
      if (el !== expected) parent.insertBefore(el, expected);
      prev = el;
    }
  }

  function updateTileStatus(id) {
    const a = agents.get(id);
    if (!a?._el) return;
    const sEl = a._el.querySelector('[data-status]');
    const launch = a._el.querySelector('[data-launch]');
    if (a.currentTask) {
      sEl.textContent = '◉ working';
      sEl.className = 'sg-tile-status sg-busy';
    } else if (a.alive) {
      sEl.textContent = '◌ live';
      sEl.className = 'sg-tile-status sg-alive';
    } else {
      sEl.textContent = '— offline';
      sEl.className = 'sg-tile-status';
    }
    if (launch) launch.style.display = a.alive ? 'none' : 'grid';
    a._el.dataset.alive = a.alive ? '1' : '0';
    a._el.dataset.busy  = a.currentTask ? '1' : '0';
  }

  function focus(id) {
    focusedId = id;
    for (const a of agents.values()) {
      if (!a._el) continue;
      a._el.classList.toggle('sg-focused', a.id === id);
    }
    const a = agents.get(id);
    if (a) try { a.term?.focus(); } catch {}
    pushFocusedView();
  }

  // ─── focused_agent push to /omo/ingest/view ────────────────────────
  function slimAgentForView(a) {
    if (!a) return null;
    return {
      agent_id: a.id,
      id: a.id,
      name: a.name || null,
      runtime: a.runtime || 'claude',
      alive: !!a.alive,
      busy: !!a.currentTask,
      status: a.currentTask ? 'working' : (a.alive ? 'live' : 'offline'),
      awaiting: a.awaiting ? { kind: a.awaiting.kind, question: a.awaiting.question } : null,
    };
  }

  let pushTimer = null;
  function pushFocusedView() {
    if (!isOpen) return; // only own the focus while overlay is visible
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const focused = focusedId ? agents.get(focusedId) : null;
      const waiting = awaitingList();
      const awaiting = (focused && focused.awaiting)
        ? focused
        : (waiting[0] || null);
      const staged = layout.mode === 'mosaic'
        ? []
        : layout.primaries.filter((id) => agents.has(id));
      const body = {
        page: 'squad_grid',
        layout: {
          mode: layout.mode,
          primaries: staged.map((id) => {
            const a = agents.get(id);
            return a ? { agent_id: a.id, name: a.name || null, runtime: a.runtime || 'claude' } : null;
          }).filter(Boolean),
        },
        focused_agent: slimAgentForView(focused),
        awaiting_agent: awaiting ? {
          ...slimAgentForView(awaiting),
          prompt_kind: awaiting.awaiting?.kind || null,
          question: awaiting.awaiting?.question || null,
        } : null,
        waiting_agents: waiting.map((a) => ({
          agent_id: a.id,
          name: a.name || null,
          runtime: a.runtime || 'claude',
          prompt_kind: a.awaiting?.kind || null,
          question: a.awaiting?.question || null,
        })),
        agents: [...agents.values()].map(slimAgentForView),
      };
      fetch('/omo/ingest/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    }, 80);
  }

  // ─── terminal wiring ───────────────────────────────────────────────
  // Each agent has at most ONE WebSocket to its PTY. Multiple xterm
  // consumers attach as listeners on `a.listeners` — the tile's xterm
  // (when on stage) AND any external xterms mounted via attachTerminalTo
  // (e.g. /squad's monitor @live tab). All share the same PeekStream
  // byte ring, so the peek tail + awaiting-input detection see every
  // byte regardless of how many xterms are rendering.
  //
  // Listener shape: { onBytes(bytes), onAttach(alive), onExit(code), onOpen() }
  //                 — any field optional.
  function ensureStream(a) {
    if (!a.stream) a.stream = new PeekStream();
    if (!a.listeners) a.listeners = new Set();
    if (a.ws) return;
    const wsBase = a.runtime === 'hermes' ? '/hermes-tty/ws/' : '/claude-tty/ws/';
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${wsBase}${encodeURIComponent(a.id)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    a.ws = ws;
    if (a._reconnectTimer) { clearTimeout(a._reconnectTimer); a._reconnectTimer = null; }

    ws.addEventListener('open', () => {
      a._reconnectAttempts = 0;
      for (const lis of a.listeners) { try { lis.onOpen?.(a); } catch {} }
    });

    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        let msg = null;
        try { msg = JSON.parse(e.data); } catch {}
        if (!msg) return;
        if (msg.type === 'claude_pty_attach') {
          a.alive = !!msg.alive;
          updateTileStatus(a.id);
          for (const lis of a.listeners) { try { lis.onAttach?.(a.alive); } catch {} }
        } else if (msg.type === 'claude_pty_exit') {
          a._ptyExited = true;
          a.alive = false;
          updateTileStatus(a.id);
          const tag = `\r\n\x1b[2;90m[session exited code=${msg.exit_code ?? '?'}]\x1b[0m\r\n`;
          const enc = new TextEncoder().encode(tag);
          a.stream.push(enc);
          for (const lis of a.listeners) {
            try { lis.onBytes?.(enc); } catch {}
            try { lis.onExit?.(msg.exit_code); } catch {}
          }
          schedulePeek(a.id);
        } else if (msg.type === 'claude_pty_error') {
          for (const lis of a.listeners) { try { lis.onError?.(msg.error); } catch {} }
          flash(msg.error || 'pty error', 'err');
        }
        return;
      }
      const bytes = new Uint8Array(e.data);
      a.stream.push(bytes);
      for (const lis of a.listeners) { try { lis.onBytes?.(bytes); } catch {} }
      schedulePeek(a.id);
    });

    ws.addEventListener('close', () => {
      a.ws = null;
      if (a._intentionalClose || a._ptyExited || !agents.has(a.id)) {
        a.alive = false;
        updateTileStatus(a.id);
        for (const lis of a.listeners) { try { lis.onAttach?.(false); } catch {} }
        return;
      }
      const attempt = (a._reconnectAttempts || 0) + 1;
      a._reconnectAttempts = attempt;
      const delay = Math.min(8000, 300 * Math.pow(1.6, Math.min(attempt - 1, 8)));
      a._reconnectTimer = setTimeout(() => {
        a._reconnectTimer = null;
        if (!agents.has(a.id) || a._intentionalClose || a._ptyExited) return;
        ensureStream(a);
      }, delay);
    });
  }

  // Shared xterm theme used by both tile xterms and external attachments
  // (see attachTerminalTo below).
  const TERM_THEME = {
    background: '#1d1b18',
    foreground: '#ece9e1',
    cursor: '#e37553',
    cursorAccent: '#1d1b18',
    selectionBackground: 'rgba(227, 117, 83, 0.35)',
    black: '#3b3833', red: '#e07b6c', green: '#9bb878', yellow: '#e0b46a',
    blue: '#8aa4c7', magenta: '#c08ab8', cyan: '#7eb7b0', white: '#ece9e1',
    brightBlack: '#5a5650', brightRed: '#ec9384', brightGreen: '#b4cf94',
    brightYellow: '#ecc88a', brightBlue: '#a3bcd9', brightMagenta: '#d0a4c9',
    brightCyan: '#9bcec7', brightWhite: '#f5f1e8',
  };

  function mountXterm(a) {
    if (a.term || !a._xtermHost) return;
    const fontSize = xtermFontFor(layout.mode);
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, SF Mono, ui-monospace, Menlo, Consolas, monospace',
      fontSize,
      lineHeight: 1.3,
      cursorBlink: true,
      convertEol: true,
      scrollback: 10000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(a._xtermHost);
    try { fit.fit(); } catch {}
    a.term = term;
    a.fit = fit;
    const replay = a.stream?.replay();
    if (replay?.length) { try { term.write(replay); } catch {} }
    const dataDispose = term.onData((data) => {
      if (a.ws?.readyState === 1) a.ws.send(new TextEncoder().encode(data));
    });
    // Always-scroll wheel handler (same rationale as attachTerminalTo —
    // override xterm's wheel-→-arrow-key alt-screen translation so the
    // user can review history even while a TUI like Claude Code is running).
    const onWheel = (ev) => {
      try {
        const dy = ev.deltaY;
        if (!dy) return;
        let lines;
        if (ev.deltaMode === 1) lines = dy;
        else if (ev.deltaMode === 2) lines = dy * (term.rows || 24);
        else {
          const cell = (term._core?._renderService?.dimensions?.css?.cell?.height)
            || (fontSize * 1.3);
          lines = dy / cell;
        }
        lines = lines >= 0 ? Math.max(1, Math.round(lines)) : Math.min(-1, Math.round(lines));
        term.scrollLines(lines);
      } catch {}
      ev.preventDefault();
      ev.stopPropagation();
    };
    a._xtermHost.addEventListener('wheel', onWheel, { capture: true, passive: false });
    a._wheelHandler = onWheel;
    // Register as a listener on the shared session — bytes that arrive after
    // mount get written to this xterm. The replay above covers everything
    // before mount.
    const listener = {
      onBytes: (bytes) => { try { term.write(bytes); } catch {} },
      onOpen: () => {
        try { a.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
      },
    };
    a.listeners.add(listener);
    a._tileListener = listener;
    a.disposeData = () => { try { dataDispose.dispose(); } catch {} };
    if (a.ws?.readyState === 1) {
      try { a.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
    }
  }

  function dismountXterm(a) {
    if (!a.term) return;
    if (a._tileListener) {
      a.listeners.delete(a._tileListener);
      a._tileListener = null;
    }
    if (a._wheelHandler && a._xtermHost) {
      try { a._xtermHost.removeEventListener('wheel', a._wheelHandler, { capture: true }); } catch {}
      a._wheelHandler = null;
    }
    try { a.disposeData?.(); } catch {}
    try { a.term.dispose(); } catch {}
    a.term = null; a.fit = null; a.disposeData = null;
  }

  function spawnPayloadFor(a) {
    const sid = a?.sessionId
      || a?.currentTask?.sessionId
      || a?.currentTask?.session_id
      || a?.lastTask?.sessionId
      || a?.lastTask?.session_id
      || null;
    const msg = { type: 'request_spawn' };
    if (sid) msg.resume_session_id = sid;
    if (sid || a?.lastTask) msg.continue_last = true;
    return msg;
  }

  function requestSpawn(id) {
    const a = agents.get(id); if (!a) return;
    a._intentionalClose = false;
    a._ptyExited = false;
    a._reconnectAttempts = 0;
    if (a._reconnectTimer) { clearTimeout(a._reconnectTimer); a._reconnectTimer = null; }
    const resuming = !!(a.stream && a.stream.replay && a.stream.replay()?.length) || !!a.term;
    const verb = resuming ? 'resuming' : 'launching';
    ensureStream(a);
    const fire = () => {
      try { a.ws.send(JSON.stringify(spawnPayloadFor(a))); flash(`${verb} ${a.name}…`); }
      catch (err) { flash(String(err?.message || err), 'err'); }
    };
    if (a.ws.readyState === 1) fire();
    else a.ws.addEventListener('open', fire, { once: true });
  }

  async function closeAgent(id) {
    const a = agents.get(id); if (!a) return;
    const busy = !!a.currentTask;
    if (busy && !confirm(`${a.name} is working — interrupt and close anyway?`)) return;
    a._intentionalClose = true;
    if (a._reconnectTimer) { clearTimeout(a._reconnectTimer); a._reconnectTimer = null; }
    try { a.ws?.close(); } catch {}
    try { a.term?.dispose(); } catch {}
    a.disposeData?.();
    a.term = null; a.fit = null; a.ws = null;
    try {
      const r = await fetch(`/omo/api/hermes/agents/${encodeURIComponent(id)}/reap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: busy }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || 'reap failed');
      agents.delete(id);
      if (focusedId === id) focusedId = null;
      const stillThere = layout.primaries.filter((x) => x !== id);
      setLayout({ mode: layout.mode, primaries: stillThere });
      flash(`✕ closed ${a.name}`, 'ok');
    } catch (err) {
      flash(String(err?.message || err), 'err');
      loadAgents();
    }
  }

  // ─── agent list / lifecycle ────────────────────────────────────────
  function upsertAgent(state) {
    let a = agents.get(state.agent_id);
    const rt = state.runtime === 'hermes' ? 'hermes' : (state.runtime === 'claude' ? 'claude' : null);
    if (!a) {
      a = {
        id: state.agent_id,
        name: state.name,
        color: state.color,
        sigil: state.sigil,
        listeners: new Set(),
        status: state.status || 'idle',
        runtime: rt || 'claude',
        currentTask: state.current_task || null,
        lastTask: state.last_task || null,
        sessionId: state.session_id || state.current_task?.sessionId || state.last_task?.sessionId || null,
        alive: !!state.alive,
      };
      agents.set(state.agent_id, a);
    } else {
      a.name = state.name || a.name;
      a.color = state.color || a.color;
      a.sigil = state.sigil || a.sigil;
      if (rt) a.runtime = rt;
      if ('current_task' in state) a.currentTask = state.current_task;
      if ('last_task' in state) a.lastTask = state.last_task;
      if (state.session_id || state.current_task?.sessionId || state.last_task?.sessionId) {
        a.sessionId = state.session_id || state.current_task?.sessionId || state.last_task?.sessionId;
      }
      if ('status' in state) a.status = state.status;
      if (a._el) {
        const nameEl = a._el.querySelector('.sg-tile-name');
        if (nameEl) nameEl.textContent = a.name;
        const rtEl = a._el.querySelector('[data-rt-tag]');
        if (rtEl) { rtEl.textContent = a.runtime; rtEl.dataset.rt = a.runtime; }
      }
    }
    return a;
  }

  async function loadAgents() {
    try {
      const r = await fetch('/omo/api/hermes/agents');
      const list = await r.json();
      if (!Array.isArray(list)) return;
      for (const s of list) upsertAgent(s);
      const serverIds = new Set(list.map((s) => s.agent_id));
      for (const a of [...agents.values()]) {
        if (serverIds.has(a.id)) continue;
        if (a.alive || a.currentTask) continue;
        a._intentionalClose = true;
        if (a._reconnectTimer) { clearTimeout(a._reconnectTimer); a._reconnectTimer = null; }
        try { a.ws?.close(); } catch {}
        try { a.term?.dispose(); } catch {}
        a.disposeData?.();
        agents.delete(a.id);
        if (focusedId === a.id) focusedId = null;
      }
      renderLayout();
      const [claudeStatus, hermesStatus] = await Promise.all([
        fetch('/omo/api/claude-pty/status').then((r) => r.json()).catch(() => null),
        fetch('/omo/api/hermes-pty/status').then((r) => r.json()).catch(() => null),
      ]);
      // PTY status corroborates `alive` but should NOT silently override
      // the server-resolved runtime. When both runtimes have a session
      // registered for the same agent_id (rare — happens if an agent was
      // briefly swapped between engines), the server's stateOf() answer is
      // authoritative; clobbering it from this poll mis-tags Claude agents
      // as Hermes (or vice versa). Only fall back to PTY-derived runtime
      // when the server didn't give us one.
      for (const a of agents.values()) {
        const claudeAlive = !!claudeStatus?.by_agent_id?.[a.id];
        const hermesAlive = !!hermesStatus?.by_agent_id?.[a.id];
        if (claudeAlive || hermesAlive) a.alive = true;
        if (!a.runtime) {
          if (claudeAlive && !hermesAlive) a.runtime = 'claude';
          else if (hermesAlive && !claudeAlive) a.runtime = 'hermes';
        }
      }
      for (const id of agents.keys()) updateTileStatus(id);
    } catch {
      flash('failed to load agents', 'err');
    }
  }

  // ─── live WSs ──────────────────────────────────────────────────────
  let hermesWS = null;
  function connectHermesWS() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/hermes/ws`;
    hermesWS = new WebSocket(url);
    hermesWS.addEventListener('message', (e) => {
      let msg = null; try { msg = JSON.parse(e.data); } catch {}
      if (!msg) return;
      switch (msg.type) {
        case 'hello': {
          if (Array.isArray(msg.agents)) {
            for (const s of msg.agents) upsertAgent(s);
            renderLayout();
          }
          break;
        }
        case 'agent_appear': {
          upsertAgent(msg);
          renderLayout();
          break;
        }
        case 'agent_state': {
          // Server pushes the full stateOf() snapshot when anything about
          // the agent changes (PTY start/stop, task start/complete, linger
          // extension). Keeping the tile in sync with this event is the
          // single source of truth for the runtime tag.
          if (msg.state) upsertAgent(msg.state);
          break;
        }
        case 'agent_leave': {
          const id = msg.agent_id;
          const a = agents.get(id);
          if (a) {
            a._intentionalClose = true;
            if (a._reconnectTimer) { clearTimeout(a._reconnectTimer); a._reconnectTimer = null; }
            try { a.ws?.close(); } catch {}
            try { a.term?.dispose(); } catch {}
            a.disposeData?.();
            agents.delete(id);
            if (focusedId === id) focusedId = null;
            const stillThere = layout.primaries.filter((x) => x !== id);
            setLayout({ mode: layout.mode, primaries: stillThere });
          }
          break;
        }
        case 'task_start': {
          const a = agents.get(msg.agent_id);
          if (a) {
            a.currentTask = msg.task || { id: msg.task_id, prompt: msg.prompt, runtime: msg.runtime || null };
            // Re-tag the tile to match the runtime of the task that just
            // started. An agent can flip engines between tasks (claude →
            // hermes or vice versa), and the runtime tag is most useful
            // when it tracks the *current* engine, not the most recently
            // captured PTY.
            const rt = msg.runtime === 'hermes' ? 'hermes' : (msg.runtime === 'claude' ? 'claude' : null);
            if (rt && rt !== a.runtime) {
              a.runtime = rt;
              if (a._el) {
                const rtEl = a._el.querySelector('[data-rt-tag]');
                if (rtEl) { rtEl.textContent = rt; rtEl.dataset.rt = rt; }
              }
            }
            updateTileStatus(a.id);
          }
          break;
        }
        case 'task_complete':
        case 'task_error': {
          const a = agents.get(msg.agent_id);
          if (a) {
            a.currentTask = null;
            a.lastTask = msg.task || a.lastTask;
            updateTileStatus(a.id);
          }
          break;
        }
      }
    });
    hermesWS.addEventListener('close', () => setTimeout(connectHermesWS, 1500));
  }

  // ─── voice bridge: zoom into agent by voice ─────────────────────────
  // Listens on /omo/ws for source='feather' OR 'squad_grid' events. Backward
  // compatibility: feather_focus voice tool still emits source='feather',
  // and we accept that here so existing voice commands keep working.
  let omoWS = null;
  const omoWSBootTs = Date.now();
  function connectOmoWS() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/omo/ws`;
    omoWS = new WebSocket(url);
    omoWS.addEventListener('message', (e) => {
      let msg = null; try { msg = JSON.parse(e.data); } catch {}
      if (!msg) return;
      const isSnapshot = msg.type === 'snapshot';
      const events = isSnapshot && Array.isArray(msg.events) ? msg.events
                   : msg.type === 'event' && msg.event ? [msg.event]
                   : (msg.source ? [msg] : []);
      for (const ev of events) {
        if (ev?.source !== 'feather' && ev?.source !== 'squad_grid') continue;
        if (isSnapshot && ev.ts && ev.ts < omoWSBootTs) continue;
        // Voice nav can SUMMON the overlay: any focus event ("zoom into
        // Atlas", "show me everyone") opens the grid even if the user is
        // on /squad's hologram view. Close/back actions are no-ops when
        // the overlay is already closed.
        const data = ev?.data || {};
        const isClose = ev?.kind === 'action' && /^(close|back|exit|out|dismiss)$/i.test(String(data.action || ''));
        if (!isOpen) {
          if (ev?.kind === 'focus') open();
          else if (isClose) continue; // already closed
          else continue; // nothing to do
        }
        if (ev?.kind === 'focus') applyVoiceFocus(data);
        else if (ev?.kind === 'action') applyVoiceAction(data);
      }
    });
    omoWS.addEventListener('close', () => setTimeout(connectOmoWS, 1500));
  }

  function applyVoiceFocus(data) {
    const mode = data?.mode || 'mosaic';
    const ids = Array.isArray(data?.agents) ? data.agents : [];
    // Voice "zoom out / mosaic / 缩回去" cascades like the Escape key:
    // zoom1/2/4 → mosaic → close. When the user re-asks for mosaic while
    // already in mosaic, they mean "leave the grid entirely" — same as
    // saying "exit / back / out". Mirrors the keydown handler below so
    // the cascade is consistent across voice, text, and keyboard.
    if (mode === 'mosaic' && layout.mode === 'mosaic') {
      goBack();
      return;
    }
    setLayout({ mode, primaries: ids });
    if (ids[0]) focus(ids[0]);
    const names = Array.isArray(data?.names) && data.names.length
      ? data.names
      : ids.map((id) => agents.get(id)?.name).filter(Boolean);
    if (mode === 'mosaic') flash('mosaic · all agents', 'ok');
    else if (names.length) flash(`zoom · ${names.join(' + ')}`, 'ok');
    for (const id of ids) {
      const el = agents.get(id)?._el;
      if (!el) continue;
      el.classList.remove('sg-voice-pulse');
      void el.offsetWidth;
      el.classList.add('sg-voice-pulse');
      setTimeout(() => el.classList.remove('sg-voice-pulse'), 700);
    }
  }

  async function applyVoiceAction(data) {
    const action = String(data?.action || '').toLowerCase();
    if (action === 'reconcile') { loadAgents(); return; }
    // "exit / close / back / out / dismiss" — close the overlay in ONE
    // step from any state. The squad page behind reappears immediately.
    // For "zoom out / back to grid" use feather_focus({mode:'mosaic'}).
    if (action === 'close' || action === 'back' || action === 'exit'
        || action === 'out' || action === 'dismiss') {
      goBack();
      return;
    }
  }

  // One-shot exit. Closes the overlay regardless of layout mode, so the
  // squad page (hologram + sprites + monitor) appears immediately. Idempotent.
  function goBack() {
    if (!isOpen) return;
    close();
  }

  // ─── keyboard ──────────────────────────────────────────────────────
  function isTypingTarget(t) {
    if (!t) return false;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
    if (t.isContentEditable) return true;
    return false;
  }
  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      if (layout.mode !== 'mosaic') {
        e.preventDefault();
        setLayout({ mode: 'mosaic' });
        return;
      }
      e.preventDefault();
      close();
      return;
    }
    if (isTypingTarget(e.target)) return;
    // Digit shortcuts (⌘1/⌘2/⌘4/⌘0 layout + plain 1-9 zoom-into-Nth) used
    // to live here. Removed — voice handles layout switching (feather_focus)
    // and the digits collide with normal terminal usage anyway.
    if ((e.key === '[' || e.key === ']') && !e.metaKey && !e.ctrlKey) {
      const list = [...agents.values()];
      if (list.length === 0) return;
      e.preventDefault();
      const cur = list.findIndex((a) => a.id === focusedId);
      const next = list[(cur + (e.key === ']' ? 1 : -1) + list.length) % list.length];
      if (layout.mode === 'mosaic') focus(next.id);
      else if (layout.primaries.includes(next.id)) focus(next.id);
      else promoteToStage(next.id);
    }
  });

  // window resize → refit
  let winResizeTimer = null;
  window.addEventListener('resize', () => {
    if (!isOpen) return;
    clearTimeout(winResizeTimer);
    winResizeTimer = setTimeout(() => {
      for (const a of agents.values()) {
        if (!a.term) continue;
        try { a.fit?.fit(); } catch {}
        if (a.ws?.readyState === 1) {
          try { a.ws.send(JSON.stringify({ type: 'resize', cols: a.term.cols, rows: a.term.rows })); } catch {}
        }
      }
    }, 120);
  });

  // ─── external xterm attachment ─────────────────────────────────────
  // Attach an xterm in any host element to an agent's shared session.
  // Used by /squad's monitor .mon-multiterm to mount its single-agent
  // terminal on the same WS+PeekStream as the grid's tile xterm.
  //
  //   const h = grid.attachTerminalTo({ host, agentId, runtime: 'claude', autoSpawn: true });
  //   h.detach();        // dispose this xterm; session stays alive for the tile
  //   h.fit();           // re-fit on container size change
  //   h.requestSpawn();  // start a fresh CLI if PTY isn't alive
  //   h.focus();         // focus this xterm
  //
  // Multiple xterms can attach to the same agent concurrently; each gets
  // every byte. The session's WebSocket is reference-counted by the union
  // of (tile xterm presence) + (external attachments) — it stays open as
  // long as anyone is interested.
  function attachTerminalTo({ host, agentId, runtime, sessionId = null, autoSpawn = false, fontSize = 13, scrollback = 10000 }) {
    if (!host || !agentId) return null;
    // Auto-upsert a stub if the grid hasn't loaded this agent yet. The
    // real metadata lands in via /omo/api/hermes/agents on next refresh.
    let a = agents.get(agentId);
    if (!a) {
      upsertAgent({ agent_id: agentId, name: agentId, runtime: runtime || 'claude' });
      a = agents.get(agentId);
    } else if (runtime && a.runtime !== runtime) {
      a.runtime = runtime;
    }
    if (sessionId) a.sessionId = sessionId;
    ensureStream(a);

    // Clear host + create xterm.
    host.innerHTML = '';
    const term = new Terminal({
      fontFamily: 'JetBrains Mono, SF Mono, ui-monospace, Menlo, Consolas, monospace',
      fontSize, lineHeight: 1.3, cursorBlink: true,
      convertEol: true, scrollback,
      allowProposedApi: true, macOptionIsMeta: true,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch {}

    // Replay the byte ring so the new xterm comes up populated.
    const replay = a.stream?.replay();
    if (replay?.length) { try { term.write(replay); } catch {} }

    // xterm input → ws
    const enc = new TextEncoder();
    const dataDispose = term.onData((data) => {
      if (a.ws?.readyState === 1) a.ws.send(enc.encode(data));
    });

    // Register as a listener so live bytes after mount get written too.
    let armedAutoSpawn = !!autoSpawn;
    const listener = {
      onOpen: () => {
        try { a.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
      },
      onBytes: (bytes) => {
        let wasAtBottom = true;
        try { const b = term.buffer.active; wasAtBottom = b.viewportY >= b.baseY; } catch {}
        try { term.write(bytes); } catch {}
        if (wasAtBottom) { try { term.scrollToBottom(); } catch {} }
      },
      onAttach: (alive) => {
        if (alive) armedAutoSpawn = false;
        else if (armedAutoSpawn && a.ws?.readyState === 1) {
          armedAutoSpawn = false;
          try { a.ws.send(JSON.stringify(spawnPayloadFor(a))); } catch {}
        }
      },
    };
    a.listeners.add(listener);

    // Initial geometry (if WS already open).
    if (a.ws?.readyState === 1) {
      try { a.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
    }
    // Auto-spawn now if requested + session not alive + WS open.
    if (armedAutoSpawn && a.ws?.readyState === 1 && !a.alive) {
      armedAutoSpawn = false;
      try { a.ws.send(JSON.stringify(spawnPayloadFor(a))); } catch {}
    }

    // ResizeObserver — refit + tell PTY when the host changes size.
    let resizeObs = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => {
        let wasAtBottom = true;
        try { const b = term.buffer.active; wasAtBottom = b.viewportY >= b.baseY; } catch {}
        try { fit.fit(); } catch {}
        if (a.ws?.readyState === 1) {
          try { a.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
        }
        if (wasAtBottom) { try { term.scrollToBottom(); } catch {} }
      });
      resizeObs.observe(host);
    }

    setTimeout(() => { try { term.focus(); } catch {} }, 30);

    // Always-scroll wheel handler — xterm normally translates wheel into
    // arrow keys when a TUI is in alt-screen (Claude Code, vim, etc.), so
    // the user can't review history. Capture-phase listener calls
    // term.scrollLines() directly so the trackpad/mouse-wheel always pages
    // the scrollback buffer regardless of screen mode.
    const onWheel = (ev) => {
      try {
        const dy = ev.deltaY;
        if (!dy) return;
        // deltaMode: 0 = pixel, 1 = line, 2 = page
        let lines;
        if (ev.deltaMode === 1) lines = dy;
        else if (ev.deltaMode === 2) lines = dy * (term.rows || 24);
        else {
          // pixels → lines via measured cell height (fallback to fontSize*1.3)
          const cell = (term._core?._renderService?.dimensions?.css?.cell?.height)
            || (fontSize * 1.3);
          lines = dy / cell;
        }
        // Round away from zero so tiny trackpad nudges still register.
        lines = lines >= 0 ? Math.max(1, Math.round(lines)) : Math.min(-1, Math.round(lines));
        term.scrollLines(lines);
      } catch {}
      ev.preventDefault();
      ev.stopPropagation();
    };
    host.addEventListener('wheel', onWheel, { capture: true, passive: false });

    return {
      detach() {
        a.listeners?.delete(listener);
        try { host.removeEventListener('wheel', onWheel, { capture: true }); } catch {}
        try { dataDispose.dispose(); } catch {}
        try { term.dispose(); } catch {}
        try { resizeObs?.disconnect(); } catch {}
        host.innerHTML = '';
      },
      fit() { try { fit.fit(); } catch {} },
      focus() { try { term.focus(); } catch {} },
      requestSpawn() {
        armedAutoSpawn = true;
        ensureStream(a);
        const fire = () => {
          try { a.ws.send(JSON.stringify(spawnPayloadFor(a))); armedAutoSpawn = false; } catch {}
        };
        if (a.ws?.readyState === 1) fire();
        else a.ws?.addEventListener('open', fire, { once: true });
      },
      getSession() { return a; },
      isAlive() { return !!a.alive; },
    };
  }

  // ─── public API ────────────────────────────────────────────────────
  // Tell the rest of the page that open-state changed. /squad's topbar
  // listens to keep aria-pressed in sync when voice auto-opens.
  function fireOpenState() {
    try { window.dispatchEvent(new CustomEvent('omo:grid-state', { detail: { open: isOpen } })); } catch {}
  }
  function open() {
    if (isOpen) return;
    isOpen = true;
    root.classList.add('sg-open');
    // Sessions are already booted in the eager-boot step below; just catch
    // up the agent list (server may have spawned/reaped while we were hidden).
    loadAgents();
    // Refit after CSS transitions settle.
    setTimeout(() => {
      for (const a of agents.values()) {
        if (!a.term) continue;
        try { a.fit?.fit(); } catch {}
      }
    }, 60);
    pushFocusedView();
    fireOpenState();
    try { opts.onOpen?.(); } catch {}
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('sg-open');
    // Don't kill WSs — keep streams alive so re-open is instant AND so the
    // monitor's external xterm attachments keep working. Clear our
    // focused_agent push so /squad's monitor regains control of voice routing.
    try {
      navigator.sendBeacon?.('/omo/ingest/view', new Blob([JSON.stringify({ clear: true })], { type: 'application/json' }));
    } catch {}
    fireOpenState();
    try { opts.onClose?.(); } catch {}
  }
  function toggle() { if (isOpen) close(); else open(); }

  // Eager boot — connect WSs on module mount so the monitor's external
  // attachTerminalTo callers can read live bytes even before the user
  // opens the grid overlay for the first time. /omo/api/hermes/agents +
  // /hermes/ws + /omo/ws are all cheap.
  loadAgents();
  connectHermesWS();
  connectOmoWS();

  window.addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon?.('/omo/ingest/view', new Blob([JSON.stringify({ clear: true })], { type: 'application/json' }));
    } catch {}
  });

  // Resolve an external ref (agent_id, exact name, or name prefix) to a
  // live agent_id. Returns null if no match. Used by focusAgent so voice
  // (which often passes the callsign) and deep-links (?focus=Atlas) work.
  function resolveAgentRef(ref) {
    const r = String(ref || '').trim();
    if (!r) return null;
    if (agents.has(r)) return r;
    const lower = r.toLowerCase();
    for (const a of agents.values()) {
      if ((a.name || '').toLowerCase() === lower) return a.id;
    }
    for (const a of agents.values()) {
      if ((a.name || '').toLowerCase().startsWith(lower)) return a.id;
    }
    return null;
  }
  _instance = {
    open, close, toggle, goBack,
    isOpen: () => isOpen,
    mode: () => layout.mode,
    focusAgent: (ref) => {
      const id = resolveAgentRef(ref);
      if (!id) return false;
      setLayout({ mode: 'zoom1', primaries: [id] });
      focus(id);
      return true;
    },
    setLayout: (mode, primaries) => setLayout({ mode, primaries }),
    refresh: () => loadAgents(),
    attachTerminalTo,
    _root: root,
  };
  // Stable global hook for non-module consumers (e.g. /squad's inline
  // monitor script). The module guarantees a single instance.
  try { window.squadGrid = _instance; } catch {}
  return _instance;
}

// Static denylist + CDN allowlist. Defence-in-depth: the iframe is also
// sandboxed and carries a CSP — this layer exists so rejected output
// triggers a retry with feedback rather than silently rendering a broken
// or unsafe chart.

import { ALLOWED_SCRIPT_HOSTS } from './theme.js';

const FORBIDDEN_PATTERNS = [
  { re: /\bfetch\s*\(/,                    reason: 'fetch() is not allowed' },
  { re: /\bXMLHttpRequest\b/,              reason: 'XMLHttpRequest is not allowed' },
  { re: /\bWebSocket\b/,                   reason: 'WebSocket is not allowed' },
  { re: /\beval\s*\(/,                     reason: 'eval() is not allowed' },
  { re: /\bnew\s+Function\b/,              reason: 'new Function() is not allowed' },
  { re: /\bimport\s*\(/,                   reason: 'dynamic import() is not allowed' },
  { re: /\blocalStorage\b/,                reason: 'localStorage is not allowed' },
  { re: /\bsessionStorage\b/,              reason: 'sessionStorage is not allowed' },
  { re: /\bdocument\.cookie\b/,            reason: 'document.cookie is not allowed' },
  { re: /\b(window|self|globalThis)\.(parent|top)\b/, reason: 'cross-frame references are not allowed' },
  { re: /\bnavigator\.sendBeacon\b/,       reason: 'sendBeacon is not allowed' },
  { re: /\s(on\w+)\s*=\s*["'][^"']*["']/i, reason: 'inline event handlers are not allowed' },
  { re: /<\s*(html|head|body)\b/i,         reason: 'do not include <html>, <head>, or <body> tags' },
  { re: /<\s*(iframe|object|embed)\b/i,    reason: 'nested iframes/objects are not allowed' },
];

function checkExternalRef(html, tagRe, kind) {
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    try {
      const url = new URL(m[1], 'https://x.invalid');
      if (url.protocol !== 'https:' && url.protocol !== 'data:') continue;
      if (!ALLOWED_SCRIPT_HOSTS.includes(url.hostname)) {
        return `external ${kind} "${url.hostname}" not on allowlist`;
      }
    } catch {
      return `invalid ${kind} src "${m[1]}"`;
    }
  }
  return null;
}

export function sanitise(html) {
  if (typeof html !== 'string') return { ok: false, reason: 'output is not a string' };
  if (html.length > 120_000) return { ok: false, reason: `output too large (${html.length} bytes)` };
  if (html.length < 40) return { ok: false, reason: 'output suspiciously short' };

  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    const m = html.match(re);
    if (m) return { ok: false, reason: `${reason} — found "${m[0]}"` };
  }

  const scriptErr = checkExternalRef(html, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, 'script');
  if (scriptErr) return { ok: false, reason: scriptErr };

  const linkErr = checkExternalRef(html, /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, 'stylesheet');
  if (linkErr) return { ok: false, reason: linkErr };

  return { ok: true };
}

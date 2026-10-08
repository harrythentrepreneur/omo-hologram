import { randomBytes } from 'node:crypto';

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function mintId(prefix) {
  return `${prefix}_${randomBytes(6).toString('base64url')}`;
}

// Compact structural description of a value — used by the kitchen to
// describe dataset shapes to the generator without leaking numbers.
export function shapeOf(v, depth = 0) {
  if (depth > 3) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `${shapeOf(v[0], depth + 1)}[](${v.length})`;
  }
  if (typeof v === 'object') {
    return `{${Object.entries(v).map(([k, val]) => `${k}:${shapeOf(val, depth + 1)}`).join(', ')}}`;
  }
  return typeof v;
}

// Lightweight preview of a value for the generator: first N items of
// any array, recursively. Strings are clipped, numbers passed through,
// nested arrays trimmed. Numbers ARE included on purpose — the model
// reads __DATA[id] at runtime, but seeing 1-2 sample values in the
// prompt is the difference between "I dunno what this dataset is" and
// "ah, it's pence, sort by value desc". Cap depth to avoid blow-ups.
export function previewOf(v, { sampleCount = 3, depth = 0, maxStr = 80 } = {}) {
  if (depth > 4) return '…';
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') return v.length > maxStr ? v.slice(0, maxStr) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const head = v.slice(0, sampleCount).map((x) => previewOf(x, { sampleCount, depth: depth + 1, maxStr }));
    return v.length > sampleCount ? [...head, `…+${v.length - sampleCount}`] : head;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = previewOf(val, { sampleCount, depth: depth + 1, maxStr });
    }
    return out;
  }
  return typeof v;
}

// Safe inline-<script> JSON embedding. Escapes sequences that would
// otherwise close the script tag, start an HTML comment, or break the
// JS string literal (U+2028 / U+2029 are valid in JSON but not in ES5
// source strings).
const LINE_SEP_RE = new RegExp('[\\u2028\\u2029]', 'g');
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(LINE_SEP_RE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

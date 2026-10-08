// google_doc_card — a hologram-native preview of a Google Doc Momo just
// created, appended to, or read back. Data-light: title, excerpt, char
// count, and a prominent "OPEN IN DRIVE" chip with the doc URL.
//
// Data shape (returned by src/tools/google_docs.js via datasets.put):
//   {
//     docId:   "1AbC..."          // Google Docs document id
//     title:   "Weekly Review"
//     url:     "https://docs.google.com/document/d/<id>/edit"
//     text:    "optional full doc plaintext for read / excerpt for create"
//     action:  "created" | "appended" | "read"   // optional kicker hint
//   }
//
// Pure text card — no ECharts. Rendered server-side into the standard
// iframe shell so it inherits the cyan halo + scanning glow.

import { escapeHtml, titleText, emptyStateBody } from './shared.js';
import { cardHeaderHTML, tagHTML, iconHTML } from './primitives.js';

const EXCERPT_CAP = 320;
const TITLE_FALLBACK = 'UNTITLED DOC';

function formatAction(raw) {
  const a = String(raw || 'opened').toLowerCase();
  if (a === 'created') return 'CREATED';
  if (a === 'appended') return 'UPDATED';
  if (a === 'read' || a === 'opened') return 'OPENED';
  return a.toUpperCase();
}

function wordCount(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  return s.split(/\s+/).length;
}

function truncate(s, n) {
  const str = String(s || '').trim().replace(/\s+/g, ' ');
  if (str.length <= n) return str;
  return str.slice(0, n - 1).trim() + '…';
}

function coerceDoc(data) {
  if (!data) return null;
  const title = String(data.title || '').trim();
  const url = String(data.url || '').trim();
  const docId = String(data.docId || data.doc_id || '').trim();
  if (!title && !url && !docId) return null;

  return {
    title: title || TITLE_FALLBACK,
    url: url || (docId ? `https://docs.google.com/document/d/${docId}/edit` : ''),
    docId,
    text: String(data.text || data.content || '').trim(),
    action: formatAction(data.action),
  };
}

export function googleDocCardTemplate({ dataset, intent }) {
  const doc = coerceDoc(dataset?.data);
  if (!doc) {
    return {
      body: emptyStateBody(intent, 'Need a Google Doc with a title or id.'),
      exposedData: {},
      needsEcharts: false,
    };
  }

  const title = titleText(doc.title, TITLE_FALLBACK);
  const kicker = `GOOGLE DOC · ${doc.action}`;
  const rightChip = tagHTML({ label: 'LIVE', tone: 'cyan' });

  const chars = doc.text.length;
  const words = wordCount(doc.text);
  const metaBits = [];
  if (words)  metaBits.push(`${words.toLocaleString()} WORDS`);
  if (chars)  metaBits.push(`${chars.toLocaleString()} CHARS`);
  if (!chars && !words) metaBits.push('EMPTY · SEEDING');
  const metaRow = `<div class="holo-doc-meta">${metaBits.map((b) => `<span>${escapeHtml(b)}</span>`).join('<span class="holo-doc-meta-dot">·</span>')}</div>`;

  const excerpt = doc.text
    ? `<div class="holo-doc-excerpt">${escapeHtml(truncate(doc.text, EXCERPT_CAP))}</div>`
    : `<div class="holo-doc-excerpt holo-doc-excerpt--empty">Fresh doc, still warm~ 正在起草…</div>`;

  // Non-interactive chip — the tool return already triggers a pane mount
  // (window.__holoPane.mount({ url: '/doc/<id>', ... })) so clicking this
  // would be redundant. Kept as a status label so the user sees where the
  // full-stage view points.
  const openChip = `<span class="holo-doc-open holo-doc-open--static">
       <span class="holo-doc-open-label">OPEN IN STAGE</span>
       <span class="holo-doc-open-arrow">↗</span>
     </span>`;

  const docIdChip = doc.docId
    ? `<div class="holo-doc-id">${iconHTML({ name: 'hashtag', inline: true })}<span>${escapeHtml(doc.docId.slice(0, 12))}…</span></div>`
    : '';

  const body = `<div id="viz">
  <style>
    .holo-doc-title {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.15;
      letter-spacing: 0.005em;
      background: linear-gradient(180deg, #ffffff 0%, #6ff2ff 72%, #00e5ff 100%);
      -webkit-background-clip: text; background-clip: text; color: transparent;
      text-shadow: 0 0 14px rgba(0, 229, 255, 0.28);
      margin-top: 2px;
    }
    .holo-doc-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.22em;
      color: rgba(0, 229, 255, 0.7);
      text-transform: uppercase;
    }
    .holo-doc-meta-dot { opacity: 0.4; }

    .holo-doc-excerpt {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      font-size: 13px;
      line-height: 1.55;
      color: rgba(231, 247, 255, 0.92);
      letter-spacing: 0.005em;
      padding: 14px 16px;
      border-left: 1px solid rgba(0, 229, 255, 0.32);
      background: linear-gradient(
        90deg,
        rgba(0, 229, 255, 0.06) 0%,
        rgba(0, 229, 255, 0.015) 40%,
        transparent 100%
      );
    }
    .holo-doc-excerpt::before {
      content: '';
      position: absolute;
      left: -1px; top: 0; bottom: 0;
      width: 1px;
      background: linear-gradient(
        180deg,
        transparent 0%,
        rgba(0, 229, 255, 0.8) 50%,
        transparent 100%
      );
      animation: holo-doc-scan 3.2s ease-in-out infinite;
    }
    @keyframes holo-doc-scan {
      0%   { transform: translateY(-100%); opacity: 0; }
      20%  { opacity: 1; }
      80%  { opacity: 1; }
      100% { transform: translateY(100%); opacity: 0; }
    }
    .holo-doc-excerpt--empty {
      font-style: italic;
      color: rgba(0, 229, 255, 0.58);
      border-left-color: rgba(0, 229, 255, 0.18);
    }

    .holo-doc-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .holo-doc-id {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 10px;
      letter-spacing: 0.12em;
      color: rgba(0, 229, 255, 0.55);
    }

    .holo-doc-open {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border: 1px solid rgba(0, 229, 255, 0.55);
      background: linear-gradient(
        180deg,
        rgba(0, 229, 255, 0.18) 0%,
        rgba(0, 229, 255, 0.06) 100%
      );
      border-radius: 2px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 11px;
      letter-spacing: 0.18em;
      color: #e7f7ff;
      text-decoration: none;
      text-transform: uppercase;
      transition: all 0.18s ease;
      box-shadow:
        0 0 12px rgba(0, 229, 255, 0.22),
        inset 0 0 10px rgba(0, 229, 255, 0.10);
    }
    .holo-doc-open:hover {
      border-color: rgba(0, 229, 255, 0.85);
      background: linear-gradient(
        180deg,
        rgba(0, 229, 255, 0.28) 0%,
        rgba(0, 229, 255, 0.10) 100%
      );
      box-shadow:
        0 0 18px rgba(0, 229, 255, 0.45),
        inset 0 0 14px rgba(0, 229, 255, 0.18);
    }
    .holo-doc-open--static {
      cursor: default;
      animation: holo-doc-open-pulse 2.4s ease-in-out infinite;
    }
    @keyframes holo-doc-open-pulse {
      0%,100% { box-shadow: 0 0 12px rgba(0, 229, 255, 0.22), inset 0 0 10px rgba(0, 229, 255, 0.10); }
      50%     { box-shadow: 0 0 18px rgba(0, 229, 255, 0.45), inset 0 0 14px rgba(0, 229, 255, 0.18); }
    }
    .holo-doc-open-arrow {
      font-size: 13px;
      line-height: 1;
      opacity: 0.9;
    }
  </style>
  <div class="holo-stack holo-stack--md" style="height:100%;">
    ${cardHeaderHTML({ title: '', kicker, right: rightChip })}
    <div class="holo-doc-title">${escapeHtml(title)}</div>
    ${metaRow}
    ${excerpt}
    <div class="holo-doc-footer">
      ${docIdChip}
      ${openChip}
    </div>
  </div>
  <script>
  (function(){
    try { window.__READY && window.__READY(); }
    catch (e) { window.__FAIL && window.__FAIL('google_doc_card: ' + (e && e.message || e)); }
  })();
  </script>
</div>`;

  return { body, exposedData: {}, needsEcharts: false };
}

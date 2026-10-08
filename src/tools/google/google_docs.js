// Google Docs tools — Momo creates, appends to, and reads Google Docs
// through the user's OAuth session. Each tool returns a `pane` hint so
// the hologram auto-opens the doc inside the stage (see pane-layer.js +
// the result.pane handler in holo_cylinder.html).
//
// Deliberately minimal: no extra projections, no extra reads — the
// pane's iframe of docs.google.com/preview is the presentation.

import * as docsConnector from '../../connectors/google_docs.js';
import * as datasets from '../../store/datasets.js';
import { hasRefreshToken } from '../../connectors/google.js';

// Pane hint the cylinder auto-mounts after the tool returns. Internal URL
// (/doc/<id>) is the security boundary — pane-layer.js refuses anything
// that doesn't start with "/". Title rides as a query param so the pane
// page doesn't need a separate /meta round-trip to render its header.
function buildPaneHint({ docId, title }) {
  if (!docId) return null;
  const cleanTitle = String(title || '').trim().slice(0, 120);
  const q = cleanTitle ? `?title=${encodeURIComponent(cleanTitle)}` : '';
  return {
    url: `/doc/${encodeURIComponent(docId)}${q}`,
    title: `DOC // ${(cleanTitle || 'UNTITLED').toUpperCase()}`,
    page: 'doc',
  };
}

const NOT_CONNECTED = {
  error: 'Google not connected. Visit http://localhost:8080/auth/google/start to authorize (needs the new Docs write scope).',
};

// ───────────────────────── create_google_doc ─────────────────────────

export const createDefinition = {
  type: 'function',
  name: 'create_google_doc',
  description:
    "Create a new Google Doc in the user's Drive. Title is required; content is optional plain text seeded into the body. Returns the new doc id and a shareable URL. Use this when the user asks to draft, summarize, or capture something in a Doc.",
  parameters: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Doc title. Keep concise — shows up in Drive.' },
      content: { type: 'string', description: 'Optional plain-text body to seed the doc with. UTF-8 supported. Use \\n for line breaks.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export async function runCreate(args = {}) {
  if (!hasRefreshToken()) return NOT_CONNECTED;
  try {
    const result = await docsConnector.createDoc({
      title: args.title,
      content: args.content,
    });
    const id = datasets.put('google_doc', {
      docId: result.docId,
      title: result.title,
      url: result.url,
      text: args.content ? String(args.content) : '',
      action: 'created',
    });
    return {
      id,
      doc_id: result.docId,
      title: result.title,
      url: result.url,
      wrote_chars: result.wrote,
      pane: buildPaneHint({ docId: result.docId, title: result.title }),
      summary: `created "${result.title}" · ${result.wrote} chars · pane opening`,
    };
  } catch (err) {
    return { error: `create_google_doc failed: ${err?.message || err}` };
  }
}

// ───────────────────────── append_to_google_doc ─────────────────────────

export const appendDefinition = {
  type: 'function',
  name: 'append_to_google_doc',
  description:
    "Append plain text to the end of an existing Google Doc. Requires the doc_id (from a prior create_google_doc call or read_google_doc lookup). Inserts a leading newline so appends don't merge with the previous line.",
  parameters: {
    type: 'object',
    properties: {
      doc_id:  { type: 'string', description: 'Google Docs document id.' },
      content: { type: 'string', description: 'Plain-text content to append. UTF-8 supported.' },
    },
    required: ['doc_id', 'content'],
    additionalProperties: false,
  },
};

export async function runAppend(args = {}) {
  if (!hasRefreshToken()) return NOT_CONNECTED;
  try {
    const result = await docsConnector.appendToDoc(args.doc_id, args.content);
    const id = datasets.put('google_doc', {
      docId: result.docId,
      url: result.url,
      text: String(args.content || ''),
      action: 'appended',
    });
    return {
      id,
      doc_id: result.docId,
      url: result.url,
      appended_chars: result.appended,
      // No title lookup — pane will render UNTITLED header until the
      // Docs preview iframe loads its own chrome. Keeps append fast.
      pane: buildPaneHint({ docId: result.docId }),
      summary: `appended ${result.appended} chars to doc ${result.docId.slice(0, 8)}… · pane opening`,
    };
  } catch (err) {
    return { error: `append_to_google_doc failed: ${err?.message || err}` };
  }
}

// ───────────────────────── read_google_doc ─────────────────────────

export const readDefinition = {
  type: 'function',
  name: 'read_google_doc',
  description:
    'Fetch the plain-text body of a Google Doc by id. Returns a dataset id (so the model can quote from it) and auto-opens the doc in the hologram pane.',
  parameters: {
    type: 'object',
    properties: {
      doc_id: { type: 'string', description: 'Google Docs document id.' },
    },
    required: ['doc_id'],
    additionalProperties: false,
  },
};

export async function runRead(args = {}) {
  if (!hasRefreshToken()) return NOT_CONNECTED;
  try {
    const result = await docsConnector.getDocPlaintext(args.doc_id);
    const id = datasets.put('google_doc', {
      docId: result.docId,
      title: result.title,
      url: result.url,
      text: result.text,
      action: 'read',
    });
    return {
      id,
      doc_id: result.docId,
      title: result.title,
      url: result.url,
      length: result.length,
      pane: buildPaneHint({ docId: result.docId, title: result.title }),
      summary: `"${result.title}" · ${result.length} chars · pane opening`,
    };
  } catch (err) {
    return { error: `read_google_doc failed: ${err?.message || err}` };
  }
}

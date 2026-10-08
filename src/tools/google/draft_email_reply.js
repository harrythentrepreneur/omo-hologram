// draft_email_reply — voice-driven reply drafting. Pulls the email
// (and surrounding thread) from integration_db, asks Gemini to write a
// reply body in the requested tone, stages it server-side keyed by
// message_id, and broadcasts an `email_reply_drafted` event so the open
// reader UI can populate its compose pane inline.
//
// IMPORTANT: this tool does NOT send the email. It only stages a draft.
// The user must explicitly confirm via send_email_reply (or the UI's
// SEND button). Drafts auto-expire after 1 hour.

import * as drafts from '../../connectors/gmail_drafts.js';
import { hasRefreshToken } from '../../connectors/google.js';

export const definition = {
  type: 'function',
  name: 'draft_email_reply',
  description:
    'Draft a reply to a specific email. Returns IMMEDIATELY with the recipient + subject and `status: "drafting"` — the body materialises in the email reader\'s compose pane via a WebSocket event a few seconds later (the user watches it appear). Do NOT block waiting for the body in your response; narrate a short handoff sentence ("OK, drafting your reply to Sarah~ check your screen") and let the user read it. Use after the user says things like "reply to her saying I\'ll call tomorrow", "draft a polite no", "tell him we\'ll get back to him next week". After the user reads + approves, call send_email_reply. The draft is NOT sent until then. If the user is currently looking at an email and says "reply" without specifying which one, omit message_id — the server will use the email currently open in the reader.',
  parameters: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'Gmail messageId to reply to. If omitted, falls back to the email currently open in the HQ reader (resolved from screen context).',
      },
      instruction: {
        type: 'string',
        description: "What the user wants to say in the reply, in plain language ('say I'll call her Friday morning', 'politely decline but suggest catching up in Q4', 'thank him for the intro and accept the meeting'). The model will turn this into the actual prose. Optional — if omitted, writes a generic acknowledging reply.",
      },
      tone: {
        type: 'string',
        enum: ['friendly', 'professional', 'direct', 'apologetic', 'enthusiastic', 'formal'],
        description: "Voice of the reply. Default 'professional'.",
      },
      length: {
        type: 'string',
        enum: ['short', 'medium', 'long'],
        description: "Roughly how long the reply should be. Default 'medium' (3–6 sentences).",
      },
      language: {
        type: 'string',
        enum: ['auto', 'en', 'zh'],
        description: "What language to write in. 'auto' (default) matches the original email; 'en' / 'zh' force the reply.",
      },
    },
    required: [],
  },
};

export async function run(args = {}) {
  if (!hasRefreshToken()) {
    return { error: 'gmail not connected — visit /auth/google/start to authorize.' };
  }
  let messageId = args.message_id ? String(args.message_id).trim() : '';

  // Fall back to the message currently open in the HQ email reader. The
  // /omo/ingest/view path keeps a running snapshot of "what is the user
  // looking at" so omo can resolve "this email" without an explicit id.
  if (!messageId) {
    try {
      const view = await import('../momo/view.js');
      const snap = view.getView?.();
      if (snap?.drilldown?.kind === 'gmail_message' && snap.drilldown.id) {
        messageId = String(snap.drilldown.id);
      }
    } catch { /* view not present — fall through */ }
  }

  if (!messageId) {
    return { error: 'no message_id and no email currently open. Ask the user which email to reply to, or call open_hq_detail first.' };
  }

  try {
    // Returns IMMEDIATELY with metadata + status: 'drafting'. The body
    // is generated in the background; the UI populates the compose
    // pane via the `email_reply_drafted` WS event when ready. Keeps
    // the /tool dispatch fast (Gemini Live blocks audio output until
    // it gets a functionResponse, so a slow reply was freezing Momo).
    const meta = await drafts.prepareReplyDraft(messageId, {
      instruction: args.instruction,
      tone: args.tone,
      length: args.length,
      language: args.language,
      source: 'voice',
    });
    return {
      ok: true,
      status: 'drafting',
      draft_id: meta.draft_id,
      message_id: meta.message_id,
      thread_id: meta.thread_id,
      to: meta.to,
      to_name: meta.to_name,
      subject: meta.subject,
      tone: meta.tone,
      length: meta.length,
      summary: `drafting ${meta.length} reply to ${meta.to_name || meta.to} — body is materialising on screen, narrate handoff in one short sentence and wait for the user to read it`,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

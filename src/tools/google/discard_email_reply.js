// discard_email_reply — drop a staged reply draft. Called when the user
// changes their mind ("never mind", "scrap that", "delete the draft").

import * as drafts from '../../connectors/gmail_drafts.js';

export const definition = {
  type: 'function',
  name: 'discard_email_reply',
  description:
    'Discard a previously staged reply draft so it won\'t be sent. Use when the user says things like "never mind", "scrap that draft", "throw that away". If a message_id is omitted, falls back to the email currently open in the reader.',
  parameters: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'Gmail messageId whose staged draft to drop. Omit to use the email currently open in the HQ reader.',
      },
      account_id: { type: 'string', description: 'Which Gmail account the staged draft belongs to. Optional — falls back to the account that owns the message.' },
    },
    required: [],
  },
};

export async function run(args = {}) {
  let messageId = args.message_id ? String(args.message_id).trim() : '';
  if (!messageId) {
    try {
      const view = await import('../momo/view.js');
      const snap = view.getView?.();
      if (snap?.drilldown?.kind === 'gmail_message' && snap.drilldown.id) {
        messageId = String(snap.drilldown.id);
      }
    } catch {}
  }
  if (!messageId) return { error: 'no message_id and no email open' };
  const had = drafts.discardDraft(messageId, args.account_id);
  return { ok: true, discarded: !!had, summary: had ? 'draft discarded' : 'no draft was staged' };
}

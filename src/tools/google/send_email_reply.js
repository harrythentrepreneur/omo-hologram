// send_email_reply — confirm + send a previously drafted reply. The user
// must have explicitly approved sending; do NOT call this without a clear
// "yes send it" / "发吧" / "go ahead" from the user.
//
// Behaviour:
//   - With message_id only: pulls the staged draft and sends as-is.
//   - With message_id + body / subject: applies overrides on top of the
//     staged draft (lets the user say "send it but change the subject to
//     X" or "send it without the last sentence").
//   - With explicit to / subject / body (no message_id): sends a
//     standalone email — useful for "send it as a fresh thread".

import * as drafts from '../../connectors/gmail_drafts.js';
import { hasRefreshToken } from '../../connectors/google.js';

export const definition = {
  type: 'function',
  name: 'send_email_reply',
  description:
    'Send a reply that was previously staged via draft_email_reply (or the UI). Only call after the user has explicitly confirmed sending. If the user wants tweaks ("change the subject", "shorten it"), call draft_email_reply again instead of overriding here. Returns the new Gmail messageId on success.',
  parameters: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'Gmail messageId of the email being replied to (the one whose staged draft to send). If omitted, falls back to the email currently open in the HQ reader.',
      },
      to: { type: 'string', description: 'Override recipient. Leave blank to keep the staged draft\'s recipient (the original sender).' },
      cc: { type: 'string', description: 'Optional Cc override.' },
      bcc: { type: 'string', description: 'Optional Bcc.' },
      subject: { type: 'string', description: 'Override subject. Leave blank to keep the staged "Re: …" subject.' },
      body: { type: 'string', description: 'Override body. Prefer re-drafting via draft_email_reply if the user wants substantive changes.' },
      account_id: { type: 'string', description: 'Which connected Gmail account to send from (the address). Optional — if omitted, omo uses the account that owns the message being replied to (or the primary account when sending fresh).' },
    },
    required: [],
  },
};

export async function run(args = {}) {
  if (!hasRefreshToken()) {
    return { error: 'gmail not connected — visit /auth/google/start to authorize.' };
  }
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

  if (!messageId && args.to && args.subject && args.body) {
    try {
      const result = await drafts.sendStoredDraft(`adhoc-${Date.now()}`, {
        to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body,
        account_id: args.account_id,
      });
      return { ok: true, sent_message_id: result.sent_message_id, account_id: result.account_id, summary: `sent to ${args.to}${result.account_id ? ` from ${result.account_id}` : ''}` };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }

  if (!messageId) {
    return { error: 'no message_id and no email open. Ask the user which reply to send, or pass to/subject/body explicitly.' };
  }

  // Don't precheck staged here — sendStoredDraft now waits for any
  // in-flight body generation before deciding "no draft". A precheck
  // would reject "send it" voice commands fired moments after the user
  // sees the body land on screen but before the staged draft has
  // been written. Capture the to_name BEFORE send (sendStoredDraft
  // clears the staged draft on success).
  const stagedBefore = drafts.getDraft(messageId, args.account_id);

  try {
    const result = await drafts.sendStoredDraft(messageId, {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      account_id: args.account_id,
    });
    return {
      ok: true,
      sent_message_id: result.sent_message_id,
      thread_id: result.thread_id,
      account_id: result.account_id,
      summary: `sent reply to ${stagedBefore?.to_name || stagedBefore?.to || args.to}${result.account_id ? ` from ${result.account_id}` : ''}`,
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

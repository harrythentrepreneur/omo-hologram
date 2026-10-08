// send_email tool — lets Momo send mail through the user's connected
// Gmail account. Refuses gracefully when the user hasn't authorized
// Gmail yet, so the model can explain rather than blow up.

import { sendEmail } from '../../connectors/gmail.js';
import * as dataCore from '../../data_core.js';
import { hasRefreshToken } from '../../connectors/google.js';

export const definition = {
  type: 'function',
  name: 'send_email',
  description: "Send a plain-text email through the user's connected Gmail account. Requires that the user has authorized Gmail (via /auth/google/start). Returns a confirmation with the new message id and thread id.",
  parameters: {
    type: 'object',
    properties: {
      to:      { type: 'string', description: 'Recipient email address. Single address only — for multiple recipients, call once per recipient or pass cc/bcc.' },
      subject: { type: 'string', description: 'Email subject line. Keep concise.' },
      body:    { type: 'string', description: 'Email body in plain text. UTF-8 supported.' },
      cc:      { type: 'string', description: 'Optional Cc recipient.' },
      bcc:     { type: 'string', description: 'Optional Bcc recipient.' },
      reply_to_thread_id: { type: 'string', description: 'Optional Gmail thread id to reply within. Omit to start a new thread.' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export async function run(args) {
  if (!hasRefreshToken()) {
    return { error: 'Gmail not connected. Visit http://localhost:8080/auth/google/start to authorize.' };
  }
  const { to, subject, body, cc, bcc, reply_to_thread_id } = args || {};
  const result = await sendEmail(
    { to, subject, body, cc, bcc, replyToThreadId: reply_to_thread_id },
    { emit: dataCore.emit },
  );
  return result;
}

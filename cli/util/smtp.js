// Email delivery via Gmail SMTP — THE one sender on every platform (`ws email`).
// Sends From the agent +alias
// with Reply-To back to it, X-Workspace-Agent header so the inbox poller never
// mistakes agent mail for a request, and automatic email-out capture in the
// central DB after every send.
// nodemailer is loaded lazily so every non-email `ws` command stays dependency-free.
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import * as apiclient from './apiclient.js';

/**
 * @param {{subject: string, bodyPath: string, to?: string, inReplyTo?: string, html?: boolean, sender?: string}} mail
 *   `sender` identifies the sending component in the email-out capture (the runner
 *   tags itself 'runner'); agent sends stay untagged — the compliance audit relies on this.
 * @returns {Promise<{to: string, from: string}>}
 * @throws {Error} with .code = 'NO_IDENTITY' | 'NO_PASSWORD' | 'NO_BODY' | 'NO_NODEMAILER' for CLI exit mapping
 */
export async function sendEmail({ subject, bodyPath, to, inReplyTo, html = false, sender }) {
  // Identity has NO code defaults (2026-07-20): a misconfigured environment must
  // fail fast, never silently send as the wrong person. MAIL_ACCOUNT is a
  // derivation (login account of the alias), not a personal default.
  const owner = process.env.OWNER_EMAIL;
  const agent = process.env.AGENT_EMAIL;
  if (!owner || !agent) {
    const err = new Error('OWNER_EMAIL / AGENT_EMAIL are not set — mail identity has no code default (see .env.example)');
    // @ts-ignore
    err.code = 'NO_IDENTITY';
    throw err;
  }
  const account = process.env.MAIL_ACCOUNT || owner;
  const recipient = to || owner;

  const password = process.env.GMAIL_APP_PASSWORD;
  if (!password) {
    const err = new Error('GMAIL_APP_PASSWORD is not set. See the email-delivery skill for setup.');
    // @ts-ignore
    err.code = 'NO_PASSWORD';
    throw err;
  }
  if (!existsSync(bodyPath)) {
    const err = new Error(`Body file not found: ${bodyPath}`);
    // @ts-ignore
    err.code = 'NO_BODY';
    throw err;
  }
  const body = readFileSync(bodyPath, 'utf8');

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    const err = new Error('nodemailer is not installed — run `npm ci --ignore-scripts` at the workspace root.');
    // @ts-ignore
    err.code = 'NO_NODEMAILER';
    throw err;
  }

  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: account, pass: password },
  });
  // Gmail rewrites From to the authenticated address unless the alias is a
  // registered send-as; Reply-To survives and routes replies to the agent alias.
  await transport.sendMail({
    from: agent,
    replyTo: agent,
    to: recipient,
    subject,
    [html ? 'html' : 'text']: body,
    headers: { 'X-Workspace-Agent': '1' },
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });

  // Capture in the central message table — non-fatal: a logging hiccup never
  // fails delivery, but the miss is reported so it is never silent.
  try {
    await apiclient.emailOut({
      subject,
      bodyPath,
      meta: JSON.stringify({ to: recipient, in_reply_to: inReplyTo || '', ...(sender ? { sender } : {}) }),
    });
  } catch (e) {
    console.error(`warning: email sent but capture to the log API failed: ${e instanceof Error ? e.message : e}`);
  }
  return { to: recipient, from: agent };
}

import { encodeStream, envelope, type Mailbox, type Message } from '@portable/mail';
import type { Env } from './config';
import { HttpError, json, readJson } from './http';
import { MailTransportError, submitMessage, type MailAccount } from './mail-transport';
import { managedRegistry } from './managed-accounts';

const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADER_CONTROL = /[\x00-\x1f\x7f]/;

function smtpEndpoint({ email, imap, smtp }: MailAccount): MailAccount['smtp'] {
  if (smtp) return smtp;
  if (imap.host.toLowerCase() !== 'imap.gmail.com' || imap.user.toLowerCase() !== email.toLowerCase()) return;
  return { ...imap, host: 'smtp.gmail.com', mode: 'tls', port: 465 };
}

export function canSubmitAttentionMessage(account: MailAccount): boolean {
  return Boolean(smtpEndpoint(account));
}

function invalidSubmission(): never {
  throw new HttpError(400, 'invalid_submission');
}

function recipients(value: unknown): Mailbox[] {
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) return invalidSubmission();
  return value.map((recipient) => {
    if (!recipient || typeof recipient !== 'object') return invalidSubmission();
    const { email, name } = recipient as Record<string, unknown>;
    if (typeof email !== 'string' || email.length > 254 || /[<>]/.test(email) || HEADER_CONTROL.test(email)
      || email.lastIndexOf('@') <= 0 || email.endsWith('@')) return invalidSubmission();
    if (name !== undefined && (typeof name !== 'string' || name.length > 512 || HEADER_CONTROL.test(name))) {
      return invalidSubmission();
    }
    return { address: email, name: name as string | undefined };
  });
}

function messageIds(value: unknown, maxCount: number): string[] {
  if (!Array.isArray(value) || value.length > maxCount) return invalidSubmission();
  return value.map((item) => {
    if (typeof item !== 'string' || HEADER_CONTROL.test(item)) return invalidSubmission();
    const bare = item.replace(/^<|>$/g, '');
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(bare) || bare.length > 512) return invalidSubmission();
    return bare;
  });
}

function submission(input: unknown, account: MailAccount): { requestId: string; message: Message } {
  if (!input || typeof input !== 'object') return invalidSubmission();
  const fields = input as Record<string, unknown>;
  const { requestId, subject, textBody, htmlBody } = fields;
  if (typeof requestId !== 'string' || !UUID.test(requestId)
    || typeof subject !== 'string' || HEADER_CONTROL.test(subject)
    || typeof textBody !== 'string' || typeof htmlBody !== 'string') return invalidSubmission();
  const to = recipients(fields.to);
  const cc = recipients(fields.cc);
  const bcc = recipients(fields.bcc);
  const count = to.length + cc.length + bcc.length;
  if (count === 0 || count > MAX_RECIPIENTS) return invalidSubmission();
  return {
    requestId: requestId.toLowerCase(),
    message: {
      from: { address: account.email }, to, cc, bcc, subject,
      text: textBody || (!htmlBody ? '' : undefined),
      html: htmlBody || undefined,
      inReplyTo: messageIds(fields.inReplyTo, 1)[0],
      references: messageIds(fields.references, 200),
    },
  };
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function submissionError(error: unknown): HttpError {
  if (!(error instanceof MailTransportError)) return new HttpError(409, 'submission_unknown');
  switch (error.code) {
    case 'authentication_failed': return new HttpError(422, 'smtp_authentication_failed');
    case 'smtp_not_configured': return new HttpError(422, 'smtp_not_configured');
    case 'mail_unavailable': return new HttpError(502, 'smtp_unavailable');
    case 'submission_rejected': return new HttpError(422, 'submission_rejected');
    case 'message_too_large': return new HttpError(413, 'message_too_large');
    default: return new HttpError(409, 'submission_unknown');
  }
}

export async function submitAttentionMessage(
  request: Request, account: MailAccount, env: Env, send: typeof submitMessage = submitMessage,
): Promise<Response> {
  const smtp = smtpEndpoint(account);
  if (!smtp) throw new HttpError(422, 'smtp_not_configured');
  const registry = managedRegistry(env);
  if (!registry) throw new HttpError(503, 'gateway_unavailable');
  const { requestId, message } = submission(await readJson(request, MAX_REQUEST_BYTES), account);
  let raw: Uint8Array;
  let to: string[];
  try {
    const addressed = envelope(message);
    to = [...addressed.to];
    const domain = addressed.from.slice(addressed.from.lastIndexOf('@') + 1);
    raw = new Uint8Array(await new Response(encodeStream({ ...message, messageId: `${requestId}@${domain}` })).arrayBuffer());
  } catch {
    return invalidSubmission();
  }

  const [accountKey, fingerprint] = await Promise.all([
    digest(JSON.stringify([account.id, account.email.toLowerCase()])),
    digest(JSON.stringify(message)),
  ]);
  const claim = await registry.claimSubmission(accountKey, requestId, fingerprint);
  if (claim.state === 'conflict') throw new HttpError(409, 'submission_conflict');
  if (claim.state === 'pending') throw new HttpError(409, 'submission_unknown');
  if (claim.state === 'submitted') return json({ status: 'submitted', rejected: claim.rejected });

  let rejected: number;
  try {
    const result = await send({ ...account, smtp }, { to, message: raw });
    rejected = result.rejected.length;
  } catch (cause) {
    const error = submissionError(cause);
    if (error.code !== 'submission_unknown') await registry.releaseSubmission(accountKey, requestId, fingerprint);
    throw error;
  }

  // A failed confirmation write leaves the claim in place. Retrying the same request cannot submit again.
  try {
    if (!await registry.finishSubmission(accountKey, requestId, fingerprint, rejected)) throw new Error();
  } catch {
    throw new HttpError(409, 'submission_unknown');
  }
  return json({ status: 'submitted', rejected });
}

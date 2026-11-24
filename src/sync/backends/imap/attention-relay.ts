import { JMAP_SERVER_URL } from '../../../defines';
import { browserRelayAssertion, browserSessionEnabled } from '../../../services/browser-session';
import type { ParsedAddress } from '../../../utils/address-parse';

const API_ROOT = '/api/imap/v1';

export interface RelayAccount {
  id: string;
  email: string;
  name: string;
  managed?: boolean;
  host?: string;
  port?: number;
  mode?: 'tls' | 'starttls';
  user?: string;
  auth?: 'google-oauth';
}

export interface RelayAccountSettings {
  accounts: RelayAccount[];
  googleOAuth?: boolean;
}

export const GOOGLE_IMAP_RESULTS = ['connected', 'cancelled', 'blocked', 'account_mismatch', 'failed'] as const;
export const GOOGLE_IMAP_RETURN_SPACE = 'stormbox.google-imap-return-space';
export type GoogleImapResult = typeof GOOGLE_IMAP_RESULTS[number];

export interface RelayAccountInput {
  email: string;
  password: string;
  name?: string;
  host?: string;
  port?: number;
  mode?: 'tls' | 'starttls';
  user?: string;
}

interface MailAddress {
  name: string;
  address: string;
}

export interface RelayMessage {
  uid: number;
  messageId: string | null;
  references: string[];
  inReplyTo: string | null;
  subject: string;
  preview?: string;
  from: MailAddress[];
  to: MailAddress[];
  cc?: MailAddress[];
  replyTo?: MailAddress[];
  keywords?: string[];
  labels?: string[];
  gmailLabels?: boolean;
  receivedAt: string;
  seen: boolean;
  flagged: boolean;
  hasAttachments?: boolean;
}

export interface RelayFolder {
  path: string;
  name: string;
  specialUse: string | null;
  delimiter: string | null;
}

export interface RelayWindow {
  mailbox: string;
  uidValidity: string;
  canSend?: boolean;
  total?: number;
  complete?: boolean;
  minUid?: number | null;
  messages: RelayMessage[];
}

export interface RelayMessageBody {
  text: string;
  html: string | null;
}

export interface ImapMessageLocation {
  accountId: string;
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export type ImapAttentionAction =
  | { type: 'star'; value: boolean }
  | { type: 'seen'; value: boolean }
  | { type: 'trash' }
  | { type: 'archive' }
  | { type: 'junk' }
  | { type: 'tags'; tags: ImapTagPatch };

export interface ImapTagPatch {
  add?: string[];
  remove?: string[];
  addLabels?: string[];
  removeLabels?: string[];
}

export interface AttentionImapDraft {
  requestId: string;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  subject: string;
  textBody: string;
  htmlBody: string;
  inReplyTo: string[];
  references: string[];
}

export interface AttentionImapSendResult {
  rejected?: number;
}

export class AttentionRelayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function messagePath(location: ImapMessageLocation, suffix = '') {
  const { accountId, mailbox, uidValidity, uid } = location;
  return `/accounts/${encodeURIComponent(accountId)}/messages/${uid}${suffix}?${new URLSearchParams({ mailbox, uidValidity })}`;
}

export class AttentionRelay {
  private browserPairing?: Promise<void>;

  constructor(private readonly fetcher: typeof globalThis.fetch) {}

  async pair(accessToken?: string) {
    if (accessToken === undefined) {
      if (!browserSessionEnabled(JMAP_SERVER_URL)) throw new Error('Enter the mail relay pairing token.');
      this.browserPairing ??= this.pairBrowser().finally(() => { this.browserPairing = undefined; });
      return this.browserPairing;
    }
    await this.startSession({ accessToken });
  }

  private async pairBrowser() {
    await this.startSession({ assertion: await browserRelayAssertion(this.fetcher) });
  }

  private async startSession(proof: { accessToken: string } | { assertion: string }) {
    await this.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proof),
    });
  }

  async disconnect() {
    await this.request('/session', { method: 'DELETE' });
  }

  async accounts(): Promise<RelayAccount[]> {
    return (await this.accountSettings()).accounts;
  }

  accountSettings(): Promise<RelayAccountSettings> {
    return this.json('/accounts');
  }

  async startGoogleOAuth(accountId?: string): Promise<string> {
    const response = await this.request('/oauth/google/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const { url } = await response.json();
    if (typeof url !== 'string') throw new Error('The relay did not return a Google sign-in URL.');
    const authorization = URL.parse(url);
    if (authorization?.origin !== 'https://accounts.google.com' || authorization.pathname !== '/o/oauth2/v2/auth'
      || authorization.username || authorization.password) {
      throw new Error('The relay returned an unexpected Google sign-in URL.');
    }
    return authorization.href;
  }

  async saveAccount(account: RelayAccountInput): Promise<RelayAccount> {
    const response = await this.request('/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account),
    });
    return response.json();
  }

  async removeAccount(id: string): Promise<void> {
    await this.request(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  inbox(accountId: string): Promise<RelayWindow> {
    return this.folder(accountId, 'INBOX');
  }

  async folders(accountId: string): Promise<RelayFolder[]> {
    const { mailboxes } = await this.json<{ mailboxes: RelayFolder[] }>(`/accounts/${encodeURIComponent(accountId)}/mailboxes`);
    if (!Array.isArray(mailboxes)) throw new Error('The mail relay did not return a folder list.');
    return mailboxes;
  }

  async folder(accountId: string, mailbox: string, limit = 50): Promise<RelayWindow> {
    const query = new URLSearchParams({ mailbox, limit: String(limit) });
    const window = await this.json<RelayWindow>(`/accounts/${encodeURIComponent(accountId)}/messages?${query}`);
    if (window.complete === false && window.minUid === null) {
      throw new AttentionRelayError(503, 'incomplete_window', 'The folder changed during sync. Try refreshing again.');
    }
    return window;
  }

  async body(location: ImapMessageLocation): Promise<RelayMessageBody> {
    const body = await this.json<{ text: string; html?: string }>(messagePath(location));
    return { text: body.text, html: body.html ?? '' };
  }

  async mutate(location: ImapMessageLocation, action: ImapAttentionAction): Promise<
    (Pick<RelayMessage, 'seen' | 'flagged' | 'keywords' | 'labels'> & { tagsApplied?: boolean }) | null
  > {
    if (action.type === 'trash' || action.type === 'archive' || action.type === 'junk') {
      const response = await this.request(messagePath(location, `/${action.type}`), { method: 'POST' });
      const result = await response.json();
      if (result?.status !== 'moved' && result?.status !== 'absent') {
        throw new Error('The mail relay did not confirm that the message left the inbox.');
      }
      return null;
    }
    const patch = action.type === 'tags' ? { tags: action.tags } : {
      [action.type === 'star' ? 'flagged' : 'seen']: action.value,
    };
    const response = await this.request(messagePath(location), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const result = await response.json();
    if (result?.uid !== location.uid || typeof result.seen !== 'boolean' || typeof result.flagged !== 'boolean') {
      throw new Error('The mail relay did not return updated message flags.');
    }
    const flags = { seen: result.seen, flagged: result.flagged };
    if (action.type !== 'tags') return flags;
    if (!Array.isArray(result.keywords) || !Array.isArray(result.labels) || typeof result.tagsApplied !== 'boolean') {
      throw new Error('The mail relay did not return the updated tags.');
    }
    return { ...flags, keywords: result.keywords, labels: result.labels, tagsApplied: result.tagsApplied };
  }

  async submit(accountId: string, draft: AttentionImapDraft): Promise<AttentionImapSendResult> {
    const response = await this.request(`/accounts/${encodeURIComponent(accountId)}/send`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    }, 40_000);
    const result = await response.json();
    if (result.status !== 'submitted') throw new Error('The mail relay did not confirm submission.');
    return Number.isSafeInteger(result.rejected) && result.rejected > 0 ? { rejected: result.rejected } : {};
  }

  private async json<T>(path: string): Promise<T> {
    return (await this.request(path)).json();
  }

  private async request(path: string, init: RequestInit = {}, timeout = 30_000) {
    const send = () => this.fetcher(`${API_ROOT}${path}`, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    let response = await send();
    if (response.status === 401 && path !== '/session' && browserSessionEnabled(JMAP_SERVER_URL)) {
      await this.pair();
      response = await send();
    }
    if (response.ok) return response;
    const { error: code } = await response.json().catch(() => ({})) ?? {};
    const messages: Record<string, string> = {
      trash_not_configured: 'This account does not have an IMAP Trash folder.',
      archive_not_configured: 'This account does not have an IMAP Archive folder.',
      archive_requires_inbox: 'Open the message from Inbox to archive it.',
      archive_rejected: 'The mail server did not confirm that the message left Inbox.',
      junk_not_configured: 'This account does not have an IMAP Junk folder.',
      move_not_supported: 'This mail server does not support moving messages.',
      same_mailbox: 'This message is already in the destination folder.',
      labels_not_supported: 'This mail server does not support Gmail labels.',
      tags_not_supported: 'This mailbox does not support changing tags.',
      tag_update_rejected: 'The mail server rejected the tag change.',
      invalid_tags: 'The mail server cannot use one of these tag names.',
      message_not_found: 'This message is no longer in this mailbox.',
      authentication_failed: 'The IMAP server rejected the relay credentials.',
      invalid_account: 'Check the email address, app password, and IMAP settings.',
      account_exists: 'An account already uses this email address.',
      account_limit: 'The relay has reached its account limit.',
      account_not_managed: 'This account is configured by the relay operator.',
      account_management_unavailable: 'The relay has not enabled account management.',
      invalid_imap_host: 'Enter the full public hostname of your IMAP server.',
      invalid_imap_port: 'Use TLS on port 993 or STARTTLS on port 143.',
      account_identity_changed: 'Remove this account before connecting it to a different IMAP server or username.',
      account_changed: 'The account changed while you were editing it. Reopen account management and try again.',
      mail_unavailable: 'The relay could not connect to the IMAP server. Check the hostname and TLS settings.',
      mail_timeout: 'The IMAP server took too long to respond. Try again.',
      google_oauth_unavailable: 'Google sign-in has not been configured for this mail relay.',
      google_reconnect_required: 'Reconnect this Google account in Manage IMAP accounts.',
      smtp_not_configured: 'This account does not have a sending server.',
      smtp_authentication_failed: 'The sending server rejected this account’s credentials.',
      smtp_unavailable: 'The sending server is unavailable. Try again when it reconnects.',
      invalid_submission: 'Check the message and its recipients before sending.',
      message_too_large: 'This message is too large to send.',
      request_too_large: 'This message is too large to send.',
      submission_conflict: 'An earlier send used this request. Check the account’s Sent folder before sending again.',
      submission_rejected: 'The sending server rejected the message.',
      submission_unknown: 'The relay could not confirm delivery. Check the account’s Sent folder before sending again.',
    };
    const message = (Object.hasOwn(messages, code) ? messages[code] : undefined)
      ?? (response.status === 401 ? 'Connect the mail relay to access IMAP mail.'
        : response.status === 409 ? 'This mailbox changed. Refresh Attention and reopen the message.'
          : response.status === 404 ? 'The mail relay is unavailable at this address.'
            : 'The mail relay could not complete the request.');
    throw new AttentionRelayError(response.status, typeof code === 'string' ? code : 'imap_relay_error', message);
  }
}

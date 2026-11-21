import { JMAP_SERVER_URL } from '../../../defines';
import { browserRelayAssertion, browserSessionEnabled } from '../../../services/browser-session';

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
}

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
  receivedAt: string;
  seen: boolean;
  flagged: boolean;
}

export interface RelayWindow {
  mailbox: string;
  uidValidity: string;
  messages: RelayMessage[];
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
  | { type: 'trash' };

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
    return (await this.json<{ accounts: RelayAccount[] }>('/accounts')).accounts;
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
    return this.json(`/accounts/${encodeURIComponent(accountId)}/messages?mailbox=INBOX&limit=50`);
  }

  async body(location: ImapMessageLocation): Promise<string> {
    const body = await this.json<{ text: string }>(messagePath(location));
    return body.text;
  }

  async mutate(location: ImapMessageLocation, action: ImapAttentionAction): Promise<Pick<RelayMessage, 'seen' | 'flagged'> | null> {
    if (action.type === 'trash') {
      const response = await this.request(messagePath(location, '/trash'), { method: 'POST' });
      const result = await response.json();
      if (result?.status !== 'moved' && result?.status !== 'absent') {
        throw new Error('The mail relay did not confirm that the message left the inbox.');
      }
      return null;
    }
    const field = action.type === 'star' ? 'flagged' : 'seen';
    const response = await this.request(messagePath(location), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: action.value }),
    });
    const result = await response.json();
    if (result?.uid !== location.uid || typeof result.seen !== 'boolean' || typeof result.flagged !== 'boolean') {
      throw new Error('The mail relay did not return updated message flags.');
    }
    return { seen: result.seen, flagged: result.flagged };
  }

  private async json<T>(path: string): Promise<T> {
    return (await this.request(path)).json();
  }

  private async request(path: string, init: RequestInit = {}) {
    const send = () => this.fetcher(`${API_ROOT}${path}`, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
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
      move_not_supported: 'This mail server does not support moving messages to Trash.',
      same_mailbox: 'This message is already in Trash.',
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
    };
    const message = (Object.hasOwn(messages, code) ? messages[code] : undefined)
      ?? (response.status === 401 ? 'Connect the mail relay to access IMAP mail.'
        : response.status === 409 ? 'This mailbox changed. Refresh Attention and reopen the message.'
          : response.status === 404 ? 'The mail relay is unavailable at this address.'
            : 'The mail relay could not complete the request.');
    throw new AttentionRelayError(response.status, typeof code === 'string' ? code : 'imap_relay_error', message);
  }
}

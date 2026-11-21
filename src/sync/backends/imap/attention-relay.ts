const API_ROOT = '/api/imap/v1';

export interface RelayAccount {
  id: string;
  email: string;
  name: string;
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
  constructor(private readonly fetcher: typeof globalThis.fetch) {}

  async pair(accessToken: string) {
    await this.request('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
  }

  async disconnect() {
    await this.request('/session', { method: 'DELETE' });
  }

  async accounts(): Promise<RelayAccount[]> {
    return (await this.json<{ accounts: RelayAccount[] }>('/accounts')).accounts;
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
    const response = await this.fetcher(`${API_ROOT}${path}`, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return response;
    const { error: code } = await response.json().catch(() => ({})) ?? {};
    const messages: Record<string, string> = {
      trash_not_configured: 'This account does not have an IMAP Trash folder.',
      move_not_supported: 'This mail server does not support moving messages to Trash.',
      same_mailbox: 'This message is already in Trash.',
      message_not_found: 'This message is no longer in this mailbox.',
      authentication_failed: 'The IMAP server rejected the relay credentials.',
    };
    const message = (Object.hasOwn(messages, code) ? messages[code] : undefined)
      ?? (response.status === 401 ? 'Connect the mail relay to access IMAP mail.'
        : response.status === 409 ? 'This mailbox changed. Refresh Attention and reopen the message.'
          : response.status === 404 ? 'The mail relay is unavailable at this address.'
            : 'The mail relay could not complete the request.');
    throw new AttentionRelayError(response.status, typeof code === 'string' ? code : 'imap_relay_error', message);
  }
}

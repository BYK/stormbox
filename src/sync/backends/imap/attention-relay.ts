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
    const { accountId, mailbox, uidValidity, uid } = location;
    const query = new URLSearchParams({ mailbox, uidValidity });
    const body = await this.json<{ text: string }>(
      `/accounts/${encodeURIComponent(accountId)}/messages/${uid}?${query}`,
    );
    return body.text;
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
    if (response.status === 401) throw new Error('Connect the mail relay to refresh IMAP mail.');
    if (response.status === 409) throw new Error('This mailbox changed. Refresh Attention and reopen the message.');
    if (response.status === 404) throw new Error('The mail relay is unavailable at this address.');
    throw new Error('The mail relay could not complete the request.');
  }
}

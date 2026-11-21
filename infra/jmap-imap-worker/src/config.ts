import type { AccountState } from './account';
import type { PushEnv } from './push';
import type { MailAccount } from './mail-transport';
import type { ManagedAccounts } from './managed-accounts';

export const MAX_IMAP_ACCOUNTS = 10;
export const RELAY_REGISTRY_NAME = 'stormbox';

export interface Env extends PushEnv {
  PUBLIC_ORIGIN: string;
  RELAY_ACCESS_TOKEN?: string;
  IMAP_ACCOUNTS?: string;
  IMAP_ACCOUNT_ENCRYPTION_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  MANAGED_ACCOUNTS?: DurableObjectNamespace<ManagedAccounts>;
  MAILBOXES: DurableObjectNamespace<AccountState>;
}

export function accessToken(env: Env): string | null {
  const token = env.RELAY_ACCESS_TOKEN;
  return typeof token === 'string' && token.length >= 32 ? token : null;
}

function configuredEndpoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const endpoint = value as Record<string, unknown>;
  return typeof endpoint.host === 'string' && /^(?=.{1,253}$)[a-z0-9.-]+$/i.test(endpoint.host)
    && typeof endpoint.user === 'string' && Boolean(endpoint.user.trim())
    && typeof endpoint.password === 'string' && Boolean(endpoint.password)
    && (endpoint.mode === undefined || endpoint.mode === 'tls' || endpoint.mode === 'starttls')
    && (endpoint.port === undefined || (Number.isInteger(endpoint.port)
      && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535));
}

export function mailAccounts(env: Pick<Env, 'IMAP_ACCOUNTS'>): MailAccount[] {
  const input: unknown = JSON.parse(env.IMAP_ACCOUNTS ?? '[]');
  if (!Array.isArray(input) || input.length > MAX_IMAP_ACCOUNTS) throw new Error('Invalid IMAP_ACCOUNTS');
  const ids = new Set<string>();
  return input.map((account: MailAccount) => {
    if (!account || typeof account !== 'object' || typeof account.id !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(account.id) || ids.has(account.id)
      || typeof account.email !== 'string' || !/^[^\s<>@]+@[^\s<>@]+$/.test(account.email)
      || (account.name !== undefined && typeof account.name !== 'string')
      || !configuredEndpoint(account.imap) || (account.smtp !== undefined && !configuredEndpoint(account.smtp))) {
      throw new Error('Invalid IMAP account');
    }
    ids.add(account.id);
    return account;
  });
}

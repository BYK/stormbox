import type { AccountRow } from '../types/db';

export const CACHED_ACCOUNT_KEY = 'stormbox.cachedAccount.v1';
const REVISION_KEY = 'stormbox.cachedAccount.logout';
let localRevision: string | null = null;

type CachedAccount = Pick<AccountRow, 'id' | 'server_origin' | 'remote_account_id'>;

export function offlineSessionRevision(): string | null {
  try {
    return globalThis.localStorage.getItem(REVISION_KEY) ?? localRevision;
  } catch {
    return localRevision;
  }
}

export function readCachedAccount(): CachedAccount | null {
  try {
    const account = JSON.parse(globalThis.localStorage.getItem(CACHED_ACCOUNT_KEY) ?? 'null');
    return Number.isSafeInteger(account?.id) && account.id > 0
      && typeof account.server_origin === 'string' && account.server_origin
      && typeof account.remote_account_id === 'string' && account.remote_account_id
      ? account : null;
  } catch {
    return null;
  }
}

export function writeCachedAccount(account: CachedAccount | null): void {
  if (account == null) localRevision = crypto.randomUUID();
  try {
    if (account == null) {
      globalThis.localStorage.setItem(REVISION_KEY, localRevision!);
      globalThis.localStorage.removeItem(CACHED_ACCOUNT_KEY);
      return;
    }
    const { id, server_origin, remote_account_id } = account;
    globalThis.localStorage.setItem(CACHED_ACCOUNT_KEY, JSON.stringify({ id, server_origin, remote_account_id }));
  } catch {
    // Some browser profiles have storage disabled.
  }
}

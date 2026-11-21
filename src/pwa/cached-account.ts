import type { AccountRow } from '../types/db';

const KEY = 'stormbox.cachedAccount.v1';

type CachedAccount = Pick<AccountRow, 'id' | 'server_origin' | 'remote_account_id'>;

export function readCachedAccount(): CachedAccount | null {
  try {
    const account = JSON.parse(globalThis.localStorage.getItem(KEY) ?? 'null');
    return Number.isSafeInteger(account?.id) && account.id > 0
      && typeof account.server_origin === 'string' && account.server_origin
      && typeof account.remote_account_id === 'string' && account.remote_account_id
      ? account : null;
  } catch {
    return null;
  }
}

export function writeCachedAccount(account: CachedAccount | null): void {
  try {
    if (account == null) {
      globalThis.localStorage.removeItem(KEY);
      return;
    }
    const { id, server_origin, remote_account_id } = account;
    globalThis.localStorage.setItem(KEY, JSON.stringify({ id, server_origin, remote_account_id }));
  } catch {
    // Some browser profiles have storage disabled.
  }
}

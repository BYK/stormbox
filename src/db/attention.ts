import { AttentionRelay, type ImapMessageLocation, type RelayMessage } from '../sync/backends/imap/attention-relay';
import type { BundleState } from '../triage/smart-sort';
import type { Engine } from './engine';
import { DB_RPC, TABLE_FAMILIES } from './protocol';

export interface CachedImapAccount {
  relay_id: string;
  address: string;
  name: string;
  mailbox: string | null;
  uid_validity: string | null;
  messages: RelayMessage[];
}

export interface AttentionCache {
  paired: boolean;
  accounts: CachedImapAccount[];
  states: Record<string, BundleState>;
}

const PREFETCH_COUNT = 5;
const BODY_CACHE_LIMIT = 100;
const BODY_CHARACTERS = 512_000;

export function makeAttentionHandlers(engine: Engine, broadcaster: { touch: (table: string) => void },
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
  const relay = new AttentionRelay(fetcher);
  const refreshing = new Map<number, Promise<string[]>>();
  const prefetching = new Set<number>();

  async function isPaired(ownerId: number) {
    return Boolean(await engine.get(
      'SELECT 1 FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId],
    ));
  }

  async function readBody(ownerId: number, location: ImapMessageLocation): Promise<string> {
    const { accountId, mailbox, uidValidity, uid } = location;
    const key = [ownerId, accountId, mailbox, uidValidity, uid];
    const cached = await engine.get(
      `SELECT body_text FROM attention_imap_bodies WHERE owner_account_id = ?
       AND relay_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`, key,
    );
    if (cached) return String(cached.body_text);
    const snapshot = await engine.get(
      `SELECT 1 FROM attention_imap_accounts WHERE owner_account_id = ?
       AND relay_id = ? AND mailbox = ? AND uid_validity = ?`, key.slice(0, 4),
    );
    if (!snapshot || !await isPaired(ownerId)) {
      throw new Error('Refresh Attention before opening this message.');
    }
    const body = (await relay.body(location)).slice(0, BODY_CHARACTERS);
    await engine.transaction(async (tx) => {
      await tx.run(
        `INSERT OR IGNORE INTO attention_imap_bodies
           (owner_account_id, relay_id, mailbox, uid_validity, uid, body_text, cached_at)
         SELECT ?, relay_id, mailbox, uid_validity, ?, ?, ? FROM attention_imap_accounts
         WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?`,
        [ownerId, uid, body, Date.now(), ...key.slice(0, 4)],
      );
      await tx.run(
        `DELETE FROM attention_imap_bodies WHERE owner_account_id = ? AND relay_id = ? AND rowid IN (
           SELECT rowid FROM attention_imap_bodies WHERE owner_account_id = ? AND relay_id = ?
           ORDER BY cached_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`, [ownerId, accountId, ownerId, accountId, BODY_CACHE_LIMIT],
      );
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    return body;
  }

  async function refresh(ownerId: number): Promise<string[]> {
    if (!await isPaired(ownerId)) return [];
    const accounts = await relay.accounts();
    const windows = await Promise.allSettled(accounts.map((account) => relay.inbox(account.id)));
    const failed: string[] = [];
    await engine.transaction(async (tx) => {
      if (!await tx.get('SELECT 1 FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId])) return;
      const retained = new Set(accounts.map((account) => account.id));
      for (const row of await tx.all('SELECT relay_id FROM attention_imap_accounts WHERE owner_account_id = ?', [ownerId])) {
        if (!retained.has(String(row.relay_id))) {
          await tx.run('DELETE FROM attention_imap_accounts WHERE owner_account_id = ? AND relay_id = ?', [ownerId, row.relay_id]);
        }
      }
      for (const [index, account] of accounts.entries()) {
        const result = windows[index];
        if (result.status === 'rejected') {
          failed.push(account.email);
          continue;
        }
        const { mailbox, uidValidity, messages } = result.value;
        await tx.run(
          `INSERT INTO attention_imap_accounts
           (owner_account_id, relay_id, address, name, mailbox, uid_validity, messages_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_account_id, relay_id) DO UPDATE SET
             address = excluded.address, name = excluded.name, mailbox = excluded.mailbox,
             uid_validity = excluded.uid_validity, messages_json = excluded.messages_json`,
          [ownerId, account.id, account.email, account.name || account.email, mailbox, uidValidity, JSON.stringify(messages)],
        );
        await tx.run(
          `DELETE FROM attention_imap_bodies WHERE owner_account_id = ? AND relay_id = ?
           AND (mailbox IS NOT ? OR uid_validity IS NOT ?)`, [ownerId, account.id, mailbox, uidValidity],
        );
      }
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    if (!prefetching.has(ownerId)) {
      prefetching.add(ownerId);
      void prefetch(ownerId, accounts, windows).finally(() => prefetching.delete(ownerId));
    }
    return failed;
  }

  async function prefetch(ownerId: number, accounts: Awaited<ReturnType<AttentionRelay['accounts']>>,
    windows: PromiseSettledResult<Awaited<ReturnType<AttentionRelay['inbox']>>>[]) {
    for (const [index, result] of windows.entries()) {
      if (result.status !== 'fulfilled') continue;
      const { mailbox, uidValidity, messages } = result.value;
      for (const { uid } of messages.slice(0, PREFETCH_COUNT)) {
        await readBody(ownerId, { accountId: accounts[index].id, mailbox, uidValidity, uid }).catch(() => {});
      }
    }
  }

  function refreshOnce(ownerId: number) {
    let pending = refreshing.get(ownerId);
    if (!pending) {
      pending = refresh(ownerId).finally(() => refreshing.delete(ownerId));
      refreshing.set(ownerId, pending);
    }
    return pending;
  }

  return {
    [DB_RPC.ATTENTION_GET]: async ({ ownerId }): Promise<AttentionCache> => engine.transaction(async (tx) => {
      const paired = Boolean(await tx.get('SELECT 1 FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId]));
      const accounts = paired ? await tx.all(
        'SELECT * FROM attention_imap_accounts WHERE owner_account_id = ? ORDER BY name, relay_id', [ownerId],
      ) : [];
      const previews = paired ? await tx.all(
        `SELECT b.relay_id, b.uid, substr(b.body_text, 1, 2400) AS preview
           FROM attention_imap_bodies b JOIN attention_imap_accounts a
             ON a.owner_account_id = b.owner_account_id AND a.relay_id = b.relay_id
            AND a.mailbox = b.mailbox AND a.uid_validity = b.uid_validity
          WHERE b.owner_account_id = ?`, [ownerId],
      ) : [];
      const byMessage = new Map(previews.map((row) => [JSON.stringify([row.relay_id, row.uid]), String(row.preview)]));
      const states = await tx.all(
        'SELECT bundle_id, state_json FROM attention_bundle_states WHERE owner_account_id = ?', [ownerId],
      );
      return {
        paired,
        accounts: accounts.map((row) => ({
          relay_id: String(row.relay_id), address: String(row.address), name: String(row.name),
          mailbox: String(row.mailbox), uid_validity: String(row.uid_validity),
          messages: (JSON.parse(String(row.messages_json)) as RelayMessage[]).map((message) => {
            const preview = byMessage.get(JSON.stringify([row.relay_id, message.uid]));
            return preview ? { ...message, preview } : message;
          }),
        })),
        states: Object.fromEntries(states.map((row) => [row.bundle_id, JSON.parse(String(row.state_json))])),
      };
    }),
    [DB_RPC.ATTENTION_PAIR]: async ({ ownerId, accessToken }) => {
      await relay.pair(accessToken);
      await engine.run('INSERT OR IGNORE INTO attention_imap_pairing VALUES (?)', [ownerId]);
      broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      return refreshOnce(ownerId);
    },
    [DB_RPC.ATTENTION_DISCONNECT]: async ({ ownerId }) => {
      await engine.transaction(async (tx) => {
        await tx.run('DELETE FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId]);
        await tx.run('DELETE FROM attention_imap_accounts WHERE owner_account_id = ?', [ownerId]);
      });
      broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      await relay.disconnect();
    },
    [DB_RPC.ATTENTION_REFRESH]: async ({ ownerId }) => refreshOnce(ownerId),
    [DB_RPC.ATTENTION_BODY]: async ({ ownerId, location }) => readBody(ownerId, location),
    [DB_RPC.ATTENTION_SET_STATE]: async ({ ownerId, bundleId, state, replacedIds }) => {
      await engine.transaction(async (tx) => {
        for (const id of new Set<string>([bundleId, ...replacedIds])) {
          await tx.run('DELETE FROM attention_bundle_states WHERE owner_account_id = ? AND bundle_id = ?', [ownerId, id]);
        }
        if (state) {
          await tx.run('INSERT INTO attention_bundle_states VALUES (?, ?, ?)', [ownerId, bundleId, JSON.stringify(state)]);
        }
      });
      broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    },
  };
}

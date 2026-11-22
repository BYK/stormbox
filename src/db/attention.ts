import { MUTATION_TYPE } from '../constants/states';
import {
  AttentionRelay, AttentionRelayError, type AttentionImapDraft, type ImapAttentionAction, type ImapMessageLocation,
  type RelayAccountInput, type RelayMessage, type RelayMessageBody,
} from '../sync/backends/imap/attention-relay';
import type { BundleState } from '../triage/smart-sort';
import type { Engine } from './engine';
import { DB_RPC, TABLE_FAMILIES } from './protocol';

export interface CachedImapAccount {
  relay_id: string;
  address: string;
  name: string;
  mailbox: string | null;
  uid_validity: string | null;
  can_send?: boolean;
  messages: RelayMessage[];
}

export interface AttentionCache {
  paired: boolean;
  accounts: CachedImapAccount[];
  states: Record<string, BundleState>;
}

const PREFETCH_COUNT = 5;
const BODY_CACHE_LIMIT = 100;
const BODY_CACHE_BYTES = 64 * 1024 * 1024;
const BODY_CHARACTERS = 512_000;

export function makeAttentionHandlers(engine: Engine, broadcaster: { touch: (table: string) => void },
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {
  const relay = new AttentionRelay(fetcher);
  const refreshing = new Map<number, Promise<string[]>>();
  const relayOperations = new Map<number, Promise<unknown>>();
  const prefetching = new Set<number>();

  function serializeRelayOperation<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    const previous = relayOperations.get(ownerId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    relayOperations.set(ownerId, pending);
    return pending.finally(() => {
      if (relayOperations.get(ownerId) === pending) relayOperations.delete(ownerId);
    });
  }

  async function isPaired(ownerId: number) {
    return Boolean(await engine.get(
      'SELECT 1 FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId],
    ));
  }

  async function requirePairing(ownerId: number) {
    if (!await isPaired(ownerId)) {
      throw new AttentionRelayError(401, 'unauthorized', 'Pair this browser to manage IMAP accounts.');
    }
  }

  async function readBody(ownerId: number, location: ImapMessageLocation, cachedOnly = false): Promise<RelayMessageBody | null> {
    const { accountId, mailbox, uidValidity, uid } = location;
    const key = [ownerId, accountId, mailbox, uidValidity, uid];
    const record = await engine.get(
      `SELECT body_text, body_html FROM attention_imap_bodies WHERE owner_account_id = ?
       AND relay_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`, key,
    );
    const cached = record ? {
      text: String(record.body_text), html: record.body_html == null ? null : String(record.body_html),
    } : null;
    if (cachedOnly || cached?.html != null) return cached;
    const snapshot = await engine.get(
      `SELECT 1 FROM attention_imap_accounts WHERE owner_account_id = ?
       AND relay_id = ? AND mailbox = ? AND uid_validity = ?`, key.slice(0, 4),
    );
    if (!snapshot || !await isPaired(ownerId)) {
      throw new Error('Refresh Attention before opening this message.');
    }
    let body: RelayMessageBody;
    try {
      const downloaded = await relay.body(location);
      body = { text: downloaded.text.slice(0, BODY_CHARACTERS), html: downloaded.html ?? '' };
    } catch (cause) {
      if (cached) return cached;
      throw cause;
    }
    await engine.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO attention_imap_bodies
           (owner_account_id, relay_id, mailbox, uid_validity, uid, body_text, body_html, cached_at)
         SELECT ?, relay_id, mailbox, uid_validity, ?, ?, ?, ? FROM attention_imap_accounts
         WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?
         ON CONFLICT (owner_account_id, relay_id, mailbox, uid_validity, uid) DO UPDATE SET
           body_text = excluded.body_text, body_html = excluded.body_html, cached_at = excluded.cached_at
         WHERE attention_imap_bodies.body_html IS NULL`,
        [ownerId, uid, body.text, body.html, Date.now(), ...key.slice(0, 4)],
      );
      await tx.run(
        `DELETE FROM attention_imap_bodies WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER newest AS position,
                    SUM(octet_length(body_text) + COALESCE(octet_length(body_html), 0)) OVER newest AS total_bytes
             FROM attention_imap_bodies WHERE owner_account_id = ? AND relay_id = ?
             WINDOW newest AS (ORDER BY cached_at DESC, rowid DESC)
           ) WHERE position > ? OR total_bytes > ?
         )`, [ownerId, accountId, BODY_CACHE_LIMIT, BODY_CACHE_BYTES],
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
        const { mailbox, uidValidity, messages, canSend } = result.value;
        await tx.run(
          `INSERT INTO attention_imap_accounts
           (owner_account_id, relay_id, address, name, mailbox, uid_validity, messages_json, can_send)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_account_id, relay_id) DO UPDATE SET
             address = excluded.address, name = excluded.name, mailbox = excluded.mailbox,
             uid_validity = excluded.uid_validity, messages_json = excluded.messages_json, can_send = excluded.can_send`,
          [ownerId, account.id, account.email, account.name || account.email, mailbox, uidValidity, JSON.stringify(messages), Number(canSend === true)],
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
      pending = serializeRelayOperation(ownerId, () => refresh(ownerId)).finally(() => refreshing.delete(ownerId));
      refreshing.set(ownerId, pending);
    }
    return pending;
  }

  function terminalImapAction(type: string, message: string) {
    return { ok: false, error: { type, message, terminal: true } };
  }

  async function applyImapAction(ownerId: number, location: ImapMessageLocation, action: ImapAttentionAction) {
    if (location?.mailbox !== 'INBOX' || typeof location.accountId !== 'string' || typeof location.uidValidity !== 'string'
      || !Number.isSafeInteger(location.uid) || location.uid < 1 || location.uid > 0xffffffff
      || !(action?.type === 'trash' || action?.type === 'archive' || action?.type === 'junk' || action?.type === 'tags'
        || ((action?.type === 'star' || action?.type === 'seen') && typeof action.value === 'boolean'))) {
      return terminalImapAction('invalidArguments', 'The pending IMAP change is invalid.');
    }
    if (!await isPaired(ownerId)) {
      return terminalImapAction('imapNotPaired', 'Connect the mail relay to update IMAP mail.');
    }
    const key = [ownerId, location.accountId, location.mailbox, location.uidValidity];
    const snapshot = await engine.get(
      `SELECT messages_json FROM attention_imap_accounts
       WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?`, key,
    );
    if (!snapshot) return terminalImapAction('imapMailboxChanged', 'This mailbox changed. Refresh Attention and reopen the message.');

    let flags: Awaited<ReturnType<AttentionRelay['mutate']>>;
    try {
      flags = await relay.mutate(location, action);
    } catch (error) {
      if (error instanceof AttentionRelayError
        && (error.status < 500 || ['move_not_supported', 'authentication_failed'].includes(error.code))) {
        return terminalImapAction(error.code, error.message);
      }
      throw error;
    }

    const messages: RelayMessage[] = JSON.parse(String(snapshot.messages_json));
    const tagUpdate = flags?.tagsApplied;
    const confirmed = flags && { seen: flags.seen, flagged: flags.flagged,
      ...(flags.keywords ? { keywords: flags.keywords } : {}), ...(flags.labels ? { labels: flags.labels } : {}) };
    const next = confirmed
      ? messages.map((message) => message.uid === location.uid ? { ...message, ...confirmed } : message)
      : messages.filter((message) => message.uid !== location.uid);
    await engine.transaction(async (tx) => {
      await tx.run(
        `UPDATE attention_imap_accounts SET messages_json = ?
         WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?`,
        [JSON.stringify(next), ...key],
      );
      if (!flags) {
        await tx.run(
          `DELETE FROM attention_imap_bodies
           WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`,
          [...key, location.uid],
        );
      }
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    if (tagUpdate === false) return terminalImapAction('tag_update_rejected', 'The mail server rejected the tag change.');
    if (flags && (action.type === 'star' || action.type === 'seen') && flags[action.type === 'star' ? 'flagged' : 'seen'] !== action.value) {
      return terminalImapAction('imapFlagRejected', 'The IMAP server did not apply the requested flag.');
    }
    return { ok: true };
  }

  async function ensureImapSend(ownerId: number, accountId: string, draft: AttentionImapDraft): Promise<number> {
    const requestJson = JSON.stringify({ accountId, draft });
    return engine.transaction(async (tx) => {
      const active = await tx.get(
        `SELECT id, json_remove(request_json, '$.cancelled') AS request_json FROM pending_mutations
         WHERE account_id = ? AND mutation_type = ? AND local_status IN ('pending', 'retry', 'in_flight')
           AND json_extract(request_json, '$.accountId') = ? AND json_extract(request_json, '$.draft.requestId') = ?`,
        [ownerId, MUTATION_TYPE.ATTENTION_IMAP_SEND, accountId, draft.requestId],
      );
      if (active) {
        if (active.request_json !== requestJson) throw new Error('An earlier send used this request.');
        return Number(active.id);
      }
      const now = Date.now();
      const result = await tx.run(
        `INSERT INTO pending_mutations (account_id, mutation_type, local_status, request_json, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?)`, [ownerId, MUTATION_TYPE.ATTENTION_IMAP_SEND, requestJson, now, now],
      );
      return Number(result.lastInsertRowid);
    });
  }

  async function applyImapSend(ownerId: number, accountId: string, draft: AttentionImapDraft, cancelled: boolean) {
    if (cancelled) return terminalImapAction('unauthorized', 'The mail relay disconnected before this message was sent.');
    if (!draft?.requestId || !await isPaired(ownerId)) {
      return terminalImapAction('unauthorized', 'Connect the mail relay to send IMAP mail.');
    }
    const account = await engine.get(
      'SELECT can_send FROM attention_imap_accounts WHERE owner_account_id = ? AND relay_id = ?', [ownerId, accountId],
    );
    if (!account?.can_send) return terminalImapAction('smtp_not_configured', 'This account does not have a sending server.');
    try {
      return { ok: true, result: await relay.submit(accountId, draft) };
    } catch (cause) {
      if (cause instanceof AttentionRelayError) return terminalImapAction(cause.code, cause.message);
      return terminalImapAction('submission_unknown', 'The relay could not confirm delivery. Check the account’s Sent folder before sending again.');
    }
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
          mailbox: String(row.mailbox), uid_validity: String(row.uid_validity), can_send: Boolean(row.can_send),
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
    [DB_RPC.ATTENTION_DISCONNECT]: async ({ ownerId }) => serializeRelayOperation(ownerId, async () => {
      await engine.transaction(async (tx) => {
        await tx.run('DELETE FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId]);
        await tx.run('DELETE FROM attention_imap_accounts WHERE owner_account_id = ?', [ownerId]);
        await tx.run('DELETE FROM pending_mutations WHERE account_id = ? AND mutation_type = ? AND local_status != ?', [
          ownerId, MUTATION_TYPE.ATTENTION_IMAP, 'in_flight',
        ]);
        await tx.run(`UPDATE pending_mutations SET request_json = json_set(request_json, '$.cancelled', 1), updated_at = ?
          WHERE account_id = ? AND mutation_type = ? AND local_status IN ('pending', 'retry')`,
        [Date.now(), ownerId, MUTATION_TYPE.ATTENTION_IMAP_SEND]);
      });
      broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      await relay.disconnect();
    }),
    [DB_RPC.ATTENTION_REFRESH]: async ({ ownerId }) => refreshOnce(ownerId),
    [DB_RPC.ATTENTION_LIST_RELAY_ACCOUNTS]: async ({ ownerId }) => {
      await requirePairing(ownerId);
      return relay.accountSettings();
    },
    [DB_RPC.ATTENTION_START_GOOGLE_OAUTH]: async ({ ownerId, accountId }) => {
      await requirePairing(ownerId);
      return relay.startGoogleOAuth(accountId);
    },
    [DB_RPC.ATTENTION_SAVE_RELAY_ACCOUNT]: async ({ ownerId, account }: { ownerId: number; account: RelayAccountInput }) =>
      serializeRelayOperation(ownerId, async () => {
        await requirePairing(ownerId);
        return relay.saveAccount(account);
      }),
    [DB_RPC.ATTENTION_REMOVE_RELAY_ACCOUNT]: async ({ ownerId, id }: { ownerId: number; id: string }) =>
      serializeRelayOperation(ownerId, async () => {
        await requirePairing(ownerId);
        await relay.removeAccount(id);
        await engine.run(
          'DELETE FROM attention_imap_accounts WHERE owner_account_id = ? AND relay_id = ?', [ownerId, id],
        );
        broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      }),
    [DB_RPC.ATTENTION_BODY]: async ({ ownerId, location, cachedOnly = false }) => readBody(ownerId, location, cachedOnly),
    [DB_RPC.ATTENTION_APPLY_IMAP_ACTION]: async ({ ownerId, location, action }) =>
      serializeRelayOperation(ownerId, () => applyImapAction(ownerId, location, action)),
    [DB_RPC.ATTENTION_ENSURE_IMAP_SEND]: async ({ ownerId, accountId, draft }) => {
      const id = await ensureImapSend(ownerId, accountId, draft);
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      return id;
    },
    [DB_RPC.ATTENTION_APPLY_IMAP_SEND]: async ({ ownerId, accountId, draft, cancelled }) => applyImapSend(ownerId, accountId, draft, cancelled),
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

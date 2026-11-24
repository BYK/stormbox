import { MUTATION_TYPE } from '../constants/states';
import { MAIL_UNDO_MS } from '../constants/mail-actions';
import {
  AttentionRelay, AttentionRelayError, type AttentionImapDraft, type ImapAttentionAction, type ImapMessageLocation,
  type RelayAccount, type RelayAccountInput, type RelayAccountSettings, type RelayFolder, type RelayMessage, type RelayMessageBody, type RelayWindow,
} from '../sync/backends/imap/attention-relay';
import { describeImapAction, isImapMove, projectImapAction } from '../sync/backends/imap/project-action';
import type { BundleState } from '../triage/smart-sort';
import { equalBundleStates, matchingBundleStates, type BundleStates } from '../triage/bundle-state-edits';
import type { Engine } from './engine';
import { DB_RPC, TABLE_FAMILIES } from './protocol';

export interface CachedImapAccount {
  relay_id: string;
  address: string;
  name: string;
  mailbox: string | null;
  uid_validity: string | null;
  can_send?: boolean;
  last_synced_at?: number | null;
  sync_error?: string | null;
  total_messages?: number | null;
  folders?: RelayFolder[];
  messages: RelayMessage[];
}

export interface CachedImapFolder {
  uidValidity: string;
  messages: RelayMessage[];
  total: number | null;
  syncedAt: number;
}

export interface AttentionCache {
  paired: boolean;
  accounts: CachedImapAccount[];
  states: Record<string, BundleState>;
  actionFailure?: ImapActionFailure | null;
}

export interface ImapActionFailure {
  id: number;
  accountId: string;
  message: string;
  updatedAt: number;
  canRetry: boolean;
}

const PREFETCH_COUNT = 5;
const BODY_CACHE_LIMIT = 100;
const BODY_CACHE_BYTES = 64 * 1024 * 1024;
const BODY_CHARACTERS = 512_000;

function accountSettings({ id, email, name, managed, host, port, mode, user, auth }: RelayAccount): RelayAccount {
  return { id, email, name, managed, host, port, mode, user, auth };
}

const UPSERT_ACCOUNT = `INSERT INTO attention_imap_accounts (owner_account_id, relay_id, address, name)
  VALUES (?, ?, ?, ?) ON CONFLICT (owner_account_id, relay_id) DO UPDATE SET
    address = excluded.address, name = excluded.name`;

export interface ImapActionRequest {
  location: ImapMessageLocation;
  action: ImapAttentionAction;
}

type PendingImapAction = ImapActionRequest & { cancelled?: number };
type Connection = Pick<Engine, 'all'>;

const SUPERSEDES_IMAP_EDIT = `
  json_extract(earlier.request_json, '$.location.accountId') = json_extract(later.request_json, '$.location.accountId')
  AND (
    (json_extract(earlier.request_json, '$.location.mailbox') = json_extract(later.request_json, '$.location.mailbox')
      AND json_extract(earlier.request_json, '$.location.uidValidity') = json_extract(later.request_json, '$.location.uidValidity')
      AND json_extract(earlier.request_json, '$.location.uid') = json_extract(later.request_json, '$.location.uid'))
    OR (json_extract(earlier.request_json, '$.accountScoped') = 1
      AND json_extract(later.request_json, '$.accountScoped') = 1
      AND json_extract(earlier.request_json, '$.messageId') = json_extract(later.request_json, '$.messageId'))
  )
  AND (
    json_extract(earlier.request_json, '$.action.type') = json_extract(later.request_json, '$.action.type')
    OR json_extract(earlier.request_json, '$.action.type') IN ('trash', 'archive', 'junk')
    OR json_extract(later.request_json, '$.action.type') IN ('trash', 'archive', 'junk')
  )`;

const IMAP_CAN_RETRY = `json_extract(earlier.request_json, '$.superseded') IS NOT 1
  AND json_extract(earlier.error_json, '$.type') IS NOT 'imapMailboxChanged'
  AND NOT EXISTS (SELECT 1 FROM pending_mutations later
    WHERE later.account_id = earlier.account_id AND later.mutation_type = earlier.mutation_type
      AND later.id > earlier.id AND json_extract(later.request_json, '$.cancelled') IS NOT 1
      AND ${SUPERSEDES_IMAP_EDIT})`;

async function readImapActionFailures(db: Connection, ownerId: number, limit: number): Promise<ImapActionFailure[]> {
  const rows = await db.all(`SELECT earlier.id, a.relay_id AS account_id, earlier.updated_at,
      json_extract(earlier.request_json, '$.action') AS action_json,
      json_extract(earlier.request_json, '$.subject') AS subject,
      json_extract(earlier.error_json, '$.message') AS message, (${IMAP_CAN_RETRY}) AS can_retry
    FROM pending_mutations earlier JOIN attention_imap_accounts a
      ON a.owner_account_id = earlier.account_id AND a.relay_id = json_extract(earlier.request_json, '$.location.accountId')
    WHERE earlier.account_id = ? AND earlier.mutation_type = ? AND earlier.local_status = 'conflicted'
    ORDER BY earlier.updated_at DESC, earlier.id DESC LIMIT ?`, [ownerId, MUTATION_TYPE.ATTENTION_IMAP, limit]);
  return rows.map((row) => {
    const action = JSON.parse(String(row.action_json ?? 'null')) as ImapAttentionAction | null;
    const detail = row.message == null ? '' : String(row.message);
    const attempt = action && row.subject != null && describeImapAction(action, `“${row.subject || '(no subject)'}”`)?.attempt;
    const message = attempt ? `Couldn’t ${attempt}.${detail ? ` ${detail}` : ''}` : detail || 'Could not update this IMAP message.';
    return { id: Number(row.id), accountId: String(row.account_id), updatedAt: Number(row.updated_at),
      message, canRetry: Boolean(row.can_retry) };
  });
}

function validImapAction(location: ImapMessageLocation, action: ImapAttentionAction) {
  if (typeof location?.mailbox !== 'string' || !location.mailbox || typeof location.accountId !== 'string'
    || typeof location.uidValidity !== 'string' || !Number.isSafeInteger(location.uid)
    || location.uid < 1 || location.uid > 0xffffffff || !action) return false;
  if (isImapMove(action)) return true;
  if (action.type === 'star' || action.type === 'seen') return typeof action.value === 'boolean';
  return action.type === 'tags' && Boolean(action.tags)
    && [action.tags.add, action.tags.remove, action.tags.addLabels, action.tags.removeLabels].every((items) =>
      items === undefined || (Array.isArray(items) && items.every((item) => typeof item === 'string')));
}

function folderKey(accountId: string, mailbox: string | null, uidValidity: string | null) {
  return JSON.stringify([accountId, mailbox, uidValidity]);
}

async function pendingActions(db: Connection, ownerId: number) {
  const rows = await db.all(`SELECT request_json FROM pending_mutations
    WHERE account_id = ? AND mutation_type = ? AND local_status IN ('pending', 'retry', 'in_flight')
      AND json_valid(request_json)
    ORDER BY id`, [ownerId, MUTATION_TYPE.ATTENTION_IMAP]);
  const byFolder = new Map<string, PendingImapAction[]>();
  for (const row of rows) {
    const request = JSON.parse(String(row.request_json)) as PendingImapAction | null;
    if (!request || request.cancelled === 1 || !validImapAction(request.location, request.action)) continue;
    const { accountId, mailbox, uidValidity } = request.location;
    const key = folderKey(accountId, mailbox, uidValidity);
    const actions = byFolder.get(key);
    if (actions) actions.push(request);
    else byFolder.set(key, [request]);
  }
  return byFolder;
}

function projectFolder(row: Record<string, unknown>, actions: ImapActionRequest[] = []) {
  const messages = JSON.parse(String(row.messages_json)) as RelayMessage[];
  const total = row.total_messages == null ? null : Number(row.total_messages);
  if (actions.length === 0) return { messages, total };

  // Keep the last server snapshot intact so rejection rolls back the local
  // projection, and keep applying it when a refresh replaces that snapshot.
  const byUid = new Map(messages.map((message) => [message.uid, message]));
  for (const { location: { uid }, action } of actions) {
    const message = byUid.get(uid);
    if (!message) continue;
    const next = projectImapAction(message, action);
    if (next) byUid.set(uid, next);
    else byUid.delete(uid);
  }
  return {
    messages: [...byUid.values()],
    total: total == null ? null : Math.max(0, total - (messages.length - byUid.size)),
  };
}

async function cancelImapActions(db: Pick<Engine, 'run'>, ownerId: number, accountId?: string) {
  const selection = accountId == null ? '' : "AND json_extract(request_json, '$.location.accountId') = ?";
  const params = [ownerId, MUTATION_TYPE.ATTENTION_IMAP, ...(accountId == null ? [] : [accountId])];
  // Keep the ID reserved until the runner notices cancellation. A claimed
  // mutation may still be waiting behind a folder sync when disconnect wins.
  await db.run(`UPDATE pending_mutations SET request_json = json_set(request_json, '$.cancelled', 1),
      not_before = NULL, updated_at = ?
    WHERE account_id = ? AND mutation_type = ? ${selection}
      AND local_status IN ('pending', 'retry', 'in_flight')`, [Date.now(), ...params]);
  await db.run(`DELETE FROM pending_mutations WHERE account_id = ? AND mutation_type = ? ${selection}
    AND local_status NOT IN ('pending', 'retry', 'in_flight')`, params);
}

export function makeAttentionHandlers(engine: Engine, broadcaster: { touch: (table: string) => void },
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  notifyMutation: (accountId: number, mutationId?: number) => void = () => {}) {
  const relay = new AttentionRelay(fetcher);
  const refreshing = new Map<number, { version: number; pending: Promise<string[]> }>();
  const relayOperations = new Map<number, Promise<unknown>>();
  const folderOperations = new Map<string, Promise<unknown>>();
  const prefetching = new Set<number>();
  const settingsVersions = new Map<number, number>();
  const loadingSettings = new Map<number, { version: number; pending: Promise<RelayAccountSettings> }>();

  function settingsVersion(ownerId: number) {
    return settingsVersions.get(ownerId) ?? 0;
  }

  function invalidateSettings(ownerId: number) {
    settingsVersions.set(ownerId, settingsVersion(ownerId) + 1);
  }

  function serializeOperation<Key, T>(
    operations: Map<Key, Promise<unknown>>, key: Key, operation: () => Promise<T>,
  ): Promise<T> {
    const previous = operations.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    operations.set(key, pending);
    return pending.finally(() => {
      if (operations.get(key) === pending) operations.delete(key);
    });
  }

  function serializeRelayOperation<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    return serializeOperation(relayOperations, ownerId, operation);
  }

  function serializeFolderOperation<T>(ownerId: number, accountId: string, mailbox: string,
    operation: () => Promise<T>): Promise<T> {
    return serializeOperation(folderOperations, JSON.stringify([ownerId, accountId, mailbox]), operation);
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

  function folderTable(mailbox: string) {
    return mailbox === 'INBOX' ? 'attention_imap_accounts' : 'imap_folder_windows';
  }

  async function readBody(ownerId: number, location: ImapMessageLocation, cachedOnly = false): Promise<RelayMessageBody | null> {
    const version = settingsVersion(ownerId);
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
      `SELECT 1 FROM ${folderTable(mailbox)} WHERE owner_account_id = ?
       AND relay_id = ? AND mailbox = ? AND uid_validity = ?`, key.slice(0, 4),
    );
    if (!snapshot || !await isPaired(ownerId)) {
      throw new Error('Refresh this folder before opening the message.');
    }
    let body: RelayMessageBody;
    try {
      const downloaded = await relay.body(location);
      body = { text: downloaded.text.slice(0, BODY_CHARACTERS), html: downloaded.html ?? '' };
    } catch (cause) {
      if (cached) return cached;
      throw cause;
    }
    const saved = await engine.transaction(async (tx) => {
      if (version !== settingsVersion(ownerId)) return false;
      await tx.run(
        `INSERT INTO attention_imap_bodies
           (owner_account_id, relay_id, mailbox, uid_validity, uid, body_text, body_html, cached_at)
         SELECT ?, relay_id, mailbox, uid_validity, ?, ?, ?, ? FROM ${folderTable(mailbox)}
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
      return true;
    });
    if (!saved) {
      const current = await engine.get(
        `SELECT 1 FROM ${folderTable(mailbox)} WHERE owner_account_id = ?
         AND relay_id = ? AND mailbox = ? AND uid_validity = ?`, key.slice(0, 4),
      );
      return current ? body : cached;
    }
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    return body;
  }

  function readRelaySettings(ownerId: number): Promise<RelayAccountSettings & { paired: boolean }> {
    return engine.transaction(async (tx) => {
      const pairing = await tx.get(`SELECT s.settings_json FROM attention_imap_pairing p
        LEFT JOIN attention_imap_settings s ON s.owner_account_id = p.owner_account_id
        WHERE p.owner_account_id = ?`, [ownerId]);
      if (!pairing) return { paired: false, accounts: [] };
      if (pairing.settings_json != null) return { ...JSON.parse(String(pairing.settings_json)), paired: true };
      const accounts = await tx.all(`SELECT relay_id AS id, address AS email, name
        FROM attention_imap_accounts WHERE owner_account_id = ? ORDER BY name, relay_id`, [ownerId]);
      return { paired: true, accounts };
    });
  }

  async function updateStoredSettings(
    tx: Pick<Engine, 'get' | 'run'>, ownerId: number, id: string, replacement?: RelayAccount,
  ) {
    const row = await tx.get('SELECT settings_json FROM attention_imap_settings WHERE owner_account_id = ?', [ownerId]);
    if (row?.settings_json == null) return;
    const settings: RelayAccountSettings = JSON.parse(String(row.settings_json));
    settings.accounts = settings.accounts.filter((account) => account.id !== id);
    if (replacement) settings.accounts.push(replacement);
    await tx.run('UPDATE attention_imap_settings SET settings_json = ? WHERE owner_account_id = ?', [
      JSON.stringify(settings), ownerId,
    ]);
  }

  function refreshRelaySettings(ownerId: number) {
    const version = settingsVersion(ownerId);
    const current = loadingSettings.get(ownerId);
    if (current?.version === version) return current.pending;
    const pending = fetchRelaySettings(ownerId, version).finally(() => {
      if (loadingSettings.get(ownerId)?.pending === pending) loadingSettings.delete(ownerId);
    });
    loadingSettings.set(ownerId, { version, pending });
    return pending;
  }

  async function fetchRelaySettings(ownerId: number, version: number): Promise<RelayAccountSettings> {
    await requirePairing(ownerId);
    const settings = await relay.accountSettings();
    const accounts = settings.accounts.map(accountSettings);
    const snapshot = { accounts, googleOAuth: settings.googleOAuth === true };
    const saved = await engine.transaction(async (tx) => {
      if (version !== settingsVersion(ownerId)) return false;
      const retained = new Set(accounts.map((account) => account.id));
      for (const row of await tx.all('SELECT relay_id FROM attention_imap_accounts WHERE owner_account_id = ?', [ownerId])) {
        if (!retained.has(String(row.relay_id))) {
          await tx.run('DELETE FROM attention_imap_accounts WHERE owner_account_id = ? AND relay_id = ?', [ownerId, row.relay_id]);
        }
      }
      for (const account of accounts) {
        await tx.run(UPSERT_ACCOUNT,
          [ownerId, account.id, account.email, account.name || account.email],
        );
      }
      await tx.run(`INSERT INTO attention_imap_settings (owner_account_id, settings_json) VALUES (?, ?)
        ON CONFLICT (owner_account_id) DO UPDATE SET settings_json = excluded.settings_json`, [
        ownerId, JSON.stringify(snapshot),
      ]);
      return true;
    });
    if (!saved) {
      const { accounts, googleOAuth } = await readRelaySettings(ownerId);
      return { accounts, googleOAuth };
    }
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    return snapshot;
  }

  async function refresh(ownerId: number, version: number): Promise<string[]> {
    if (!await isPaired(ownerId)) return [];
    const { accounts } = await refreshRelaySettings(ownerId);
    const windows = await Promise.allSettled(accounts.map((account) =>
      serializeFolderOperation(ownerId, account.id, 'INBOX', () => refreshInbox(ownerId, account, version))));
    if (!prefetching.has(ownerId)) {
      prefetching.add(ownerId);
      void prefetch(ownerId, accounts, windows).finally(() => prefetching.delete(ownerId));
    }
    return accounts.filter((_account, index) => windows[index].status === 'rejected').map(({ email }) => email);
  }

  async function refreshInbox(ownerId: number, account: RelayAccount, version: number) {
    if (version !== settingsVersion(ownerId)) return;
    const identity = [ownerId, account.id];
    let window: RelayWindow;
    try {
      window = await relay.inbox(account.id);
    } catch (cause) {
      const message = cause instanceof AttentionRelayError
        ? cause.message : 'Could not reach the IMAP relay. Try refreshing again.';
      await engine.transaction(async (tx) => {
        if (version !== settingsVersion(ownerId)) return;
        await tx.run(
          'UPDATE attention_imap_accounts SET sync_error = ? WHERE owner_account_id = ? AND relay_id = ?',
          [message, ...identity],
        );
      });
      broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      throw cause;
    }
    const { mailbox, uidValidity, messages, canSend, total } = window;
    const saved = await engine.transaction(async (tx) => {
      if (version !== settingsVersion(ownerId)) return false;
      await tx.run(
        `UPDATE attention_imap_accounts SET mailbox = ?, uid_validity = ?, messages_json = ?, can_send = ?,
           last_synced_at = ?, total_messages = ?, sync_error = NULL
         WHERE owner_account_id = ? AND relay_id = ?`,
        [mailbox, uidValidity, JSON.stringify(messages), Number(canSend === true), Date.now(), total ?? null, ...identity],
      );
      await tx.run(
        `DELETE FROM attention_imap_bodies WHERE owner_account_id = ? AND relay_id = ?
         AND mailbox = ? AND uid_validity IS NOT ?`, [...identity, mailbox, uidValidity],
      );
      return true;
    });
    if (saved) await resumeImapActions(ownerId, account.id, true);
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    return saved ? window : undefined;
  }

  async function prefetch(ownerId: number, accounts: Awaited<ReturnType<AttentionRelay['accounts']>>,
    windows: PromiseSettledResult<RelayWindow | undefined>[]) {
    for (const [index, result] of windows.entries()) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { mailbox, uidValidity, messages } = result.value;
      for (const { uid } of messages.slice(0, PREFETCH_COUNT)) {
        await readBody(ownerId, { accountId: accounts[index].id, mailbox, uidValidity, uid }).catch(() => {});
      }
    }
  }

  function refreshOnce(ownerId: number) {
    const version = settingsVersion(ownerId);
    const current = refreshing.get(ownerId);
    if (current?.version === version) return current.pending;
    const pending = refresh(ownerId, version).finally(() => {
      if (refreshing.get(ownerId)?.pending === pending) refreshing.delete(ownerId);
    });
    refreshing.set(ownerId, { version, pending });
    return pending;
  }

  async function listFolders(ownerId: number, accountId: string) {
    const version = settingsVersion(ownerId);
    await requirePairing(ownerId);
    const folders = await relay.folders(accountId);
    await engine.transaction(async (tx) => {
      if (version !== settingsVersion(ownerId)) return;
      await tx.run(`UPDATE attention_imap_accounts SET folders_json = ?
        WHERE owner_account_id = ? AND relay_id = ?`, [JSON.stringify(folders), ownerId, accountId]);
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
  }

  async function getFolder(ownerId: number, accountId: string, mailbox: string): Promise<CachedImapFolder | null> {
    return engine.transaction(async (tx) => {
      const account = await tx.get(`SELECT messages_json, uid_validity, total_messages, cached_at FROM imap_folder_windows
        WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ?`, [ownerId, accountId, mailbox]);
      if (!account) return null;
      const uidValidity = String(account.uid_validity);
      const actions = await pendingActions(tx, ownerId);
      return {
        uidValidity, ...projectFolder(account, actions.get(folderKey(accountId, mailbox, uidValidity))),
        syncedAt: Number(account.cached_at),
      };
    });
  }

  async function refreshFolder(ownerId: number, accountId: string, mailbox: string) {
    const version = settingsVersion(ownerId);
    await requirePairing(ownerId);
    const { uidValidity, messages, total }: RelayWindow = await relay.folder(accountId, mailbox, 100);
    await engine.transaction(async (tx) => {
      if (version !== settingsVersion(ownerId)) return;
      await tx.run(`INSERT INTO imap_folder_windows
        (owner_account_id, relay_id, mailbox, uid_validity, messages_json, total_messages, cached_at)
        SELECT owner_account_id, relay_id, ?, ?, ?, ?, ? FROM attention_imap_accounts
        WHERE owner_account_id = ? AND relay_id = ?
        ON CONFLICT (owner_account_id, relay_id, mailbox) DO UPDATE SET
          uid_validity = excluded.uid_validity, messages_json = excluded.messages_json,
          total_messages = excluded.total_messages, cached_at = excluded.cached_at`,
      [mailbox, uidValidity, JSON.stringify(messages), total ?? null, Date.now(), ownerId, accountId]);
      await tx.run(`DELETE FROM attention_imap_bodies WHERE owner_account_id = ? AND relay_id = ?
        AND mailbox = ? AND uid_validity IS NOT ?`, [ownerId, accountId, mailbox, uidValidity]);
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    return getFolder(ownerId, accountId, mailbox);
  }

  function terminalImapAction(type: string, message: string) {
    return { ok: false, error: { type, message, terminal: true } };
  }

  async function resumeImapActions(ownerId: number, accountId?: string, authenticationOnly = false) {
    const { changes } = await engine.run(`UPDATE pending_mutations SET not_before = NULL
      WHERE account_id = ? AND mutation_type = ? AND local_status = 'retry'
        AND (? IS NULL OR json_extract(request_json, '$.location.accountId') = ?)
        AND (? = 0 OR json_extract(error_json, '$.type') IN ('imapReconnectRequired', 'authenticationFailed'))`,
    [ownerId, MUTATION_TYPE.ATTENTION_IMAP, accountId ?? null, accountId ?? null, Number(authenticationOnly)]);
    if (!authenticationOnly || changes > 0) notifyMutation(ownerId);
  }

  async function enqueueImapActions(ownerId: number, requests: readonly ImapActionRequest[],
    { undoable = false, retryOf }: { undoable?: boolean; retryOf?: number } = {}) {
    if (!Array.isArray(requests)) throw new Error('The IMAP change is invalid.');
    if (requests.length === 0 && retryOf == null) return { mutationIds: [] };
    const mutationIds = await engine.transaction(async (tx) => {
      const paired = await tx.get('SELECT 1 FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId]);
      if (!paired) throw new Error('Connect the mail relay to update IMAP mail.');
      let targetRequests = requests;
      if (retryOf != null) {
        const failed = await tx.get(`SELECT request_json FROM pending_mutations earlier
          WHERE id = ? AND account_id = ? AND mutation_type = ? AND local_status = 'conflicted' AND ${IMAP_CAN_RETRY}`,
        [retryOf, ownerId, MUTATION_TYPE.ATTENTION_IMAP]);
        if (!failed) throw new Error('This mail change was replaced by a newer action or is no longer available.');
        targetRequests = [JSON.parse(String(failed.request_json)) as ImapActionRequest];
      }
      const actions = await pendingActions(tx, ownerId);
      const messagesByFolder = new Map<string, Map<number, RelayMessage>>();
      const queued: Array<ImapActionRequest & { accountScoped?: true; messageId?: string; undoable?: true; subject?: string }> = [];
      for (const request of targetRequests) {
        if (!request || !validImapAction(request.location, request.action)) throw new Error('The IMAP change is invalid.');
        const { location, action } = request;
        const { accountId, mailbox, uidValidity, uid } = location;
        const key = folderKey(accountId, mailbox, uidValidity);
        let messages = messagesByFolder.get(key);
        if (!messages) {
          const snapshot = await tx.get(
            `SELECT messages_json FROM ${folderTable(mailbox)}
             WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?`,
            [ownerId, accountId, mailbox, uidValidity],
          );
          if (!snapshot) throw new Error('This mailbox changed. Refresh this folder and reopen the message.');
          const projected = projectFolder(snapshot, actions.get(key));
          messages = new Map(projected.messages.map((message) => [message.uid, message]));
          messagesByFolder.set(key, messages);
        }
        const message = messages.get(uid);
        if (!message) throw new Error('This message is no longer in this folder.');
        // Gmail shares flags and labels across mailbox views with different UIDs.
        const accountScoped = message.gmailLabels === true || Boolean(message.labels?.length);
        queued.push({ location, action,
          ...(accountScoped && { accountScoped, ...(message.messageId && { messageId: message.messageId }) }),
          ...(undoable && { undoable: true }),
          ...(typeof message.subject === 'string' && { subject: message.subject.slice(0, 200) }),
        });
        if (isImapMove(action)) messages.delete(uid);
      }
      const now = Date.now();
      const rows: { id: number }[] = await tx.all(
        `INSERT INTO pending_mutations (account_id, mutation_type, local_status, request_json, created_at, updated_at, not_before)
         SELECT ?, ?, 'pending', value, ?, ?, ? FROM json_each(?) ORDER BY CAST(key AS INTEGER)
         RETURNING id`, [ownerId, MUTATION_TYPE.ATTENTION_IMAP, now, now, undoable ? now + MAIL_UNDO_MS : null, JSON.stringify(queued)],
      );
      if (retryOf != null) await tx.run('DELETE FROM pending_mutations WHERE id = ?', [retryOf]);
      return rows.map(({ id }) => Number(id)).sort((a, b) => a - b);
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
    notifyMutation(ownerId, mutationIds[0]);
    return { mutationIds };
  }

  async function undoImapActions(ownerId: number, mutationIds: readonly number[]) {
    if (!Array.isArray(mutationIds) || !mutationIds.length || !mutationIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new Error('This mail change cannot be undone.');
    }
    const ids = [...new Set(mutationIds)];
    await engine.transaction(async (tx) => {
      const result = await tx.run(`DELETE FROM pending_mutations
        WHERE account_id = ? AND mutation_type = ? AND local_status = 'pending' AND attempts = 0
          AND json_extract(request_json, '$.undoable') = 1 AND json_extract(request_json, '$.cancelled') IS NOT 1
          AND id IN (SELECT value FROM json_each(?))`, [ownerId, MUTATION_TYPE.ATTENTION_IMAP, JSON.stringify(ids)]);
      if (result.changes !== ids.length) throw new Error('This mail change has already started syncing.');
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
    notifyMutation(ownerId);
  }

  async function settleImapAction(mutationId: number, error?: { type?: string; message?: string }) {
    await engine.transaction(async (tx) => {
      if (error) {
        const result = await tx.run(`UPDATE pending_mutations SET local_status = 'conflicted', not_before = NULL,
            error_json = ?, updated_at = ? WHERE id = ? AND mutation_type = ?
            AND json_extract(request_json, '$.cancelled') IS NOT 1`,
        [JSON.stringify(error), Date.now(), mutationId, MUTATION_TYPE.ATTENTION_IMAP]);
        if (result.changes) return;
      } else {
        await tx.run(`UPDATE pending_mutations AS earlier
          SET request_json = json_set(request_json, '$.superseded', 1)
          WHERE earlier.mutation_type = ? AND earlier.local_status = 'conflicted' AND earlier.id < ?
            AND EXISTS (SELECT 1 FROM pending_mutations later WHERE later.id = ?
              AND later.account_id = earlier.account_id AND later.mutation_type = earlier.mutation_type
              AND json_extract(later.request_json, '$.cancelled') IS NOT 1 AND ${SUPERSEDES_IMAP_EDIT})`,
        [MUTATION_TYPE.ATTENTION_IMAP, mutationId, mutationId]);
      }
      await tx.run('DELETE FROM pending_mutations WHERE id = ? AND mutation_type = ?',
        [mutationId, MUTATION_TYPE.ATTENTION_IMAP]);
    });
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
  }

  async function activeImapAction(db: Pick<Engine, 'get'>, ownerId: number, mutationId?: number) {
    return mutationId == null || Boolean(await db.get(`SELECT 1 FROM pending_mutations WHERE id = ? AND account_id = ?
      AND local_status = 'in_flight' AND json_extract(request_json, '$.cancelled') IS NOT 1`, [mutationId, ownerId]));
  }

  async function applyImapAction(ownerId: number, location: ImapMessageLocation, action: ImapAttentionAction,
    mutationId?: number) {
    if (!await isPaired(ownerId)) {
      return terminalImapAction('imapNotPaired', 'Connect the mail relay to update IMAP mail.');
    }
    const key = [ownerId, location.accountId, location.mailbox, location.uidValidity];
    const snapshot = await engine.get(
      `SELECT messages_json FROM ${folderTable(location.mailbox)}
       WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?`, key,
    );
    if (!snapshot) return terminalImapAction('imapMailboxChanged', 'This mailbox changed. Refresh this folder and reopen the message.');
    if (!await activeImapAction(engine, ownerId, mutationId)) return { ok: true };
    const messages: RelayMessage[] = JSON.parse(String(snapshot.messages_json));

    // The message may have aged out of the cached window while queued.
    // The relay verifies UIDVALIDITY and resolves the UID on the server.
    let flags: Awaited<ReturnType<AttentionRelay['mutate']>>;
    try {
      flags = await relay.mutate(location, action);
    } catch (error) {
      if (error instanceof AttentionRelayError) {
        if (error.status === 401 || error.code === 'authentication_failed' || error.code === 'google_reconnect_required') {
          return { ok: false, error: { type: 'imapReconnectRequired', message: error.message } };
        }
        if ((error.status < 500 && error.status !== 408 && error.status !== 429) || error.code === 'move_not_supported') {
          return terminalImapAction(error.code, error.message);
        }
      }
      throw error;
    }

    const tagUpdate = flags?.tagsApplied;
    const confirmed = flags && { seen: flags.seen, flagged: flags.flagged,
      ...(flags.keywords ? { keywords: flags.keywords } : {}), ...(flags.labels ? { labels: flags.labels } : {}) };
    const next = confirmed
      ? messages.map((message) => message.uid === location.uid ? { ...message, ...confirmed } : message)
      : messages.filter((message) => message.uid !== location.uid);
    const reconciled = await engine.transaction(async (tx) => {
      if (!await activeImapAction(tx, ownerId, mutationId)) return false;
      await tx.run(
        `UPDATE ${folderTable(location.mailbox)} SET messages_json = ?, total_messages = total_messages - ?
         WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ?`,
        [JSON.stringify(next), messages.length - next.length, ...key],
      );
      if (!flags) {
        await tx.run(
          `DELETE FROM attention_imap_bodies
           WHERE owner_account_id = ? AND relay_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`,
          [...key, location.uid],
        );
      }
      return true;
    });
    if (!reconciled) return { ok: true };
    broadcaster.touch(TABLE_FAMILIES.ATTENTION);
    broadcaster.touch(TABLE_FAMILIES.IMAP_MUTATIONS);
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
      const actions = await pendingActions(tx, ownerId);
      const [failure] = paired ? await readImapActionFailures(tx, ownerId, 1) : [];
      return {
        paired,
        accounts: accounts.map((row) => {
          const relayId = String(row.relay_id);
          const mailbox = row.mailbox == null ? null : String(row.mailbox);
          const uidValidity = row.uid_validity == null ? null : String(row.uid_validity);
          const { messages, total } = projectFolder(row, actions.get(folderKey(relayId, mailbox, uidValidity)));
          return {
            relay_id: relayId, address: String(row.address), name: String(row.name),
            mailbox, uid_validity: uidValidity, can_send: Boolean(row.can_send),
            last_synced_at: row.last_synced_at == null ? null : Number(row.last_synced_at),
            sync_error: row.sync_error == null ? null : String(row.sync_error),
            total_messages: total, folders: JSON.parse(String(row.folders_json)),
            messages: messages.map((message) => {
              const preview = byMessage.get(JSON.stringify([relayId, message.uid]));
              return preview ? { ...message, preview } : message;
            }),
          };
        }),
        states: Object.fromEntries(states.map((row) => [row.bundle_id, JSON.parse(String(row.state_json))])),
        ...(failure && { actionFailure: failure }),
      };
    }),
    [DB_RPC.ATTENTION_IMAP_UNREAD_COUNT]: async ({ ownerId }) => engine.transaction(async (tx) => {
      const accounts = await tx.all(`SELECT relay_id, mailbox, uid_validity, messages_json FROM attention_imap_accounts
        WHERE owner_account_id = ?`, [ownerId]);
      const actions = await pendingActions(tx, ownerId);
      return accounts.reduce((total, row) => {
        const key = folderKey(String(row.relay_id), row.mailbox == null ? null : String(row.mailbox),
          row.uid_validity == null ? null : String(row.uid_validity));
        return total + projectFolder(row, actions.get(key)).messages.filter(({ seen }) => !seen).length;
      }, 0);
    }),
    [DB_RPC.ATTENTION_PAIR]: async ({ ownerId, accessToken, waitForSync = true }) => {
      await serializeRelayOperation(ownerId, async () => {
        await relay.pair(accessToken);
        await engine.run('INSERT OR IGNORE INTO attention_imap_pairing (owner_account_id) VALUES (?)', [ownerId]);
        await resumeImapActions(ownerId, undefined, true);
        broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      });
      const pending = refreshOnce(ownerId);
      if (waitForSync) return pending;
      void pending.catch(() => {});
      return [];
    },
    [DB_RPC.ATTENTION_DISCONNECT]: async ({ ownerId }) => serializeRelayOperation(ownerId, async () => {
      invalidateSettings(ownerId);
      await engine.transaction(async (tx) => {
        await tx.run('DELETE FROM attention_imap_pairing WHERE owner_account_id = ?', [ownerId]);
        await tx.run('DELETE FROM attention_imap_accounts WHERE owner_account_id = ?', [ownerId]);
        await cancelImapActions(tx, ownerId);
        await tx.run(`UPDATE pending_mutations SET request_json = json_set(request_json, '$.cancelled', 1), updated_at = ?
          WHERE account_id = ? AND mutation_type = ? AND local_status IN ('pending', 'retry')`,
        [Date.now(), ownerId, MUTATION_TYPE.ATTENTION_IMAP_SEND]);
      });
      broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
      notifyMutation(ownerId);
      await relay.disconnect();
    }),
    [DB_RPC.ATTENTION_REFRESH]: async ({ ownerId }) => refreshOnce(ownerId),
    [DB_RPC.IMAP_FOLDER_LIST_REFRESH]: async ({ ownerId, accountId }) => listFolders(ownerId, accountId),
    [DB_RPC.IMAP_FOLDER_GET]: async ({ ownerId, accountId, mailbox, refresh: online = false }) => online
      ? serializeFolderOperation(ownerId, accountId, mailbox, () => refreshFolder(ownerId, accountId, mailbox))
      : getFolder(ownerId, accountId, mailbox),
    [DB_RPC.ATTENTION_LIST_RELAY_ACCOUNTS]: async ({ ownerId, cachedOnly = false }) => cachedOnly
      ? readRelaySettings(ownerId) : refreshRelaySettings(ownerId),
    [DB_RPC.ATTENTION_START_GOOGLE_OAUTH]: async ({ ownerId, accountId }) => {
      await requirePairing(ownerId);
      return relay.startGoogleOAuth(accountId);
    },
    [DB_RPC.ATTENTION_SAVE_RELAY_ACCOUNT]: async ({ ownerId, account }: { ownerId: number; account: RelayAccountInput }) =>
      serializeRelayOperation(ownerId, async () => {
        await requirePairing(ownerId);
        const saved = accountSettings(await relay.saveAccount(account));
        invalidateSettings(ownerId);
        await engine.transaction(async (tx) => {
          await tx.run(UPSERT_ACCOUNT, [ownerId, saved.id, saved.email, saved.name || saved.email]);
          await updateStoredSettings(tx, ownerId, saved.id, saved);
        });
        broadcaster.touch(TABLE_FAMILIES.ATTENTION);
        await resumeImapActions(ownerId, saved.id);
        void refreshOnce(ownerId).catch(() => {});
        return saved;
      }),
    [DB_RPC.ATTENTION_REMOVE_RELAY_ACCOUNT]: async ({ ownerId, id }: { ownerId: number; id: string }) =>
      serializeRelayOperation(ownerId, async () => {
        await requirePairing(ownerId);
        await relay.removeAccount(id);
        invalidateSettings(ownerId);
        await engine.transaction(async (tx) => {
          await tx.run('DELETE FROM attention_imap_accounts WHERE owner_account_id = ? AND relay_id = ?', [ownerId, id]);
          await cancelImapActions(tx, ownerId, id);
          await updateStoredSettings(tx, ownerId, id);
        });
        broadcaster.touch(TABLE_FAMILIES.ATTENTION);
        broadcaster.touch(TABLE_FAMILIES.MUTATIONS);
        notifyMutation(ownerId);
      }),
    [DB_RPC.ATTENTION_BODY]: async ({ ownerId, location, cachedOnly = false }) => readBody(ownerId, location, cachedOnly),
    [DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]: async ({ ownerId, location, action, undoable = false }) =>
      enqueueImapActions(ownerId, [{ location, action }], { undoable: undoable === true }),
    [DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTIONS]: async ({ ownerId, requests, undoable = false }) =>
      enqueueImapActions(ownerId, requests, { undoable: undoable === true }),
    [DB_RPC.ATTENTION_UNDO_IMAP_ACTIONS]: async ({ ownerId, mutationIds }) => undoImapActions(ownerId, mutationIds),
    [DB_RPC.ATTENTION_IMAP_ACTION_FAILURES]: async ({ ownerId }) => readImapActionFailures(engine, ownerId, 20),
    [DB_RPC.ATTENTION_RETRY_IMAP_ACTION]: async ({ ownerId, mutationId }) =>
      enqueueImapActions(ownerId, [], { retryOf: mutationId }),
    [DB_RPC.ATTENTION_RESUME_IMAP_ACTIONS]: async ({ ownerId }) => resumeImapActions(ownerId),
    [DB_RPC.ATTENTION_SETTLE_IMAP_ACTION]: async ({ mutationId, error }: { mutationId: number; error?: { type?: string; message?: string } }) =>
      settleImapAction(mutationId, error),
    [DB_RPC.ATTENTION_APPLY_IMAP_ACTION]: async ({ ownerId, location, action, mutationId }:
      ImapActionRequest & { ownerId: number; mutationId?: number }) => {
      if (!validImapAction(location, action)) {
        return terminalImapAction('invalidArguments', 'The pending IMAP change is invalid.');
      }
      return serializeFolderOperation(ownerId, location.accountId, location.mailbox, () =>
        applyImapAction(ownerId, location, action, mutationId));
    },
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
    [DB_RPC.ATTENTION_CHANGE_BUNDLE_STATES]: async ({ ownerId, aliases, replacements, expected }: {
      ownerId: number; aliases: readonly string[]; replacements: BundleStates; expected?: BundleStates;
    }) => {
      const result = await engine.transaction(async (tx) => {
        const rows = await tx.all(
          'SELECT bundle_id, state_json FROM attention_bundle_states WHERE owner_account_id = ?', [ownerId],
        );
        const states = Object.fromEntries(rows.map(({ bundle_id, state_json }) => [String(bundle_id), JSON.parse(String(state_json)) as BundleState]));
        const previous = matchingBundleStates(states, aliases);
        if (expected && !equalBundleStates(previous, expected)) return { applied: false, previous };
        for (const id of Object.keys(previous)) {
          await tx.run('DELETE FROM attention_bundle_states WHERE owner_account_id = ? AND bundle_id = ?', [ownerId, id]);
        }
        for (const [id, state] of Object.entries(replacements)) {
          await tx.run('INSERT INTO attention_bundle_states VALUES (?, ?, ?)', [ownerId, id, JSON.stringify(state)]);
        }
        return { applied: true, previous };
      });
      if (result.applied) broadcaster.touch(TABLE_FAMILIES.ATTENTION);
      return result;
    },
  };
}

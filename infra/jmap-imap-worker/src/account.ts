import { DurableObject } from 'cloudflare:workers';
import { newAttentionNotifications } from './attention-notifications';
import { mailAccounts, type Env } from './config';
import { HttpError } from './http';
import { jmapKeywords, type KeywordError, type KeywordUpdate, type KeywordWriteOutcome } from './keywords';
import { listMailboxWindows, listMessages, MailTransportError, patchMailboxKeywords, readMessagePreviews, type ImapKeywordResult, type ImapMessage, type ImapWindow, type MailAccount, type MailTransportErrorCode } from './mail-transport';
import { getManagedAccount } from './managed-accounts';
import { hasPushSubscribers, notifyArrival, pushAttentionStates } from './push';

export interface Address {
  email: string;
  name?: string | null;
}

export interface MessageEnvelope {
  uid: number;
  receivedAt: string;
  subject: string | null;
  from: Address[];
  to: Address[];
  cc?: Address[];
  messageId: string[];
  inReplyTo?: string[];
  references?: string[];
  keywords: Record<string, true>;
  size: number;
  hasAttachment?: boolean;
  preview?: string;
}

export interface MailboxSnapshot {
  path: string;
  name: string;
  role?: string | null;
  delimiter?: string | null;
  uidValidity: string;
  total: number;
  unread?: number;
  messages: MessageEnvelope[];
  complete?: boolean;
  minUid?: number | null;
}

export interface StoredMailbox {
  id: string;
  path: string;
  name: string;
  role: string | null;
  delimiter?: string | null;
  uidValidity: string;
  total: number;
  unread: number;
}

export interface StoredMessage extends MessageEnvelope {
  id: string;
  mailboxId: string;
  threadId: string;
  path: string;
  uidValidity: string;
}

export interface AccountSnapshot {
  state: string;
  mailboxes: StoredMailbox[];
  messages: StoredMessage[];
  total: number;
}

export interface ChangePage {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

interface SnapshotOptions {
  mailboxId?: string;
  offset?: number;
  limit?: number;
}

interface ReconcileOptions {
  generation?: number;
  allMailboxPaths?: string[];
}

type ChangeKind = 'created' | 'updated' | 'destroyed';
type ObjectKind = 'email' | 'mailbox';
interface Change {
  type: ObjectKind;
  id: string;
  kind: ChangeKind;
}

type RowValue = number | string | null;
type Row = Record<string, RowValue>;

const CHANGE_RETENTION_STATES = 1024;
const DEFAULT_PAGE_SIZE = 5000;
const PER_FOLDER_WINDOW = 50;
const MAX_FOLDERS = 25;
const REFRESH_COOLDOWN = 15_000;
const KEYWORD_WRITE_BUDGET = 20_000;
const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 3600;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS gateway_state (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_mailboxes (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT,
    delimiter TEXT,
    uid_validity TEXT NOT NULL,
    total INTEGER NOT NULL,
    unread INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_messages (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL REFERENCES gateway_mailboxes(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    uid_validity TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    envelope TEXT NOT NULL,
    UNIQUE(mailbox_id, uid_validity, uid)
  );
  CREATE INDEX IF NOT EXISTS gateway_message_recency
    ON gateway_messages(received_at DESC, id);
  CREATE INDEX IF NOT EXISTS gateway_folder_recency
    ON gateway_messages(mailbox_id, received_at DESC, id);
  CREATE TABLE IF NOT EXISTS gateway_thread_keys (
    key TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_inbox_cursor (
    mailbox_id TEXT PRIMARY KEY REFERENCES gateway_mailboxes(id) ON DELETE CASCADE,
    uid_validity TEXT NOT NULL,
    last_uid INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_push_outbox (
    event_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_push_previews (
    message_id TEXT PRIMARY KEY REFERENCES gateway_messages(id) ON DELETE CASCADE,
    preview TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gateway_changes (
    version INTEGER NOT NULL,
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY(version, type, id)
  );
  CREATE INDEX IF NOT EXISTS gateway_changes_lookup ON gateway_changes(type, version);
`;

function mailboxFromRow(row: Row): StoredMailbox {
  return {
    id: String(row.id), path: String(row.path), name: String(row.name),
    role: row.role === null ? null : String(row.role),
    delimiter: row.delimiter === null ? null : String(row.delimiter), uidValidity: String(row.uid_validity),
    total: Number(row.total), unread: Number(row.unread),
  };
}

function messageFromRow(row: Row): StoredMessage {
  return {
    ...(JSON.parse(String(row.envelope)) as MessageEnvelope),
    id: String(row.id), mailboxId: String(row.mailbox_id), threadId: String(row.thread_id),
    path: String(row.path), uidValidity: String(row.uid_validity),
  };
}

function coalesce(previous: ChangeKind | undefined, next: ChangeKind): ChangeKind | undefined {
  if (previous === 'created') return next === 'destroyed' ? undefined : 'created';
  if (previous === 'destroyed' && next === 'created') return 'updated';
  return next;
}

function clampInteger(value: number | undefined, least: number, greatest: number, fallback: number) {
  return Number.isSafeInteger(value) ? Math.max(least, Math.min(greatest, value!)) : fallback;
}

function canonicalEnvelope(input: MessageEnvelope): MessageEnvelope {
  return {
    ...input,
    keywords: Object.fromEntries(Object.entries(input.keywords).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

function normalizeEnvelope(message: ImapMessage): MessageEnvelope {
  const addresses = (items: ImapMessage['from']): Address[] =>
    items.map(({ address, name }) => ({ email: address, name: name || null }));
  return {
    uid: message.uid, receivedAt: message.receivedAt, subject: message.subject,
    from: addresses(message.from), to: addresses(message.to), cc: addresses(message.cc),
    messageId: message.messageId ? [normalizeMessageId(message.messageId)] : [],
    inReplyTo: message.inReplyTo ? [normalizeMessageId(message.inReplyTo)] : [],
    references: message.references.map(normalizeMessageId),
    keywords: jmapKeywords(message), size: message.size, hasAttachment: message.hasAttachments,
  };
}

function mailboxRole(path: string, specialUse: string | null): string | null {
  const candidate = specialUse?.replace(/^\\/, '').toLowerCase();
  if (path.toUpperCase() === 'INBOX') return 'inbox';
  if (candidate === 'junk' || candidate === 'spam') return 'junk';
  return candidate && ['archive', 'drafts', 'sent', 'trash', 'all', 'important'].includes(candidate)
    ? candidate : null;
}

export class AccountState extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly readingFolders = new Map<string, { generation: number; window: Promise<ImapWindow> }>();
  private syncing?: Promise<AccountSnapshot>;
  private settingKeywords?: Promise<KeywordWriteOutcome>;
  private delivering?: Promise<void>;
  private refreshedAt = 0;
  private refreshFailed = false;
  private forgotten = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private getState(name: string): number {
    return this.sql.exec<{ value: number }>('SELECT value FROM gateway_state WHERE name = ?', name).toArray()[0]?.value ?? 0;
  }

  private setState(name: string, value: number): void {
    this.sql.exec(`INSERT INTO gateway_state VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`, name, value);
  }

  private recordChanges(changes: Change[]): void {
    const effective = new Map<string, Change>();
    for (const change of changes) {
      const key = `${change.type}/${change.id}`;
      const kind = coalesce(effective.get(key)?.kind, change.kind);
      if (kind) effective.set(key, { ...change, kind });
      else effective.delete(key);
    }
    if (effective.size === 0) return;
    const version = this.getState('version') + 1;
    for (const change of effective.values()) {
      this.sql.exec('INSERT INTO gateway_changes VALUES (?, ?, ?, ?)', version, change.type, change.id, change.kind);
    }
    this.setState('version', version);
    this.sql.exec('DELETE FROM gateway_changes WHERE version <= ?', version - CHANGE_RETENTION_STATES);
  }

  beginSync(): number {
    const generation = this.getState('next_generation') + 1;
    this.setState('next_generation', generation);
    return generation;
  }

  private checkAccount(id: string): void {
    if (this.ctx.id.name && id !== this.ctx.id.name) throw new Error('Account does not match this storage object.');
    if (this.forgotten) throw new Error('Account is disconnected.');
  }

  private readFolder(account: MailAccount, mailbox: string, limit: number) {
    this.checkAccount(account.id);
    const key = JSON.stringify([mailbox, limit]);
    const current = this.readingFolders.get(key);
    if (current) return current;
    const generation = this.beginSync();
    const window = listMessages(account, mailbox, limit).finally(() => {
      if (this.readingFolders.get(key)?.window === window) this.readingFolders.delete(key);
    });
    const pending = { generation, window };
    this.readingFolders.set(key, pending);
    return pending;
  }

  async liveFolder(account: MailAccount, mailbox: string, limit: number): Promise<ImapWindow | { error: MailTransportErrorCode }> {
    const { window } = this.readFolder(account, mailbox, limit);
    try {
      const result = await window;
      this.checkAccount(account.id);
      return result;
    } catch (error) {
      if (error instanceof MailTransportError) return { error: error.code };
      throw error;
    }
  }

  invalidateFolders(id: string): void {
    this.checkAccount(id);
    this.markFoldersDirty();
  }

  private markFoldersDirty(): void {
    this.readingFolders.clear();
    this.refreshedAt = 0;
    this.setState('applied_generation', this.beginSync());
  }

  snapshot(options: SnapshotOptions = {}): AccountSnapshot {
    const limit = clampInteger(options.limit, 0, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
    const offset = clampInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const filter = options.mailboxId === undefined ? [] : [options.mailboxId];
    const predicate = filter.length ? 'WHERE m.mailbox_id = ?' : '';
    const rows = this.sql.exec<Row>(`
      SELECT m.*, b.path FROM gateway_messages m JOIN gateway_mailboxes b ON b.id = m.mailbox_id
      ${predicate} ORDER BY m.received_at DESC, m.id LIMIT ? OFFSET ?
    `, ...filter, limit, offset).toArray();
    const total = this.sql.exec<{ count: number }>(`
      SELECT COUNT(*) AS count FROM gateway_messages m ${predicate}
    `, ...filter).one().count;
    return {
      state: String(this.getState('version')),
      mailboxes: this.sql.exec<Row>('SELECT * FROM gateway_mailboxes ORDER BY path').toArray().map(mailboxFromRow),
      messages: rows.map(messageFromRow), total,
    };
  }

  mailbox(id: string): StoredMailbox | null {
    const row = this.sql.exec<Row>('SELECT * FROM gateway_mailboxes WHERE id = ?', id).toArray()[0];
    return row ? mailboxFromRow(row) : null;
  }

  message(id: string): StoredMessage | null {
    const row = this.sql.exec<Row>(`
      SELECT m.*, b.path FROM gateway_messages m JOIN gateway_mailboxes b ON b.id = m.mailbox_id WHERE m.id = ?
    `, id).toArray()[0];
    return row ? messageFromRow(row) : null;
  }

  async setKeywords(account: MailAccount, updates: KeywordUpdate[], ifInState: string | null): Promise<KeywordWriteOutcome> {
    this.checkAccount(account.id);
    const previous = this.settingKeywords;
    const pending = Promise.resolve(previous).catch(() => {}).then(() => this.writeKeywords(account, updates, ifInState));
    this.settingKeywords = pending;
    try {
      return await pending;
    } finally {
      if (this.settingKeywords === pending) this.settingKeywords = undefined;
    }
  }

  private async writeKeywords(account: MailAccount, updates: KeywordUpdate[], ifInState: string | null): Promise<KeywordWriteOutcome> {
    if (this.forgotten) throw new Error('Account is disconnected.');
    const oldState = String(this.getState('version'));
    if (ifInState !== null && ifInState !== oldState) return null;
    const groups = new Map<string, { message: StoredMessage; update: KeywordUpdate }[]>();
    const outcomes: [string, KeywordError][] = [];
    for (const update of updates) {
      const message = this.message(update.id);
      if (!message) {
        outcomes.push([update.id, 'notFound']);
        continue;
      }
      const group = groups.get(message.mailboxId) ?? [];
      group.push({ message, update });
      groups.set(message.mailboxId, group);
    }

    const confirmed: { id: string; result: ImapKeywordResult }[] = [];
    let failure: 'serverPartialFail' | 'serverUnavailable' | undefined;
    const deadline = Date.now() + KEYWORD_WRITE_BUDGET;
    for (const group of groups.values()) {
      if (this.forgotten) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        failure = confirmed.length ? 'serverPartialFail' : 'serverUnavailable';
        break;
      }
      const { path, uidValidity } = group[0].message;
      try {
        const results = await patchMailboxKeywords(account, path, uidValidity, group.map(({ message, update }) =>
          ({ uid: message.uid, add: update.add, keyword: update.keyword })), remaining);
        const idsByUid = new Map(group.map(({ message }) => [message.uid, message.id]));
        for (const result of results) {
          const id = idsByUid.get(result.uid)!;
          confirmed.push({ id, result });
          if (result.error) outcomes.push([id, result.error]);
        }
      } catch (error) {
        this.refreshedAt = 0;
        const code = error instanceof MailTransportError ? error.code : undefined;
        if (code === 'keyword_write_unknown' && !this.forgotten) this.markFoldersDirty();
        if (code === 'mailbox_changed') {
          for (const { message } of group) outcomes.push([message.id, 'notFound']);
          continue;
        }
        failure = confirmed.length || code === 'keyword_write_unknown' ? 'serverPartialFail' : 'serverUnavailable';
        break;
      }
    }
    if (this.forgotten) return { error: confirmed.length || failure === 'serverPartialFail' ? 'serverPartialFail' : 'serverUnavailable' };
    let newState: string;
    try {
      this.ctx.storage.transactionSync(() => this.saveConfirmedKeywords(confirmed));
      newState = String(this.getState('version'));
    } catch {
      this.refreshedAt = 0;
      return { error: confirmed.length || failure === 'serverPartialFail' ? 'serverPartialFail' : 'serverUnavailable' };
    }
    if (failure) return { error: failure };
    return {
      oldState, newState,
      updated: confirmed.filter(({ result }) => !result.error).map(({ id }) => id),
      notUpdated: Object.fromEntries(outcomes),
    };
  }

  private saveConfirmedKeywords(confirmed: { id: string; result: ImapKeywordResult }[]): void {
    if (!confirmed.length) return;
    // An IMAP snapshot fetched before the STORE must not overwrite its confirmed flags.
    this.markFoldersDirty();
    const changes: Change[] = [];
    const mailboxDeltas = new Map<string, { total: number; unread: number }>();
    for (const { id, result } of confirmed) {
      const row = this.sql.exec<Row>('SELECT mailbox_id,envelope FROM gateway_messages WHERE id = ?', id).toArray()[0];
      if (!row) continue;
      const mailboxId = String(row.mailbox_id);
      const delta = mailboxDeltas.get(mailboxId) ?? { total: 0, unread: 0 };
      const previous = JSON.parse(String(row.envelope)) as MessageEnvelope;
      if (result.keywords) {
        const encoded = JSON.stringify(canonicalEnvelope({ ...previous, keywords: result.keywords }));
        if (encoded === row.envelope) continue;
        this.sql.exec('UPDATE gateway_messages SET envelope = ? WHERE id = ?', encoded, id);
        changes.push({ type: 'email', kind: 'updated', id });
        delta.unread += Number(Boolean(previous.keywords.$seen)) - Number(Boolean(result.keywords.$seen));
      } else if (result.error === 'notFound') {
        this.sql.exec('DELETE FROM gateway_messages WHERE id = ?', id);
        changes.push({ type: 'email', kind: 'destroyed', id });
        delta.total -= 1;
        delta.unread -= Number(!previous.keywords.$seen);
      }
      mailboxDeltas.set(mailboxId, delta);
    }
    for (const [id, { total, unread }] of mailboxDeltas) {
      if (!total && !unread) continue;
      this.sql.exec(`UPDATE gateway_mailboxes SET total = MAX(0, total + ?),
        unread = MIN(MAX(0, total + ?), MAX(0, unread + ?)) WHERE id = ?`, total, total, unread, id);
      changes.push({ type: 'mailbox', kind: 'updated', id });
    }
    this.recordChanges(changes);
  }

  reconcile(snapshots: MailboxSnapshot[], options: ReconcileOptions = {}): AccountSnapshot {
    this.ctx.storage.transactionSync(() => {
      if (options.generation !== undefined) {
        if (options.generation <= this.getState('applied_generation')) return;
        this.setState('applied_generation', options.generation);
      }
      const changes: Change[] = [];
      if (options.allMailboxPaths) {
        const paths = new Set(options.allMailboxPaths);
        for (const row of this.sql.exec<Row>('SELECT * FROM gateway_mailboxes')) {
          const box = mailboxFromRow(row);
          if (paths.has(box.path)) continue;
          this.removeMessages(box.id, changes);
          this.sql.exec('DELETE FROM gateway_mailboxes WHERE id = ?', box.id);
          changes.push({ type: 'mailbox', kind: 'destroyed', id: box.id });
        }
      }
      for (const snapshot of snapshots) this.saveMailbox(snapshot, changes);
      this.recordChanges(changes);
    });
    return this.snapshot();
  }

  changes(sinceState: string, type: ObjectKind, maxChanges?: number): ChangePage | null {
    if (!/^(0|[1-9][0-9]*)$/.test(sinceState)) return null;
    const oldVersion = Number(sinceState);
    const current = this.getState('version');
    if (oldVersion > current || current - oldVersion > CHANGE_RETENTION_STATES) return null;
    const limit = clampInteger(maxChanges, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const result = new Map<string, ChangeKind>();
    let newVersion = current;
    let appliedVersion = oldVersion;
    const rows = this.sql.exec<{ version: number; id: string; kind: ChangeKind }>(`
      SELECT version,id,kind FROM gateway_changes WHERE type = ? AND version > ? ORDER BY version,id
    `, type, oldVersion).toArray();
    for (let start = 0; start < rows.length;) {
      const version = rows[start].version;
      const previous = new Map<string, ChangeKind | undefined>();
      do {
        const { id, kind } = rows[start++];
        const existing = result.get(id);
        previous.set(id, existing);
        const next = coalesce(existing, kind);
        if (next) result.set(id, next);
        else result.delete(id);
      } while (rows[start]?.version === version);
      if (result.size > limit) {
        if (appliedVersion === oldVersion) return null;
        for (const [id, kind] of previous) {
          if (kind) result.set(id, kind);
          else result.delete(id);
        }
        newVersion = appliedVersion;
        break;
      }
      appliedVersion = version;
    }
    const page: ChangePage = {
      oldState: sinceState, newState: String(newVersion), hasMoreChanges: newVersion < current,
      created: [], updated: [], destroyed: [],
    };
    for (const [id, kind] of result) page[kind].push(id);
    return page;
  }

  private removeMessages(id: string, changes: Change[]): void {
    for (const row of this.sql.exec<{ id: string }>('SELECT id FROM gateway_messages WHERE mailbox_id = ?', id)) {
      changes.push({ type: 'email', kind: 'destroyed', id: row.id });
    }
    this.sql.exec('DELETE FROM gateway_messages WHERE mailbox_id = ?', id);
  }

  private saveMailbox(snapshot: MailboxSnapshot, changes: Change[]): void {
    const existing = this.sql.exec<Row>('SELECT * FROM gateway_mailboxes WHERE path = ?', snapshot.path).toArray()[0];
    const id = existing ? String(existing.id) : crypto.randomUUID();
    const role = snapshot.role ?? null;
    const delimiter = snapshot.delimiter ?? null;
    const unreadInWindow = snapshot.messages.filter((message) => !message.keywords.$seen).length;
    const unread = snapshot.unread ?? unreadInWindow;
    const mailboxChanged = !existing || existing.name !== snapshot.name || existing.role !== role
      || existing.delimiter !== delimiter || existing.uid_validity !== snapshot.uidValidity || existing.total !== snapshot.total || existing.unread !== unread;
    if (mailboxChanged) {
      this.sql.exec(`
        INSERT INTO gateway_mailboxes (id,path,name,role,delimiter,uid_validity,total,unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET name=excluded.name,role=excluded.role,delimiter=excluded.delimiter,
          uid_validity=excluded.uid_validity,total=excluded.total,unread=excluded.unread
      `, id, snapshot.path, snapshot.name, role, delimiter, snapshot.uidValidity, snapshot.total, unread);
      changes.push({ type: 'mailbox', kind: existing ? 'updated' : 'created', id });
    }
    if (existing && existing.uid_validity !== snapshot.uidValidity) this.removeMessages(id, changes);

    if (role === 'inbox') this.queueInboxArrival(id, snapshot);

    const incoming = new Set(snapshot.messages.map(({ uid }) => uid));
    const current = this.sql.exec<{ id: string; uid: number }>(`
      SELECT id,uid FROM gateway_messages WHERE mailbox_id = ? ORDER BY uid DESC
    `, id).toArray();
    const evict = current.filter((row) => !incoming.has(row.uid)
      && (snapshot.complete || (snapshot.minUid != null && row.uid >= snapshot.minUid)));
    for (const row of evict) {
      this.sql.exec('DELETE FROM gateway_messages WHERE id = ?', row.id);
      changes.push({ type: 'email', kind: 'destroyed', id: row.id });
    }
    for (const message of snapshot.messages) this.saveMessage(id, snapshot.uidValidity, message, changes);
    const overflow = this.sql.exec<{ id: string }>(`
      SELECT id FROM gateway_messages WHERE mailbox_id = ? ORDER BY uid DESC LIMIT -1 OFFSET ?
    `, id, PER_FOLDER_WINDOW).toArray();
    for (const { id: messageId } of overflow) {
      this.sql.exec('DELETE FROM gateway_messages WHERE id = ?', messageId);
      changes.push({ type: 'email', kind: 'destroyed', id: messageId });
    }
  }

  private queueInboxArrival(mailboxId: string, snapshot: MailboxSnapshot): void {
    const row = this.sql.exec<{ uid_validity: string; last_uid: number }>(`
      SELECT uid_validity,last_uid FROM gateway_inbox_cursor WHERE mailbox_id = ?
    `, mailboxId).toArray()[0];
    const latest = Math.max(0, ...snapshot.messages.map(({ uid }) => uid));
    if (!row || row.uid_validity !== snapshot.uidValidity) {
      if (snapshot.complete || snapshot.minUid != null) {
        this.sql.exec(`
          INSERT INTO gateway_inbox_cursor VALUES (?, ?, ?)
          ON CONFLICT(mailbox_id) DO UPDATE SET uid_validity=excluded.uid_validity,last_uid=excluded.last_uid
        `, mailboxId, snapshot.uidValidity, latest);
      }
      return;
    }
    if (latest <= row.last_uid || (!snapshot.complete && snapshot.minUid == null)) return;
    const first = Math.min(...snapshot.messages.filter(({ uid }) => uid > row.last_uid).map(({ uid }) => uid));
    const eventId = `v${snapshot.uidValidity}:${first}:${latest}`;
    this.sql.exec('UPDATE gateway_inbox_cursor SET last_uid = ? WHERE mailbox_id = ?', latest, mailboxId);
    this.sql.exec('INSERT OR IGNORE INTO gateway_push_outbox VALUES (?, ?)', eventId, Date.now());
  }

  private deliveryMessages(uidValidity: string): StoredMessage[] {
    return this.sql.exec<Row>(`SELECT m.*, b.path, p.preview AS body_preview
      FROM gateway_messages m JOIN gateway_mailboxes b ON b.id = m.mailbox_id
      LEFT JOIN gateway_push_previews p ON p.message_id = m.id
      WHERE b.role = 'inbox' AND m.uid_validity = ? ORDER BY m.uid DESC`, uidValidity).toArray()
      .map((row) => ({ ...messageFromRow(row), ...(row.body_preview === null ? {} : { preview: String(row.body_preview) }) }));
  }

  inboxPreviews(): { uidValidity: string; previews: Record<number, string> } | null {
    const mailbox = this.sql.exec<{ id: string; uid_validity: string }>(
      "SELECT id,uid_validity FROM gateway_mailboxes WHERE role = 'inbox' LIMIT 1",
    ).toArray()[0];
    if (!mailbox) return null;
    const rows = this.sql.exec<{ uid: number; preview: string }>(`SELECT m.uid, p.preview
      FROM gateway_messages m JOIN gateway_push_previews p ON p.message_id = m.id
      WHERE m.mailbox_id = ? AND m.uid_validity = ?`, mailbox.id, mailbox.uid_validity).toArray();
    return { uidValidity: mailbox.uid_validity, previews: Object.fromEntries(rows.map(({ uid, preview }) => [uid, preview])) };
  }

  private deliverArrivals(account: MailAccount): Promise<void> {
    this.delivering ??= this.processArrivals(account).finally(() => { this.delivering = undefined; });
    return this.delivering;
  }

  private queueDelivery(account: MailAccount): void {
    this.ctx.waitUntil(this.deliverArrivals(account).catch(() => {}));
  }

  private async processArrivals(account: MailAccount): Promise<void> {
    const staleAt = Date.now() - 24 * 60 * 60 * 1000;
    this.sql.exec('DELETE FROM gateway_push_outbox WHERE created_at < ?', staleAt);
    const jobs = this.sql.exec<{ event_id: string }>(`
      SELECT event_id FROM gateway_push_outbox ORDER BY created_at,event_id LIMIT 10
    `).toArray();
    if (jobs.length === 0) return;
    for (const { event_id: eventId } of jobs) {
      if (this.forgotten) return;
      const range = /^v(\d+):(\d+):(\d+)$/.exec(eventId);
      if (!range || await this.deliverArrivalRange(account, range, eventId)) {
        this.sql.exec('DELETE FROM gateway_push_outbox WHERE event_id = ?', eventId);
      }
    }
  }

  private async deliverArrivalRange(
    account: MailAccount, range: RegExpExecArray, eventId: string,
  ): Promise<boolean> {
    const [, validity, first, last] = range;
    const firstUid = Number(first);
    const lastUid = Number(last);
    let messages = this.deliveryMessages(validity).filter(({ uid }) => uid <= lastUid);
    if (!messages.some(({ uid }) => uid >= firstUid)) return true;
    let states = await pushAttentionStates(this.env, account.id);
    if (!states || this.forgotten) return true;

    let plan = newAttentionNotifications(account, messages, firstUid, states);
    const { missingPreviews } = plan;
    if (missingPreviews.length) {
      // Fetch the arriving conversations' missing excerpts together. Other rows do not affect these bundles.
      const previews = await readMessagePreviews(account, messages[0].path, validity, missingPreviews.map(({ uid }) => uid))
        .catch((): Record<number, string> => ({}));
      if (this.forgotten) return true;
      this.ctx.storage.transactionSync(() => {
        for (const { id, uid } of missingPreviews) {
          if (!Object.hasOwn(previews, uid)) continue;
          this.sql.exec(`INSERT OR IGNORE INTO gateway_push_previews (message_id, preview)
            SELECT id, ? FROM gateway_messages WHERE id = ?`, previews[uid], id);
        }
      });
      messages = this.deliveryMessages(validity).filter(({ uid }) => uid <= lastUid);
      // A user can snooze or complete a bundle while the IMAP fetch is in flight.
      states = await pushAttentionStates(this.env, account.id);
      if (!states) return true;
      plan = newAttentionNotifications(account, messages, firstUid, states);
    }

    let delivered = plan.missingPreviews.length === 0;
    for (const { bundleUid, notification } of plan.notifications) {
      if (this.forgotten) return true;
      if (!await notifyArrival(this.env, account.id, `${eventId}:${bundleUid}`, notification)) delivered = false;
    }
    return delivered;
  }

  private saveMessage(mailboxId: string, uidValidity: string, input: MessageEnvelope, changes: Change[]): void {
    const message = canonicalEnvelope(input);
    const encoded = JSON.stringify(message);
    const existing = this.sql.exec<{ id: string; envelope: string }>(`
      SELECT id,envelope FROM gateway_messages WHERE mailbox_id = ? AND uid_validity = ? AND uid = ?
    `, mailboxId, uidValidity, message.uid).toArray()[0];
    if (existing?.envelope === encoded) return;
    const id = existing?.id ?? `${mailboxId}-${uidValidity}-${message.uid}`;
    if (existing) {
      this.sql.exec('UPDATE gateway_messages SET received_at = ?, envelope = ? WHERE id = ?', message.receivedAt, encoded, id);
    } else {
      this.sql.exec('INSERT INTO gateway_messages VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, mailboxId, message.uid, uidValidity, this.threadId(message), message.receivedAt, encoded);
    }
    changes.push({ type: 'email', kind: existing ? 'updated' : 'created', id });
  }

  private threadId(message: MessageEnvelope): string {
    const keys = [...new Set([...(message.references ?? []), ...(message.inReplyTo ?? []), ...message.messageId]
      .map((id) => id.trim().replace(/^<|>$/g, ''))
      .filter((id) => id.length > 0 && id.length <= 1024))].slice(0, 80);
    let threadId: string | undefined;
    for (const key of keys) {
      threadId = this.sql.exec<{ thread_id: string }>('SELECT thread_id FROM gateway_thread_keys WHERE key = ?', key)
        .toArray()[0]?.thread_id;
      if (threadId) break;
    }
    threadId ??= crypto.randomUUID();
    for (const key of keys) this.sql.exec('INSERT OR IGNORE INTO gateway_thread_keys VALUES (?, ?)', key, threadId);
    return threadId;
  }

  private resolveAccount(id: string): MailAccount | Promise<MailAccount | undefined> | undefined {
    return mailAccounts(this.env).find((entry) => entry.id === id)
      ?? (id.startsWith('managed_') ? getManagedAccount(this.env, id) : undefined);
  }

  async refresh(id: string, options: { force?: boolean } = {}): Promise<AccountSnapshot> {
    this.checkAccount(id);
    const warm = this.getState('version') > 0 || (this.refreshedAt > 0 && !this.refreshFailed);
    if (this.syncing) return warm && !options.force ? this.snapshot() : this.syncing;
    if (this.settingKeywords) {
      if (warm && !options.force) return this.snapshot();
      await this.settingKeywords.catch(() => {});
      return this.refresh(id, options);
    }
    if (!options.force && Date.now() - this.refreshedAt < REFRESH_COOLDOWN) {
      if (this.refreshFailed && !warm) throw new MailTransportError('mail_unavailable');
      return this.snapshot();
    }
    const generation = this.beginSync();
    const pending = this.refreshMailboxes(id, generation).then((snapshot) => {
      this.refreshFailed = false;
      return snapshot;
    }).catch((error) => {
      this.refreshFailed = true;
      throw error;
    }).finally(() => {
      this.refreshedAt = Date.now();
      this.syncing = undefined;
    });
    this.syncing = pending;
    if (warm && !options.force) {
      this.ctx.waitUntil(pending.catch(() => {}));
      return this.snapshot();
    }
    return pending;
  }

  private async refreshMailboxes(id: string, generation: number): Promise<AccountSnapshot> {
    const account = await this.resolveAccount(id);
    this.checkAccount(id);
    if (!account) throw new HttpError(404, 'account_not_found');
    const { folders, windows, failedFolders } = await listMailboxWindows(account, PER_FOLDER_WINDOW, MAX_FOLDERS);
    this.checkAccount(id);
    if (windows.length === 0 && failedFolders.length > 0) throw new Error('Could not refresh the configured mailboxes.');
    const selected = new Set([...windows.map(({ mailbox }) => mailbox), ...failedFolders]);
    const metadata = new Map(folders.filter(({ path }) => selected.has(path)).map((folder) => [folder.path, folder]));
    const snapshots = windows.flatMap((window) => {
      const folder = metadata.get(window.mailbox);
      if (!folder) return [];
      return [{
        path: folder.path, name: folder.name, role: mailboxRole(folder.path, folder.specialUse), delimiter: folder.delimiter,
        uidValidity: window.uidValidity, total: window.total, complete: window.complete, minUid: window.minUid,
        messages: window.messages.map(normalizeEnvelope),
      }];
    });
    const snapshot = this.reconcile(snapshots, { generation, allMailboxPaths: [...metadata.keys()] });
    this.queueDelivery(account);
    return snapshot;
  }

  async watch(intervalSeconds: number | null): Promise<void> {
    if (this.forgotten) return;
    if (intervalSeconds === null) {
      this.setState('poll_interval_seconds', 0);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const interval = clampInteger(intervalSeconds, MIN_POLL_SECONDS, MAX_POLL_SECONDS, MIN_POLL_SECONDS);
    this.setState('poll_interval_seconds', interval);
    const next = Date.now() + interval * 1000;
    const existing = await this.ctx.storage.getAlarm();
    if (!this.forgotten && this.getState('poll_interval_seconds') === interval && (existing === null || existing > next)) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  async forgetManagedMailbox(): Promise<void> {
    if (!this.ctx.id.name?.startsWith('managed_')) return;
    this.forgotten = true;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  private async pollInbox(account: MailAccount): Promise<void> {
    const previous = this.sql.exec<Row>("SELECT * FROM gateway_mailboxes WHERE role = 'inbox' LIMIT 1").toArray()[0];
    const path = previous ? String(previous.path) : 'INBOX';
    const pending = this.readFolder(account, path, PER_FOLDER_WINDOW);
    const window = await pending.window;
    if (this.forgotten) return;
    this.reconcile([{
      path, name: previous ? String(previous.name) : 'Inbox', role: 'inbox',
      delimiter: previous?.delimiter == null ? null : String(previous.delimiter),
      uidValidity: window.uidValidity, total: window.total, complete: window.complete, minUid: window.minUid,
      messages: window.messages.map(normalizeEnvelope),
    }], { generation: pending.generation });
  }

  async alarm(): Promise<void> {
    if (this.forgotten) return;
    const interval = this.getState('poll_interval_seconds');
    if (interval === 0) return;
    const id = this.ctx.id.name;
    if (!id) return;
    const managed = id.startsWith('managed_');
    let account: MailAccount | undefined;
    let shouldPoll = true;
    try {
      shouldPoll = await hasPushSubscribers(this.env);
      if (!shouldPoll || this.forgotten) return;
      account = await this.resolveAccount(id);
      if (this.forgotten) return;
      if (!account) {
        shouldPoll = false;
        if (managed) await this.forgetManagedMailbox();
        return;
      }
      if (!this.syncing) await this.pollInbox(account);
    } catch (error) {
      // The scheduled poll supplies the retry for transient upstream failures.
      if (!(error instanceof MailTransportError || error instanceof HttpError)) throw error;
    } finally {
      // A disconnect can cancel polling while the refresh awaits IMAP.
      if (shouldPoll && !this.forgotten) {
        const current = this.getState('poll_interval_seconds');
        if (current !== 0) await this.ctx.storage.setAlarm(Date.now() + current * 1000);
      }
      if (account && !this.forgotten) this.queueDelivery(account);
    }
  }
}

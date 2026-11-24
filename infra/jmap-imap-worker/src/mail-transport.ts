import { connect } from 'cloudflare:sockets';
import { connect as connectSmtp, CommandError, type Connect as SmtpConnect } from '@portable/smtp';
import {
  AuthenticationFailure,
  createSocketsTransport,
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type MailboxObject,
  type MessageAddressObject,
} from 'imapflow';
import PostalMime from 'postal-mime';
import { imapFlag, jmapKeywords, type KeywordChange, type KeywordError } from './keywords';

export interface MailConnection {
  host: string;
  port?: number;
  mode?: 'tls' | 'starttls';
  user: string;
  password: string;
}

export type ImapConnection = MailConnection | (Omit<MailConnection, 'password'> & { accessToken: string });

export interface MailAccount {
  id: string;
  email: string;
  name?: string;
  imap: ImapConnection;
  smtp?: ImapConnection;
}

export interface ImapFolder {
  path: string;
  name: string;
  specialUse: string | null;
  delimiter: string | null;
}

export interface MailAddress {
  name: string;
  address: string;
}

export interface ImapMessage {
  uid: number;
  messageId: string | null;
  references: string[];
  inReplyTo: string | null;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  keywords: string[];
  labels: string[];
  gmailLabels: boolean;
  receivedAt: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface ImapWindow {
  mailbox: string;
  uidValidity: string;
  messages: ImapMessage[];
  total: number;
  complete: boolean;
  minUid: number | null;
}

export interface ImapMessageBody extends ImapMessage {
  mailbox: string;
  uidValidity: string;
  text: string;
  html: string;
}

export interface ImapTagPatch {
  add: string[];
  remove: string[];
  addLabels: string[];
  removeLabels: string[];
}

type FlagPatch = { seen?: boolean; flagged?: boolean };

export type ImapBatchOperation = { uid: number } & (
  { type: 'read' } | { type: 'flags'; flags: FlagPatch } | { type: 'tags'; tags: ImapTagPatch } | { type: 'move'; role: MoveAction }
);
export interface ImapBatchBudget { bodyBytes: number }
type ImapBatchResult = { value: unknown } | { error: MailTransportErrorCode };

export interface ImapKeywordUpdate extends KeywordChange {
  uid: number;
}

export interface ImapKeywordResult {
  uid: number;
  keywords?: Record<string, true>;
  error?: KeywordError;
}

export const MOVE_ROLES = {
  archive: '\\Archive', junk: '\\Junk', trash: '\\Trash',
} as const;
export type MoveAction = keyof typeof MOVE_ROLES;

export type MailTransportErrorCode = 'authentication_failed' | 'invalid_message' | 'mailbox_changed'
  | 'mail_unavailable' | 'mail_timeout' | 'keyword_write_unknown' | 'message_not_found' | 'message_too_large' | 'batch_body_limit' | 'move_not_supported'
  | 'archive_not_configured' | 'archive_requires_inbox' | 'archive_rejected' | 'junk_not_configured' | 'labels_not_supported'
  | 'same_mailbox' | 'trash_not_configured' | 'smtp_not_configured' | 'submission_rejected' | 'submission_unknown';

export class MailTransportError extends Error {
  readonly code: MailTransportErrorCode;

  constructor(code: MailTransportErrorCode) {
    super(code);
    this.name = 'MailTransportError';
    this.code = code;
  }
}

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_WINDOW_SIZE = 500;
const MAX_PREVIEW_SOURCE_BYTES = 24 * 1024;

const MESSAGE_QUERY: FetchQueryObject = {
  envelope: true,
  flags: true,
  labels: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  headers: ['references'],
};

function addresses(list: MessageAddressObject[] | undefined): MailAddress[] {
  return (list ?? []).flatMap(({ name, address }) => address ? [{ name: name ?? '', address }] : []);
}

function hasAttachment(part: FetchMessageObject['bodyStructure']): boolean {
  return Boolean(part && (part.disposition?.toLowerCase() === 'attachment'
    || part.dispositionParameters?.filename || part.childNodes?.some(hasAttachment)));
}

function messageTagState(message: FetchMessageObject) {
  return {
    keywords: [...(message.flags ?? [])].filter((flag) => !flag.startsWith('\\')),
    labels: [...(message.labels ?? [])].filter((label) => !label.startsWith('\\')),
  };
}

function envelope(message: FetchMessageObject): ImapMessage {
  const fields = message.envelope;
  const receivedAtMs = new Date(message.internalDate || fields?.date || 0).getTime();
  return {
    uid: message.uid,
    messageId: fields?.messageId ?? null,
    references: message.headers?.toString('utf8').match(/<[^\s<>]+>/g) ?? [],
    inReplyTo: fields?.inReplyTo ?? null,
    subject: fields?.subject ?? '',
    from: addresses(fields?.from),
    to: addresses(fields?.to),
    cc: addresses(fields?.cc),
    replyTo: addresses(fields?.replyTo),
    ...messageTagState(message),
    gmailLabels: message.labels != null,
    receivedAt: new Date(Number.isNaN(receivedAtMs) ? 0 : receivedAtMs).toISOString(),
    size: message.size ?? 0,
    seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false,
    hasAttachments: hasAttachment(message.bodyStructure),
  };
}

async function fetchSource(client: ImapFlow, uid: number, size: number | undefined, budget?: ImapBatchBudget) {
  if ((size ?? 0) > MAX_MESSAGE_BYTES) throw new MailTransportError('message_too_large');
  const maximum = budget ? Math.min(MAX_MESSAGE_BYTES, budget.bodyBytes) : MAX_MESSAGE_BYTES;
  if (maximum <= 0 || (size ?? 0) > maximum) throw new MailTransportError('batch_body_limit');
  const reserved = budget ? size || maximum : maximum;
  if (budget) budget.bodyBytes -= reserved;
  const raw = await client.fetchOne(uid, { source: { start: 0, maxLength: reserved + 1 } }, { uid: true });
  if (!raw || !raw.source) throw new MailTransportError('message_not_found');
  if (raw.source.length > reserved) throw new MailTransportError(budget ? 'batch_body_limit' : 'message_too_large');
  if (budget) budget.bodyBytes += reserved - raw.source.length;
  return raw.source;
}

function beforeDeadline<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailTransportError('mail_timeout')), timeout);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

export function createMailTransport(openSocket: SmtpConnect = connect, {
  operationTimeout = 15_000, folderTimeout = 6_000, syncTimeout = 20_000,
} = {}) {
  const transport = createSocketsTransport((address, options) => openSocket(address, {
    secureTransport: options?.secureTransport ?? 'off',
    allowHalfOpen: options?.allowHalfOpen ?? false,
  }));

  async function withClient<T>(options: ImapConnection, task: (client: ImapFlow) => Promise<T>,
    timeout = operationTimeout): Promise<T> {
    const useStartTls = options.mode === 'starttls';
    const client = new ImapFlow({
      host: options.host,
      port: options.port ?? (useStartTls ? 143 : 993),
      secure: !useStartTls,
      doSTARTTLS: useStartTls,
      auth: 'accessToken' in options
        ? { user: options.user, accessToken: options.accessToken }
        : { user: options.user, pass: options.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableAutoIdle: true,
      logger: false,
      transport,
    });
    // The operation promise reports failures to its caller.
    client.on('error', () => {});
    try {
      return await beforeDeadline(client.connect().then(() => task(client)), timeout);
    } catch (error) {
      if (error instanceof MailTransportError) throw error;
      if (error instanceof AuthenticationFailure) throw new MailTransportError('authentication_failed');
      throw new MailTransportError('mail_unavailable');
    } finally {
      client.close();
    }
  }

  async function withSelectedMailbox<T>(
    client: ImapFlow,
    mailbox: string,
    options: { readOnly: boolean; uidValidity?: string },
    task: (selected: MailboxObject) => Promise<T>,
  ): Promise<T> {
    const lock = await client.getMailboxLock(mailbox, { readOnly: options.readOnly });
    try {
      const selected = client.mailbox;
      if (!selected) throw new MailTransportError('mail_unavailable');
      if (options.uidValidity != null && selected.uidValidity.toString() !== options.uidValidity) {
        throw new MailTransportError('mailbox_changed');
      }
      return await task(selected);
    } finally {
      lock.release();
    }
  }

  function withMailbox<T>(
    account: MailAccount,
    mailbox: string,
    options: { readOnly: boolean; uidValidity?: string },
    task: (client: ImapFlow, selected: MailboxObject) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    return withClient(account.imap, (client) => withSelectedMailbox(client, mailbox, options, (selected) => task(client, selected)), timeout);
  }

  async function readFolders(client: ImapFlow): Promise<ImapFolder[]> {
    return (await client.list())
      .filter(({ flags }) => !flags.has('\\Noselect') && !flags.has('\\NonExistent'))
      .map(({ path, name, specialUse, delimiter }) => ({
        path, name, specialUse: specialUse ?? null, delimiter: delimiter || null,
      }));
  }

  function listMailboxes(account: MailAccount, timeout = operationTimeout): Promise<ImapFolder[]> {
    return withClient(account.imap, readFolders, Math.min(timeout, operationTimeout));
  }

  async function verifyImapAccount(account: MailAccount): Promise<void> {
    await withMailbox(account, 'INBOX', { readOnly: true }, async () => {});
  }

  function readWindow(client: ImapFlow, mailbox: string, limit: number): Promise<ImapWindow> {
    const count = Number.isSafeInteger(limit) ? Math.min(MAX_WINDOW_SIZE, Math.max(1, limit)) : 50;
    return withSelectedMailbox(client, mailbox, { readOnly: true }, async (selected) => {
      const total = selected.exists;
      const uidValidity = selected.uidValidity.toString();
      const first = Math.max(1, total - count + 1);
      const records = total === 0 ? [] : await client.fetchAll(`${first}:${total}`, MESSAGE_QUERY);
      const messages = records.map(envelope);
      messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.uid - a.uid);
      // Do not reconcile absences off a partial FETCH or a mailbox that changed during FETCH.
      const stable = selected.exists === total && selected.uidValidity.toString() === uidValidity
        && records.length === total - first + 1;
      return {
        mailbox,
        uidValidity,
        messages,
        total,
        complete: stable && first === 1,
        minUid: stable && messages.length ? Math.min(...messages.map(({ uid }) => uid)) : null,
      };
    });
  }

  function listMessages(account: MailAccount, mailbox: string, limit: number): Promise<ImapWindow> {
    return withClient(account.imap, (client) => readWindow(client, mailbox, limit));
  }

  async function listMailboxWindows(account: MailAccount, limit: number, maxFolders = 8, resumeAt = 0) {
    const count = Number.isSafeInteger(maxFolders) ? Math.min(25, Math.max(1, maxFolders)) : 8;
    let folders: ImapFolder[] = [];
    const windows: ImapWindow[] = [];
    const failedFolders = new Set<string>();
    let selectedCount = 0;
    let attempted = 0;
    let offset = 0;
    try {
      await withClient(account.imap, async (client) => {
        folders = await readFolders(client);
        const inboxFirst = [...folders.filter(({ path }) => path === 'INBOX'), ...folders.filter(({ path }) => path !== 'INBOX')];
        const selected = inboxFirst.slice(0, count);
        selectedCount = selected.length;
        offset = selectedCount ? resumeAt % selectedCount : 0;
        for (const { path } of selected) failedFolders.add(path);
        for (const { path } of [...selected.slice(offset), ...selected.slice(0, offset)]) {
          attempted += 1;
          try {
            windows.push(await beforeDeadline(readWindow(client, path, limit), folderTimeout));
            failedFolders.delete(path);
          } catch (error) {
            if (error instanceof MailTransportError && error.code === 'mail_timeout') {
              client.close();
              break;
            }
            if (!client.usable) break;
          }
        }
      }, syncTimeout);
    } catch (error) {
      if (!(error instanceof MailTransportError && error.code === 'mail_timeout' && attempted > 0)) throw error;
      // Give the unfinished folder a fresh budget when this scan already returned a window.
      if (windows.length > 0) attempted -= 1;
    }
    const nextFolder = attempted < selectedCount ? (offset + attempted) % selectedCount : 0;
    return { folders, windows, failedFolders: [...failedFolders], nextFolder };
  }

  function readMessageSource(account: MailAccount, mailbox: string, uidValidity: string, uid: number): Promise<Uint8Array> {
    return withMailbox(account, mailbox, { readOnly: true, uidValidity }, async (client) => {
      const info = await client.fetchOne(uid, { size: true }, { uid: true });
      if (!info) throw new MailTransportError('message_not_found');
      return fetchSource(client, uid, info.size);
    });
  }

  async function messageBody(client: ImapFlow, mailbox: string, uidValidity: string, message: FetchMessageObject,
    budget?: ImapBatchBudget): Promise<ImapMessageBody> {
    const source = await fetchSource(client, message.uid, message.size, budget);
    try {
      const parsed = await PostalMime.parse(source, { maxNestingDepth: 64, maxHeadersSize: 128 * 1024 });
      return { ...envelope(message), mailbox, uidValidity, text: parsed.text ?? '', html: parsed.html ?? '' };
    } catch {
      throw new MailTransportError('invalid_message');
    }
  }

  function readMessage(account: MailAccount, mailbox: string, uidValidity: string, uid: number): Promise<ImapMessageBody> {
    return withMailbox(account, mailbox, { readOnly: true, uidValidity }, async (client) => {
      const message = await client.fetchOne(uid, MESSAGE_QUERY, { uid: true });
      if (!message) throw new MailTransportError('message_not_found');
      return messageBody(client, mailbox, uidValidity, message);
    });
  }

  function readMessagePreviews(account: MailAccount, mailbox: string, uidValidity: string, uids: number[]): Promise<Record<number, string>> {
    return withMailbox(account, mailbox, { readOnly: true, uidValidity }, async (client) => {
      const records = await client.fetchAll(uids.join(','), { source: { start: 0, maxLength: MAX_PREVIEW_SOURCE_BYTES } }, { uid: true });
      const previews: Record<number, string> = {};
      for (const { uid, source } of records) {
        if (!source) continue;
        try {
          const parsed = await PostalMime.parse(source.subarray(0, MAX_PREVIEW_SOURCE_BYTES), {
            maxNestingDepth: 24, maxHeadersSize: MAX_PREVIEW_SOURCE_BYTES,
          });
          previews[uid] = parsed.text?.slice(0, 2400) ?? '';
        } catch {
          previews[uid] = '';
        }
      }
      return previews;
    });
  }

  function patchMessage(
    account: MailAccount, mailbox: string, uidValidity: string, uid: number,
    flags: FlagPatch,
  ): Promise<{ uid: number; seen: boolean; flagged: boolean }> {
    return withMailbox(account, mailbox, { readOnly: false, uidValidity }, async (client) => {
      const before = await client.fetchOne(uid, { flags: true }, { uid: true });
      if (!before) throw new MailTransportError('message_not_found');
      const { add, remove } = flagChanges(flags);
      if ((add.length && !await client.messageFlagsAdd(uid, add, { uid: true }))
          || (remove.length && !await client.messageFlagsRemove(uid, remove, { uid: true }))) {
        throw new MailTransportError('mail_unavailable');
      }
      const updated = await client.fetchOne(uid, { flags: true }, { uid: true });
      if (!updated) throw new MailTransportError('message_not_found');
      return { uid, seen: updated.flags?.has('\\Seen') ?? false, flagged: updated.flags?.has('\\Flagged') ?? false };
    });
  }

  function flagChanges(flags: FlagPatch) {
    const changes = Object.entries({ '\\Seen': flags.seen, '\\Flagged': flags.flagged });
    return {
      add: changes.filter(([, value]) => value === true).map(([flag]) => flag),
      remove: changes.filter(([, value]) => value === false).map(([flag]) => flag),
    };
  }

  function patchMessageTags(account: MailAccount, mailbox: string, uidValidity: string, uid: number, patch: ImapTagPatch) {
    return withMailbox(account, mailbox, { readOnly: false, uidValidity }, (client) => patchSelectedTags(client, uid, patch));
  }

  async function patchSelectedTags(client: ImapFlow, uid: number, patch: ImapTagPatch) {
    const updateLabels = patch.addLabels.length > 0 || patch.removeLabels.length > 0;
    if (updateLabels && !client.capabilities.has('X-GM-EXT-1')) {
      throw new MailTransportError('labels_not_supported');
    }
    const query = { flags: true, labels: true };
    const byUid = { uid: true };
    const before = await client.fetchOne(uid, query, byUid);
    if (!before) throw new MailTransportError('message_not_found');
    const current = messageTagState(before);
    const keywords = new Set(current.keywords.map((keyword) => keyword.toLowerCase()));
    const labels = new Set(current.labels);
    const add = patch.add.filter((keyword) => !keywords.has(keyword.toLowerCase()));
    const remove = patch.remove.filter((keyword) => keywords.has(keyword.toLowerCase()));
    const addLabels = patch.addLabels.filter((label) => !labels.has(label));
    const removeLabels = patch.removeLabels.filter((label) => labels.has(label));
    if (addLabels.length) {
      const existing = new Set((await client.list()).map(({ path }) => path));
      for (const label of addLabels) {
        // The final FETCH confirms the outcome even if another client created the label first.
        if (!existing.has(label)) await client.mailboxCreate(label).catch(() => {});
      }
    }
    if (add.length) await client.messageFlagsAdd(uid, add, byUid);
    if (remove.length) await client.messageFlagsRemove(uid, remove, byUid);
    const gmailLabels = { ...byUid, useLabels: true };
    if (addLabels.length) await client.messageFlagsAdd(uid, addLabels, gmailLabels);
    if (removeLabels.length) await client.messageFlagsRemove(uid, removeLabels, gmailLabels);
    const updated = await client.fetchOne(uid, query, byUid);
    if (!updated) throw new MailTransportError('message_not_found');
    const state = messageTagState(updated);
    const newKeywords = new Set(state.keywords.map((keyword) => keyword.toLowerCase()));
    const newLabels = new Set(state.labels);
    const tagsApplied = patch.add.every((keyword) => newKeywords.has(keyword.toLowerCase()))
      && patch.remove.every((keyword) => !newKeywords.has(keyword.toLowerCase()))
      && patch.addLabels.every((label) => newLabels.has(label))
      && patch.removeLabels.every((label) => !newLabels.has(label));
    return {
      uid, ...state, tagsApplied,
      seen: updated.flags?.has('\\Seen') ?? false, flagged: updated.flags?.has('\\Flagged') ?? false,
    };
  }

  function patchMailboxKeywords(account: MailAccount, mailbox: string, uidValidity: string, updates: ImapKeywordUpdate[],
    timeout = operationTimeout): Promise<ImapKeywordResult[]> {
    let storeAttempted = false;
    return withMailbox(account, mailbox, { readOnly: false, uidValidity }, async (client) => {
      const groups = new Map<string, { flag: string; add: boolean; uids: number[] }>();
      for (const { uid, keyword, add } of updates) {
        const flag = imapFlag(keyword);
        if (!flag) continue;
        const key = `${add}/${flag}`;
        const group = groups.get(key) ?? { flag, add, uids: [] };
        group.uids.push(uid);
        groups.set(key, group);
      }
      for (const { flag, add, uids } of groups.values()) {
        const sequence = uids.join(',');
        storeAttempted = true;
        if (add) await client.messageFlagsAdd(sequence, [flag], { uid: true });
        else await client.messageFlagsRemove(sequence, [flag], { uid: true });
      }
      const confirmed = await client.fetchAll(updates.map(({ uid }) => uid).join(','), { flags: true }, { uid: true });
      const byUid = new Map(confirmed.map((record) => [record.uid, jmapKeywords({
        seen: record.flags?.has('\\Seen') ?? false,
        flagged: record.flags?.has('\\Flagged') ?? false,
        keywords: messageTagState(record).keywords,
      })]));
      const missing = updates.filter(({ uid }) => !byUid.has(uid));
      if (missing.length) {
        const present = await client.search({ uid: missing.map(({ uid }) => uid).join(',') }, { uid: true });
        if (!present || present.length) throw new MailTransportError('mail_unavailable');
      }
      return updates.map<ImapKeywordResult>(({ uid, keyword, add }) => {
        const keywords = byUid.get(uid);
        if (!keywords) return { uid, error: 'notFound' };
        return { uid, keywords, ...(imapFlag(keyword) && Object.hasOwn(keywords, keyword) === add ? {} : { error: 'forbidden' }) };
      });
    }, Math.min(timeout, operationTimeout)).catch((error) => {
      if (storeAttempted) throw new MailTransportError('keyword_write_unknown');
      throw error;
    });
  }

  async function moveSelectedMessage(client: ImapFlow, mailbox: string, uid: number, destination: string) {
    if (mailbox === destination) throw new MailTransportError('same_mailbox');
    if (!client.capabilities.has('MOVE')) throw new MailTransportError('move_not_supported');
    if (!await client.fetchOne(uid, { uid: true }, { uid: true })) return { status: 'absent' as const };
    const moved = await client.messageMove(uid, destination, { uid: true });
    if (!moved) throw new MailTransportError('mail_unavailable');
    return {
      status: 'moved' as const,
      destination,
      uid: moved.uidMap?.get(uid) ?? null,
      uidValidity: moved.uidValidity?.toString() ?? null,
    };
  }

  function moveMessage(account: MailAccount, mailbox: string, uidValidity: string, uid: number, destination: string) {
    if (mailbox === destination) throw new MailTransportError('same_mailbox');
    return withMailbox(account, mailbox, { readOnly: false, uidValidity }, (client) =>
      moveSelectedMessage(client, mailbox, uid, destination));
  }

  function trashMessage(account: MailAccount, mailbox: string, uidValidity: string, uid: number) {
    return moveToRole(account, mailbox, uidValidity, uid, 'trash');
  }

  async function archiveGmailFromSelected(client: ImapFlow, uid: number) {
    const byUid = { uid: true };
    if (!await client.fetchOne(uid, byUid, byUid)) return { status: 'absent' as const };
    // Gmail archive removes Inbox membership while retaining All Mail and every other label.
    if (!await client.messageFlagsRemove(uid, ['\\Inbox'], { ...byUid, useLabels: true })) {
      throw new MailTransportError('archive_rejected');
    }
    const updated = await client.fetchOne(uid, { labels: true }, byUid);
    if (updated && (!updated.labels || [...updated.labels].some((label) => label.toLowerCase() === '\\inbox'))) {
      throw new MailTransportError('archive_rejected');
    }
    return { status: 'moved' as const };
  }

  type FolderList = Awaited<ReturnType<ImapFlow['list']>>;

  function moveDestination(folders: FolderList, action: MoveAction): string {
    const destination = folders.find(({ flags }) =>
      flags.has(MOVE_ROLES[action]) && !flags.has('\\Noselect') && !flags.has('\\NonExistent'));
    if (!destination) throw new MailTransportError(`${action}_not_configured`);
    return destination.path;
  }

  function moveToRole(account: MailAccount, mailbox: string, uidValidity: string, uid: number, action: MoveAction) {
    return withClient(account.imap, async (client) => {
      if (action === 'archive' && client.capabilities.has('X-GM-EXT-1')) {
        if (mailbox.toUpperCase() !== 'INBOX') throw new MailTransportError('archive_requires_inbox');
        return withSelectedMailbox(client, mailbox, { readOnly: false, uidValidity }, () => archiveGmailFromSelected(client, uid));
      }
      const destination = moveDestination(await client.list(), action);
      return withSelectedMailbox(client, mailbox, { readOnly: false, uidValidity }, () =>
        moveSelectedMessage(client, mailbox, uid, destination));
    });
  }

  function batchError(error: unknown): ImapBatchResult {
    return { error: error instanceof MailTransportError ? error.code : 'mail_unavailable' };
  }

  async function patchFlagGroup(client: ImapFlow, uids: number[], flags: FlagPatch): Promise<ImapBatchResult[]> {
    const byUid = { uid: true };
    const query = { flags: true };
    const initial = await client.fetchAll(uids.join(','), query, byUid);
    const observed = new Set(initial.map(({ uid }) => uid));
    const { add, remove } = flagChanges(flags);
    const sequence = uids.filter((uid) => observed.has(uid)).join(',');
    if (sequence && add.length) await client.messageFlagsAdd(sequence, add, byUid);
    if (sequence && remove.length) await client.messageFlagsRemove(sequence, remove, byUid);
    const confirmed = sequence ? await client.fetchAll(sequence, query, byUid) : [];
    const byMessage = new Map(confirmed.flatMap(({ uid, flags }) => flags ? [[uid, flags] as const] : []));
    const missing = uids.filter((uid) => !byMessage.has(uid));
    const unresolved = missing.length ? await client.search({ uid: missing.join(',') }, byUid).catch(() => false as const) : [];
    return uids.map((uid) => {
      const actual = byMessage.get(uid);
      if (!actual) return { error: !unresolved || unresolved.includes(uid) ? 'mail_unavailable' : 'message_not_found' };
      return { value: { uid, seen: actual.has('\\Seen'), flagged: actual.has('\\Flagged') } };
    });
  }

  async function runMessageBatch(account: MailAccount, mailbox: string, uidValidity: string, operations: ImapBatchOperation[],
    budget: ImapBatchBudget, timeout = operationTimeout, deferredWrites = new Set<number>()): Promise<ImapBatchResult[]> {
    const outcomes: (ImapBatchResult | undefined)[] = Array.from({ length: operations.length });
    const readOnly = operations.every(({ type }) => type === 'read');
    function record(position: number, result: ImapBatchResult) {
      outcomes[position] = result;
      if (operations[position].type !== 'read' && 'error' in result
        && (result.error === 'mail_timeout' || result.error === 'mail_unavailable')) deferredWrites.add(operations[position].uid);
      return result;
    }
    try {
      await withMailbox(account, mailbox, { readOnly, uidValidity }, async (client) => {
        let folders: FolderList | undefined;
        for (let index = 0; index < operations.length && client.usable;) {
          const operation = operations[index];
          const { uid } = operation;
          let end = index + 1;
          try {
            if (operation.type === 'read') {
              while (operations[end]?.type === 'read') end += 1;
              const uids = new Set(operations.slice(index, end).map((entry) => entry.uid));
              const messages = await client.fetchAll([...uids].join(','), MESSAGE_QUERY, { uid: true });
              const byUid = new Map(messages.map((message) => [message.uid, message]));
              for (let item = index; item < end; item += 1) {
                const message = byUid.get(operations[item].uid);
                record(item, message ? await messageBody(client, mailbox, uidValidity, message, budget)
                  .then((value): ImapBatchResult => ({ value }), batchError) : { error: 'message_not_found' });
              }
            } else if (deferredWrites.has(uid)) {
              record(index, { error: 'mail_unavailable' });
            } else if (operation.type === 'flags') {
              const uids = new Set([uid]);
              let next = operations[end];
              while (next?.type === 'flags' && !uids.has(next.uid) && !deferredWrites.has(next.uid)
                && next.flags.seen === operation.flags.seen && next.flags.flagged === operation.flags.flagged) {
                uids.add(next.uid);
                next = operations[++end];
              }
              const results = await patchFlagGroup(client, [...uids], operation.flags);
              for (const [position, result] of results.entries()) record(index + position, result);
            } else if (operation.type === 'tags') {
              record(index, { value: await patchSelectedTags(client, uid, operation.tags) });
            } else if (operation.role === 'archive' && client.capabilities.has('X-GM-EXT-1')) {
              if (mailbox.toUpperCase() !== 'INBOX') throw new MailTransportError('archive_requires_inbox');
              record(index, { value: await archiveGmailFromSelected(client, uid) });
            } else {
              folders ??= await client.list();
              const destination = moveDestination(folders, operation.role);
              record(index, { value: await moveSelectedMessage(client, mailbox, uid, destination) });
            }
          } catch (error) {
            for (let item = index; item < end; item += 1) if (!outcomes[item]) record(item, batchError(error));
          }
          index = end;
        }
      }, Math.min(timeout, operationTimeout));
    } catch (error) {
      return outcomes.map((result, index) => result ?? record(index, batchError(error)));
    }
    return outcomes.map((result, index) => result ?? record(index, { error: 'mail_unavailable' }));
  }

  async function submitMessage(account: MailAccount, { to, message }: { to: string[]; message: string | Uint8Array }) {
    if (!account.smtp) throw new MailTransportError('smtp_not_configured');
    const smtp = account.smtp;
    const useStartTls = smtp.mode === 'starttls';
    const size = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_MESSAGE_BYTES) throw new MailTransportError('message_too_large');
    const signal = AbortSignal.timeout(30_000);
    let client: Awaited<ReturnType<typeof connectSmtp>>;
    try {
      client = await connectSmtp({
        connect: openSocket,
        host: smtp.host,
        port: smtp.port ?? (useStartTls ? 587 : 465),
        secure: useStartTls ? 'starttls' : 'on',
        auth: 'accessToken' in smtp ? { user: smtp.user, accessToken: smtp.accessToken } : { user: smtp.user, pass: smtp.password },
        signal,
      });
    } catch (error) {
      if (error instanceof CommandError && error.code === 'EAUTH') throw new MailTransportError('authentication_failed');
      // The server has received no message data at this stage.
      throw new MailTransportError('mail_unavailable');
    }
    try {
      const result = await client.send({ from: account.email, to, message }, { signal });
      return { accepted: [...result.accepted], rejected: result.rejected.map(({ recipient }) => recipient) };
    } catch (error) {
      if (error instanceof CommandError && error.responseCode && error.responseCode >= 400
          && error.code !== 'ECONNECTION') {
        throw new MailTransportError('submission_rejected');
      }
      // A connection loss after DATA can hide a successful server acknowledgement.
      throw new MailTransportError('submission_unknown');
    } finally {
      await client.close({ signal }).catch(() => {});
    }
  }

  return { listMailboxes, verifyImapAccount, listMessages, listMailboxWindows, readMessage, readMessagePreviews, readMessageSource, patchMessage, patchMessageTags, patchMailboxKeywords, moveMessage, moveToRole, trashMessage, submitMessage, runMessageBatch };
}

export const {
  listMailboxes, verifyImapAccount, listMessages, listMailboxWindows, readMessage, readMessagePreviews, readMessageSource, patchMessage, patchMessageTags, patchMailboxKeywords, moveMessage, moveToRole, trashMessage, submitMessage, runMessageBatch,
} = createMailTransport();

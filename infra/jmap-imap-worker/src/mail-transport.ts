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

export const MOVE_ROLES = {
  archive: '\\Archive', junk: '\\Junk', trash: '\\Trash',
} as const;
export type MoveAction = keyof typeof MOVE_ROLES;

export type MailTransportErrorCode = 'authentication_failed' | 'invalid_message' | 'mailbox_changed'
  | 'mail_unavailable' | 'message_not_found' | 'message_too_large' | 'move_not_supported'
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

async function fetchSource(client: ImapFlow, uid: number, size: number | undefined) {
  if ((size ?? 0) > MAX_MESSAGE_BYTES) throw new MailTransportError('message_too_large');
  const raw = await client.fetchOne(uid, { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } }, { uid: true });
  if (!raw || !raw.source) throw new MailTransportError('message_not_found');
  if (raw.source.length > MAX_MESSAGE_BYTES) throw new MailTransportError('message_too_large');
  return raw.source;
}

export function createMailTransport(openSocket: SmtpConnect = connect) {
  const transport = createSocketsTransport((address, options) => openSocket(address, {
    secureTransport: options?.secureTransport ?? 'off',
    allowHalfOpen: options?.allowHalfOpen ?? false,
  }));

  async function withClient<T>(options: ImapConnection, task: (client: ImapFlow) => Promise<T>): Promise<T> {
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
      await client.connect();
      return await task(client);
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
  ): Promise<T> {
    return withClient(account.imap, (client) => withSelectedMailbox(client, mailbox, options, (selected) => task(client, selected)));
  }

  async function readFolders(client: ImapFlow): Promise<ImapFolder[]> {
    return (await client.list())
      .filter(({ flags }) => !flags.has('\\Noselect') && !flags.has('\\NonExistent'))
      .map(({ path, name, specialUse, delimiter }) => ({
        path, name, specialUse: specialUse ?? null, delimiter: delimiter || null,
      }));
  }

  function listMailboxes(account: MailAccount): Promise<ImapFolder[]> {
    return withClient(account.imap, readFolders);
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

  function listMailboxWindows(account: MailAccount, limit: number, maxFolders = 8) {
    const count = Number.isSafeInteger(maxFolders) ? Math.min(25, Math.max(1, maxFolders)) : 8;
    return withClient(account.imap, async (client) => {
      const folders = await readFolders(client);
      const inboxFirst = [...folders.filter(({ path }) => path === 'INBOX'), ...folders.filter(({ path }) => path !== 'INBOX')];
      const windows: ImapWindow[] = [];
      const failedFolders: string[] = [];
      for (const { path } of inboxFirst.slice(0, count)) {
        try {
          windows.push(await readWindow(client, path, limit));
        } catch {
          failedFolders.push(path);
        }
      }
      return { folders, windows, failedFolders };
    });
  }

  function readMessageSource(account: MailAccount, mailbox: string, uidValidity: string, uid: number): Promise<Uint8Array> {
    return withMailbox(account, mailbox, { readOnly: true, uidValidity }, async (client) => {
      const info = await client.fetchOne(uid, { size: true }, { uid: true });
      if (!info) throw new MailTransportError('message_not_found');
      return fetchSource(client, uid, info.size);
    });
  }

  function readMessage(account: MailAccount, mailbox: string, uidValidity: string, uid: number): Promise<ImapMessageBody> {
    return withMailbox(account, mailbox, { readOnly: true, uidValidity }, async (client) => {
      const message = await client.fetchOne(uid, MESSAGE_QUERY, { uid: true });
      if (!message) throw new MailTransportError('message_not_found');
      const source = await fetchSource(client, uid, message.size);
      try {
        const parsed = await PostalMime.parse(source, { maxNestingDepth: 64, maxHeadersSize: 128 * 1024 });
        return { ...envelope(message), mailbox, uidValidity, text: parsed.text ?? '', html: parsed.html ?? '' };
      } catch {
        throw new MailTransportError('invalid_message');
      }
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
    flags: { seen?: boolean; flagged?: boolean },
  ): Promise<{ uid: number; seen: boolean; flagged: boolean }> {
    return withMailbox(account, mailbox, { readOnly: false, uidValidity }, async (client) => {
      const before = await client.fetchOne(uid, { flags: true }, { uid: true });
      if (!before) throw new MailTransportError('message_not_found');
      const changes = Object.entries({ '\\Seen': flags.seen, '\\Flagged': flags.flagged });
      const add = changes.filter(([, value]) => value === true).map(([flag]) => flag);
      const remove = changes.filter(([, value]) => value === false).map(([flag]) => flag);
      if ((add.length && !await client.messageFlagsAdd(uid, add, { uid: true }))
          || (remove.length && !await client.messageFlagsRemove(uid, remove, { uid: true }))) {
        throw new MailTransportError('mail_unavailable');
      }
      const updated = await client.fetchOne(uid, { flags: true }, { uid: true });
      if (!updated) throw new MailTransportError('message_not_found');
      return { uid, seen: updated.flags?.has('\\Seen') ?? false, flagged: updated.flags?.has('\\Flagged') ?? false };
    });
  }

  function patchMessageTags(account: MailAccount, mailbox: string, uidValidity: string, uid: number, patch: ImapTagPatch) {
    return withMailbox(account, mailbox, { readOnly: false, uidValidity }, async (client) => {
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

  function moveToRole(account: MailAccount, mailbox: string, uidValidity: string, uid: number, action: MoveAction) {
    return withClient(account.imap, async (client) => {
      if (action === 'archive' && client.capabilities.has('X-GM-EXT-1')) {
        if (mailbox.toUpperCase() !== 'INBOX') throw new MailTransportError('archive_requires_inbox');
        return withSelectedMailbox(client, mailbox, { readOnly: false, uidValidity }, async () => {
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
        });
      }
      const destination = (await client.list()).find(({ flags }) =>
        flags.has(MOVE_ROLES[action]) && !flags.has('\\Noselect') && !flags.has('\\NonExistent'));
      if (!destination) throw new MailTransportError(`${action}_not_configured`);
      return withSelectedMailbox(client, mailbox, { readOnly: false, uidValidity }, () =>
        moveSelectedMessage(client, mailbox, uid, destination.path));
    });
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

  return { listMailboxes, verifyImapAccount, listMessages, listMailboxWindows, readMessage, readMessagePreviews, readMessageSource, patchMessage, patchMessageTags, moveMessage, moveToRole, trashMessage, submitMessage };
}

export const {
  listMailboxes, verifyImapAccount, listMessages, listMailboxWindows, readMessage, readMessagePreviews, readMessageSource, patchMessage, patchMessageTags, moveMessage, moveToRole, trashMessage, submitMessage,
} = createMailTransport();

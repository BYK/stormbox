import { compile } from 'html-to-text';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { RelayError } from './errors.js';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const htmlToText = compile({
  wordwrap: false,
  limits: { maxInputLength: MAX_MESSAGE_BYTES, maxDepth: 128, maxChildNodes: 10_000 },
  selectors: ['script', 'style', 'img'].map((selector) => ({ selector, format: 'skip' })),
});
const MESSAGE_QUERY = {
  envelope: true,
  flags: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  headers: ['references'],
};

function openClient(options) {
  const client = new ImapFlow({
    host: options.host,
    port: options.port,
    secure: options.secure,
    doSTARTTLS: !options.secure || undefined,
    auth: { user: options.user, pass: options.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    disableAutoIdle: true,
    logger: false,
  });
  client.on('error', () => {});
  return client;
}

async function withClient(options, task) {
  const client = openClient(options);
  try {
    await client.connect();
    return await task(client);
  } finally {
    client.close();
  }
}

function withSelectedMailbox(account, mailbox, options, task) {
  return withClient(account.imap, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: options.readOnly });
    try {
      const selected = client.mailbox;
      if (options.uidValidity && selected.uidValidity.toString() !== options.uidValidity) {
        throw new RelayError(409, 'mailbox_changed');
      }
      return await task(client, selected);
    } finally {
      lock.release();
    }
  });
}

function addresses(list) {
  return (list ?? []).filter(({ address }) => address).map(({ name, address }) => ({ name: name ?? '', address }));
}

function hasAttachment(part) {
  if (!part) return false;
  return part.disposition?.toLowerCase() === 'attachment'
    || Boolean(part.dispositionParameters?.filename)
    || Boolean(part.childNodes?.some(hasAttachment));
}

function envelope(message) {
  const fields = message.envelope ?? {};
  const refs = message.headers?.toString('utf8').match(/<[^\s<>]+>/g) ?? [];
  const receivedAt = new Date(message.internalDate ?? fields.date ?? 0);
  return {
    uid: message.uid,
    messageId: fields.messageId ?? null,
    references: refs,
    inReplyTo: fields.inReplyTo ?? null,
    subject: fields.subject ?? '',
    from: addresses(fields.from),
    to: addresses(fields.to),
    cc: addresses(fields.cc),
    receivedAt: Number.isNaN(receivedAt.getTime()) ? '1970-01-01T00:00:00.000Z' : receivedAt.toISOString(),
    size: message.size ?? 0,
    seen: message.flags?.has('\\Seen') ?? false,
    flagged: message.flags?.has('\\Flagged') ?? false,
    hasAttachments: hasAttachment(message.bodyStructure),
  };
}

async function selectableMailboxes(client) {
  return (await client.list()).filter((entry) => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'));
}

export function listMailboxes(account) {
  return withClient(account.imap, async (client) => (await selectableMailboxes(client))
    .map(({ path, name, specialUse }) => ({ path, name, specialUse: specialUse ?? null })));
}

export function listMessages(account, mailbox, limit) {
  return withSelectedMailbox(account, mailbox, { readOnly: true }, async (client, selected) => {
    const total = selected.exists;
    const first = Math.max(1, total - limit + 1);
    const messages = total ? (await client.fetchAll(`${first}:${total}`, MESSAGE_QUERY)).map(envelope) : [];
    messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.uid - a.uid);
    return { mailbox, uidValidity: selected.uidValidity.toString(), messages };
  });
}

export function readMessage(account, mailbox, uidValidity, uid) {
  return withSelectedMailbox(account, mailbox, { readOnly: true, uidValidity }, async (client) => {
    const message = await client.fetchOne(uid, MESSAGE_QUERY, { uid: true });
    if (!message) throw new RelayError(404, 'message_not_found');
    if (message.size > MAX_MESSAGE_BYTES) throw new RelayError(413, 'message_too_large');
    const raw = await client.fetchOne(uid, { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } }, { uid: true });
    if (!raw?.source) throw new RelayError(404, 'message_not_found');
    if (raw.source.length > MAX_MESSAGE_BYTES) throw new RelayError(413, 'message_too_large');
    let parsed;
    try {
      parsed = await PostalMime.parse(raw.source, { maxNestingDepth: 64, maxHeadersSize: 128 * 1024 });
    } catch {
      throw new RelayError(422, 'invalid_message');
    }
    const html = parsed.html ?? '';
    const text = parsed.text?.trim() ? parsed.text : htmlToText(html);
    return { ...envelope(message), mailbox, uidValidity, text, html };
  });
}

export function patchMessage(account, mailbox, uidValidity, uid, flags) {
  return withSelectedMailbox(account, mailbox, { uidValidity }, async (client) => {
    const previous = await client.fetchOne(uid, { flags: true }, { uid: true });
    if (!previous) throw new RelayError(404, 'message_not_found');
    const flagValues = { '\\Seen': flags.seen, '\\Flagged': flags.flagged };
    const add = Object.keys(flagValues).filter((key) => flagValues[key] === true);
    const remove = Object.keys(flagValues).filter((key) => flagValues[key] === false);
    if (add.length) await client.messageFlagsAdd(uid, add, { uid: true });
    if (remove.length) await client.messageFlagsRemove(uid, remove, { uid: true });
    const updated = await client.fetchOne(uid, { flags: true }, { uid: true });
    if (!updated) throw new RelayError(404, 'message_not_found');
    return { uid, seen: updated.flags.has('\\Seen'), flagged: updated.flags.has('\\Flagged') };
  });
}

export function moveMessage(account, mailbox, uidValidity, uid, destination) {
  if (mailbox === destination) throw new RelayError(400, 'same_mailbox');
  return withSelectedMailbox(account, mailbox, { uidValidity }, async (client) => {
    if (!client.capabilities.has('MOVE')) throw new RelayError(501, 'move_not_supported');
    if (!(await client.fetchOne(uid, { uid: true }, { uid: true }))) return { status: 'absent' };
    const moved = await client.messageMove(uid, destination, { uid: true });
    if (!moved) throw new RelayError(502, 'mail_unavailable');
    return {
      status: 'moved',
      destination,
      uid: moved.uidMap?.get(uid) ?? null,
      uidValidity: moved.uidValidity?.toString() ?? null,
    };
  });
}

export async function trashMessage(account, mailbox, uidValidity, uid) {
  const trash = await withClient(account.imap, async (client) =>
    (await selectableMailboxes(client)).find(({ flags }) => flags.has('\\Trash')));
  if (!trash) throw new RelayError(422, 'trash_not_configured');
  return moveMessage(account, mailbox, uidValidity, uid, trash.path);
}

export function watchSnapshot(account, previous) {
  return withSelectedMailbox(account, 'INBOX', { readOnly: true }, async (client, selected) => {
    const next = { uidValidity: selected.uidValidity.toString(), uidNext: selected.uidNext };
    if (!previous || next.uidValidity !== previous.uidValidity || previous.uidNext >= next.uidNext || !selected.exists) {
      return { next, messages: [] };
    }
    const messages = await client.fetchAll(`${previous.uidNext}:${next.uidNext - 1}`, { uid: true }, { uid: true });
    return { next, messages: messages.map(({ uid }) => `${next.uidValidity}:${uid}`) };
  });
}

import { createHash } from 'node:crypto';
import type { AccountSnapshot, ChangePage, StoredMailbox, StoredMessage } from './account';
import type { ImapMessageBody, MailAccount } from './mail-transport';
import { HttpError, json, readJson } from './http';
import { imapFlag, type KeywordUpdate, type KeywordWriteOutcome } from './keywords';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const MAX_CALLS = 16;
const MAX_OBJECTS = 100;
const MAX_BODY_FETCHES = 4;
const PAGE_LIMIT = 5000;

export interface JmapStore {
  snapshot(account: JmapAccount): Promise<AccountSnapshot>;
  changes(account: JmapAccount, type: 'email' | 'mailbox', since: string, max?: number): Promise<ChangePage | null>;
  body(account: JmapAccount, message: StoredMessage): Promise<ImapMessageBody>;
  source(account: JmapAccount, id: string): Promise<Uint8Array<ArrayBufferLike> | null>;
  setKeywords?(account: JmapAccount, updates: KeywordUpdate[], ifInState: string | null): Promise<KeywordWriteOutcome>;
}

export type JmapAccount = Pick<MailAccount, 'id' | 'name' | 'email'>;

type ObjectMap = Record<string, any>;
type MethodResult = [string, ObjectMap, string];

class MethodError extends Error {
  constructor(readonly type: string) { super(type); }
}

function record(value: unknown): value is ObjectMap {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function selectedProperties(object: ObjectMap, args: ObjectMap): ObjectMap {
  if (args.properties === undefined || args.properties === null) return object;
  if (!strings(args.properties)) throw new MethodError('invalidArguments');
  return Object.fromEntries(Object.entries(object).filter(([key]) => key === 'id' || args.properties.includes(key)));
}

function needed(args: ObjectMap, properties: string[]): boolean {
  return !strings(args.properties) || properties.some((key) => args.properties.includes(key));
}

function get<T>(rows: readonly T[], args: ObjectMap, key: (row: T) => string) {
  if (args.ids === undefined || args.ids === null) {
    if (rows.length > MAX_OBJECTS) throw new MethodError('tooManyObjects');
    return { rows, notFound: [] };
  }
  if (!strings(args.ids)) throw new MethodError('invalidArguments');
  if (args.ids.length > MAX_OBJECTS) throw new MethodError('tooManyObjects');
  const indexed = new Map(rows.map((row) => [key(row), row]));
  const requested = [...new Set(args.ids)];
  return {
    rows: requested.flatMap((id) => indexed.has(id) ? [indexed.get(id)!] : []),
    notFound: requested.filter((id) => !indexed.has(id)),
  };
}

function mailboxObject(folder: StoredMailbox, folders: readonly StoredMailbox[]): ObjectMap {
  const delimiter = folder.delimiter === undefined ? '/' : folder.delimiter;
  const parent = folders.filter((candidate) => delimiter && folder.path.startsWith(`${candidate.path}${delimiter}`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return {
    id: folder.id, name: folder.name, parentId: parent?.id ?? null, role: folder.role,
    sortOrder: 0, totalEmails: folder.total, unreadEmails: folder.unread,
    totalThreads: folder.total, unreadThreads: folder.unread, isSubscribed: true,
    myRights: {
      mayReadItems: true, mayAddItems: false, mayRemoveItems: false,
      maySetSeen: false, maySetKeywords: false, mayCreateChild: false,
      mayRename: false, mayDelete: false, maySubmit: false,
    },
  };
}

function cleanId(id: string) { return id.replace(/^<|>$/g, ''); }

function emailObject(row: StoredMessage, body?: ImapMessageBody): ObjectMap {
  const textBody = body?.text ? [{ partId: 'text', type: 'text/plain', size: new TextEncoder().encode(body.text).length, charset: 'utf-8' }] : [];
  const htmlBody = body?.html ? [{ partId: 'html', type: 'text/html', size: new TextEncoder().encode(body.html).length, charset: 'utf-8' }] : [];
  const parts = [...textBody, ...htmlBody];
  return {
    id: row.id, blobId: row.id, threadId: row.threadId, mailboxIds: { [row.mailboxId]: true }, keywords: row.keywords,
    size: row.size, receivedAt: row.receivedAt, sentAt: null,
    messageId: row.messageId.map(cleanId), inReplyTo: (row.inReplyTo ?? []).map(cleanId),
    references: (row.references ?? []).map(cleanId), from: row.from, sender: null,
    to: row.to, cc: row.cc ?? [], bcc: null, replyTo: null, subject: row.subject,
    hasAttachment: Boolean(row.hasAttachment), preview: row.preview ?? body?.text?.slice(0, 256) ?? '',
    bodyStructure: parts.length > 1 ? { type: 'multipart/alternative', subParts: parts } : parts[0] ?? null,
    textBody, htmlBody, attachments: [],
    bodyValues: Object.fromEntries(parts.map(({ partId }) => {
      const value = body![partId as 'text' | 'html'];
      const limit = 128_000;
      return [partId, { value: value.slice(0, limit), isEncodingProblem: false, isTruncated: value.length > limit }];
    })),
  };
}

function resolveReferences(input: ObjectMap, calls: MethodResult[]): ObjectMap {
  const args = { ...input };
  for (const [key, reference] of Object.entries(input)) {
    if (!key.startsWith('#')) continue;
    if (!record(reference) || typeof reference.path !== 'string' || !reference.path.startsWith('/')) {
      throw new MethodError('invalidResultReference');
    }
    const prior = calls.find(([name, , id]) => name === reference.name && id === reference.resultOf);
    if (!prior || Object.hasOwn(args, key.slice(1))) throw new MethodError('invalidResultReference');
    let result: any = prior[1];
    for (const part of reference.path.slice(1).split('/')) {
      const segment = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (segment === '*' && Array.isArray(result)) {
        throw new MethodError('invalidResultReference');
      }
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, segment)) {
        throw new MethodError('invalidResultReference');
      }
      result = result[segment];
    }
    delete args[key];
    Object.defineProperty(args, key.slice(1), { value: result, enumerable: true });
  }
  return args;
}

function contains(haystack: string | undefined | null, value: unknown) {
  if (typeof value !== 'string') throw new MethodError('invalidArguments');
  return (haystack ?? '').toLowerCase().includes(value.toLowerCase());
}

function filterEmails(value: unknown, depth = 0): (row: StoredMessage) => boolean {
  if (value === null || value === undefined) return () => true;
  if (!record(value) || depth > 6) throw new MethodError('invalidArguments');
  if (Object.hasOwn(value, 'operator')) {
    if (!Array.isArray(value.conditions) || value.conditions.length > 20) throw new MethodError('invalidArguments');
    const predicates = value.conditions.map((condition: unknown) => filterEmails(condition, depth + 1));
    if (value.operator === 'AND') return (row) => predicates.every((predicate) => predicate(row));
    if (value.operator === 'OR') return (row) => predicates.some((predicate) => predicate(row));
    if (value.operator === 'NOT') return (row) => predicates.every((predicate) => !predicate(row));
    throw new MethodError('unsupportedFilter');
  }
  const predicates = Object.entries(value).map(([key, operand]): ((row: StoredMessage) => boolean) => {
    switch (key) {
      case 'inMailbox':
        if (typeof operand !== 'string') throw new MethodError('invalidArguments');
        return (row) => row.mailboxId === operand;
      case 'inMailboxOtherThan':
        if (!strings(operand)) throw new MethodError('invalidArguments');
        return (row) => !operand.includes(row.mailboxId);
      case 'hasKeyword': case 'notKeyword':
        if (typeof operand !== 'string') throw new MethodError('invalidArguments');
        return (row) => Object.hasOwn(row.keywords, operand.toLowerCase()) === (key === 'hasKeyword');
      case 'before': case 'after': {
        const threshold = typeof operand === 'string' ? Date.parse(operand) : NaN;
        if (!Number.isFinite(threshold)) throw new MethodError('invalidArguments');
        return (row) => key === 'before' ? Date.parse(row.receivedAt) < threshold : Date.parse(row.receivedAt) >= threshold;
      }
      case 'minSize': case 'maxSize':
        if (!Number.isSafeInteger(operand) || operand < 0) throw new MethodError('invalidArguments');
        return (row) => key === 'minSize' ? row.size >= operand : row.size <= operand;
      case 'hasAttachment':
        if (typeof operand !== 'boolean') throw new MethodError('invalidArguments');
        return (row) => Boolean(row.hasAttachment) === operand;
      case 'subject':
        if (typeof operand !== 'string') throw new MethodError('invalidArguments');
        return (row) => contains(row.subject, operand);
      case 'from': case 'to': case 'cc':
        if (typeof operand !== 'string') throw new MethodError('invalidArguments');
        return (row) => (row[key] ?? []).some(({ name, email }) => contains(`${name ?? ''} ${email}`, operand));
      default: throw new MethodError('unsupportedFilter');
    }
  });
  return (row) => predicates.every((predicate) => predicate(row));
}

function queryIds<T>(input: T[], args: ObjectMap, state: string, candidates: Record<string, (row: T) => string | number>,
  id: (row: T) => string, collapse?: (row: T) => string) {
  const sort = args.sort ?? [];
  if (!Array.isArray(sort) || sort.length > 8) throw new MethodError('invalidArguments');
  const selectors = sort.map((entry) => {
    if (!record(entry) || !Object.hasOwn(candidates, entry.property) || entry.collation !== undefined) {
      throw new MethodError('unsupportedSort');
    }
    return { value: candidates[entry.property], direction: entry.isAscending === false ? -1 : 1 };
  });
  if (selectors.length) input.sort((a, b) => {
    for (const { value, direction } of selectors) {
      const left = value(a);
      const right = value(b);
      if (left !== right) return direction * (left < right ? -1 : 1);
    }
    return id(a).localeCompare(id(b));
  });
  const chosen = new Set<string>();
  const rows = collapse ? input.filter((row) => {
    const key = collapse(row);
    if (chosen.has(key)) return false;
    chosen.add(key);
    return true;
  }) : input;
  const limit = args.limit ?? PAGE_LIMIT;
  const offset = args.anchorOffset ?? 0;
  const position = args.position ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(position) || !Number.isSafeInteger(offset)) {
    throw new MethodError('invalidArguments');
  }
  if (args.anchor != null && typeof args.anchor !== 'string') throw new MethodError('invalidArguments');
  const anchor = args.anchor == null ? null : rows.findIndex((row) => id(row) === args.anchor);
  if (anchor === -1) throw new MethodError('anchorNotFound');
  const start = Math.min(rows.length, Math.max(0, anchor !== null ? anchor + offset : position < 0 ? rows.length + position : position));
  return {
    accountId: args.accountId, queryState: state, canCalculateChanges: false, position: start,
    ids: rows.slice(start, start + Math.min(limit, PAGE_LIMIT)).map(id),
    ...(args.calculateTotal ? { total: rows.length } : {}),
  };
}

export function session(origin: string, accounts: readonly JmapAccount[], writable = false) {
  const accountMap = Object.fromEntries(accounts.map((account) => [account.id, {
    name: account.name ?? account.email, isPersonal: true, isReadOnly: !writable,
    accountCapabilities: { [MAIL]: {
      maxMailboxesPerEmail: 1, maxMailboxDepth: null, maxSizeMailboxName: 255,
      maxSizeAttachmentsPerEmail: 0, emailQuerySortOptions: ['receivedAt', 'sentAt', 'size', 'subject'], mayCreateTopLevelMailbox: false,
    } },
  }]));
  return {
    capabilities: {
      [CORE]: {
        maxSizeUpload: 0, maxConcurrentUpload: 0, maxSizeRequest: 131_072, maxConcurrentRequests: 4,
        maxCallsInRequest: MAX_CALLS, maxObjectsInGet: MAX_OBJECTS, maxObjectsInSet: writable ? MAX_OBJECTS : 0, collationAlgorithms: [],
      },
      [MAIL]: {},
    },
    accounts: accountMap, primaryAccounts: accounts.length ? { [MAIL]: accounts[0].id } : {}, username: accounts[0]?.email ?? '',
    apiUrl: `${origin}/jmap`, downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{type}/{name}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}`, eventSourceUrl: `${origin}/jmap/eventsource{?types,closeafter,ping}`,
    state: createHash('sha256').update(JSON.stringify([writable, accounts.map(({ id, name, email }) => [id, name, email])])).digest('base64url'),
  };
}

export async function jmap(request: Request, accounts: readonly JmapAccount[], store: JmapStore) {
  const payload = await readJson(request);
  if (!record(payload) || !strings(payload.using) || !Array.isArray(payload.methodCalls)) throw new HttpError(400, 'notRequest');
  if (!payload.using.every((capability) => capability === CORE || capability === MAIL)) throw new HttpError(400, 'unknownCapability');
  if (payload.methodCalls.length > MAX_CALLS) throw new HttpError(400, 'limit');
  if (!payload.methodCalls.every((call: unknown) => Array.isArray(call) && call.length === 3
    && typeof call[0] === 'string' && record(call[1]) && typeof call[2] === 'string')) throw new HttpError(400, 'notRequest');
  const methodResponses: MethodResult[] = [];
  const snapshots = new Map<string, Promise<AccountSnapshot>>();
  const bodyBudget = { left: MAX_BODY_FETCHES };
  const methods = new Set([
    'Core/echo', 'Email/get', 'Email/query', 'Email/changes', 'Email/queryChanges',
    'Mailbox/get', 'Mailbox/query', 'Mailbox/changes', 'Mailbox/queryChanges', 'Thread/get',
  ]);
  if (store.setKeywords) methods.add('Email/set');
  for (const [name, args, callId] of payload.methodCalls) {
    try {
      if (!methods.has(name)) throw new MethodError('unknownMethod');
      const resolved = resolveReferences(args, methodResponses);
      if (name === 'Core/echo') {
        methodResponses.push([name, resolved, callId]);
        continue;
      }
      if (!payload.using.includes(MAIL)) throw new MethodError('unknownMethod');
      const account = accounts.find(({ id }) => id === resolved.accountId);
      if (!account) throw new MethodError('accountNotFound');
      if (name === 'Email/set') {
        try {
          methodResponses.push([name, await emailSet(resolved, account, store), callId]);
        } finally {
          snapshots.delete(account.id);
        }
      } else {
        let pending = snapshots.get(account.id);
        if (!pending) {
          pending = store.snapshot(account);
          snapshots.set(account.id, pending);
        }
        const snapshot = await pending;
        methodResponses.push([name, await handleMethod(name, resolved, account, snapshot, store, bodyBudget), callId]);
      }
    } catch (error) {
      methodResponses.push(['error', { type: error instanceof MethodError ? error.type : 'serverFail' }, callId]);
    }
  }
  const origin = new URL(request.url).origin;
  return json({ methodResponses, sessionState: session(origin, accounts, Boolean(store.setKeywords)).state });
}

async function emailSet(args: ObjectMap, account: JmapAccount, store: JmapStore): Promise<ObjectMap> {
  const { create = null, destroy = null, ifInState = null, update = null } = args;
  if ((create !== null && !record(create)) || (update !== null && !record(update))
    || (destroy !== null && !strings(destroy)) || (ifInState !== null && typeof ifInState !== 'string')) {
    throw new MethodError('invalidArguments');
  }
  const creations = Object.keys(create ?? {});
  const destructions = destroy ?? [];
  const patches = Object.entries(update ?? {});
  if (creations.length + destructions.length + patches.length > MAX_OBJECTS) throw new MethodError('requestTooLarge');
  const updates: KeywordUpdate[] = [];
  const invalid: [string, ObjectMap][] = [];
  for (const [id, patch] of patches) {
    // One keyword per Email keeps each object update a single atomic IMAP STORE (RFC 8620 §5.3).
    if (!record(patch) || Object.keys(patch).length !== 1) {
      invalid.push([id, { type: 'invalidPatch' }]);
      continue;
    }
    const [path, value] = Object.entries(patch)[0];
    const pointer = /^keywords\/((?:[^/~]|~[01])+)$/.exec(path)?.[1];
    const keyword = pointer?.replace(/~1/g, '/').replace(/~0/g, '~').toLowerCase();
    if (!keyword || !imapFlag(keyword) || (value !== true && value !== null)) {
      invalid.push([id, { type: 'invalidProperties', properties: [path] }]);
      continue;
    }
    updates.push({ id, keyword, add: value === true });
  }
  const result = await store.setKeywords!(account, updates, ifInState);
  if (!result) throw new MethodError('stateMismatch');
  if ('error' in result) throw new MethodError(result.error);
  const rejected = [...invalid, ...Object.entries(result.notUpdated).map(([id, type]): [string, ObjectMap] => [id, { type }])];
  return {
    accountId: account.id, oldState: result.oldState, newState: result.newState,
    created: null, destroyed: null,
    updated: result.updated.length ? Object.fromEntries(result.updated.map((id) => [id, null])) : null,
    notUpdated: rejected.length ? Object.fromEntries(rejected) : null,
    notCreated: creations.length ? Object.fromEntries(creations.map((id) => [id, { type: 'forbidden' }])) : null,
    notDestroyed: destructions.length ? Object.fromEntries(destructions.map((id: string) => [id, { type: 'forbidden' }])) : null,
  };
}

async function handleMethod(name: string, args: ObjectMap, account: JmapAccount, snapshot: AccountSnapshot,
  store: JmapStore, bodyBudget: { left: number }): Promise<ObjectMap> {
  const { mailboxes, messages, state } = snapshot;
  const base = { accountId: account.id, state };
  const [type, method] = name.split('/');
  if (method === 'changes') {
    if (typeof args.sinceState !== 'string' || (args.maxChanges != null &&
      (!Number.isSafeInteger(args.maxChanges) || args.maxChanges < 1))) throw new MethodError('invalidArguments');
    const result = await store.changes(account, type === 'Email' ? 'email' : 'mailbox', args.sinceState, args.maxChanges);
    if (!result) throw new MethodError('cannotCalculateChanges');
    return { accountId: account.id, ...result };
  }
  if (method === 'queryChanges') throw new MethodError('cannotCalculateChanges');
  if (type === 'Mailbox') {
    const objects = mailboxes.map((folder) => mailboxObject(folder, mailboxes));
    if (method === 'query') {
      const filter = args.filter ?? {};
      const filterKeys = Object.keys(filter);
      if (!record(filter) || filterKeys.some((key) => !['parentId', 'role', 'hasAnyRole', 'isSubscribed'].includes(key))) {
        throw new MethodError('unsupportedFilter');
      }
      return queryIds(objects.filter((folder) => filterKeys.every((key) => key === 'hasAnyRole'
        ? Boolean(folder.role) === filter[key] : folder[key] === filter[key])),
      args, state, { name: (folder) => folder.name, sortOrder: (folder) => folder.sortOrder }, (folder) => folder.id);
    }
    const found = get(objects, args, (folder) => folder.id);
    return { ...base, list: found.rows.map((folder) => selectedProperties(folder, args)), notFound: found.notFound };
  }
  if (type === 'Thread') {
    const groups = new Map<string, string[]>();
    for (const item of [...messages].reverse()) {
      const ids = groups.get(item.threadId) ?? [];
      ids.push(item.id);
      groups.set(item.threadId, ids);
    }
    const found = get(Array.from(groups, ([id, emailIds]) => ({ id, emailIds })), args, (thread) => thread.id);
    return { ...base, list: found.rows.map((thread) => selectedProperties(thread, args)), notFound: found.notFound };
  }
  if (method === 'query') {
    return queryIds(messages.filter(filterEmails(args.filter)), args, state, {
      receivedAt: (row) => row.receivedAt, sentAt: (row) => row.receivedAt,
      size: (row) => row.size, subject: (row) => row.subject ?? '',
    }, (row) => row.id, args.collapseThreads ? (row) => row.threadId : undefined);
  }
  const found = get(messages, args, (email) => email.id);
  const wantsBody = strings(args.properties)
    ? needed(args, ['bodyStructure', 'bodyValues', 'textBody', 'htmlBody'])
    : args.fetchTextBodyValues === true || args.fetchHTMLBodyValues === true || args.fetchAllBodyValues === true;
  if (wantsBody && found.rows.length > bodyBudget.left) throw new MethodError('tooManyObjects');
  const list: ObjectMap[] = [];
  for (const email of found.rows) {
    const body = wantsBody ? await store.body(account, email) : undefined;
    if (wantsBody) bodyBudget.left -= 1;
    list.push(selectedProperties(emailObject(email, body), args));
  }
  return { ...base, list, notFound: found.notFound };
}

import { type Env, accessToken, mailAccounts, MAX_IMAP_ACCOUNTS } from './config';
import { canSubmitAttentionMessage, submitAttentionMessage } from './attention-submission';
import { GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH, googleOAuthConfiguration } from './google-auth';
import { cancelGoogleLink, finishGoogleLink, startGoogleLink } from './google-link';
import { authorization, consumeSessionAssertion, HttpError, json, matchesToken, pairedAuthorization, readJson, sessionCookie } from './http';
import { jmap, session, type JmapAccount, type JmapStore } from './jmap';
import { isTagKeyword } from './keywords';
import {
  listMailboxes, MailTransportError, MOVE_ROLES, moveToRole, patchMessage, patchMessageTags,
  readMessage, readMessageSource, type ImapTagPatch, type MailAccount, type MoveAction,
} from './mail-transport';
import {
  getManagedAccount, listManagedAccounts, listManagedIds, managedAccountInput, registerManagedAccount, removeManagedAccount,
} from './managed-accounts';
import { handlePush, hasPushSubscribers } from './push';

export { AccountState } from './account';
export { ManagedAccounts } from './managed-accounts';
export { PushSubscriptions } from './push';

const RELAY = '/api/imap/v1';

function accountObject(env: Env, account: JmapAccount) {
  return env.MAILBOXES.getByName(account.id);
}

function makeStore(env: Env, configured: readonly MailAccount[], paired = false): JmapStore {
  const connections = new Map(configured.map((account) => [account.id, account]));
  async function open(account: JmapAccount): Promise<MailAccount> {
    const connection = connections.get(account.id) ?? (paired ? await getManagedAccount(env, account.id) : undefined);
    if (!connection) throw new HttpError(404, 'account_not_found');
    return connection;
  }
  return {
    snapshot: (account) => accountObject(env, account).refresh(account.id),
    changes: (account, type, since, max) => accountObject(env, account).changes(since, type, max),
    body: async (account, { path, uidValidity, uid }) => readMessage(await open(account), path, uidValidity, uid),
    source: async (account, id) => {
      const message = await accountObject(env, account).message(id);
      return message ? readMessageSource(await open(account), message.path, message.uidValidity, message.uid) : null;
    },
    ...(paired ? {
      setKeywords: async (account, updates, ifInState) => {
        const connection = await open(account);
        return accountObject(env, account).setKeywords(connection, updates, ifInState).catch(() => ({ error: 'serverPartialFail' as const }));
      },
    } satisfies Pick<JmapStore, 'setKeywords'> : {}),
  };
}

function number(value: string | null, maximum: number): number {
  if (!value || !/^\d{1,10}$/.test(value)) throw new HttpError(400, 'invalid_number');
  const parsed = Number(value);
  if (parsed < 1 || parsed > maximum) throw new HttpError(400, 'invalid_number');
  return parsed;
}

function parsedSegments(path: string): string[] {
  try {
    return path.split('/').map(decodeURIComponent);
  } catch {
    throw new HttpError(400, 'invalid_path');
  }
}

function readFlagPatch(input: unknown): { seen?: boolean; flagged?: boolean } {
  if (input == null || typeof input !== 'object') throw new HttpError(400, 'invalid_flags');
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key, value]) => !['seen', 'flagged'].includes(key) || typeof value !== 'boolean')) {
    throw new HttpError(400, 'invalid_flags');
  }
  return Object.fromEntries(entries);
}

function isCustomLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && value.trim().length > 0
    && !/^\\|^inbox$|^\[(?:gmail|googlemail)\](?:\/|$)/i.test(value) && !/[\p{Cc}\p{Cs}]/u.test(value);
}

function readTagPatch(input: unknown): ImapTagPatch {
  const patch: ImapTagPatch = { add: [], remove: [], addLabels: [], removeLabels: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_tags');
  for (const [operation, values] of Object.entries(input)) {
    const labels = operation === 'addLabels' || operation === 'removeLabels';
    if ((!labels && operation !== 'add' && operation !== 'remove') || !Array.isArray(values)
      || values.length > 64 || !values.every(labels ? isCustomLabel : isTagKeyword)) {
      throw new HttpError(400, 'invalid_tags');
    }
    patch[operation] = [...new Set(values)];
  }
  const removedKeywords = new Set(patch.remove.map((keyword) => keyword.toLowerCase()));
  const removedLabels = new Set(patch.removeLabels);
  if ((!patch.add.length && !patch.remove.length && !patch.addLabels.length && !patch.removeLabels.length)
    || patch.add.some((keyword) => removedKeywords.has(keyword.toLowerCase()))
    || patch.addLabels.some((label) => removedLabels.has(label))) {
    throw new HttpError(400, 'invalid_tags');
  }
  return patch;
}

function managedAuthorized(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get('Origin');
  return url.origin === env.PUBLIC_ORIGIN && (!origin || origin === env.PUBLIC_ORIGIN) && pairedAuthorization(request, env);
}

async function relay(request: Request, url: URL, env: Env): Promise<Response> {
  const parts = parsedSegments(url.pathname.slice(RELAY.length + 1));
  if (parts.length === 1 && parts[0] === 'health' && request.method === 'GET') {
    return json({ status: 'ok', service: 'stormbox-jmap-imap' });
  }
  const secret = accessToken(env);
  if (!secret && !env.RELAY_SESSION_KEY) throw new HttpError(503, 'gateway_not_configured');
  if (url.pathname === GOOGLE_CALLBACK_PATH && request.method === 'GET') {
    const configured = mailAccounts(env);
    return finishGoogleLink(request, url, env, configured, MAX_IMAP_ACCOUNTS - configured.length);
  }
  if (url.pathname === GOOGLE_START_PATH && request.method === 'POST') {
    if (!googleOAuthConfiguration(env)) throw new HttpError(404, 'google_oauth_unavailable');
    if (!managedAuthorized(request, url, env)) throw new HttpError(401, 'unauthorized');
    return startGoogleLink(request, env);
  }
  if (parts.length === 1 && parts[0] === 'session') {
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) throw new HttpError(403, 'invalid_origin');
    if (request.method === 'DELETE') {
      const headers = new Headers({ 'Set-Cookie': sessionCookie(env, false) });
      await cancelGoogleLink(request, env, headers).catch(() => {});
      return json(null, 204, headers);
    }
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const input = await readJson(request, 4096);
    const paired = env.RELAY_SESSION_KEY
      ? url.origin === env.PUBLIC_ORIGIN && await consumeSessionAssertion(input?.assertion, env)
      : matchesToken(input?.accessToken, secret);
    if (!paired) throw new HttpError(401, 'unauthorized');
    return json(null, 204, { 'Set-Cookie': sessionCookie(env, true) });
  }
  const authorized = request.method === 'GET'
    ? authorization(request, env, true)
    : pairedAuthorization(request, env);
  if (!authorized) throw new HttpError(401, 'unauthorized');
  const accounts = mailAccounts(env);
  const [resource, id, subresource, uid] = parts;
  if (resource !== 'accounts') throw new HttpError(404, 'not_found');
  const managed = managedAuthorized(request, url, env);
  if (parts.length === 1 && request.method === 'GET') {
    const configured = accounts.map(({ id, email, name }) => ({ id, email, name: name ?? email }));
    return json({
      accounts: [...configured, ...(managed ? await listManagedAccounts(env) : [])],
      ...(managed && googleOAuthConfiguration(env) ? { googleOAuth: true } : {}),
    });
  }
  if (parts.length === 1 && request.method === 'POST') {
    if (!managed) throw new HttpError(401, 'unauthorized');
    const input = managedAccountInput(await readJson(request, 4096));
    if (accounts.some(({ email }) => email.toLowerCase() === input.email.toLowerCase())) {
      throw new HttpError(409, 'account_exists');
    }
    const account = await registerManagedAccount(env, input, MAX_IMAP_ACCOUNTS - accounts.length);
    if (await hasPushSubscribers(env).catch(() => false)) {
      await env.MAILBOXES.getByName(account.id).watch(60).catch(() => {});
    }
    return json(account);
  }
  if (!id) throw new HttpError(405, 'method_not_allowed');
  const configured = accounts.find((entry) => entry.id === id);
  if (parts.length === 2 && request.method === 'DELETE') {
    if (!managed) throw new HttpError(401, 'unauthorized');
    if (configured) throw new HttpError(409, 'account_not_managed');
    if (!await removeManagedAccount(env, id)) throw new HttpError(404, 'account_not_found');
    await env.MAILBOXES.getByName(id).forgetManagedMailbox().catch(() => {});
    return json(null, 204);
  }
  const account = configured ?? (managed ? await getManagedAccount(env, id) : undefined);
  if (!account) throw new HttpError(404, 'account_not_found');
  if (parts.length === 3 && subresource === 'send' && request.method === 'POST') {
    if (!managed) throw new HttpError(401, 'unauthorized');
    return submitAttentionMessage(request, account, env);
  }
  if (parts.length === 3 && subresource === 'mailboxes' && request.method === 'GET') {
    return json({ mailboxes: await listMailboxes(account) });
  }
  if (subresource !== 'messages') throw new HttpError(404, 'not_found');
  const mailboxValue = url.searchParams.get('mailbox') ?? 'INBOX';
  const mailbox = mailboxValue.toUpperCase() === 'INBOX' ? 'INBOX' : mailboxValue;
  if (!mailbox || mailbox.length > 1024 || /[\0\r\n]/.test(mailbox)) throw new HttpError(400, 'invalid_mailbox');
  if (parts.length === 3 && request.method === 'GET') {
    const state = accountObject(env, account);
    const [window, cached] = await Promise.all([
      state.liveFolder(account, mailbox, number(url.searchParams.get('limit') ?? '50', 100)),
      mailbox === 'INBOX' ? state.inboxPreviews().catch(() => null) : null,
    ]);
    if ('error' in window) throw new MailTransportError(window.error);
    const messages = cached?.uidValidity === window.uidValidity
      ? window.messages.map((message) => ({ ...message, preview: cached.previews[message.uid] }))
      : window.messages;
    return json({ ...window, messages, canSend: Boolean(env.MANAGED_ACCOUNTS) && managed && canSubmitAttentionMessage(account) });
  }
  const action = parts.length === 5 && Object.hasOwn(MOVE_ROLES, parts[4]) ? parts[4] as MoveAction : null;
  if (parts.length !== 4 && !action) {
    throw new HttpError(404, 'not_found');
  }
  const uidValidity = String(number(url.searchParams.get('uidValidity'), 0xffffffff));
  const messageUid = number(uid, 0xffffffff);
  if (parts.length === 4 && request.method === 'GET') {
    return json(await readMessage(account, mailbox, uidValidity, messageUid));
  }
  if (parts.length === 4 && request.method === 'PATCH') {
    const input = await readJson(request, 65_536);
    let mutation;
    if (input && typeof input === 'object' && Object.hasOwn(input, 'tags')) {
      if (Object.keys(input).length !== 1) throw new HttpError(400, 'invalid_tags');
      mutation = patchMessageTags(account, mailbox, uidValidity, messageUid, readTagPatch(input.tags));
    } else {
      mutation = patchMessage(account, mailbox, uidValidity, messageUid, readFlagPatch(input));
    }
    return json(await mutation.finally(() => accountObject(env, account).invalidateFolders(id).catch(() => {})));
  }
  if (action && request.method === 'POST') {
    const mutation = moveToRole(account, mailbox, uidValidity, messageUid, action);
    return json(await mutation.finally(() => accountObject(env, account).invalidateFolders(id).catch(() => {})));
  }
  throw new HttpError(405, 'method_not_allowed');
}

function eventSource(request: Request, accounts: readonly JmapAccount[], store: JmapStore): Response {
  let stop: () => void = () => {};
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const known = new Map<string, string>();
      const closeAfter = new URL(request.url).searchParams.get('closeafter') === 'state';
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      stop = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', stop);
        try { controller.close(); } catch { /* stream already cancelled */ }
      };
      request.signal.addEventListener('abort', stop, { once: true });
      const emit = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)); };
      const poll = async () => {
        const changed: Record<string, Record<string, string>> = Object.create(null);
        for (const account of accounts) {
          if (closed) return;
          try {
            const { state } = await store.snapshot(account);
            if (known.get(account.id) !== state) {
              known.set(account.id, state);
              changed[account.id] = { Email: state, Mailbox: state, Thread: state };
            }
          } catch { /* a later poll can retry transient upstream errors */ }
        }
        if (Object.keys(changed).length) {
          emit(`event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed })}\n\n`);
          if (closeAfter) { stop(); return; }
        } else {
          emit(': keepalive\n\n');
        }
        if (!closed) timeout = setTimeout(() => { void poll(); }, 30_000);
      };
      emit(': connected\n\n');
      void poll();
    },
    cancel() { stop(); },
  });
  return new Response(readable, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
  } });
}

async function generic(request: Request, url: URL, env: Env): Promise<Response> {
  if (!accessToken(env)) throw new HttpError(503, 'gateway_not_configured');
  if (!authorization(request, env)) return json({ error: 'unauthorized' }, 401, {
    'WWW-Authenticate': 'Bearer realm="Stormbox gateway"',
  });
  const accounts = mailAccounts(env);
  return serveJmap(request, url, accounts, makeStore(env, accounts));
}

async function pairedJmap(request: Request, url: URL, env: Env): Promise<Response> {
  if (!managedAuthorized(request, url, env)
    || (request.method === 'POST' && request.headers.get('Origin') !== env.PUBLIC_ORIGIN)) throw new HttpError(401, 'unauthorized');
  const configured = mailAccounts(env);
  const accounts = [...configured, ...await listManagedAccounts(env)];
  return serveJmap(request, url, accounts, makeStore(env, configured, true), RELAY);
}

async function serveJmap(request: Request, url: URL, accounts: readonly JmapAccount[], store: JmapStore, prefix = ''): Promise<Response> {
  const path = url.pathname.slice(prefix.length);
  if ((path === '/.well-known/jmap' || path === '/jmap/session') && request.method === 'GET') {
    return json(session(`${url.origin}${prefix}`, accounts, Boolean(store.setKeywords)));
  }
  if (path === '/jmap' && request.method === 'POST') return jmap(request, accounts, store);
  if (path === '/jmap/eventsource' && request.method === 'GET') return eventSource(request, accounts, store);
  if (path.startsWith('/jmap/download/') && request.method === 'GET') {
    const [accountId, id] = parsedSegments(path.slice('/jmap/download/'.length));
    const account = accounts.find(({ id }) => id === accountId);
    if (!account) throw new HttpError(404, 'account_not_found');
    const source = await store.source(account, id);
    if (!source) throw new HttpError(404, 'message_not_found');
    return new Response(source.slice().buffer, { headers: {
      'Cache-Control': 'no-store', 'Content-Type': 'message/rfc822',
      'Content-Disposition': 'attachment; filename="message.eml"', 'X-Content-Type-Options': 'nosniff',
    } });
  }
  throw new HttpError(404, 'not_found');
}

function addCors(request: Request, response: Response, env: Env): Response {
  const origin = request.headers.get('Origin');
  if (origin !== env.PUBLIC_ORIGIN) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  return new Response(response.body, { status: response.status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.code }, error.status);
  if (error instanceof MailTransportError) {
    switch (error.code) {
      case 'mailbox_changed': return json({ error: error.code }, 409);
      case 'message_not_found': return json({ error: error.code }, 404);
      case 'message_too_large': return json({ error: error.code }, 413);
      case 'mail_timeout': return json({ error: error.code }, 504);
      case 'same_mailbox':
      case 'move_not_supported':
      case 'archive_not_configured':
      case 'archive_requires_inbox':
      case 'archive_rejected':
      case 'junk_not_configured':
      case 'labels_not_supported':
      case 'trash_not_configured': return json({ error: error.code }, 422);
      default: return json({ error: error.code }, 502);
    }
  }
  return json({ error: 'gateway_unavailable' }, 502);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === `${RELAY}/jmap` || url.pathname.startsWith(`${RELAY}/jmap/`)) return await pairedJmap(request, url, env);
      if (url.pathname.startsWith(`${RELAY}/`)) return await relay(request, url, env);
      if (url.pathname.startsWith('/api/push/')) {
        const paired = env.RELAY_SESSION_KEY
          ? managedAuthorized(request, url, env)
          : authorization(request, env, true);
        const response = await handlePush(request, env, paired);
        if (paired && response.ok && request.method === 'POST') {
          const configuredIds = mailAccounts(env).map(({ id }) => id);
          const managedIds = managedAuthorized(request, url, env) ? await listManagedIds(env) : [];
          await Promise.all([...configuredIds, ...managedIds].map((id) => env.MAILBOXES.getByName(id).watch(60)));
        }
        return response;
      }
      if (url.pathname === '/.well-known/jmap' || url.pathname === '/jmap' || url.pathname.startsWith('/jmap/')) {
        const response = request.method === 'OPTIONS' ? json(null, 204) : await generic(request, url, env);
        return addCors(request, response, env);
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const response = errorResponse(error);
      return url.pathname.startsWith('/api/') ? response : addCors(request, response, env);
    }
  },
} satisfies ExportedHandler<Env>;

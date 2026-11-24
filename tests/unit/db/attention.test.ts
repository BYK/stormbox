import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTATION_TYPE } from '../../../src/constants/states';
import { MAIL_UNDO_MS } from '../../../src/constants/mail-actions';
import { makeAttentionHandlers } from '../../../src/db/attention';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC, TABLE_FAMILIES } from '../../../src/db/protocol';
import { AttentionRelay, type AttentionImapDraft } from '../../../src/sync/backends/imap/attention-relay';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';
import { OutboxRunner } from '../../../src/sync/backends/jmap/outbox-runner';

let engine: Awaited<ReturnType<typeof bootTestEngine>>;

beforeEach(async () => {
  engine = await bootTestEngine();
  await engine.run(`INSERT INTO accounts (id, server_origin, remote_account_id, created_at, updated_at)
    VALUES (1, 'https://jmap.example', 'one', 1, 1), (2, 'https://jmap.example', 'two', 1, 1)`);
});
afterEach(async () => engine.close());

function fakeRelay() {
  const notify = vi.fn();
  const touch = vi.fn();
  const server = { online: true, uidValidity: '3', accountTwoOnline: true, lastToken: '',
    flags: { seen: true, flagged: false }, trashed: false, archived: false, labels: ['Read later'],
    homeWindowGate: undefined as Promise<void> | undefined, workWindowGate: undefined as Promise<void> | undefined,
    workBodyGate: undefined as Promise<void> | undefined, homeActionGate: undefined as Promise<void> | undefined,
    actionFailure: 0, actionFailureCode: '',
    attemptedPatches: [] as unknown[],
    sends: [] as { url: string; draft: AttentionImapDraft }[] };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (!server.online) throw new TypeError('Offline');
    if (url.endsWith('/batch')) return Response.json({ error: 'not_found' }, { status: 404 });
    if (url.endsWith('/session')) {
      if (init.method === 'POST') server.lastToken = JSON.parse(String(init.body)).accessToken;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/accounts')) {
      return Response.json({ accounts: [
        { id: 'work', email: 'work@example.com', name: 'Work' },
        { id: 'home', email: 'me@example.com', name: 'Home' },
      ] });
    }
    if (url.endsWith('/mailboxes')) {
      return Response.json({ mailboxes: [{ path: 'Clients & Projects', name: 'Clients & Projects', specialUse: null, delimiter: '/' }] });
    }
    if (new URL(url, 'https://relay.example').searchParams.get('mailbox') === 'Clients & Projects' && !url.includes('/messages/')) {
      return Response.json({ mailbox: 'Clients & Projects', uidValidity: '9', total: 1,
        messages: [{ uid: 12, subject: 'Client update', seen: false, flagged: false }] });
    }
    if (url.endsWith('/send')) {
      server.sends.push({ url, draft: JSON.parse(String(init.body)) });
      return Response.json({ status: 'submitted', rejected: 1 });
    }
    if (url.includes('/messages/')) {
      if (init.method === 'PATCH') {
        expect(init.credentials).toBe('same-origin');
        const patch = JSON.parse(String(init.body));
        server.attemptedPatches.push(patch);
        if (url.includes('/home/')) await server.homeActionGate;
        if (server.actionFailure) return Response.json({ error: server.actionFailureCode }, { status: server.actionFailure });
        if (patch.tags) {
          server.labels = server.labels.filter((label) => !patch.tags.removeLabels?.includes(label));
          return Response.json({ uid: 12, ...server.flags, keywords: [], labels: server.labels, tagsApplied: true });
        }
        Object.assign(server.flags, patch);
        return Response.json({ uid: 12, ...server.flags });
      }
      if (init.method === 'POST' && url.includes('/trash?')) {
        server.trashed = true;
        return Response.json({ status: 'moved' });
      }
      if (init.method === 'POST' && url.includes('/archive?')) {
        server.archived = true;
        return Response.json({ status: 'moved' });
      }
      if (url.includes('/work/')) await server.workBodyGate;
      const text = `Body from ${url.split('/')[5]}`;
      return Response.json({ text, html: `<p>${text}</p>` });
    }
    if (url.includes('/home/') && !server.accountTwoOnline) return Response.json({}, { status: 502 });
    const work = url.includes('/work/');
    if (!work) await server.homeWindowGate;
    const snapshot = { mailbox: 'INBOX', uidValidity: server.uidValidity, canSend: work,
      messages: work && (server.trashed || server.archived) ? [] : [{ uid: 12, subject: url, ...server.flags, labels: server.labels }] };
    if (work) await server.workWindowGate;
    return Response.json(snapshot);
  });
  const handlers = makeAttentionHandlers(engine, { touch }, fetcher as unknown as typeof fetch, notify);
  return { server, handlers, fetcher, notify, touch };
}

const ownerId = 1;
const workMessage = { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 12 };

describe('Attention cache', () => {
  it('opens a prefetched message without waiting for the rest of its batch', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sibling = { ...workMessage, uid: 13 };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/session')) return new Response(null, { status: 204 });
      if (path.endsWith('/accounts')) return Response.json({ accounts: [{ id: 'work', email: 'work@example.com', name: 'Work' }] });
      if (path.includes('/messages?')) return Response.json({ mailbox: 'INBOX', uidValidity: '3', messages: [{ uid: 12 }, { uid: 13 }] });
      if (path.endsWith('/batch')) {
        const { requests } = JSON.parse(String(init?.body));
        expect(requests.map(({ path: item }) => item)).toEqual([
          '/accounts/work/messages/12?mailbox=INBOX&uidValidity=3', '/accounts/work/messages/13?mailbox=INBOX&uidValidity=3',
        ]);
        await held;
        return Response.json({ responses: requests.map(() => ({ status: 200, body: { text: 'prefetched' } })) });
      }
      return Response.json({ text: 'opened', html: '<p>opened</p>' });
    });
    const handlers = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher);
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    let foreground: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/batch'))).toBe(true));
      const open = () => handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage });
      let opened = false;
      const reads = Promise.all([open(), open()]).then((bodies) => { opened = true; return bodies; });
      foreground = reads;
      await vi.waitFor(() => expect(opened).toBe(true));
      const [first, second] = await reads;
      expect(first).toEqual({ text: 'opened', html: '<p>opened</p>' });
      expect(second).toEqual(first);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/messages/12?'))).toHaveLength(1);
      expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: sibling, cachedOnly: true })).toBeNull();
      release();
      await vi.waitFor(async () => expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: sibling, cachedOnly: true }))
        .toMatchObject({ text: 'prefetched' }));
      expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage, cachedOnly: true })).toEqual(first);
    } finally {
      release();
      await foreground;
    }
  });

  it('batches distinct Gmail writes in one folder and settles each confirmed row', async () => {
    const messages = [12, 13].map((uid) => ({
      uid, seen: false, flagged: false, gmailLabels: true, messageId: `<message-${uid}@example.com>`, subject: `Message ${uid}`,
    }));
    const writeRequests: Array<Array<{ method: string; path: string; body?: { flagged: boolean } }>> = [];
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const url = String(request);
      if (url.endsWith('/session')) return new Response(null, { status: 204 });
      if (url.endsWith('/accounts')) return Response.json({ accounts: [{ id: 'work', email: 'work@example.com', name: 'Work' }] });
      if (url.includes('/messages?')) return Response.json({ mailbox: 'INBOX', uidValidity: '3', messages });
      if (url.includes('/messages/') && init?.method !== 'PATCH') return Response.json({ text: 'Message body' });
      if (!url.endsWith('/batch')) throw new Error(`Unexpected request ${url}`);
      const { requests } = JSON.parse(String(init?.body)) as { requests: (typeof writeRequests)[number] };
      if (requests[0].method === 'PATCH') writeRequests.push(requests);
      return Response.json({ responses: requests.map(({ path, method, body }) => ({
        status: 200, body: method === 'PATCH'
          ? { uid: Number(path.match(/\/messages\/(\d+)/)?.[1]), seen: false, flagged: body?.flagged } : { text: 'Message body' },
      })) });
    });
    const handlers = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher);
    const allHandlers = { ...makeHandlers(engine), ...handlers };
    const runner = new OutboxRunner({ accountId: ownerId, handlers: allHandlers,
      processRow: (row) => processMutationRow({ account: { id: ownerId }, transport: null, handlers: allHandlers, row }) });
    try {
      await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
      await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTIONS]({ ownerId,
        requests: messages.map(({ uid }) => ({ location: { ...workMessage, uid }, action: { type: 'star', value: true } })),
      });
      await runner.drain();
      expect(writeRequests).toHaveLength(1);
      expect(writeRequests[0].map(({ path, body }) => [path, body])).toEqual(messages.map(({ uid }) => [
        `/accounts/work/messages/${uid}?mailbox=INBOX&uidValidity=3`, { flagged: true },
      ]));
      expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts[0].messages)
        .toMatchObject([{ uid: 12, flagged: true }, { uid: 13, flagged: true }]);
      expect(await engine.get('SELECT 1 FROM pending_mutations')).toBeNull();
    } finally {
      await runner.stop();
    }
  });

  it('shares a foreground body with prefetch without holding up other accounts or cached reads', async () => {
    const { handlers, server, fetcher } = fakeRelay();
    let releaseWork!: () => void;
    let releaseHome!: () => void;
    server.workBodyGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    server.homeWindowGate = new Promise<void>((resolve) => { releaseHome = resolve; });
    const bodyRequests = (account: string) => fetcher.mock.calls.filter(([url]) =>
      url.includes(`/${account}/messages/12?`));
    let refresh: Promise<string[]> | undefined;
    try {
      await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test', waitForSync: false });
      refresh = handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId });
      await vi.waitFor(() => expect(bodyRequests('work')).toHaveLength(1));
      const foreground = handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage });
      await expect(handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage, cachedOnly: true })).resolves.toBeNull();
      releaseHome();
      await expect(refresh).resolves.toEqual([]);
      await vi.waitFor(async () => {
        const cached = await handlers[DB_RPC.ATTENTION_BODY]({ ownerId,
          location: { ...workMessage, accountId: 'home' }, cachedOnly: true });
        expect(cached?.text).toBe('Body from home');
      });
      expect(bodyRequests('work')).toHaveLength(1);
      releaseWork();
      await expect(foreground).resolves.toEqual({ text: 'Body from work', html: '<p>Body from work</p>' });
      expect(bodyRequests('work')).toHaveLength(1);
    } finally {
      releaseHome();
      releaseWork();
      await refresh;
      await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage }).catch(() => {});
    }
  });

  it('confirms a message action during an inbox refresh and rejects the stale window', async () => {
    const { handlers, server, fetcher } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    let release!: () => void;
    server.workWindowGate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId });
    try {
      await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.includes('/work/messages?')))
        .toHaveLength(2));
      const action = handlers[DB_RPC.ATTENTION_APPLY_IMAP_ACTION]({
        ownerId, location: workMessage, action: { type: 'star', value: true },
      });
      await vi.waitFor(() => expect(server.attemptedPatches).toEqual([{ flagged: true }]));
      await expect(action).resolves.toMatchObject({ ok: true });
      release();
      await expect(refresh).resolves.toEqual([]);
      const cache = await handlers[DB_RPC.ATTENTION_GET]({ ownerId });
      expect(cache.accounts.find(({ relay_id }) => relay_id === 'work')?.messages).toMatchObject([{ flagged: true }]);
    } finally {
      release();
      await refresh;
    }
  });

  it('refreshes only the affected Inbox after an obsolete UID is rejected without Retry', async () => {
    const { handlers, server, fetcher } = fakeRelay();
    const allHandlers = { ...makeHandlers(engine, { touch: vi.fn() }), ...handlers };
    const runner = new OutboxRunner({
      accountId: ownerId, handlers: allHandlers,
      processRow: (row) => processMutationRow({ account: { id: ownerId }, transport: null, handlers: allHandlers, row }),
    });
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    let release!: () => void;
    server.workWindowGate = new Promise<void>((resolve) => { release = resolve; });
    const windows = (account: string) => fetcher.mock.calls.filter(([url]) => url.includes(`/${account}/messages?`));
    const refresh = handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId });
    try {
      await vi.waitFor(() => expect(windows('work')).toHaveLength(2));
      server.uidValidity = '4';
      server.actionFailure = 409;
      server.actionFailureCode = 'mailbox_changed';
      for (const value of [true, false]) {
        await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
          ownerId, location: workMessage, action: { type: 'star', value },
        });
      }
      await runner.drain();
      expect(await engine.all(`SELECT json_extract(error_json, '$.type') AS type FROM pending_mutations`))
        .toEqual([{ type: 'imapMailboxChanged' }, { type: 'imapMailboxChanged' }]);
      expect(await handlers[DB_RPC.ATTENTION_IMAP_ACTION_FAILURES]({ ownerId }))
        .toMatchObject([{ canRetry: false }, { canRetry: false }]);
      expect(windows('work')).toHaveLength(2);
      release();
      await refresh;
      await vi.waitFor(async () => expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts
        .find(({ relay_id }) => relay_id === 'work')?.uid_validity).toBe('4'));
      expect(windows('work')).toHaveLength(3);
      expect(windows('home')).toHaveLength(2);
      await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: { ...workMessage, uidValidity: '4' } });
    } finally {
      release();
      await refresh;
      await runner.stop();
    }
  });

  it('persists scoped account settings before a slow inbox sync completes', async () => {
    const google = {
      id: 'work', email: 'work@example.com', name: 'Work', managed: true, host: 'imap.gmail.com', auth: 'google-oauth',
    };
    let finishInbox!: (value: Response) => void;
    const inbox = new Promise<Response>((resolve) => { finishInbox = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/session')) return new Response(null, { status: 204 });
      if (String(url).endsWith('/accounts')) {
        return Response.json({ googleOAuth: true, accounts: [{ ...google, password: 'should-not-be-cached' }] });
      }
      return inbox;
    });
    const handlers = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher);
    try {
      await expect(handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'pair', waitForSync: false })).resolves.toEqual([]);
      await handlers[DB_RPC.ATTENTION_LIST_RELAY_ACCOUNTS]({ ownerId });
      const expected = { paired: true, accounts: [google], googleOAuth: true };
      const reopened = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher);
      fetcher.mockClear();
      expect(await reopened[DB_RPC.ATTENTION_LIST_RELAY_ACCOUNTS]({ ownerId, cachedOnly: true })).toEqual(expected);
      expect(await reopened[DB_RPC.ATTENTION_LIST_RELAY_ACCOUNTS]({ ownerId: 2, cachedOnly: true }))
        .toEqual({ paired: false, accounts: [] });
      await engine.run('INSERT INTO attention_imap_pairing VALUES (?)', [2]);
      expect(await reopened[DB_RPC.ATTENTION_LIST_RELAY_ACCOUNTS]({ ownerId: 2, cachedOnly: true }))
        .toEqual({ paired: true, accounts: [] });
      expect(fetcher).not.toHaveBeenCalledWith(expect.stringMatching(/\/accounts$/), expect.anything());
    } finally {
      finishInbox(Response.json({ mailbox: 'INBOX', uidValidity: '3', messages: [] }));
      await handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId });
    }
  });

  it('rejects an unstable inbox window so it cannot replace cached mail', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      mailbox: 'INBOX', uidValidity: '3', messages: [], total: 4, complete: false, minUid: null,
    }));
    await expect(new AttentionRelay(fetcher).inbox('work')).rejects.toMatchObject({ code: 'incomplete_window' });
  });

  it('surfaces a relay deadline as a retryable IMAP timeout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'mail_timeout' }, { status: 504 }));
    await expect(new AttentionRelay(fetcher).body(workMessage)).rejects.toMatchObject({
      code: 'mail_timeout', status: 504, message: 'The IMAP server took too long to respond. Try again.',
    });
  });

  it('allows Google authorization redirects only to the Google consent endpoint', async () => {
    const google = 'https://accounts.google.com/o/oauth2/v2/auth?state=test';
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ url: google }))
      .mockResolvedValueOnce(Response.json({ url: 'https://accounts.google.com.example.org/o/oauth2/v2/auth' }));
    const relay = new AttentionRelay(fetcher);

    expect(await relay.startGoogleOAuth('work')).toBe(google);
    expect(fetcher).toHaveBeenCalledWith('/api/imap/v1/oauth/google/start', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: '{"accountId":"work"}',
    }));
    await expect(relay.startGoogleOAuth()).rejects.toThrow('unexpected Google sign-in URL');
  });

  it('pairing lists isolated accounts and preserves downloaded bodies without a network', async () => {
    const { server, handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'pair-this-browser' });
    expect(server.lastToken).toBe('pair-this-browser');
    const cached = await handlers[DB_RPC.ATTENTION_GET]({ ownerId });
    expect(cached.accounts.map((account) => account.relay_id)).toEqual(['home', 'work']);
    expect(await handlers[DB_RPC.ATTENTION_GET]({ ownerId: 2 })).toEqual({ paired: false, accounts: [], states: {} });
    const body = { text: 'Body from work', html: '<p>Body from work</p>' };
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage })).toEqual(body);
    const withBody = await handlers[DB_RPC.ATTENTION_GET]({ ownerId });
    expect(withBody.accounts.find((account) => account.relay_id === 'work').messages[0].preview).toBe('Body from work');
    server.online = false;
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage, cachedOnly: true })).toEqual(body);
    await expect(handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId })).rejects.toThrow('Offline');
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.map((account) => account.relay_id))
      .toEqual(cached.accounts.map((account) => account.relay_id));
  });

  it('retains a legacy plaintext body offline and fills in its HTML when it reconnects', async () => {
    const { server, handlers } = fakeRelay();
    const args = { ownerId, location: workMessage };
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    await handlers[DB_RPC.ATTENTION_BODY](args);
    await engine.run(`UPDATE attention_imap_bodies SET body_text = 'Previously saved', body_html = NULL WHERE relay_id = 'work'`);

    const cached = { text: 'Previously saved', html: null };
    server.online = false;
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ...args, cachedOnly: true })).toEqual(cached);
    expect(await handlers[DB_RPC.ATTENTION_BODY](args)).toEqual(cached);
    server.online = true;
    const upgraded = { text: 'Body from work', html: '<p>Body from work</p>' };
    expect(await handlers[DB_RPC.ATTENTION_BODY](args)).toEqual(upgraded);
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ...args, cachedOnly: true })).toEqual(upgraded);
  });

  it('shows the account when its first Inbox fetch fails and clears the error on recovery', async () => {
    const { handlers, server } = fakeRelay();
    server.accountTwoOnline = false;
    expect(await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'token' })).toEqual(['me@example.com']);
    const home = async () => (await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.find(({ relay_id }) => relay_id === 'home');
    expect(await home()).toMatchObject({ mailbox: null, messages: [], last_synced_at: null, sync_error: expect.any(String) });
    server.accountTwoOnline = true;
    expect(await handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId })).toEqual([]);
    expect(await home()).toMatchObject({ mailbox: 'INBOX', last_synced_at: expect.any(Number), sync_error: null });
  });

  it('keeps folder windows, message bodies and mutations scoped to account and mailbox', async () => {
    const { handlers, server, fetcher } = fakeRelay();
    const args = { ownerId, accountId: 'work', mailbox: 'Clients & Projects' };
    const location = { accountId: args.accountId, mailbox: args.mailbox, uidValidity: '9', uid: 12 };
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'token' });
    await handlers[DB_RPC.IMAP_FOLDER_LIST_REFRESH](args);
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.find(({ relay_id }) => relay_id === 'work')?.folders)
      .toMatchObject([{ path: args.mailbox }]);
    const [folder, concurrent] = await Promise.all([
      handlers[DB_RPC.IMAP_FOLDER_GET]({ ...args, refresh: true }), handlers[DB_RPC.IMAP_FOLDER_GET]({ ...args, refresh: true }),
    ]);
    expect(folder).toMatchObject({
      uidValidity: '9', messages: [{ uid: 12, subject: 'Client update', flagged: false }], total: 1,
    });
    expect(concurrent).toEqual(folder);
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/work/messages?mailbox=Clients'))).toHaveLength(1);
    await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location });
    expect(await handlers[DB_RPC.ATTENTION_APPLY_IMAP_ACTION]({ ownerId, location, action: { type: 'star', value: true } }))
      .toEqual({ ok: true });
    expect(await handlers[DB_RPC.IMAP_FOLDER_GET]({ ...args, ownerId: 2 })).toBeNull();
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.find(({ relay_id }) => relay_id === 'work')?.messages)
      .toMatchObject([{ uid: 12, flagged: false }]);
    server.online = false;
    expect(await handlers[DB_RPC.IMAP_FOLDER_GET](args)).toMatchObject({ messages: [{ uid: 12, flagged: true }] });
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location, cachedOnly: true })).toMatchObject({ text: 'Body from work' });
  });

  it('keeps accounts with transient failures and discards bodies when UIDVALIDITY changes', async () => {
    const { server, handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage });
    server.uidValidity = '4';
    server.accountTwoOnline = false;
    expect(await handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId })).toEqual(['me@example.com']);
    const updated = await handlers[DB_RPC.ATTENTION_GET]({ ownerId });
    expect(updated.accounts.map((account) => [account.relay_id, account.uid_validity])).toEqual([
      ['home', '3'], ['work', '4'],
    ]);
    await expect(handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage })).rejects.toThrow('Refresh this folder');
  });

  it('reprojects durable offline edits over refreshed windows and restores the row after a rejection', async () => {
    const { server, handlers, fetcher, notify } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const enqueue = (action: object) => handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
      ownerId, location: workMessage, action,
    });
    const work = (cache: Awaited<ReturnType<typeof handlers[typeof DB_RPC.ATTENTION_GET]>>) =>
      cache.accounts.find(({ relay_id }) => relay_id === 'work');

    server.online = false;
    await enqueue({ type: 'star', value: true });
    await enqueue({ type: 'seen', value: false });
    await enqueue({ type: 'tags', tags: { add: ['FollowUp'], addLabels: ['To do'], removeLabels: ['Read later'] } });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(server.flags).toEqual({ seen: true, flagged: false });
    expect(work(await handlers[DB_RPC.ATTENTION_GET]({ ownerId }))?.messages).toMatchObject([
      { uid: 12, flagged: true, seen: false, keywords: ['FollowUp'], labels: ['To do'] },
    ]);
    expect(await handlers[DB_RPC.ATTENTION_IMAP_UNREAD_COUNT]({ ownerId })).toBe(1);

    await enqueue({ type: 'archive' });
    expect(work(await handlers[DB_RPC.ATTENTION_GET]({ ownerId }))?.messages).toEqual([]);
    const reopened = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher as unknown as typeof fetch);
    expect(work(await reopened[DB_RPC.ATTENTION_GET]({ ownerId }))?.messages).toEqual([]);
    expect(await reopened[DB_RPC.ATTENTION_IMAP_UNREAD_COUNT]({ ownerId })).toBe(0);

    server.online = true;
    await reopened[DB_RPC.ATTENTION_REFRESH]({ ownerId });
    expect(work(await reopened[DB_RPC.ATTENTION_GET]({ ownerId }))?.messages).toEqual([]);
    const archive = await engine.get(`SELECT id FROM pending_mutations
      WHERE json_extract(request_json, '$.action.type') = 'archive'`);
    await reopened[DB_RPC.ATTENTION_SETTLE_IMAP_ACTION]({
      mutationId: archive?.id, error: { type: 'archive_not_configured', message: 'Archive is unavailable.' },
    });
    const recovered = await reopened[DB_RPC.ATTENTION_GET]({ ownerId });
    expect(recovered.actionFailure).toMatchObject({ accountId: 'work',
      message: expect.stringMatching(/^Couldn’t archive .*Archive is unavailable\.$/) });
    expect(work(recovered)?.messages).toMatchObject([
      { uid: 12, flagged: true, seen: false, keywords: ['FollowUp'], labels: ['To do'] },
    ]);
  });

  it('queues a selection across IMAP accounts in request order with one offline wake-up', async () => {
    const { server, handlers, notify, touch } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    server.online = false;
    touch.mockClear();
    notify.mockClear();
    const homeMessage = { ...workMessage, accountId: 'home' };
    const requests = [
      { location: workMessage, action: { type: 'star', value: true } },
      { location: homeMessage, action: { type: 'seen', value: false } },
      { location: workMessage, action: { type: 'star', value: false } },
    ];
    const { mutationIds } = await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTIONS]({ ownerId, requests });
    const rows = await engine.all(`SELECT id, request_json FROM pending_mutations ORDER BY id`);
    expect(mutationIds).toEqual(rows.map(({ id }) => id));
    expect(rows.map(({ request_json }) => JSON.parse(String(request_json)))).toEqual(
      requests.map((request) => ({ ...request, accountScoped: true, subject: expect.any(String) })),
    );
    expect(notify).toHaveBeenCalledExactlyOnceWith(ownerId, mutationIds[0]);
    expect(touch.mock.calls).toEqual([[TABLE_FAMILIES.ATTENTION], [TABLE_FAMILIES.MUTATIONS]]);
    expect(server.attemptedPatches).toEqual([]);
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts).toEqual([
      expect.objectContaining({ relay_id: 'home', messages: [expect.objectContaining({ seen: false })] }),
      expect.objectContaining({ relay_id: 'work', messages: [expect.objectContaining({ flagged: false })] }),
    ]);
  });

  it('leaves every row untouched when a selected IMAP UID belongs to an old mailbox window', async () => {
    const { handlers, notify, touch } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    touch.mockClear();
    notify.mockClear();
    const requests = [
      { location: workMessage, action: { type: 'archive' } },
      { location: { ...workMessage, accountId: 'home', uidValidity: '2' }, action: { type: 'archive' } },
    ];
    await expect(handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTIONS]({ ownerId, requests })).rejects.toThrow('This mailbox changed');
    expect(await engine.all('SELECT id FROM pending_mutations')).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.map(({ messages }) => messages.length))
      .toEqual([1, 1]);
  });

  it('projects a deferred edit across worker restart and cancels the whole batch without an IMAP command', async () => {
    const { handlers, server, fetcher } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const { mutationIds } = await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTIONS]({ ownerId, undoable: true,
      requests: [
        { location: workMessage, action: { type: 'trash' } },
        { location: { ...workMessage, accountId: 'home' }, action: { type: 'seen', value: false } },
      ],
    });
    const reopened = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher as unknown as typeof fetch);
    const rows = await engine.all('SELECT id, not_before - created_at AS delay, not_before FROM pending_mutations ORDER BY id');
    expect(rows.map(({ delay }) => delay)).toEqual([MAIL_UNDO_MS, MAIL_UNDO_MS]);
    let clock = Number(rows[0].not_before) - 1;
    const allHandlers = { ...makeHandlers(engine, { touch: vi.fn() }), ...reopened };
    const runner = new OutboxRunner({ accountId: ownerId, handlers: allHandlers,
      options: { now: () => clock },
      processRow: (row) => processMutationRow({ account: { id: ownerId }, transport: null, handlers: allHandlers, row }),
    });
    try {
      await runner.drain();
      await expect(reopened[DB_RPC.ATTENTION_UNDO_IMAP_ACTIONS]({ ownerId: 2, mutationIds })).rejects.toThrow('started syncing');
      await expect(reopened[DB_RPC.ATTENTION_UNDO_IMAP_ACTIONS]({ ownerId, mutationIds: [...mutationIds, 999] }))
        .rejects.toThrow('started syncing');
      expect((await reopened[DB_RPC.ATTENTION_GET]({ ownerId })).accounts).toMatchObject([
        { relay_id: 'home', messages: [{ seen: false }] }, { relay_id: 'work', messages: [] },
      ]);
      await reopened[DB_RPC.ATTENTION_UNDO_IMAP_ACTIONS]({ ownerId, mutationIds });
      clock += MAIL_UNDO_MS;
      await runner.drain();
      expect(server.trashed).toBe(false);
      expect(server.attemptedPatches).toHaveLength(0);
      expect((await reopened[DB_RPC.ATTENTION_GET]({ ownerId })).accounts).toMatchObject([
        { relay_id: 'home', messages: [{ seen: true }] }, { relay_id: 'work', messages: [{ uid: 12 }] },
      ]);
    } finally {
      await runner.stop();
    }
  });

  it('holds each IMAP action until the shared deadline and cancels only unclaimed actions', async () => {
    const { handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const undoExpiresAt = Date.now() + MAIL_UNDO_MS / 2;
    const { mutationIds } = await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTIONS]({ ownerId, undoable: true, undoExpiresAt,
      requests: [
        { location: workMessage, action: { type: 'trash' } },
        { location: { ...workMessage, accountId: 'home' }, action: { type: 'seen', value: false } },
      ],
    });
    const [claimed, pending] = mutationIds;
    const rows = await engine.all('SELECT not_before FROM pending_mutations ORDER BY id');
    expect(rows.map(({ not_before }) => not_before)).toEqual([undoExpiresAt, undoExpiresAt]);
    await engine.run("UPDATE pending_mutations SET local_status = 'in_flight', attempts = 1 WHERE id = ?", [claimed]);
    await expect(handlers[DB_RPC.ATTENTION_UNDO_IMAP_ACTIONS]({ ownerId, mutationIds, allowPartial: true }))
      .resolves.toEqual({ canceledIds: [pending] });
    expect(await engine.all('SELECT id FROM pending_mutations')).toEqual([{ id: claimed }]);
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts).toMatchObject([
      { relay_id: 'home', messages: [{ seen: true }] }, { relay_id: 'work', messages: [] },
    ]);
  });

  it('retries an unsuperseded failure as a fresh edit and refuses stale retries after a newer edit', async () => {
    const { handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const [failedId] = (await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
      ownerId, location: workMessage, action: { type: 'star', value: true },
    })).mutationIds;
    const reject = (mutationId: number) => handlers[DB_RPC.ATTENTION_SETTLE_IMAP_ACTION]({ mutationId,
      error: { type: 'rejected', message: 'The server rejected the change.' },
    });
    await reject(failedId);
    expect(await handlers[DB_RPC.ATTENTION_IMAP_ACTION_FAILURES]({ ownerId: 2 })).toEqual([]);
    expect(await handlers[DB_RPC.ATTENTION_IMAP_ACTION_FAILURES]({ ownerId })).toMatchObject([
      { id: failedId, accountId: 'work', canRetry: true, updatedAt: expect.any(Number),
        message: expect.stringMatching(/^Couldn’t star .*The server rejected the change\.$/) },
    ]);
    const [unrelated] = (await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
      ownerId, location: workMessage, action: { type: 'seen', value: false },
    })).mutationIds;
    await handlers[DB_RPC.ATTENTION_SETTLE_IMAP_ACTION]({ mutationId: unrelated });
    const [retried] = (await handlers[DB_RPC.ATTENTION_RETRY_IMAP_ACTION]({ ownerId, mutationId: failedId })).mutationIds;
    expect(retried).toBeGreaterThan(failedId);
    expect(await handlers[DB_RPC.ATTENTION_IMAP_ACTION_FAILURES]({ ownerId })).toEqual([]);
    await reject(retried);
    const [newer] = (await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
      ownerId, location: workMessage, action: { type: 'star', value: false },
    })).mutationIds;
    expect(await handlers[DB_RPC.ATTENTION_IMAP_ACTION_FAILURES]({ ownerId })).toMatchObject([{ id: retried, canRetry: false }]);
    await handlers[DB_RPC.ATTENTION_SETTLE_IMAP_ACTION]({ mutationId: newer });
    await expect(handlers[DB_RPC.ATTENTION_RETRY_IMAP_ACTION]({ ownerId, mutationId: retried }))
      .rejects.toThrow('replaced by a newer action');
  });

  it('replays Gmail edits across mailbox aliases in order while another account is refreshing', async () => {
    const { server, handlers, fetcher } = fakeRelay();
    const broadcaster = { touch: vi.fn() };
    const allHandlers = { ...makeHandlers(engine, broadcaster), ...handlers };
    const runner = new OutboxRunner({
      accountId: ownerId, handlers: allHandlers,
      processRow: (row) => processMutationRow({ account: { id: ownerId }, transport: null, handlers: allHandlers, row }),
      options: { maxAttempts: 1, backoffBaseMs: 30_000 },
    });
    let releaseHome = () => {};
    let releaseAction = () => {};
    let refresh: Promise<string[]> | undefined;
    try {
      await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
      const alternate = { ...workMessage, mailbox: 'Clients & Projects', uidValidity: '9' };
      await handlers[DB_RPC.IMAP_FOLDER_GET]({ ownerId, ...alternate, refresh: true });
      server.homeWindowGate = new Promise<void>((resolve) => { releaseHome = resolve; });
      refresh = handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId });
      await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.includes('/home/') && url.includes('/messages?')))
        .toHaveLength(2));
      server.actionFailure = 429;
      for (const [location, value] of [[workMessage, true], [alternate, false]] as const) {
        await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
          ownerId, location, action: { type: 'star', value },
        });
      }

      await runner.drain();
      expect(server.attemptedPatches).toEqual([{ flagged: true }]);
      expect((await engine.all('SELECT local_status FROM pending_mutations ORDER BY id')).map(({ local_status }) => local_status))
        .toEqual(['retry', 'pending']);

      server.actionFailure = 0;
      await handlers[DB_RPC.ATTENTION_RESUME_IMAP_ACTIONS]({ ownerId });
      await runner.drain();
      expect(server.attemptedPatches).toEqual([{ flagged: true }, { flagged: true }, { flagged: false }]);
      expect(server.flags.flagged).toBe(false);
      expect(await engine.all('SELECT id FROM pending_mutations')).toEqual([]);

      await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
        ownerId, location: { ...workMessage, accountId: 'home' }, action: { type: 'star', value: true },
      });
      server.homeActionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
      const finishing = runner.drain();
      await vi.waitFor(() => expect(server.attemptedPatches).toHaveLength(4));
      await handlers[DB_RPC.ATTENTION_DISCONNECT]({ ownerId });
      releaseAction();
      releaseHome();
      await finishing;
      expect(await engine.all('SELECT id FROM pending_mutations')).toEqual([]);
      expect(await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).toMatchObject({ paired: false, accounts: [] });
      expect(await engine.get('SELECT 1 FROM attention_imap_settings WHERE owner_account_id = ?', [ownerId])).toBeNull();
    } finally {
      releaseAction();
      releaseHome();
      await refresh;
      await runner.stop();
    }
  });

  it.each([
    [401, 'unauthorized'],
    [422, 'google_reconnect_required'],
    [502, 'authentication_failed'],
  ])('keeps a queued edit through recoverable IMAP authentication %s (%s)', async (status, code) => {
    const { server, handlers } = fakeRelay();
    const allHandlers = { ...makeHandlers(engine, { touch: vi.fn() }), ...handlers };
    const runner = new OutboxRunner({
      accountId: ownerId, handlers: allHandlers,
      processRow: (row) => processMutationRow({ account: { id: ownerId }, transport: null, handlers: allHandlers, row }),
      options: { maxAttempts: 1, backoffBaseMs: 30_000 },
    });
    try {
      await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
      server.actionFailure = status;
      server.actionFailureCode = code;
      await handlers[DB_RPC.ATTENTION_ENQUEUE_IMAP_ACTION]({
        ownerId, location: workMessage, action: { type: 'star', value: true },
      });
      await runner.drain();
      expect(await engine.get('SELECT local_status FROM pending_mutations')).toMatchObject({ local_status: 'retry' });
      expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.find(({ relay_id }) => relay_id === 'work')
        ?.messages[0]?.flagged).toBe(true);
      expect(server.flags.flagged).toBe(false);

      server.actionFailure = 0;
      await handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId });
      await runner.drain();
      expect(server.flags.flagged).toBe(true);
      expect(await engine.get('SELECT 1 FROM pending_mutations')).toBeNull();
    } finally {
      await runner.stop();
    }
  });

  it('replaces previous aliases atomically and restores the bundle', async () => {
    const { handlers } = fakeRelay();
    const state = { disposition: 'done', aliases: ['old', 'new'], changedAt: 1, observed: ['mail'], resolved: ['mail'] };
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId, bundleId: 'old', state, replacedIds: [] });
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId, bundleId: 'new', state, replacedIds: ['old'] });
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).states).toEqual({ new: state });
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId, bundleId: 'new', state: null, replacedIds: [] });
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).states).toEqual({});
  });

  it('compares and restores all matching bundle records without changing newer or unrelated state', async () => {
    const { handlers } = fakeRelay();
    const restore = { disposition: 'snoozed' as const, aliases: ['thread', 'old'], changedAt: 1, observed: [], resolved: [], snoozedUntil: 900 };
    const done = { disposition: 'done' as const, aliases: ['thread', 'first'], changedAt: 2, observed: ['mail'], resolved: ['mail'] };
    const unrelated = { ...done, aliases: ['unrelated'] };
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId, bundleId: 'old', state: restore, replacedIds: [] });
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId, bundleId: 'first', state: done, replacedIds: [] });
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId, bundleId: 'unrelated', state: unrelated, replacedIds: [] });
    await handlers[DB_RPC.ATTENTION_SET_STATE]({ ownerId: 2, bundleId: 'old', state: restore, replacedIds: [] });
    const original = { old: restore, first: done };
    const aliases = ['thread', 'old', 'first', 'new'];
    const merged = { new: { ...done, aliases, changedAt: 3 } };
    const write = (replacements: typeof original | typeof merged, expected?: typeof merged) =>
      handlers[DB_RPC.ATTENTION_CHANGE_BUNDLE_STATES]({ ownerId, aliases, replacements, expected });
    await expect(write(merged)).resolves.toEqual({ applied: true, previous: original });
    await expect(write(original, { new: { ...merged.new, changedAt: 1 } })).resolves.toEqual({ applied: false, previous: merged });
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).states).toEqual({ unrelated, ...merged });
    await expect(write(original, merged)).resolves.toEqual({ applied: true, previous: merged });
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).states).toEqual({ unrelated, ...original });
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId: 2 })).states).toEqual({ old: restore });
  });

  it('applies an IMAP outbox change only to its paired account and updates its cached flags and Trash state', async () => {
    const { server, handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const cacheFor = async (relayId: string) =>
      (await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.find((account) => account.relay_id === relayId)?.messages;
    const apply = (accountId: number, location: typeof workMessage, action: object) => processMutationRow({
      transport: null, account: { id: accountId }, handlers,
      row: { account_id: accountId, mutation_type: MUTATION_TYPE.ATTENTION_IMAP,
        request_json: JSON.stringify({ location, action }) },
    });

    expect(await apply(2, workMessage, { type: 'star', value: true })).toMatchObject({ ok: false });
    expect(await apply(ownerId, { ...workMessage, uidValidity: '4' }, { type: 'star', value: true })).toMatchObject({ ok: false });
    expect(server.flags.flagged).toBe(false);
    expect(await apply(ownerId, workMessage, { type: 'star', value: true })).toEqual({ ok: true });
    expect(await cacheFor('work')).toMatchObject([{ uid: 12, seen: true, flagged: true }]);
    expect(await cacheFor('home')).toMatchObject([{ uid: 12, seen: true, flagged: false }]);
    expect(await apply(ownerId, workMessage, { type: 'seen', value: false })).toEqual({ ok: true });
    expect(await cacheFor('work')).toMatchObject([{ uid: 12, seen: false, flagged: true }]);
    expect(await apply(ownerId, workMessage, { type: 'trash' })).toEqual({ ok: true });
    expect(await cacheFor('work')).toEqual([]);
    expect(await cacheFor('home')).toHaveLength(1);
  });

  it('writes Gmail labels and archives through the outbox, then reconciles the corresponding cached row', async () => {
    const { server, handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const apply = (action: object) => processMutationRow({
      transport: null, account: { id: ownerId }, handlers,
      row: { account_id: ownerId, mutation_type: MUTATION_TYPE.ATTENTION_IMAP,
        request_json: JSON.stringify({ location: workMessage, action }) },
    });
    const cached = async (accountId: string) => (await handlers[DB_RPC.ATTENTION_GET]({ ownerId }))
      .accounts.find((account) => account.relay_id === accountId)?.messages;

    expect(await apply({ type: 'tags', tags: { removeLabels: ['Read later'] } })).toEqual({ ok: true });
    expect(server.labels).toEqual([]);
    expect(await cached('work')).toMatchObject([{ uid: 12, labels: [] }]);
    expect(await cached('home')).toMatchObject([{ uid: 12, labels: ['Read later'] }]);
    expect(await apply({ type: 'archive' })).toEqual({ ok: true });
    expect(server.archived).toBe(true);
    expect(server.trashed).toBe(false);
    expect(await cached('work')).toEqual([]);
    expect(await cached('home')).toHaveLength(1);
  });

  it('deduplicates a pending account-scoped send and submits it to the relay with the stable request ID', async () => {
    const { server, handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'test' });
    const draft = {
      requestId: crypto.randomUUID(), to: [{ email: 'recipient@example.net' }], cc: [], bcc: [],
      subject: 'Re: News', textBody: 'Thanks', htmlBody: '<p>Thanks</p>',
      inReplyTo: ['thread@example.net'], references: ['thread@example.net'],
    };
    const payload = { ownerId, accountId: 'work', draft };
    const ids = await Promise.all([handlers[DB_RPC.ATTENTION_ENSURE_IMAP_SEND](payload),
      handlers[DB_RPC.ATTENTION_ENSURE_IMAP_SEND](payload)]);
    expect(ids[0]).toBe(ids[1]);
    const apply = (accountId: string, owner = ownerId) => processMutationRow({
      transport: null, account: { id: owner }, handlers,
      row: { account_id: owner, mutation_type: MUTATION_TYPE.ATTENTION_IMAP_SEND,
        request_json: JSON.stringify({ accountId, draft }) },
    });
    expect(await apply('work', 2)).toMatchObject({ ok: false, error: { type: 'unauthorized' } });
    expect(await apply('home')).toMatchObject({ ok: false, error: { type: 'smtp_not_configured' } });
    expect(await apply('work')).toEqual({ ok: true, result: { rejected: 1 } });
    expect(server.sends).toEqual([{ url: '/api/imap/v1/accounts/work/send', draft }]);
  });
});

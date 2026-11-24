import { describe, expect, it, vi } from 'vitest';
import { AttentionRelay, type ImapMessageLocation } from '../../../src/sync/backends/imap/attention-relay';

type WireRequest = { path: string; method: string; body?: unknown };
const root = '/api/imap/v1';
const location = (uid: number, accountId = 'work'): ImapMessageLocation => ({ accountId, mailbox: 'INBOX', uidValidity: '7', uid });
const bodyPath = (uid: number) => `${root}/accounts/work/messages/${uid}?mailbox=INBOX&uidValidity=7`;

function items(init?: RequestInit) {
  return (JSON.parse(String(init?.body)) as { requests: WireRequest[] }).requests;
}

function reply(responses: Array<{ status: number; body: unknown }>) {
  return Response.json({ responses });
}

describe('IMAP relay batch client', () => {
  it('uses ordered batches of at most eight mailbox requests for one account', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(items(init).map(({ path }) => ({
      status: 200, body: { mailbox: new URL(path, 'https://mail.example').searchParams.get('mailbox'), uidValidity: '7', messages: [] },
    }))));
    const relay = new AttentionRelay(fetcher);
    const mailboxes = Array.from({ length: 10 }, (_, index) => `Mailbox ${index}`);
    const windows = await Promise.all(mailboxes.map((mailbox) => relay.folder('work', mailbox)));
    expect(windows.map(({ mailbox }) => mailbox)).toEqual(mailboxes);
    expect(fetcher.mock.calls.map(([url, init]) => [url, items(init).length])).toEqual([
      [`${root}/batch`, 8], [`${root}/batch`, 2],
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', signal: expect.any(AbortSignal) });
  });

  it('sends flags, tags, and moves without waiting on a held body batch', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const requests = items(init);
      if (requests[0].method === 'GET') {
        await held;
        return reply(requests.map(({ path }) => ({ status: 200, body: { text: path } })));
      }
      return reply([
        { status: 200, body: { uid: 1, seen: false, flagged: true } },
        { status: 200, body: { status: 'moved' } },
        { status: 409, body: { error: 'mailbox_changed' } },
      ]);
    });
    const relay = new AttentionRelay(fetcher);
    const bodies = Promise.all([relay.body(location(1)), relay.body(location(2))]);
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const outcomes = await Promise.allSettled([
        relay.mutate(location(1), { type: 'star', value: true }),
        relay.mutate(location(2), { type: 'trash' }),
        relay.mutate(location(3), { type: 'tags', tags: { add: ['todo'] } }),
      ]);
      expect(outcomes).toMatchObject([
        { status: 'fulfilled', value: { flagged: true } }, { status: 'fulfilled', value: null },
        { status: 'rejected', reason: { status: 409, code: 'mailbox_changed' } },
      ]);
      expect(fetcher.mock.calls.map(([, init]) => items(init).map(({ method }) => method))).toEqual([
        ['GET', 'GET'], ['PATCH', 'POST', 'PATCH'],
      ]);
      expect(items(fetcher.mock.calls[1][1])).toMatchObject([
        { path: '/accounts/work/messages/1?mailbox=INBOX&uidValidity=7', body: { flagged: true } },
        { path: '/accounts/work/messages/2/trash?mailbox=INBOX&uidValidity=7' },
        { path: '/accounts/work/messages/3?mailbox=INBOX&uidValidity=7', body: { tags: { add: ['todo'] } } },
      ]);
    } finally {
      release();
      await bodies;
    }
  });

  it('keeps a healthy account independent from held mailbox, body, and write batches', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const response = (path: string, method?: string) => {
      if (method === 'PATCH') return { uid: Number(path.match(/\/messages\/(\d+)/)?.[1]), seen: true, flagged: false };
      if (path.includes('/messages?')) return { mailbox: 'INBOX', uidValidity: '7', messages: [] };
      return { text: path };
    };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (url !== `${root}/batch`) return Response.json(response(String(url), init?.method));
      await held;
      return reply(items(init).map(({ path, method }) => ({ status: 200, body: response(path, method) })));
    });
    const relay = new AttentionRelay(fetcher);
    const work = Promise.all([
      relay.inbox('work'), relay.folder('work', 'Archive'), relay.body(location(1)), relay.body(location(2)),
      relay.mutate(location(1), { type: 'seen', value: true }), relay.mutate(location(2), { type: 'seen', value: true }),
    ]);
    let homeFinished = false;
    const home = Promise.all([
      relay.inbox('home'), relay.body(location(3, 'home')), relay.mutate(location(3, 'home'), { type: 'seen', value: true }),
    ]).then((result) => { homeFinished = true; return result; });
    try {
      await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === `${root}/batch`)).toHaveLength(3));
      await vi.waitFor(() => expect(homeFinished).toBe(true));
      expect(await home).toMatchObject([{ uidValidity: '7' }, { text: expect.stringContaining('/home/messages/3?') }, { seen: true }]);
      const batches = fetcher.mock.calls.filter(([url]) => url === `${root}/batch`);
      expect(batches.every(([, init]) => items(init).every(({ path }) => path.includes('/work/')))).toBe(true);
    } finally {
      release();
      await Promise.all([work, home]);
    }
  });

  it.each([[404, 'not_found'], [405, 'method_not_allowed']] as const)(
    'falls back only when the old relay reports its batch endpoint is unavailable (%i)', async (status, error) => {
      const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/batch')
        ? Response.json({ error }, { status }) : Response.json({ status: 'moved' }));
      const relay = new AttentionRelay(fetcher);
      const archive = () => Promise.all([1, 2].map((uid) => relay.mutate(location(uid), { type: 'archive' })));
      await expect(archive()).resolves.toEqual([null, null]);
      await archive();
      const routes = fetcher.mock.calls.map(([url]) => String(url));
      expect(routes.filter((url) => url.endsWith('/batch'))).toHaveLength(1);
      expect(routes.filter((url) => url.includes('/archive?'))).toHaveLength(4);
    },
  );

  it.each(['transport', 'malformed', 'unrelated 404'])('does not repeat potentially committed writes after %s', async (failure) => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failure === 'transport') throw new TypeError('response lost');
      if (failure === 'unrelated 404') return Response.json({ error: 'message_not_found' }, { status: 404 });
      return reply([{ status: 200, body: { status: 'moved' } }]);
    });
    const relay = new AttentionRelay(fetcher);
    const settled = await Promise.allSettled([1, 2].map((uid) => relay.mutate(location(uid), { type: 'trash' })));
    expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${root}/batch`);
  });

  it('retries only the body that did not fit the batch response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply([
      { status: 200, body: { text: 'first' } },
      { status: 413, body: { error: 'batch_body_limit' } },
      { status: 404, body: { error: 'message_not_found' } },
    ])).mockResolvedValueOnce(Response.json({ text: 'second' }));
    const relay = new AttentionRelay(fetcher);
    const settled = await Promise.allSettled([1, 2, 3].map((uid) => relay.body(location(uid))));
    expect(settled).toMatchObject([
      { status: 'fulfilled', value: { text: 'first' } }, { status: 'fulfilled', value: { text: 'second' } },
      { status: 'rejected', reason: { status: 404, code: 'message_not_found' } },
    ]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${root}/batch`, bodyPath(2)]);
  });

  it('does not queue foreground body reads or another account behind automatic prefetch', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (url !== `${root}/batch`) return Response.json({ text: 'foreground' });
      const entries = items(init);
      if (entries[0].path.includes('/work/')) await held;
      return reply(entries.map(({ path }) => ({ status: 200, body: { text: path } })));
    });
    const relay = new AttentionRelay(fetcher);
    const prefetch = Promise.all([1, 2].map((uid) => relay.body(location(uid), true)));
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const [foreground, home] = await Promise.all([
        relay.body(location(3)), Promise.all([4, 5].map((uid) => relay.body(location(uid, 'home'), true))),
      ]);
      expect(foreground.text).toBe('foreground');
      expect(home).toHaveLength(2);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${root}/batch`, bodyPath(3), `${root}/batch`]);
    } finally {
      release();
      await prefetch;
    }
  });
});

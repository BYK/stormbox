import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MUTATION_TYPE } from '../../../src/constants/states';
import { makeAttentionHandlers } from '../../../src/db/attention';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { DB_RPC } from '../../../src/db/protocol';
import { AttentionRelay } from '../../../src/sync/backends/imap/attention-relay';
import { processMutationRow } from '../../../src/sync/backends/jmap/outbox';

let engine: Awaited<ReturnType<typeof bootTestEngine>>;

beforeEach(async () => {
  engine = await bootTestEngine();
  await engine.run(`INSERT INTO accounts (id, server_origin, remote_account_id, created_at, updated_at)
    VALUES (1, 'https://jmap.example', 'one', 1, 1), (2, 'https://jmap.example', 'two', 1, 1)`);
});
afterEach(async () => engine.close());

function fakeRelay() {
  const server = { online: true, uidValidity: '3', accountTwoOnline: true, lastToken: '',
    flags: { seen: true, flagged: false }, trashed: false };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (!server.online) throw new TypeError('Offline');
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
    if (url.includes('/messages/')) {
      if (init.method === 'PATCH') {
        expect(init.credentials).toBe('same-origin');
        Object.assign(server.flags, JSON.parse(String(init.body)));
        return Response.json({ uid: 12, ...server.flags });
      }
      if (init.method === 'POST' && url.includes('/trash?')) {
        server.trashed = true;
        return Response.json({ status: 'moved' });
      }
      const text = `Body from ${url.split('/')[5]}`;
      return Response.json({ text, html: `<p>${text}</p>` });
    }
    if (url.includes('/home/') && !server.accountTwoOnline) return Response.json({}, { status: 502 });
    return Response.json({ mailbox: 'INBOX', uidValidity: server.uidValidity,
      messages: server.trashed && url.includes('/work/') ? [] : [{ uid: 12, subject: url, ...server.flags }] });
  });
  const handlers = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher as unknown as typeof fetch);
  return { server, handlers };
}

const ownerId = 1;
const workMessage = { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 12 };

describe('Attention cache', () => {
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
    await expect(handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage })).rejects.toThrow('Refresh Attention');
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAttentionHandlers } from '../../../src/db/attention';
import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { DB_RPC } from '../../../src/db/protocol';

let engine: Awaited<ReturnType<typeof bootTestEngine>>;

beforeEach(async () => {
  engine = await bootTestEngine();
  await engine.run(`INSERT INTO accounts (id, server_origin, remote_account_id, created_at, updated_at)
    VALUES (1, 'https://jmap.example', 'one', 1, 1), (2, 'https://jmap.example', 'two', 1, 1)`);
});
afterEach(async () => engine.close());

function fakeRelay() {
  const server = { online: true, uidValidity: '3', accountTwoOnline: true, lastToken: '' };
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
    if (url.includes('/messages/')) return Response.json({ text: `Body from ${url.split('/')[5]}` });
    if (url.includes('/home/') && !server.accountTwoOnline) return Response.json({}, { status: 502 });
    return Response.json({ mailbox: 'INBOX', uidValidity: server.uidValidity, messages: [{ uid: 12, subject: url }] });
  });
  const handlers = makeAttentionHandlers(engine, { touch: vi.fn() }, fetcher as unknown as typeof fetch);
  return { server, handlers };
}

const ownerId = 1;
const workMessage = { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 12 };

describe('Attention cache', () => {
  it('pairing lists isolated accounts and preserves downloaded bodies without a network', async () => {
    const { server, handlers } = fakeRelay();
    await handlers[DB_RPC.ATTENTION_PAIR]({ ownerId, accessToken: 'pair-this-browser' });
    expect(server.lastToken).toBe('pair-this-browser');
    const cached = await handlers[DB_RPC.ATTENTION_GET]({ ownerId });
    expect(cached.accounts.map((account) => account.relay_id)).toEqual(['home', 'work']);
    expect(await handlers[DB_RPC.ATTENTION_GET]({ ownerId: 2 })).toEqual({ paired: false, accounts: [], states: {} });
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage })).toBe('Body from work');
    const withBody = await handlers[DB_RPC.ATTENTION_GET]({ ownerId });
    expect(withBody.accounts.find((account) => account.relay_id === 'work').messages[0].preview).toBe('Body from work');
    server.online = false;
    expect(await handlers[DB_RPC.ATTENTION_BODY]({ ownerId, location: workMessage })).toBe('Body from work');
    await expect(handlers[DB_RPC.ATTENTION_REFRESH]({ ownerId })).rejects.toThrow('Offline');
    expect((await handlers[DB_RPC.ATTENTION_GET]({ ownerId })).accounts.map((account) => account.relay_id))
      .toEqual(cached.accounts.map((account) => account.relay_id));
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
});

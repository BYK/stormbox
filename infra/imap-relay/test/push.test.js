import assert from 'node:assert/strict';
import test from 'node:test';
import { watchMailboxes } from '../src/push.js';

test('the mailbox watcher records its cursor only after authenticated push delivery', { timeout: 2000 }, async (t) => {
  const account = { id: 'relay-one' };
  const before = { uidValidity: '123', uidNext: 10 };
  const after = { uidValidity: '123', uidNext: 11 };
  const events = [];
  const { promise, resolve } = Promise.withResolvers();
  const state = {
    readInboxPosition: () => before,
    writeInboxPosition: (id, position) => {
      assert.deepEqual([id, position, events.length], [account.id, after, 1]);
      resolve();
    },
  };
  const stop = watchMailboxes(new Map([[account.id, account]]), {
    origin: 'http://127.0.0.1:4000', token: 'internal-test-token', intervalMs: 60_000,
  }, state, async (accountToCheck, position) => {
    assert.deepEqual([accountToCheck, position], [account, before]);
    return { next: after, messages: ['123:10'] };
  }, async (url, init) => {
    assert.equal(url.href, 'http://127.0.0.1:4000/internal/new-mail');
    assert.equal(init.headers.authorization, 'Bearer internal-test-token');
    events.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  t.after(stop);
  await promise;
  assert.deepEqual(events, [{ account: account.id, event: '123:10' }]);
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
let gateway;

before(async () => {
  const files = await build({
    entryPoints: [fileURLToPath(new URL('../src/jmap.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  gateway = await import(`data:text/javascript;base64,${Buffer.from(files.outputFiles[0].text).toString('base64')}`);
});

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const account = { id: 'alpha', email: 'me@example.test', name: 'Alpha' };
const mailbox = { id: 'inbox', path: 'INBOX', name: 'Inbox', role: 'inbox', uidValidity: '19', total: 2, unread: 1 };
const messages = [
  { id: 'newer', uidValidity: '19', uid: 2, path: 'INBOX', threadId: 't1', mailboxId: 'inbox', size: 200,
    messageId: ['<newer@example.test>'], receivedAt: '2026-11-20T12:01:00Z', from: [], to: [], subject: 'Follow-up', keywords: {} },
  { id: 'older', uidValidity: '19', uid: 1, path: 'INBOX', threadId: 't1', mailboxId: 'inbox', size: 100,
    messageId: ['<older@example.test>'], receivedAt: '2026-11-20T12:00:00Z', from: [], to: [], subject: 'Question', keywords: { $seen: true } },
];

async function call(calls, store = {}) {
  const response = await gateway.jmap(new Request('https://mail.example.test/jmap', {
    method: 'POST', body: JSON.stringify({ using: [CORE, MAIL], methodCalls: calls }),
  }), [account], {
    snapshot: async () => ({ state: '2', mailboxes: [mailbox], messages, total: messages.length }),
    changes: async () => null,
    body: async () => ({ text: 'Test body', html: '' }),
    ...store,
  });
  return (await response.json()).methodResponses;
}

test('projects a mailbox query and its Email/get back reference with a single account snapshot', async () => {
  let loads = 0;
  const output = await call([
    ['Mailbox/get', { accountId: 'alpha', properties: ['name', 'role'] }, 'a'],
    ['Email/query', { accountId: 'alpha', filter: { inMailbox: 'inbox', notKeyword: '$seen' }, calculateTotal: true }, 'b'],
    ['Email/get', { accountId: 'alpha', '#ids': { resultOf: 'b', name: 'Email/query', path: '/ids' }, properties: ['subject', 'messageId'] }, 'c'],
  ], { snapshot: async () => { loads += 1; return { state: '2', mailboxes: [mailbox], messages }; } });
  assert.equal(loads, 1);
  assert.deepEqual(output[0][1].list, [{ id: 'inbox', name: 'Inbox', role: 'inbox' }]);
  assert.deepEqual(output[1][1].ids, ['newer']);
  assert.equal(output[1][1].total, 1);
  assert.deepEqual(output[2][1].list, [{ id: 'newer', subject: 'Follow-up', messageId: ['newer@example.test'] }]);
});

test('isolates accounts, surfaces uncertifiable query changes, supports body reads and rejects mutation calls', async () => {
  const output = await call([
    ['Email/get', { accountId: 'unlinked', ids: ['newer'] }, 'a'],
    ['Email/queryChanges', { accountId: 'alpha', sinceQueryState: '1' }, 'b'],
    ['Email/get', { accountId: 'alpha', ids: ['newer', 'gone'], properties: ['textBody', 'bodyValues'] }, 'c'],
    ['Email/set', { accountId: 'alpha', destroy: ['newer'] }, 'd'],
  ]);
  assert.equal(output[0][1].type, 'accountNotFound');
  assert.equal(output[1][1].type, 'cannotCalculateChanges');
  assert.equal(output[2][1].list[0].bodyValues.text.value, 'Test body');
  assert.deepEqual(output[2][1].notFound, ['gone']);
  assert.equal(output[3][1].type, 'unknownMethod');
});

test('emits the durable delta provided by the account store', async () => {
  const changes = { oldState: '1', newState: '2', hasMoreChanges: false, created: ['newer'], updated: [], destroyed: [] };
  const output = await call([['Email/changes', { accountId: 'alpha', sinceState: '1' }, 'a']], {
    changes: async (_account, type, since) => {
      assert.equal(type, 'email');
      assert.equal(since, '1');
      return changes;
    },
  });
  assert.deepEqual(output[0], ['Email/changes', { accountId: 'alpha', ...changes }, 'a']);
});

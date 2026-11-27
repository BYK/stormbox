import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler'))('esbuild');
const transport = Symbol.for('stormbox.test.imap');
let AccountState;
let MailTransportError;

before(async () => {
  const modules = {
    'cloudflare:workers': 'export class DurableObject { constructor(ctx, env) { Object.assign(this, {ctx, env}); } }',
    './mail-transport': `
      export class MailTransportError extends Error { constructor(code) { super(code); this.code = code; } }
      export const listMessages = (...args) => globalThis[Symbol.for('stormbox.test.imap')].listMessages(...args);
      export const listMailboxWindows = (...args) => globalThis[Symbol.for('stormbox.test.imap')].listMailboxWindows(...args);
      export const patchMailboxKeywords = (...args) => globalThis[Symbol.for('stormbox.test.imap')].patchMailboxKeywords(...args);
      export const readMessagePreviews = () => ({});
      export const verifyImapAccount = () => {};
    `,
    './push': `
      export const hasPushSubscribers = () => true;
      export const notifyArrival = () => true;
      export const observePushConversations = () => true;
      export const pushAttentionStates = () => null;
    `,
  };
  const files = await build({
    stdin: { contents: `export { AccountState } from './account'; export { MailTransportError } from './mail-transport';`,
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)) },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'test-connections', setup(plugin) {
      plugin.onResolve({ filter: /^(cloudflare:workers|\.\/mail-transport|\.\/push)$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      plugin.onLoad({ namespace: 'fixture', filter: /.*/ }, ({ path }) => ({ contents: modules[path] }));
    } }],
  });
  ({ AccountState, MailTransportError } = await import(`data:text/javascript;base64,${Buffer.from(files.outputFiles[0].text).toString('base64')}`));
});

const account = { id: 'work', email: 'me@example.test', imap: { host: 'imap.example.test', user: 'me', password: 'fixture-password' } };
const folder = { path: 'INBOX', name: 'Inbox', specialUse: null, delimiter: null };
const receivedAt = '2026-11-20T12:00:00.000Z';
const message = { uid: 10, subject: 'Hello', receivedAt, from: [], to: [], cc: [], replyTo: [], references: [],
  inReplyTo: null, messageId: null, keywords: [], labels: [], gmailLabels: false, seen: false, flagged: false, size: 10 };
const window = { mailbox: 'INBOX', uidValidity: '1', total: 1, complete: true, minUid: 10, messages: [message] };

function fixture(t, mailer) {
  const db = new DatabaseSync(':memory:');
  globalThis[transport] = mailer;
  t.after(() => { db.close(); delete globalThis[transport]; });
  let nextAlarm = null;
  let alarmWrites = 0;
  const store = new AccountState({
    id: { name: account.id },
    waitUntil() {},
    storage: {
      sql: { exec(query, ...params) {
        if (query.trimStart().startsWith('CREATE TABLE')) { db.exec(query); return; }
        const rows = db.prepare(query).all(...params);
        return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows.values() };
      } },
      transactionSync(task) {
        db.exec('BEGIN');
        try { const result = task(); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      async getAlarm() { return nextAlarm; },
      async setAlarm(at) { nextAlarm = at; alarmWrites += 1; },
    },
  }, { IMAP_ACCOUNTS: JSON.stringify([account]) });
  return { store, alarmWrites: () => alarmWrites };
}

test('concurrent folder reads share one connection until invalidation after a write', async (t) => {
  const reads = [];
  const { store } = fixture(t, { listMessages: () => {
    const operation = Promise.withResolvers();
    reads.push(operation);
    return operation.promise;
  } });
  const read = () => store.liveFolder(account, 'INBOX', 50);
  const first = read();
  const joined = read();
  assert.equal(reads.length, 1);
  store.invalidateFolders(account.id);
  const afterWrite = read();
  assert.equal(reads.length, 2);
  reads[0].resolve(window);
  assert.deepEqual(await first, { error: 'incomplete_window' });
  assert.deepEqual(await joined, { error: 'incomplete_window' });
  const joinedAfterWrite = read();
  assert.equal(reads.length, 2);
  reads[1].reject(new MailTransportError('mail_timeout'));
  assert.deepEqual(await afterWrite, { error: 'mail_timeout' });
  assert.deepEqual(await joinedAfterWrite, { error: 'mail_timeout' });
  const retry = read();
  assert.equal(reads.length, 3);
  reads[2].resolve(window);
  assert.deepEqual(await retry, window);
});

test('a slow JMAP refresh leaves cached reads and keyword writes available', { timeout: 3000 }, async (t) => {
  const scans = [];
  const { store } = fixture(t, {
    listMailboxWindows() {
      const scan = Promise.withResolvers();
      scans.push(scan);
      return scan.promise;
    },
    patchMailboxKeywords: async () => [{ uid: 10, keywords: { $flagged: true } }],
  });
  const cached = store.reconcile([{ ...folder, role: 'inbox', uidValidity: '1', total: 1, complete: true,
    messages: [{ ...message, keywords: {}, messageId: [] }] }]);
  const cachedRow = cached.messages[0];
  assert.deepEqual(await store.refresh(account.id), cached);
  const finished = store.refresh(account.id, { force: true });
  assert.equal(scans.length, 1);
  const update = await store.setKeywords(account, [{ id: cachedRow.id, keyword: '$flagged', add: true }], cached.state);
  assert.deepEqual(update.updated, [cachedRow.id]);
  scans[0].resolve({ folders: [folder], windows: [window], failedFolders: [], nextFolder: 0 });
  assert.deepEqual((await finished).messages[0].keywords, { $flagged: true });
  await store.refresh(account.id);
  assert.equal(scans.length, 2);
  const reconciled = store.refresh(account.id, { force: true });
  scans[1].resolve({ folders: [folder], windows: [{ ...window, messages: [{ ...message, flagged: true }] }],
    failedFolders: [], nextFolder: 0 });
  assert.deepEqual((await reconciled).messages[0].keywords, { $flagged: true });
  await store.refresh(account.id);
  assert.equal(scans.length, 2);
});

test('a push poll shares a live Inbox read and schedules the next alarm after transport failure', async (t) => {
  const read = Promise.withResolvers();
  let listCalls = 0;
  const { store, alarmWrites } = fixture(t, { listMessages() { listCalls += 1; return read.promise; } });
  await store.watch(60);
  const poll = store.alarm();
  await setImmediate();
  assert.equal(listCalls, 1);
  const live = store.liveFolder(account, 'INBOX', 50);
  assert.equal(listCalls, 1);
  read.reject(new MailTransportError('mail_timeout'));
  await poll;
  assert.deepEqual(await live, { error: 'mail_timeout' });
  assert.equal(alarmWrites(), 2);
});

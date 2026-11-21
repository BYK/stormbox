import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler'))('miniflare');
let script;
let runtime;

before(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stormbox-account-build-'));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  try {
    await promisify(execFile)(process.execPath, [wrangler, 'deploy', '--dry-run', '--outdir', directory], {
      cwd, env: { ...process.env, WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    });
    script = await readFile(join(directory, 'worker.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  runtime = start();
});
after(async () => runtime?.dispose());

function start(durableObjectsPersist) {
  return new Miniflare(convertV4MiniflareOptions({
    name: 'account-test',
    modules: [{ type: 'ESModule', path: 'account-test.mjs', contents: script }],
    compatibilityDate: '2026-11-20', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { MAILBOXES: { className: 'AccountState', useSQLite: true } },
    resourcePersistencePath: durableObjectsPersist,
  }));
}

async function account(name, worker = runtime) {
  const binding = await worker.getDurableObjectNamespace('MAILBOXES', 'account-test');
  return binding.get(binding.idFromName(name));
}

function envelope(uid, patch = {}) {
  return {
    uid, receivedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, uid)).toISOString(), subject: `Message ${uid}`,
    from: [{ email: 'sender@example.org' }], to: [], messageId: [`<id-${uid}@example.org>`],
    keywords: {}, size: 100, ...patch,
  };
}

function inbox(messages, patch = {}) {
  return {
    path: 'INBOX', name: 'Inbox', role: 'inbox', uidValidity: '9', total: messages.length, messages, complete: true,
    ...patch,
  };
}

test('persists stable mailbox and message IDs and scopes caches to account objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stormbox-account-'));
  let worker = start(directory);
  try {
    const one = await account('one', worker);
    const { state, mailboxes, messages } = await one.reconcile([inbox([envelope(1)])]);
    const { id, threadId } = messages[0];
    assert.equal(state, '1');
    assert.equal(messages[0].mailboxId, mailboxes[0].id);
    assert.equal((await (await account('two', worker)).snapshot()).total, 0);
    await worker.dispose();
    worker = start(directory);
    const restarted = await account('one', worker);
    const saved = await restarted.reconcile([inbox([envelope(1)])]);
    assert.equal(saved.state, state);
    assert.equal(saved.messages[0].id, id);
    assert.equal(saved.messages[0].threadId, threadId);
    assert.equal((await restarted.mailbox(mailboxes[0].id)).path, 'INBOX');
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('replaces stale identities when IMAP changes UIDVALIDITY', async () => {
  const store = await account('validity');
  const initial = await store.reconcile([inbox([envelope(14)])]);
  const current = await store.reconcile([inbox([envelope(14)], { uidValidity: '10' })]);
  assert.equal(current.mailboxes[0].id, initial.mailboxes[0].id);
  assert.notEqual(current.messages[0].id, initial.messages[0].id);
  assert.equal(await store.message(initial.messages[0].id), null);
  const page = await store.changes(initial.state, 'email');
  assert.equal(page.oldState, initial.state);
  assert.equal(page.newState, current.state);
  assert.equal(page.hasMoreChanges, false);
  assert.deepEqual(page.created, [current.messages[0].id]);
  assert.deepEqual(page.updated, []);
  assert.deepEqual(page.destroyed, [initial.messages[0].id]);
});

test('preserves unscanned records and reconciles confirmed holes with stable archive history', async () => {
  const store = await account('coverage');
  const initial = await store.reconcile([inbox([envelope(1), envelope(2), envelope(3)])]);
  const unread = envelope(4, { references: ['<id-1@example.org>'] });
  const current = await store.reconcile([inbox([envelope(2), unread], { minUid: 2, complete: false, total: 3 })]);
  assert.deepEqual(current.messages.map(({ uid }) => uid), [4, 2, 1]);
  assert.equal(current.messages[0].threadId, current.messages[2].threadId);
  const changed = await store.changes(initial.state, 'email');
  assert.deepEqual(changed.created, [current.messages[0].id]);
  assert.deepEqual(changed.destroyed, [initial.messages[0].id]);
  const page = await store.snapshot({ mailboxId: current.mailboxes[0].id, offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.messages[0].uid, 2);
  await store.reconcile([], { allMailboxPaths: [] });
  assert.equal((await store.snapshot()).total, 0);
});

test('does not let delayed results overwrite a newer snapshot and can page changes', async () => {
  const store = await account('generations');
  const slow = await store.beginSync();
  const faster = await store.beginSync();
  const initial = await store.reconcile([inbox([envelope(5)])], { generation: faster });
  const discarded = await store.reconcile([inbox([envelope(1)])], { generation: slow });
  assert.equal(discarded.state, initial.state);
  assert.deepEqual(discarded.messages.map(({ id }) => id), initial.messages.map(({ id }) => id));
  const changed = envelope(5, { keywords: { $seen: true } });
  const updated = await store.reconcile([inbox([changed])]);
  const current = await store.reconcile([inbox([changed, envelope(6)])]);
  const first = await store.changes(initial.state, 'email', 1);
  assert.deepEqual(first.updated, [updated.messages[0].id]);
  assert.equal(first.newState, updated.state);
  assert.equal(first.hasMoreChanges, true);
  const next = await store.changes(first.newState, 'email', 1);
  assert.deepEqual(next.created, [current.messages[0].id]);
  assert.equal(next.hasMoreChanges, false);
  assert.equal(await store.changes('made-up', 'email'), null);
});


test('bounds the recent projection without changing an IMAP id when it becomes visible again', async () => {
  const store = await account('bound');
  const messages = Array.from({ length: 50 }, (_, index) => envelope(index + 1));
  const initial = await store.reconcile([inbox(messages)]);
  const originalId = initial.messages.find(({ uid }) => uid === 1).id;
  const next = await store.reconcile([inbox([...messages.slice(1), envelope(51)], {
    total: 51, complete: false, minUid: 2,
  })]);
  assert.equal(next.total, 50);
  assert.equal(await store.message(originalId), null);
  assert.equal((await store.snapshot({ mailboxId: next.mailboxes[0].id })).total, 50);
  const restored = await store.reconcile([inbox(messages)]);
  assert.equal(restored.messages.find(({ uid }) => uid === 1).id, originalId);
});

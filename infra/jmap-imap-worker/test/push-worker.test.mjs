import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';

const require = createRequire(import.meta.url);
const ece = createRequire(require.resolve('web-push'))('http_ece');
const wranglerPackage = require.resolve('wrangler/package.json');
const { Miniflare, convertV4MiniflareOptions } = createRequire(wranglerPackage)('miniflare');
const base = 'https://mail.example.test';
const endpoint = 'https://fcm.googleapis.com/fcm/send/mock-subscription';

async function until(condition) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await condition()) return;
    await setTimeout(25);
  }
  assert.fail('Expected the Web Push Durable Object alarm to finish.');
}

test('Workers isolate pairs browsers and sends encrypted, deduplicated notifications from SQLite alarms', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stormbox-worker-push-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'wrangler.json');
  const fixture = join(directory, 'fixture.ts');
  const source = fileURLToPath(new URL('../src/push.ts', import.meta.url));
  const classifier = fileURLToPath(new URL('../src/attention-notifications.ts', import.meta.url));
  await writeFile(fixture, `import { PushSubscriptions as Registry, handlePush, notifyArrival, pushAttentionStates } from ${JSON.stringify(source)};
import { newAttentionNotifications } from ${JSON.stringify(classifier)};
export class PushSubscriptions extends Registry {
  async flush() {
    this.ctx.storage.sql.exec('UPDATE push_pending SET due_at = ?', Date.now());
    await this.alarm();
  }
}
export default { async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/test/flush') {
      await env.PUSH_SUBSCRIPTIONS.getByName('stormbox').flush();
      return new Response(null, { status: 204 });
    }
    if (pathname === '/test/arrival' || pathname === '/test/plan') {
      const { event, messages, firstUid } = await request.json();
      const id = 'account-1';
      const states = await pushAttentionStates(env, id) ?? {};
      const { notifications, missingPreviews } = newAttentionNotifications({ id, email: 'me@example.test' }, messages, firstUid, states);
      if (pathname === '/test/plan') return Response.json({ notifications, missing: missingPreviews.map(({ uid }) => uid) });
      const results = await Promise.all(notifications.map(({ bundleUid, notification }) => notifyArrival(env, id, event + ':' + bundleUid, notification)));
      return Response.json(notifications.map(({ uid }) => uid), { status: results.every(Boolean) ? 200 : 503 });
    }
    return handlePush(request, env, request.headers.get('X-Test-Paired') === 'yes');
  } };`);
  await writeFile(config, JSON.stringify({
    name: 'stormbox-push-smoke',
    main: fixture,
    compatibility_date: '2026-11-20',
  }));
  execFileSync(process.execPath, [join(wranglerPackage, '../bin/wrangler.js'), 'deploy', '--dry-run',
    '--config', config, '--outdir', directory], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') } });

  const vapid = webPush.generateVAPIDKeys();
  const accountKey = createECDH('prime256v1');
  const subscription = { endpoint, keys: {
    p256dh: accountKey.generateKeys().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  } };
  const sent = [];
  let upstreamStatus = 201;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: 'fixture.mjs', contents: await readFile(join(directory, 'fixture.js'), 'utf8') }],
    compatibilityDate: '2026-11-20',
    durableObjects: { PUSH_SUBSCRIPTIONS: { className: 'PushSubscriptions', useSQLite: true } },
    bindings: {
      WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
      WEB_PUSH_VAPID_SUBJECT: 'mailto:admin@example.test',
    },
    outboundService: async (request) => {
      sent.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.arrayBuffer() });
      const headers = upstreamStatus === 307 ? { Location: 'https://redirect.example.test/' } : {};
      return new Response(null, { status: upstreamStatus, headers });
    },
  }));
  t.after(() => mf.dispose());
  const request = (path, { method = 'GET', body, paired = true } = {}) => mf.dispatchFetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(paired ? { 'X-Test-Paired': 'yes' } : {}) },
    body: body && JSON.stringify(body),
  });
  const status = () => request('/api/push/subscriptions/status', { method: 'POST', body: { endpoint } });
  const message = (uid, subject, patch = {}) => ({
    id: `stored-${uid}`, path: 'INBOX', uidValidity: '7', uid,
    receivedAt: new Date(2026, 10, 21, 10, uid).toISOString(),
    subject, from: [{ email: 'sam@example.test', name: 'Sam' }], to: [{ email: 'me@example.test' }],
    preview: 'Please confirm the new date.\n\nOn Friday Sam wrote:\n> Old text',
    messageId: [`message-${uid}@example.test`], keywords: {}, ...patch,
  });
  const arrive = async (event, messages, firstUid = 1) => {
    const response = await request('/test/arrival', { method: 'POST', body: { event, messages, firstUid } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const plan = async (messages, firstUid) => (await request('/test/plan', { method: 'POST', body: { messages, firstUid } })).json();
  const messageKey = (uid) => JSON.stringify(['imap:account-1', '3-local', JSON.stringify(['INBOX', '7', uid])]);
  const aliasKey = (message) => JSON.stringify(['imap:account-1', '2-message', message.messageId[0]]);

  const configuration = await request('/api/push/config', { paired: false });
  assert.deepEqual(await configuration.json(), { publicKey: vapid.publicKey });
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', body: subscription, paired: false })).status, 401);
  assert.equal((await request('/api/push/subscriptions', {
    method: 'POST', body: { ...subscription, endpoint: 'https://push.example.test/other' },
  })).status, 400);
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', body: subscription })).status, 204);
  assert.deepEqual(await (await status()).json(), { enabled: true });
  const unrelated = message(1, 'Older unrelated', { preview: undefined });
  const related = message(2, 'Older related', { preview: undefined });
  const incompleteReply = message(5, 'Re: Older related', { references: related.messageId });
  const routine = message(3, 'Weekly digest', { preview: 'Newsletter' });
  const newReply = message(4, 'Re: Weekly digest', { path: 'Inbox', references: routine.messageId });
  const partial = await plan([unrelated, related, routine, newReply, incompleteReply], 3);
  assert.deepEqual(partial.missing, [2]);
  assert.deepEqual(partial.notifications, [{ uid: 4, bundleUid: 3, notification: {
    messageKey: messageKey(4), confirmed: true, sender: 'Sam', subject: newReply.subject, preview: 'Please confirm the new date.',
  } }]);
  const revised = await plan([unrelated, { ...routine, keywords: { $flagged: true } }, newReply], 3);
  assert.equal(revised.notifications[0].bundleUid, 3);
  assert.equal(revised.notifications[0].uid, 4);
  assert.equal(revised.notifications[0].notification.messageKey, messageKey(4));
  assert.equal(revised.notifications[0].notification.preview, 'Please confirm the new date.');
  assert.equal(revised.notifications[0].notification.confirmed, true);
  assert.deepEqual(await arrive('v7:10:10', [message(10, 'Weekly digest', { preview: 'Here are the highlights.' })]), []);
  assert.equal(sent.length, 0);
  const actionable = message(11, 'Schedule');
  const routineReply = message(12, 'Weekly digest', { preview: 'Here are the highlights.', references: actionable.messageId });
  const actionReply = message(13, 'Re: Schedule', { references: actionable.messageId });
  assert.deepEqual(await arrive('v7:11:12', [actionable, routineReply]), [11]);
  await until(() => sent.length >= 1);
  assert.equal(sent[0].url, endpoint);
  assert.equal(sent[0].headers['content-encoding'], 'aes128gcm');
  assert.match(sent[0].headers.authorization, /^vapid t=.+, k=.+$/i);
  assert.match(sent[0].headers.topic, /^stormbox-[a-f0-9]{20}$/);
  assert.ok(sent[0].body.byteLength > 100);
  assert.equal(Buffer.from(sent[0].body).includes('Schedule'), false);
  assert.deepEqual(JSON.parse(ece.decrypt(Buffer.from(sent[0].body), {
    version: 'aes128gcm', privateKey: accountKey, authSecret: subscription.keys.auth,
  }).toString()), {
    tag: sent[0].headers.topic, sender: 'Sam', subject: 'Schedule', preview: 'Please confirm the new date.',
  });

  assert.deepEqual(await arrive('v7:11:12', [actionable, routineReply]), [11]);
  assert.deepEqual(await arrive('v7:12:12', [actionable, routineReply], 12), []);
  assert.deepEqual(await arrive('v7:13:13', [actionable, actionReply], 13), []);

  const alias = aliasKey(actionable);
  const observed = [messageKey(11)];
  const changedAt = Date.now();
  const snoozed = { disposition: 'snoozed', changedAt, aliases: [alias], observed, resolved: [], snoozedUntil: changedAt + 60_000 };
  const updateState = (state, timestamp = changedAt, paired = true) => request('/api/push/attention', {
    method: 'PUT', paired, body: { id: alias, state, changedAt: timestamp, replacedIds: [] },
  });
  assert.equal((await updateState(snoozed, changedAt, false)).status, 401);
  assert.equal((await updateState(snoozed)).status, 204);
  assert.deepEqual(await arrive('v7:12:12', [actionable, routineReply], 12), []);

  upstreamStatus = 307;
  assert.deepEqual(await arrive('v7:13:13', [actionable, actionReply], 13), [13]);
  await until(() => sent.length >= 2);
  assert.notEqual(sent[0].headers.topic, sent[1].headers.topic);

  assert.equal((await updateState(null, changedAt + 1)).status, 204);
  assert.equal((await updateState(snoozed)).status, 204);
  assert.deepEqual(await arrive('v7:13:13', [actionable, actionReply], 13), []);

  const statusWithLocalModel = await request('/api/push/subscriptions/status', {
    method: 'POST', body: { endpoint, confirmedOnly: true },
  });
  assert.deepEqual(await statusWithLocalModel.json(), { enabled: true });
  assert.deepEqual(await arrive('v7:14:14', [message(14, 'Another thread', { preview: 'Some thoughts.' })], 14), [14]);
  upstreamStatus = 410;
  assert.deepEqual(await arrive('v7:15:15', [message(15, 'Approve a new date')], 15), [15]);
  await until(async () => !(await (await status()).json()).enabled);
  assert.deepEqual(sent.map((entry) => entry.url), [endpoint, endpoint, endpoint]);
  assert.equal(JSON.parse(ece.decrypt(Buffer.from(sent[2].body), {
    version: 'aes128gcm', privateKey: accountKey, authSecret: subscription.keys.auth,
  }).toString()).subject, 'Approve a new date');
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', body: subscription })).status, 204);

  for (const [index, disposition] of ['done', 'snoozed'].entries()) {
    const uid = 20 + index;
    const arriving = message(uid, `${disposition} before retry`);
    upstreamStatus = 503;
    const attempts = sent.length;
    assert.deepEqual(await arrive(`v7:${uid}:${uid}`, [arriving], uid), [uid]);
    await until(() => sent.length === attempts + 1);
    const id = aliasKey(arriving);
    const changedAt = Date.now();
    const state = { disposition, changedAt, aliases: [id], observed: [messageKey(uid)],
      resolved: disposition === 'done' ? [messageKey(uid)] : [],
      ...(disposition === 'snoozed' ? { snoozedUntil: changedAt + 60_000 } : {}),
    };
    assert.equal((await request('/api/push/attention', { method: 'PUT', body: { id, state, changedAt, replacedIds: [] } })).status, 204);
    upstreamStatus = 201;
    assert.equal((await request('/test/flush')).status, 204);
    assert.equal(sent.length, attempts + 1);
  }
  assert.equal((await request('/api/push/subscriptions', { method: 'DELETE', body: { endpoint } })).status, 204);
  assert.deepEqual(await (await status()).json(), { enabled: false });
});

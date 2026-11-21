import assert from 'node:assert/strict';
import { createECDH, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPushRelay } from '../relay.mjs';

const browserToken = 'test-browser-token';
const ingestToken = 'test-worker-token';
const publicOrigin = 'https://stormbox.example';
const accountEvent = { account: 'personal', event: '213:50001' };

function makeCookie(expires = Date.now() + 60000) {
  const hmac = createHmac('sha256', browserToken).update(`stormbox_relay:${expires}`).digest('base64url');
  return `stormbox_relay=${expires}.${hmac}`;
}

function subscription(endpoint) {
  const key = createECDH('prime256v1');
  return {
    endpoint,
    keys: { p256dh: key.generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

async function testServer(t, statePath, send) {
  const server = await createPushRelay({ statePath, browserToken, ingestToken, publicOrigin, publicKey: 'test-key' }, send);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const paired = { origin: publicOrigin, cookie: makeCookie() };
  const relay = { authorization: `Bearer ${ingestToken}` };

  function json(path, data, headers, method = 'POST') {
    return fetch(url + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(data),
    });
  }

  return {
    config: () => fetch(`${url}/api/push/config`),
    subscribe: (record, headers = paired) => json('/api/push/subscriptions', record, headers),
    status: (endpoint) => json('/api/push/subscriptions/status', { endpoint }, paired),
    unsubscribe: (endpoint) => json('/api/push/subscriptions', { endpoint }, paired, 'DELETE'),
    ingest: (event, headers = relay) => json('/internal/new-mail', event, headers),
  };
}

async function testStatePath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stormbox-push-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'push.json');
}

test('checks pairing and origin, allows a public key, and rejects arbitrary endpoints', async (t) => {
  const relay = await testServer(t, await testStatePath(t), async () => assert.fail('unexpected push'));
  const record = subscription('https://fcm.googleapis.com/fcm/send/fake');
  assert.deepEqual(await (await relay.config()).json(), { publicKey: 'test-key' });
  assert.equal((await relay.subscribe(record, { origin: publicOrigin })).status, 401);
  assert.equal((await relay.subscribe(record, { origin: 'https://evil.example', cookie: makeCookie() })).status, 403);
  assert.equal((await relay.subscribe(record, { origin: publicOrigin, cookie: makeCookie(Date.now() - 500) })).status, 401);
  assert.equal((await relay.subscribe({ ...record, endpoint: 'https://127.0.0.1/private' })).status, 400);
  assert.equal((await relay.subscribe({ ...record, endpoint: 'https://fcm.googleapis.com.evil.example/token' })).status, 400);
  assert.equal((await relay.subscribe({ ...record, endpoint: 'https://fcm.googleapis.com:8443/token' })).status, 400);
  assert.equal((await relay.ingest(accountEvent, { authorization: `Bearer ${browserToken}` })).status, 401);
  assert.deepEqual(await (await relay.status(record.endpoint)).json(), { enabled: false });
  assert.equal((await relay.subscribe(record)).status, 204);
  assert.deepEqual(await (await relay.status(record.endpoint)).json(), { enabled: true });
  assert.equal((await relay.unsubscribe(record.endpoint)).status, 204);
  assert.deepEqual(await (await relay.status(record.endpoint)).json(), { enabled: false });
  assert.equal((await relay.ingest(accountEvent)).status, 204);
});

test('retries only undelivered subscriptions, deduplicates across restart, and drops expired endpoints', async (t) => {
  const statePath = await testStatePath(t);
  const delivered = [];
  const first = subscription('https://fcm.googleapis.com/fcm/send/first');
  const second = subscription('https://updates.push.services.mozilla.com/wpush/v2/second');
  let failure = 503;
  const send = async (record, payload) => {
    delivered.push([record.endpoint, payload]);
    if (record.endpoint === second.endpoint && failure) throw Object.assign(new Error('provider failed'), { statusCode: failure });
  };
  const relay = await testServer(t, statePath, send);
  assert.equal((await relay.subscribe(first)).status, 204);
  assert.equal((await relay.subscribe(second)).status, 204);
  assert.equal((await relay.ingest(accountEvent)).status, 503);
  assert.deepEqual(delivered.map(([endpoint]) => endpoint), [first.endpoint, second.endpoint]);
  assert.deepEqual(Object.keys(delivered[0][1]), ['tag']);
  assert.match(delivered[0][1].tag, /^stormbox-[a-f0-9]{20}$/);
  assert.doesNotMatch(JSON.stringify(delivered[0][1]), /personal|50001/);

  failure = 410;
  const restarted = await testServer(t, statePath, send);
  assert.equal((await restarted.ingest(accountEvent)).status, 204);
  assert.equal((await restarted.ingest(accountEvent)).status, 204);
  assert.deepEqual(delivered.slice(2).map(([endpoint]) => endpoint), [second.endpoint]);
  assert.equal((await restarted.ingest({ ...accountEvent, event: '213:50002' })).status, 204);
  assert.deepEqual(delivered.slice(3).map(([endpoint]) => endpoint), [first.endpoint]);
  assert.equal((await restarted.ingest({ ...accountEvent, account: 'work' })).status, 204);
  assert.notEqual(delivered[3][1].tag, delivered[4][1].tag);
});

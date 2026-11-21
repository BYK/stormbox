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
  await writeFile(fixture, `import { PushSubscriptions, handlePush, notifyArrival } from ${JSON.stringify(source)};
export { PushSubscriptions };
export default { async fetch(request, env) {
    if (new URL(request.url).pathname === '/test/arrival') {
      const event = await request.text();
      return new Response(null, { status: (await notifyArrival(env, 'account-1', event)) ? 204 : 503 });
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
  const arrive = (event) => mf.dispatchFetch(`${base}/test/arrival`, { method: 'POST', body: event });

  const configuration = await request('/api/push/config', { paired: false });
  assert.deepEqual(await configuration.json(), { publicKey: vapid.publicKey });
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', body: subscription, paired: false })).status, 401);
  assert.equal((await request('/api/push/subscriptions', {
    method: 'POST', body: { ...subscription, endpoint: 'https://push.example.test/other' },
  })).status, 400);
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', body: subscription })).status, 204);
  assert.deepEqual(await (await status()).json(), { enabled: true });
  assert.equal((await arrive('1:10:11')).status, 204);
  await until(() => sent.length >= 1);
  assert.equal(sent[0].url, endpoint);
  assert.equal(sent[0].headers['content-encoding'], 'aes128gcm');
  assert.match(sent[0].headers.authorization, /^vapid t=.+, k=.+$/i);
  assert.match(sent[0].headers.topic, /^stormbox-[a-f0-9]{20}$/);
  assert.ok(sent[0].body.byteLength > 100);

  assert.equal((await arrive('1:10:11')).status, 204);
  upstreamStatus = 307;
  assert.equal((await arrive('1:12:12')).status, 204);
  await until(() => sent.length >= 2);
  upstreamStatus = 410;
  assert.equal((await arrive('1:13:13')).status, 204);
  await until(async () => !(await (await status()).json()).enabled);
  assert.deepEqual(sent.map((entry) => entry.url), [endpoint, endpoint, endpoint]);
  assert.equal((await request('/api/push/subscriptions', { method: 'POST', body: subscription })).status, 204);
  assert.equal((await request('/api/push/subscriptions', { method: 'DELETE', body: { endpoint } })).status, 204);
  assert.deepEqual(await (await status()).json(), { enabled: false });
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve('wrangler/package.json');
const { Miniflare, convertV4MiniflareOptions } = createRequire(wranglerPackage)('miniflare');
const origin = 'https://webmail.example.test';
const accessToken = '0123456789abcdefghijklmnopqrstuvwxyz';
const accountKey = Buffer.alloc(32, 1);
const sessionKey = Buffer.alloc(32, 2);
let worker;
let directory;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stormbox-worker-routing-'));
  const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
  execFileSync(process.execPath, [join(wranglerPackage, '../bin/wrangler.js'), 'deploy', '--dry-run',
    '--config', configPath, '--outdir', directory], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
  });
  const code = await readFile(join(directory, 'worker.js'), 'utf8');
  const config = convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: code }],
    compatibilityDate: '2026-11-20', compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      MAILBOXES: { className: 'AccountState', useSQLite: true },
      PUSH_SUBSCRIPTIONS: { className: 'PushSubscriptions', useSQLite: true },
      MANAGED_ACCOUNTS: { className: 'ManagedAccounts', useSQLite: true },
    },
    bindings: {
      PUBLIC_ORIGIN: origin, RELAY_ACCESS_TOKEN: accessToken,
      IMAP_ACCOUNT_ENCRYPTION_KEY: accountKey.toString('base64'),
      RELAY_SESSION_KEY: sessionKey.toString('base64'),
      IMAP_ACCOUNTS: JSON.stringify([{ id: 'alpha', email: 'alpha@example.test', imap: {
        host: 'imap.example.test', user: 'alpha', password: 'fixture-password',
      } }]),
    },
  });
  worker = new Miniflare(config);
});
after(async () => {
  await worker?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function request(path, init) { return worker.dispatchFetch(`${origin}${path}`, init); }
const api = '/api/imap/v1';

async function pairBrowser(payload = { assertion: signAssertion(Date.now() + 45_000) }, requestedOrigin = origin) {
  return request(`${api}/session`, {
    method: 'POST', headers: { Origin: requestedOrigin }, body: JSON.stringify(payload),
  });
}

function signAssertion(expiry) {
  const unsigned = `v1.${expiry}.${randomUUID()}`;
  return `${unsigned}.${createHmac('sha256', sessionKey).update(`stormbox-imap-relay:${unsigned}`).digest('hex')}`;
}

test('authorizes a browser without a relay token using an exact-origin single-use bridge assertion', async () => {
  const proof = signAssertion(Date.now() + 45_000);
  const invalidProof = `${proof.slice(0, -1)}${proof.endsWith('0') ? '1' : '0'}`;
  assert.equal((await pairBrowser({ assertion: invalidProof })).status, 401);
  assert.equal((await pairBrowser({ assertion: signAssertion(Date.now() - 1000) })).status, 401);
  assert.equal((await pairBrowser({ assertion: signAssertion(Date.now() + 120_000) })).status, 401);
  assert.equal((await pairBrowser({ assertion: proof }, 'https://other.example.test')).status, 403);
  assert.equal((await pairBrowser({ accessToken })).status, 401);
  const paired = await pairBrowser({ assertion: proof });
  assert.equal(paired.status, 204);
  const Cookie = paired.headers.get('set-cookie').split(';')[0];
  assert.equal((await request(`${api}/accounts`, { headers: { Cookie } })).status, 200);
  assert.equal((await pairBrowser({ assertion: proof })).status, 401);
});

test('paired same-origin API lists accounts without exposing credentials', async () => {
  assert.equal((await request('/api/imap/v1/health')).status, 200);
  assert.equal((await request('/api/imap/v1/accounts')).status, 401);
  const response = await pairBrowser();
  assert.equal(response.status, 204);
  const setCookie = response.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=1800; Secure$/);
  const oldExpiry = Date.now() + 60_000;
  const oldSignature = createHmac('sha256', accessToken).update(`stormbox_relay:${oldExpiry}`).digest('base64url');
  assert.equal((await request('/api/imap/v1/accounts', { headers: {
    Cookie: `stormbox_relay=${oldExpiry}.${oldSignature}`,
  } })).status, 401);
  const Cookie = setCookie.split(';')[0];
  const list = await request('/api/imap/v1/accounts', { headers: { Cookie } });
  assert.deepEqual(await list.json(), { accounts: [{ id: 'alpha', email: 'alpha@example.test', name: 'alpha@example.test' }] });
  assert.equal((await request('/api/imap/v1/accounts/beta/messages', { headers: { Cookie } })).status, 404);
  const messagePath = '/api/imap/v1/accounts/alpha/messages/44';
  const patch = { method: 'PATCH', body: JSON.stringify({ flagged: true }) };
  assert.equal((await request(`${messagePath}?uidValidity=7`, {
    ...patch, headers: { Cookie, Origin: 'https://other.example.test' },
  })).status, 401);
  assert.equal((await request(`${messagePath}?uidValidity=7`, {
    ...patch, headers: { Authorization: `Bearer ${accessToken}`, Origin: origin },
  })).status, 401);
  assert.equal((await request(`${messagePath}/trash?uidValidity=7`, {
    method: 'POST', headers: { Cookie },
  })).status, 401);
  const headers = { Cookie, Origin: origin };
  assert.equal((await request(`${messagePath}?uidValidity=7`, { ...patch, headers, body: '{"deleted":true}' })).status, 400);
  assert.equal((await request(`${messagePath}?uidValidity=7`, { method: 'DELETE', headers })).status, 405);
  assert.equal((await request(`${messagePath}/trash?uidValidity=0`, { method: 'POST', headers })).status, 400);
});

test('generic JMAP requires its bearer token and supports Core/echo', async () => {
  assert.equal((await request('/.well-known/jmap')).status, 401);
  const headers = { Authorization: `Bearer ${accessToken}`, Origin: origin };
  const response = await request('/.well-known/jmap', { headers });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  const session = await response.json();
  assert.deepEqual(Object.keys(session.accounts), ['alpha']);
  assert.equal(session.accounts.alpha.isReadOnly, true);
  const res = await request('/jmap', {
    headers, method: 'POST', body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core'], methodCalls: [['Core/echo', { health: true }, 'a']],
    }),
  });
  assert.deepEqual((await res.json()).methodResponses, [['Core/echo', { health: true }, 'a']]);
});

test('requires paired account setup and validates public host and TLS options before network access', async () => {
  const path = `${api}/accounts`;
  const payload = { email: 'me@gmail.com', password: 'fict itio uspa sswd' };
  const init = { method: 'POST', body: JSON.stringify(payload) };
  const pair = await pairBrowser();
  const Cookie = pair.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie, Origin: origin };
  assert.equal((await request(path, { ...init, headers: { Origin: origin, Authorization: `Bearer ${accessToken}` } })).status, 401);
  assert.equal((await request(path, { ...init, headers: { Cookie, Origin: 'https://other.example.test' } })).status, 401);
  for (const host of ['localhost', 'mail.internal', '127.0.0.1', 'https://mail.example.com', 'mail.example.com:993']) {
    const res = await request(path, { ...init, headers, body: JSON.stringify({ ...payload, host }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_imap_host' });
  }
  for (const endpoint of [{ port: 443 }, { host: 'imap.gmail.com', mode: 'starttls' }]) {
    const res = await request(path, { ...init, headers, body: JSON.stringify({ ...payload, ...endpoint }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_imap_port' });
  }
  const duplicate = await request(path, { ...init, headers, body: JSON.stringify({ ...payload, email: 'ALPHA@EXAMPLE.TEST' }) });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'account_exists' });
  assert.equal((await request(`${path}/alpha`, { method: 'DELETE', headers })).status, 409);
});

test('keeps managed account records encrypted and exposes metadata only to paired browsers', async () => {
  const namespace = await worker.getDurableObjectNamespace('MANAGED_ACCOUNTS');
  const registry = namespace.getByName('stormbox');
  const key = await crypto.subtle.importKey('raw', accountKey, 'AES-GCM', false, ['encrypt']);
  const id = 'managed_example';
  const revision = randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const connection = { host: 'imap.gmail.com', user: 'me@gmail.com', mode: 'tls', port: 993, password: 'fictional-password' };
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(id) },
    key, Buffer.from(JSON.stringify(connection)));
  const credential = `${Buffer.from(iv).toString('base64')}.${Buffer.from(ciphertext).toString('base64')}`;
  const record = { id, email: 'me@gmail.com', email_key: 'me@gmail.com', name: 'Work', revision, credential };
  assert.equal(await registry.save(record, null, 0), 'limit');
  assert.equal(await registry.save(record, null, 9), 'saved');
  assert.equal(await registry.save({ ...record, name: 'Stale' }, null, 9), 'stale');
  assert.equal(await registry.save({ ...record, name: 'Gmail', revision: randomUUID() }, revision, 9), 'saved');
  assert.equal(JSON.stringify(await registry.byId(id)).includes(connection.password), false);

  const pair = await pairBrowser();
  const Cookie = pair.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie, Origin: origin };
  const pairedList = await (await request(`${api}/accounts`, { headers })).json();
  const { password, ...metadata } = connection;
  assert.deepEqual(pairedList.accounts.find((account) => account.id === id), {
    ...metadata, id, email: 'me@gmail.com', name: 'Gmail', managed: true,
  });
  const bearer = { Authorization: `Bearer ${accessToken}` };
  const bearerList = await (await request(`${api}/accounts`, { headers: bearer })).json();
  assert.deepEqual(bearerList.accounts.map(({ id }) => id), ['alpha']);
  const session = await (await request('/.well-known/jmap', { headers: bearer })).json();
  assert.deepEqual(Object.keys(session.accounts), ['alpha']);
  assert.equal((await request(`${api}/accounts/${id}/messages?mailbox=INBOX`, { headers: bearer })).status, 404);
  assert.equal((await request(`${api}/accounts/${id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal(await registry.byId(id), null);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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
let code;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stormbox-worker-routing-'));
  const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
  execFileSync(process.execPath, [join(wranglerPackage, '../bin/wrangler.js'), 'deploy', '--dry-run',
    '--config', configPath, '--outdir', directory], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
  });
  code = await readFile(join(directory, 'worker.js'), 'utf8');
  worker = makeWorker();
});

function makeWorker(extraBindings = {}, outboundService) {
  return new Miniflare(convertV4MiniflareOptions({
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
      ...extraBindings,
    },
    ...(outboundService ? { outboundService } : {}),
  }));
}

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
  assert.equal((await request(`${api}/oauth/google/start`, { method: 'POST', headers: { Cookie, Origin: origin }, body: '{}' })).status, 404);
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

test('relay batches enforce direct route authorization and return ordered per-item errors', async () => {
  const batch = (requests, headers) => request(`${api}/batch`, {
    method: 'POST', headers, body: JSON.stringify({ requests }),
  });
  const read = { method: 'GET', path: '/accounts/missing/messages?mailbox=INBOX' };
  const patch = { method: 'PATCH', path: '/accounts/alpha/messages/44?uidValidity=7', body: { deleted: true } };
  assert.equal((await batch([read])).status, 401);
  const bearer = await batch([patch, read], { Authorization: `Bearer ${accessToken}` });
  assert.equal(bearer.status, 200);
  assert.deepEqual((await bearer.json()).responses, [
    { status: 401, body: { error: 'unauthorized' } },
    { status: 404, body: { error: 'account_not_found' } },
  ]);

  const paired = await pairBrowser();
  const Cookie = paired.headers.get('set-cookie').split(';')[0];
  assert.equal((await batch([read], { Cookie, Origin: 'https://other.example.test' })).status, 401);
  const headers = { Cookie, Origin: origin };
  const response = await batch([
    patch, read,
    { method: 'POST', path: '/accounts/alpha/send' },
    { method: 'GET', path: '/accounts/alpha/%2e%2e/messages' },
    { method: 'GET', path: '//other.example.test/accounts/alpha/mailboxes' },
    { method: 'GET', path: '/accounts/alpha/messages/44?uidValidity=7&uidValidity=8' },
    { method: 'GET', path: '/accounts/alpha/messages/44?uidValidity=0' },
    { method: 'GET', path: '/accounts/missing/mailboxes' },
  ], headers);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).responses, [
    { status: 400, body: { error: 'invalid_flags' } },
    { status: 404, body: { error: 'account_not_found' } },
    ...Array.from({ length: 4 }, () => ({ status: 400, body: { error: 'invalid_batch_path' } })),
    { status: 400, body: { error: 'invalid_number' } },
    { status: 404, body: { error: 'account_not_found' } },
  ]);
  assert.equal((await batch([], headers)).status, 400);
  assert.equal((await batch(Array(9).fill(read), headers)).status, 413);
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

test('accepts submission requests only from the paired application origin', async () => {
  const send = `${api}/accounts/alpha/send`;
  const Cookie = (await pairBrowser()).headers.get('set-cookie').split(';')[0];
  const init = { method: 'POST', body: '{}' };
  assert.equal((await request(send, { ...init, headers: { Origin: origin, Authorization: `Bearer ${accessToken}` } })).status, 401);
  assert.equal((await request(send, { ...init, headers: { Origin: 'https://other.example.test', Cookie } })).status, 401);
  const unavailable = await request(send, { ...init, headers: { Origin: origin, Cookie } });
  assert.equal(unavailable.status, 422);
  assert.deepEqual(await unavailable.json(), { error: 'smtp_not_configured' });
});

test('requires pairing and rejects malformed tag patches before contacting a mail server', async () => {
  const message = `${api}/accounts/alpha/messages/44`;
  const paired = await pairBrowser();
  const headers = { Cookie: paired.headers.get('set-cookie').split(';')[0], Origin: origin };
  for (const operation of ['archive', 'junk']) {
    assert.equal((await request(`${message}/${operation}?uidValidity=7`, { method: 'POST', headers: { Origin: origin } })).status, 401);
    assert.equal((await request(`${message}/${operation}?uidValidity=0`, { method: 'POST', headers })).status, 400);
  }
  for (const payload of [
    { tags: {} }, { tags: { add: ['foo bar'] } }, { tags: { add: ['\\Deleted'] } },
    { tags: { add: ['$Junk'] } }, { tags: { add: ['valid'], remove: ['VALID'] } },
    { tags: { removeLabels: ['\\Inbox'] } }, { tags: { addLabels: ['Inbox'] } },
    { tags: { addLabels: ['[Gmail]/Trash'] } }, { tags: { addLabels: ['injected\r\ncommand'] } },
    { tags: { add: ['valid'] }, seen: false },
  ]) {
    const response = await request(`${message}?uidValidity=7`, { method: 'PATCH', headers, body: JSON.stringify(payload) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_tags' });
  }
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
  assert.equal((await registry.byId(id)).credential.includes(connection.password), false);

  const pair = await pairBrowser();
  const Cookie = pair.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie, Origin: origin };
  const pairedList = await (await request(`${api}/accounts`, { headers })).json();
  const { password, ...metadata } = connection;
  assert.deepEqual(pairedList.accounts.find((account) => account.id === id), {
    ...metadata, id, email: 'me@gmail.com', name: 'Gmail', managed: true,
  });
  const resolution = await registry.resolve(id);
  assert.deepEqual(await resolution.account, { id, email: 'me@gmail.com', name: 'Gmail', imap: connection });
  const bearer = { Authorization: `Bearer ${accessToken}` };
  const bearerList = await (await request(`${api}/accounts`, { headers: bearer })).json();
  assert.deepEqual(bearerList.accounts.map(({ id }) => id), ['alpha']);
  const session = await (await request('/.well-known/jmap', { headers: bearer })).json();
  assert.deepEqual(Object.keys(session.accounts), ['alpha']);
  assert.equal((await request(`${api}/jmap/session`, { headers: bearer })).status, 401);
  assert.equal((await request(`${api}/jmap/session`, { headers: { Cookie, Origin: 'https://other.example.test' } })).status, 401);
  const pairedSession = await (await request(`${api}/jmap/session`, { headers })).json();
  assert.deepEqual(Object.keys(pairedSession.accounts), ['alpha', id]);
  assert.equal(pairedSession.accounts[id].isReadOnly, false);
  assert.equal(pairedSession.apiUrl, `${origin}${api}/jmap`);
  assert.match(pairedSession.downloadUrl, new RegExp(`${api}/jmap/download/`));
  assert.doesNotMatch(JSON.stringify(pairedSession), /fictional-password|imap\.gmail\.com/);
  const call = {
    method: 'POST', body: JSON.stringify({ using: ['urn:ietf:params:jmap:mail'],
      methodCalls: [['Email/set', { accountId: 'removed', update: { m1: { 'keywords/$seen': true } } }, 'a']] }),
  };
  assert.equal((await request(`${api}/jmap`, { ...call, headers: { Cookie } })).status, 401);
  assert.deepEqual((await (await request(`${api}/jmap`, { ...call, headers })).json()).methodResponses,
    [['error', { type: 'accountNotFound' }, 'a']]);
  assert.equal((await request(`${api}/accounts/${id}/messages?mailbox=INBOX`, { headers: bearer })).status, 404);
  assert.equal((await request(`${api}/accounts/${id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal(await registry.byId(id), null);
});

test('binds Google OAuth to the paired browser, handles Workspace denial and cancels state on sign-out', async (t) => {
  const clientId = 'example-client.apps.googleusercontent.com';
  const clientSecret = 'example-client-secret';
  const issuer = makeWorker({ GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret });
  t.after(() => issuer.dispose());
  const fetch = (path, init) => issuer.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...init });
  const base = `${api}/oauth/google`;
  const pair = await fetch(`${api}/session`, {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ assertion: signAssertion(Date.now() + 45_000) }),
  });
  const relayCookie = pair.headers.get('Set-Cookie').split(';')[0];
  const authenticated = { Origin: origin, Cookie: relayCookie };
  const init = { method: 'POST', body: '{}' };
  assert.equal((await fetch(`${base}/start`, { ...init, headers: { Origin: origin, Authorization: `Bearer ${accessToken}` } })).status, 401);
  assert.equal((await fetch(`${base}/start`, { ...init, headers: { ...authenticated, Origin: 'https://other.example.test' } })).status, 401);
  const configured = await (await fetch(`${api}/accounts`, { headers: authenticated })).json();
  assert.equal(configured.googleOAuth, true);

  async function start() {
    const response = await fetch(`${base}/start`, { ...init, headers: authenticated });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-stormbox_google_imap=[a-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/i);
    const authorizationUrl = new URL((await response.json()).url);
    assert.equal(authorizationUrl.origin + authorizationUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(authorizationUrl.searchParams.get('client_id'), clientId);
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), `${origin}${base}/callback`);
    assert.equal(authorizationUrl.searchParams.get('scope'), 'openid email https://mail.google.com/');
    assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorizationUrl.searchParams.get('code_challenge'), /^[a-z0-9_-]{43}$/i);
    assert.ok(!authorizationUrl.href.includes(clientSecret));
    return { cookie: cookie.split(';')[0], state: authorizationUrl.searchParams.get('state') };
  }

  const first = await start();
  const callback = (flow, query, cookie = flow.cookie) => fetch(`${base}/callback?state=${flow.state}&${query}`, { headers: { Cookie: cookie } });
  const other = await start();
  const forged = await callback(first, 'error=admin_policy_enforced', other.cookie);
  assert.equal(forged.headers.get('Location'), '/?view=attention&google_imap=failed');
  assert.equal(forged.headers.get('Set-Cookie'), null);
  const denied = await callback(first, 'error=admin_policy_enforced');
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get('Location'), '/?view=attention&google_imap=blocked');
  assert.equal(denied.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(denied.headers.get('Set-Cookie'), /Max-Age=0$/);
  assert.equal((await callback(first, 'error=access_denied')).headers.get('Location'), '/?view=attention&google_imap=failed');
  assert.equal((await callback(other, 'error=access_denied')).headers.get('Location'), '/?view=attention&google_imap=cancelled');

  const loggedOut = await start();
  const logout = await fetch(`${api}/session`, { method: 'DELETE', headers: {
    Origin: origin, Cookie: `${relayCookie}; ${loggedOut.cookie}`,
  } });
  assert.equal(logout.status, 204);
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.equal((await callback(loggedOut, 'error=access_denied')).headers.get('Location'), '/?view=attention&google_imap=failed');
});

test('refreshes encrypted Google credentials once, pins reconnect identity, and reports a revoked grant', async (t) => {
  const clientId = 'example-client.apps.googleusercontent.com';
  const clientSecret = 'example-client-secret';
  let expectedChallenge;
  let refreshes = 0;
  let revoked = false;
  const providerCalls = [];
  const provider = makeWorker({ GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret }, async (request) => {
    providerCalls.push(request.url);
    if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      assert.equal(request.headers.get('Authorization'), 'Bearer callback-access');
      return Response.json({ email: 'different@example.com', email_verified: true, sub: 'other-identity' });
    }
    assert.equal(request.url, 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get('client_id'), clientId);
    assert.equal(form.get('client_secret'), clientSecret);
    if (form.get('grant_type') === 'authorization_code') {
      assert.equal(form.get('redirect_uri'), `${origin}${api}/oauth/google/callback`);
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), expectedChallenge);
      return Response.json({ access_token: 'callback-access', refresh_token: 'callback-refresh', token_type: 'Bearer',
        expires_in: 3600, scope: 'openid email https://mail.google.com/' });
    }
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), revoked ? 'rotated-refresh' : 'original-refresh');
    refreshes += 1;
    return revoked ? Response.json({ error: 'invalid_grant' }, { status: 400 })
      : Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
  });
  t.after(() => provider.dispose());
  const fetch = (path, init) => provider.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...init });
  const registry = (await provider.getDurableObjectNamespace('MANAGED_ACCOUNTS')).getByName('stormbox');
  const id = 'managed_work';
  const email = 'work@example.com';
  const stored = { auth: 'google-oauth', host: 'imap.gmail.com', user: email, mode: 'tls', port: 993,
    subject: 'work-identity', clientId, refreshToken: 'original-refresh' };
  const key = await crypto.subtle.importKey('raw', accountKey, 'AES-GCM', false, ['encrypt']);
  async function makeRecord(endpoint) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(id) },
      key, Buffer.from(JSON.stringify(endpoint)));
    const credential = `${Buffer.from(iv).toString('base64')}.${Buffer.from(cipher).toString('base64')}`;
    return { id, email, email_key: email, name: 'Work', revision: randomUUID(), credential };
  }
  const original = await makeRecord(stored);
  assert.equal(await registry.save(original, null, 10), 'saved');
  const pair = await fetch(`${api}/session`, {
    method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ assertion: signAssertion(Date.now() + 45_000) }),
  });
  const Cookie = pair.headers.get('Set-Cookie').split(';')[0];
  const catalog = await (await fetch(`${api}/accounts`, { headers: { Cookie } })).json();
  assert.deepEqual(catalog.accounts.find((row) => row.id === id), {
    id, email, name: 'Work', host: 'imap.gmail.com', user: email, mode: 'tls', port: 993, managed: true, auth: 'google-oauth',
  });
  assert.equal(refreshes, 0);

  const link = await fetch(`${api}/oauth/google/start`, {
    method: 'POST', headers: { Cookie, Origin: origin }, body: JSON.stringify({ accountId: id }),
  });
  const googleCookie = link.headers.get('Set-Cookie').split(';')[0];
  const params = new URL((await link.json()).url).searchParams;
  assert.equal(params.get('login_hint'), email);
  expectedChallenge = params.get('code_challenge');
  const mismatch = await fetch(`${api}/oauth/google/callback?state=${params.get('state')}&code=mock-code`, {
    headers: { Cookie: googleCookie },
  });
  assert.equal(mismatch.headers.get('Location'), '/?view=attention&google_imap=account_mismatch', JSON.stringify(providerCalls));
  const unchanged = await registry.byId(id);
  assert.equal(unchanged.credential, original.credential);
  assert.equal(unchanged.revision, original.revision);

  const [first, second] = await Promise.all([registry.resolve(id), registry.resolve(id)]);
  for (const result of [first, second]) {
    const { imap } = await result.account;
    assert.equal(imap.accessToken, 'rotated-access');
    assert.equal(imap.refreshToken, undefined);
  }
  assert.equal(refreshes, 1);
  assert.notEqual((await registry.byId(id)).credential, original.credential);
  assert.equal((await registry.byId(id)).credential.includes('rotated-refresh'), false);

  // A new account revision cannot reuse the prior in-memory access token.
  revoked = true;
  assert.equal(await registry.save(await makeRecord({ ...stored, refreshToken: 'rotated-refresh' }), original.revision, 10), 'saved');
  const failed = await fetch(`${api}/accounts/${id}/messages`, { headers: { Cookie } });
  assert.equal(failed.status, 422);
  assert.deepEqual(await failed.json(), { error: 'google_reconnect_required' });
  assert.equal(refreshes, 2);
});

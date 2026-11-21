import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    },
    bindings: {
      PUBLIC_ORIGIN: origin, RELAY_ACCESS_TOKEN: accessToken,
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

test('paired same-origin API lists accounts without exposing credentials', async () => {
  assert.equal((await request('/api/imap/v1/health')).status, 200);
  assert.equal((await request('/api/imap/v1/accounts')).status, 401);
  const pair = () => ({ method: 'POST', body: JSON.stringify({ accessToken }) });
  assert.equal((await request('/api/imap/v1/session', { ...pair(), headers: { Origin: 'https://other.example.test' } })).status, 403);
  const response = await request('/api/imap/v1/session', { ...pair(), headers: { Origin: origin } });
  assert.equal(response.status, 204);
  const setCookie = response.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
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

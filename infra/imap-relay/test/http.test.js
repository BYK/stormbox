import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { RelayError } from '../src/errors.js';
import { createRelayServer } from '../src/http.js';

const publicOrigin = 'http://localhost:3000';
const accessToken = 'local-only-test-token-at-least-32-characters';
const account = { id: 'personal', email: 'me@example.test', name: 'Me', imap: { password: 'never expose this' } };

async function fixture(t, service = {}) {
  const config = { accessToken, publicOrigin, accounts: new Map([[account.id, account]]) };
  const server = createRelayServer(config, service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/imap/v1`;
  return (path, init) => fetch(`${base}${path}`, init);
}

function write(path, data) {
  return { method: path, headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: JSON.stringify(data) };
}

test('relay session cookie authorizes reads and protects private account configuration', async (t) => {
  const request = await fixture(t);
  assert.equal((await request('/accounts')).status, 401);
  assert.equal((await request('/session', write('POST', { accessToken: 'wrong' }))).status, 401);

  const pairing = await request('/session', write('POST', { accessToken }));
  assert.equal(pairing.status, 204);
  const cookie = pairing.headers.get('set-cookie');
  assert.match(cookie, /Path=\/api; HttpOnly; SameSite=Strict/);

  const authenticated = await request('/accounts', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(authenticated.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await authenticated.json(), { accounts: [{ id: account.id, email: account.email, name: account.name }] });

  assert.equal((await request('/session', { method: 'DELETE', headers: { origin: 'https://elsewhere.test' } })).status, 403);
  const disconnect = await request('/session', { method: 'DELETE', headers: { origin: publicOrigin } });
  assert.match(disconnect.headers.get('set-cookie'), /Max-Age=0/);
});

test('message reads require UIDVALIDITY and relay maps a stale identity to 409', async (t) => {
  const request = await fixture(t, {
    async listMessages(relayAccount, mailbox, limit) {
      assert.equal(relayAccount, account);
      assert.equal(mailbox, 'INBOX');
      assert.equal(limit, 25);
      return { mailbox, uidValidity: '100', messages: [{ uid: 9 }] };
    },
    async readMessage(relayAccount, mailbox, uidValidity, uid) {
      assert.equal(relayAccount, account);
      if (uidValidity !== '100') throw new RelayError(409, 'mailbox_changed');
      return { mailbox, uidValidity, uid, text: 'Existing message' };
    },
  });
  const init = { headers: { authorization: `Bearer ${accessToken}` } };
  const listed = await request('/accounts/personal/messages?limit=25', init);
  assert.deepEqual(await listed.json(), { mailbox: 'INBOX', uidValidity: '100', messages: [{ uid: 9 }] });
  assert.equal((await request('/accounts/personal/messages/9', init)).status, 400);
  const changed = await request('/accounts/personal/messages/9?uidValidity=99', init);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: 'mailbox_changed' });
  const read = await request('/accounts/personal/messages/9?uidValidity=100', init);
  assert.deepEqual(await read.json(), { mailbox: 'INBOX', uidValidity: '100', uid: 9, text: 'Existing message' });
});

test('cookie authentication restricts mailbox writes to the public origin', async (t) => {
  const request = await fixture(t, {
    async patchMessage(relayAccount, mailbox, uidValidity, uid, flags) {
      assert.deepEqual([relayAccount.id, mailbox, uidValidity, uid, flags], ['personal', 'INBOX', '100', 42, { seen: true }]);
      return { uid, seen: true, flagged: false };
    },
  });
  const pairing = await request('/session', write('POST', { accessToken }));
  const cookie = pairing.headers.get('set-cookie').split(';')[0];
  const init = write('PATCH', { seen: true });
  const path = '/accounts/personal/messages/42?uidValidity=100';
  const denied = await request(path, { ...init, headers: { ...init.headers, cookie, origin: 'https://elsewhere.test' } });
  assert.equal(denied.status, 401);
  const allowed = await request(path, { ...init, headers: { ...init.headers, cookie } });
  assert.deepEqual(await allowed.json(), { uid: 42, seen: true, flagged: false });
});

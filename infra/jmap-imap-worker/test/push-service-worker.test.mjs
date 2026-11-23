import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../../../public/push-sw.js', import.meta.url), 'utf8');

test('renders attention sender, subject and excerpt and ignores generic push data', async () => {
  const listeners = new Map();
  const notifications = [];
  const messages = [];
  let permission;
  runInNewContext(source, {
    URL,
    caches: { match: async (url, options) => {
      assert.equal(url, 'https://mail.example.test/.push-session');
      assert.equal(options.cacheName, 'stormbox-push');
      return permission ? new Response(permission) : undefined;
    } },
    self: {
      registration: {
        scope: 'https://mail.example.test/',
        showNotification: async (title, options) => notifications.push({ title, ...options }),
      },
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    clients: { matchAll: async () => [{ postMessage: (message) => messages.push(message.type) }] },
  });
  const push = (payload) => new Promise((resolve) => listeners.get('push')({
    data: { json: () => JSON.parse(payload) }, waitUntil: resolve,
  }));
  const tag = 'stormbox-1234567890abcdef1234';
  await push(JSON.stringify({ tag }));
  await push('{');
  await push(JSON.stringify({ tag, sender: 'Ada', subject: 'Legacy subscription', preview: 'Unverified device' }));
  assert.equal(notifications.length, 0);

  permission = 'allowed';
  await push(JSON.stringify({ tag, sender: 'Ada', subject: 'Review request', preview: 'Can you review this?' }));
  assert.deepEqual(notifications.map(({ title, body, tag }) => ({ title, body, tag })), [
    { title: 'Ada', body: 'Review request\nCan you review this?', tag },
  ]);

  permission = 'signed out';
  await push(JSON.stringify({ tag, sender: 'Ada', subject: 'Private preview', preview: 'Confidential mail' }));
  assert.equal(notifications.length, 1);
  assert.deepEqual(messages, Array(5).fill('stormbox:refresh'));
});

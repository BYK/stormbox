import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const worker = await readFile(new URL('../../../public/push-sw.js', import.meta.url), 'utf8');
const scope = 'https://stormbox.example/mail/';

function setupWorker(windows = []) {
  const events = new Map();
  const messages = [];
  const opened = [];
  runInNewContext(worker, {
    URL,
    self: {
      addEventListener: (name, handler) => events.set(name, handler),
      registration: {
        scope,
        showNotification: async (title, options) => { messages.push({ title, ...options }); },
      },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); },
    },
  });

  return {
    messages,
    opened,
    async push(payload) {
      let task;
      events.get('push')({ data: { json: () => payload }, waitUntil: (promise) => { task = promise; } });
      await task;
    },
    async click(data) {
      let task;
      let closed = false;
      events.get('notificationclick')({
        notification: { data, close: () => { closed = true; } },
        waitUntil: (promise) => { task = promise; },
      });
      await task;
      return closed;
    },
  };
}

test('a push can display with no app windows, hides remote content, and opens the scoped attention view', async () => {
  const worker = setupWorker();
  await worker.push({ title: 'Remote subject', body: 'Remote content', tag: 'stormbox-01234567890123456789' });
  const [notification] = worker.messages;
  assert.equal(notification.title, 'Stormbox');
  assert.equal(notification.body, 'New mail is available.');
  assert.equal(notification.tag, 'stormbox-01234567890123456789');
  assert.equal(await worker.click(notification.data), true);
  assert.deepEqual(worker.opened, [`${scope}?view=attention`]);
});

test('push refreshes an open inbox and a click focuses it without navigation', async () => {
  const messages = [];
  let focused = false;
  const worker = setupWorker([{
    url: scope,
    postMessage: (message) => { messages.push(message.type); },
    focus: async () => { focused = true; },
  }]);
  await worker.push({ tag: 'unexpected' });
  assert.equal(worker.messages[0].tag, 'stormbox-mail');
  assert.equal(await worker.click({ type: 'other' }), false);
  assert.equal(await worker.click(worker.messages[0].data), true);
  assert.deepEqual(messages, ['stormbox:refresh', 'stormbox:open-attention']);
  assert.equal(focused, true);
  assert.deepEqual(worker.opened, []);
});

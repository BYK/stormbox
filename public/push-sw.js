/* global clients */
self.addEventListener('push', (event) => {
  let tag = 'stormbox-mail';
  try {
    const payload = event.data?.json();
    if (typeof payload?.tag === 'string' && /^stormbox-[a-f0-9]{20}$/.test(payload.tag)) {
      tag = payload.tag;
    }
  } catch {
    // Keep the alert visible if the payload was missing or unrecognized.
  }

  event.waitUntil(Promise.all([
    self.registration.showNotification('Stormbox', {
      body: 'New mail is available.',
      tag,
      data: { type: 'stormbox:new-mail' },
    }),
    clients.matchAll({ type: 'window' }).then((windows) => {
      for (const window of windows) window.postMessage({ type: 'stormbox:refresh' });
    }),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  if (event.notification.data?.type !== 'stormbox:new-mail') return;
  event.notification.close();
  event.waitUntil((async () => {
    const inbox = new URL('./?view=attention', self.registration.scope);
    const windows = await clients.matchAll({ type: 'window' });
    const currentWindow = windows.find((client) => {
      const url = new URL(client.url);
      return url.origin === inbox.origin && url.pathname === inbox.pathname;
    });
    if (currentWindow) {
      try {
        await currentWindow.focus();
        currentWindow.postMessage({ type: 'stormbox:open-attention' });
        return;
      } catch {
        // The app can close between listing and focusing its window.
      }
    }
    await clients.openWindow(inbox.href);
  })());
});

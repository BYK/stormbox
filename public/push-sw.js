/* global clients */
async function previewsAllowed() {
  try {
    const permission = await caches.match(new URL('.push-session', self.registration.scope).href, {
      cacheName: 'stormbox-push',
    });
    return await permission?.text() === 'allowed';
  } catch {
    return false;
  }
}

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    // Old or malformed payloads cannot describe a Needs attention item.
  }
  const work = [
    clients.matchAll({ type: 'window' }).then((windows) => {
      for (const window of windows) window.postMessage({ type: 'stormbox:refresh' });
    }),
  ];
  if (typeof payload?.tag === 'string' && /^stormbox-[a-f0-9]{20}$/.test(payload.tag)
    && typeof payload.sender === 'string' && payload.sender.length > 0 && payload.sender.length <= 200
    && typeof payload.subject === 'string' && payload.subject.length > 0 && payload.subject.length <= 300
    && typeof payload.preview === 'string' && payload.preview.length <= 400) {
    const { sender, subject, preview, tag } = payload;
    work.push((async () => {
      if (!await previewsAllowed()) return;
      await self.registration.showNotification(sender, {
        body: preview ? `${subject}\n${preview}` : subject,
        tag,
        data: { type: 'stormbox:new-mail' },
      });
      if (!await previewsAllowed()) {
        for (const notification of await self.registration.getNotifications({ tag })) notification.close();
      }
    })());
  }
  event.waitUntil(Promise.all(work));
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

/* global importScripts */
importScripts('./stormbox-precache.js', './push-sw.js');

const scope = new URL(self.registration.scope);
const shell = new URL('index.html', scope);
const cachePrefix = `stormbox-shell:${scope.pathname}:`;
const { version, files, optionalFiles } = self.stormboxPrecache;
const cacheName = `${cachePrefix}${version}`;
const assets = new Set(files.map((path) => new URL(path, scope).href));
const optionalAssets = new Set(optionalFiles.map((path) => new URL(path, scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(
    [...assets].map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })),
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const existing = await caches.keys();
    await Promise.all(existing.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;

  if (request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === shell.pathname)) {
    // OIDC redirects always go to the network. The shell cache contains no credentials.
    if (['code', 'state', 'error'].some((key) => url.searchParams.has(key))) return;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(shell.href);
      // Launch with the shell and assets from the same precache version.
      // Reloads and the service worker update check can pick up a new release.
      if (cached && request.cache !== 'reload' && request.cache !== 'no-cache') return cached;
      return fetch(request).catch(() => cached ?? Response.error());
    })());
    return;
  }

  const optional = optionalAssets.has(url.href);
  if (!optional && !assets.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(url.href);
    if (cached) return cached;
    const response = await fetch(request);
    if (optional && response.status === 200) {
      event.waitUntil(cache.put(url.href, response.clone()).catch(() => {}));
    }
    return response;
  })());
});

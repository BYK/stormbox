/** Register the production service worker from a normal, secure web origin. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !globalThis.isSecureContext || !navigator.serviceWorker) return;
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}stormbox-sw.js`, {
    updateViaCache: 'none',
  }).catch((error) => console.warn('[offline] Could not register the service worker', error));
}

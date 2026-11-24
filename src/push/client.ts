import { JMAP_SERVER_URL } from '../defines';
import { browserSessionEnabled } from '../services/browser-session';
import { offlineSessionRevision } from '../pwa/cached-account';
import { AttentionRelay } from '../sync/backends/imap/attention-relay';
import type { BundleState } from '../triage/smart-sort';

const notificationsPath = '/api/push';
const mailRelay = new AttentionRelay((input, init) => fetch(input, init));
const stateQueuePrefix = 'stormbox:push-attention:';
const pendingAttentionStates = new Map<string, string>();
let attentionSync: Promise<void> | undefined;
let stateSyncRequested = false;

async function relayRequest(path: string, init?: RequestInit, repairSession = true) {
  const send = () => fetch(`${notificationsPath}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...init,
  });
  const response = await send();
  if (response.status !== 401 || !repairSession || !browserSessionEnabled(JMAP_SERVER_URL)) return response;
  await mailRelay.pair();
  return send();
}

function asPublicKey(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const key = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (key.length !== 65 || key[0] !== 4) {
    throw new Error('The notification relay provided an invalid public key.');
  }
  return key;
}

async function requireSuccess(response: Response) {
  if (response.status === 401) {
    throw new Error('Pair this browser with the mail relay to manage notifications.');
  }
  if (!response.ok) throw new Error('The notification relay is unavailable.');
}

export async function getWebPushPublicKey(): Promise<Uint8Array<ArrayBuffer>> {
  const response = await relayRequest('/config');
  await requireSuccess(response);
  const configuration: { publicKey?: string } = await response.json();
  if (!configuration.publicKey) throw new Error('The notification relay is unconfigured.');
  void syncWebPushAttentionStates();
  return asPublicKey(configuration.publicKey);
}

function pendingWebPushAttentionStates(): Map<string, string> {
  const combined = new Map(pendingAttentionStates);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(stateQueuePrefix)) continue;
      const value = localStorage.getItem(key);
      if (value) combined.set(key, value);
    }
  } catch {
    // Private or restricted storage keeps this operation in memory.
  }
  return combined;
}

async function sendAttentionStates() {
  do {
    stateSyncRequested = false;
    for (const [key, body] of pendingWebPushAttentionStates()) {
      const response = await relayRequest('/attention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && response.status !== 400 && response.status !== 413) return;
      if (pendingAttentionStates.get(key) === body) pendingAttentionStates.delete(key);
      try {
        if (localStorage.getItem(key) === body) localStorage.removeItem(key);
      } catch {
        // The in-memory entry was already removed.
      }
    }
  } while (stateSyncRequested);
}

function syncWebPushAttentionStates(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return Promise.resolve();
  stateSyncRequested = true;
  attentionSync ??= sendAttentionStates().catch(() => {}).finally(() => { attentionSync = undefined; });
  return attentionSync;
}

export function publishWebPushAttentionState(id: string, state: BundleState | null, replacedIds: string[], changedAt = state?.changedAt ?? Date.now()): Promise<void> {
  const key = `${stateQueuePrefix}${crypto.randomUUID()}`;
  const body = JSON.stringify({ id, state, replacedIds, changedAt });
  try {
    localStorage.setItem(key, body);
  } catch {
    pendingAttentionStates.set(key, body);
  }
  return syncWebPushAttentionStates();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { void syncWebPushAttentionStates(); });
}

function usesDifferentKey(subscription: PushSubscription, publicKey: Uint8Array<ArrayBuffer>): boolean {
  const buffer = subscription.options.applicationServerKey;
  if (!buffer) return false;
  const key = new Uint8Array(buffer);
  return key.length !== publicKey.length || key.some((byte, index) => byte !== publicKey[index]);
}

export async function isWebPushEnabled(
  registration: ServiceWorkerRegistration, publicKey: Uint8Array<ArrayBuffer>, confirmedOnly?: boolean,
): Promise<boolean> {
  const revision = offlineSessionRevision();
  const permission = await pushSessionCache(registration)
    .then(async ({ cache, url }) => (await cache.match(url))?.text()).catch(() => undefined);
  if (permission === 'signed out' || revision !== offlineSessionRevision()) return false;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription || usesDifferentKey(subscription, publicKey)) return false;
  const response = await relayRequest('/subscriptions/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint, confirmedOnly }),
  });
  await requireSuccess(response);
  const status: { enabled?: boolean } = await response.json();
  return status.enabled === true && await allowPushPreviews(registration, revision);
}

function pushRegistrationError(cause: unknown): Error {
  if (cause instanceof Error && cause.name === 'NotAllowedError') {
    return new Error('Allow notifications for this site in your browser settings, then try again.', { cause });
  }
  return new Error('Your browser could not register for push notifications. Reload the page and try again.', { cause });
}

/**
 * The caller loads the key and worker before enabling its control. subscribe()
 * must begin during the click that opens the browser's permission prompt.
 */
export async function enableWebPush({
  registration,
  publicKey,
  confirmedOnly,
}: {
  registration: ServiceWorkerRegistration;
  publicKey: Uint8Array<ArrayBuffer>;
  confirmedOnly?: boolean;
}): Promise<void> {
  const revision = offlineSessionRevision();
  const manager = registration.pushManager;
  const subscribe = () => manager.subscribe({
    applicationServerKey: publicKey,
    userVisibleOnly: true,
  });
  let subscription: PushSubscription;
  try {
    subscription = await subscribe();
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : '';
    if (globalThis.Notification?.permission !== 'granted'
      || (name !== 'AbortError' && name !== 'InvalidStateError')) throw pushRegistrationError(cause);
    try {
      const existing = await manager.getSubscription().catch((lookupError: unknown) => {
        if (name === 'AbortError' && lookupError instanceof Error && lookupError.name === 'AbortError') return null;
        throw lookupError;
      });
      if (existing && usesDifferentKey(existing, publicKey)) {
        if (!await existing.unsubscribe()) throw cause;
        subscription = await subscribe();
      } else if (name === 'AbortError') {
        subscription = existing ?? await subscribe();
      } else {
        throw cause;
      }
    } catch (retryError) {
      throw pushRegistrationError(retryError);
    }
  }
  // Retain the browser subscription if registration with the relay fails. A retry can reuse it.
  if (revision !== offlineSessionRevision()) {
    await subscription.unsubscribe().catch(() => {});
    throw new Error('Sign in to enable notifications.');
  }
  await requireSuccess(await relayRequest('/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirmedOnly === undefined ? subscription : { ...subscription.toJSON(), confirmedOnly }),
  }));
  if (!await allowPushPreviews(registration, revision)) {
    await disableWebPush(registration, false).catch(() => {});
    throw new Error('Sign in to enable notifications.');
  }
}

export async function disableWebPush(registration: ServiceWorkerRegistration, repairSession = true): Promise<void> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const [browser, relay] = await Promise.allSettled([
    subscription.unsubscribe(),
    relayRequest('/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      signal: AbortSignal.timeout(5_000),
    }, repairSession).then(requireSuccess),
  ]);

  // The browser or the relay can independently stop delivery.
  if (relay.status === 'fulfilled' || (browser.status === 'fulfilled' && browser.value)) return;
  throw new Error('Could not disable notifications. Try again when the relay is reachable.');
}

async function pushSessionCache(registration: ServiceWorkerRegistration) {
  const cache = await caches.open('stormbox-push');
  return { cache, url: new URL('.push-session', registration.scope).href };
}

async function allowPushPreviews(registration: ServiceWorkerRegistration, revision: string | null): Promise<boolean> {
  await pushSessionCache(registration).then(async ({ cache, url }) => {
    if (revision === offlineSessionRevision()) await cache.put(url, new Response('allowed'));
  }).catch(() => {});
  return revision === offlineSessionRevision();
}

/** Remove account previews from this browser even when the relay is unreachable. */
export async function revokeWebPushOnSignOut(): Promise<void> {
  const registration = await globalThis.navigator?.serviceWorker?.getRegistration();
  if (!registration?.pushManager) return;
  const hidePreviews = async () => {
    await pushSessionCache(registration).then(({ cache, url }) => cache.put(url, new Response('signed out'))).catch(() => {});
    for (const notification of await registration.getNotifications()) notification.close();
  };
  await Promise.allSettled([
    hidePreviews(),
    disableWebPush(registration, false),
  ]);
}

function onWorkerMessage(type: string, action: () => void): () => void {
  const serviceWorker = navigator.serviceWorker;
  if (!serviceWorker) return () => {};
  const onMessage = (message: MessageEvent) => {
    if (message.source !== serviceWorker.controller) return;
    if (message.data?.type === type) action();
  };
  serviceWorker.addEventListener('message', onMessage);
  return () => serviceWorker.removeEventListener('message', onMessage);
}

export function onWebPushOpenAttention(openAttention: () => void): () => void {
  return onWorkerMessage('stormbox:open-attention', openAttention);
}

export function onWebPushRefresh(refresh: () => void): () => void {
  return onWorkerMessage('stormbox:refresh', refresh);
}

import { JMAP_SERVER_URL } from '../defines';
import { browserSessionEnabled } from '../services/browser-session';
import { AttentionRelay } from '../sync/backends/imap/attention-relay';

const notificationsPath = '/api/push';
const mailRelay = new AttentionRelay((input, init) => fetch(input, init));

async function relayRequest(path: string, init?: RequestInit) {
  const send = () => fetch(`${notificationsPath}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...init,
  });
  const response = await send();
  if (response.status !== 401 || !browserSessionEnabled(JMAP_SERVER_URL)) return response;
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
  return asPublicKey(configuration.publicKey);
}

function usesDifferentKey(subscription: PushSubscription, publicKey: Uint8Array<ArrayBuffer>): boolean {
  const buffer = subscription.options.applicationServerKey;
  if (!buffer) return false;
  const key = new Uint8Array(buffer);
  return key.length !== publicKey.length || key.some((byte, index) => byte !== publicKey[index]);
}

export async function isWebPushEnabled(
  registration: ServiceWorkerRegistration, publicKey: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription || usesDifferentKey(subscription, publicKey)) return false;
  const response = await relayRequest('/subscriptions/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await requireSuccess(response);
  const status: { enabled?: boolean } = await response.json();
  return status.enabled === true;
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
}: {
  registration: ServiceWorkerRegistration;
  publicKey: Uint8Array<ArrayBuffer>;
}): Promise<void> {
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
  await requireSuccess(await relayRequest('/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  }));
}

export async function disableWebPush(registration: ServiceWorkerRegistration): Promise<void> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const [browser, relay] = await Promise.allSettled([
    subscription.unsubscribe(),
    relayRequest('/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).then(requireSuccess),
  ]);

  // The browser or the relay can independently stop delivery.
  if (relay.status === 'fulfilled' || (browser.status === 'fulfilled' && browser.value)) return;
  throw new Error('Could not disable notifications. Try again when the relay is reachable.');
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

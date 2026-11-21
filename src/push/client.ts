const notificationsPath = '/api/push';

function relayRequest(path: string, init?: RequestInit) {
  return fetch(`${notificationsPath}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...init,
  });
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

export async function isWebPushEnabled(registration: ServiceWorkerRegistration): Promise<boolean> {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  const response = await relayRequest('/subscriptions/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await requireSuccess(response);
  const status: { enabled?: boolean } = await response.json();
  return status.enabled === true;
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
  const subscription = await registration.pushManager.subscribe({
    applicationServerKey: publicKey,
    userVisibleOnly: true,
  });
  try {
    await requireSuccess(await relayRequest('/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    }));
  } catch (error) {
    // A browser subscription alone does not enable delivery from the relay.
    await subscription.unsubscribe().catch(() => {});
    throw error;
  }
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

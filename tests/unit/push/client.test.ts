import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableWebPush, isWebPushEnabled, publishWebPushAttentionState, revokeWebPushOnSignOut } from '../../../src/push/client';
import { browserRelayAssertion, browserSessionEnabled } from '../../../src/services/browser-session';
import { writeCachedAccount } from '../../../src/pwa/cached-account';

vi.mock('../../../src/services/browser-session', () => ({
  browserSessionEnabled: vi.fn(),
  browserRelayAssertion: vi.fn(),
}));

const publicKey = Uint8Array.of(4, 12);
const endpoint = 'https://updates.push.services.mozilla.com/test';

function makeSubscription(key = publicKey) {
  return {
    endpoint, options: { applicationServerKey: key.buffer }, unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { auth: 'auth', p256dh: 'public' } }),
  };
}

function makeRegistration() {
  const subscribe = vi.fn<PushManager['subscribe']>();
  const getSubscription = vi.fn<PushManager['getSubscription']>();
  const registration = { pushManager: { subscribe, getSubscription } } as unknown as ServiceWorkerRegistration;
  return { registration, subscribe, getSubscription };
}

describe('browser push registration', () => {
  const fetcher = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetcher.mockReset();
    vi.mocked(browserSessionEnabled).mockReset();
    vi.mocked(browserRelayAssertion).mockReset();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('Notification', { permission: 'granted' });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts the browser subscription before awaiting anything else', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    subscribe.mockResolvedValue(makeSubscription() as unknown as PushSubscription);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));

    const enabled = enableWebPush({ registration, publicKey });
    expect(subscribe).toHaveBeenCalledWith({ applicationServerKey: publicKey, userVisibleOnly: true });
    expect(getSubscription).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await enabled;
    expect(fetcher).toHaveBeenCalledWith('/api/push/subscriptions', expect.objectContaining({ method: 'POST' }));
  });

  it('retries an aborted browser registration only after permission was granted', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    subscribe.mockRejectedValueOnce(new DOMException('Error retrieving push subscription.', 'AbortError'))
      .mockResolvedValueOnce(makeSubscription() as unknown as PushSubscription);
    getSubscription.mockResolvedValue(null);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));

    await enableWebPush({ registration, publicKey });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the notification subscription mode in sync with the local model', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    const subscription = makeSubscription() as unknown as PushSubscription;
    subscribe.mockResolvedValue(subscription);
    getSubscription.mockResolvedValue(subscription);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ enabled: true }));

    await enableWebPush({ registration, publicKey, confirmedOnly: true });
    await expect(isWebPushEnabled(registration, publicKey, false)).resolves.toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ ...subscription.toJSON(), confirmedOnly: true });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ endpoint, confirmedOnly: false });
  });

  it('closes previews and blocks a leftover subscription after sign-out even if the relay cannot be reached', async () => {
    const { registration, getSubscription, subscribe } = makeRegistration();
    const subscription = makeSubscription();
    const close = vi.fn();
    Object.assign(registration, { scope: 'https://stormbox.example/', getNotifications: async () => [{ close }] });
    getSubscription.mockResolvedValue(subscription as unknown as PushSubscription);
    subscription.unsubscribe.mockResolvedValue(false);
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
    const markers = new Map<string, Response>();
    vi.stubGlobal('caches', { open: async () => ({
      put: (key: string, response: Response) => markers.set(key, response),
      match: (key: string) => markers.get(key),
      delete: (key: string) => markers.delete(key),
    }) });
    vi.mocked(browserSessionEnabled).mockReturnValue(true);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));

    await revokeWebPushOnSignOut();
    expect(close).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserRelayAssertion).not.toHaveBeenCalled();
    await expect(isWebPushEnabled(registration, publicKey)).resolves.toBe(false);

    subscribe.mockResolvedValue(subscription as unknown as PushSubscription);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await enableWebPush({ registration, publicKey });
    expect(await markers.get('https://stormbox.example/.push-session')?.text()).toBe('allowed');
  });

  it('abandons a subscription that becomes ready after another tab signs out', async () => {
    const { registration, subscribe } = makeRegistration();
    const subscription = makeSubscription();
    let finishSubscribe!: (value: PushSubscription) => void;
    subscribe.mockReturnValue(new Promise((resolve) => { finishSubscribe = resolve; }));
    const enabling = enableWebPush({ registration, publicKey });
    writeCachedAccount(null);
    finishSubscribe(subscription as unknown as PushSubscription);
    await expect(enabling).rejects.toThrow('Sign in to enable notifications.');
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('queues local attention changes offline and delivers them on the next online sync', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return saved.size; },
      key: (index: number) => [...saved.keys()][index],
      getItem: (key: string) => saved.get(key),
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    });
    const connectivity = { onLine: false };
    vi.stubGlobal('navigator', connectivity);
    const id = '["imap:personal","2-message","review@example.test"]';
    const state = { disposition: 'done' as const, changedAt: Date.now() - 1, aliases: [id], observed: [], resolved: [] };

    await publishWebPushAttentionState(id, state, []);
    expect(saved.size).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();

    connectivity.onLine = true;
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await publishWebPushAttentionState(id, null, []);
    expect(fetcher.mock.calls.map(([path, init]) => [path, JSON.parse(String(init?.body)).state])).toEqual([
      ['/api/push/attention', state],
      ['/api/push/attention', null],
    ]);
    expect(saved.size).toBe(0);
  });

  it('reuses a matching subscription if the browser reports a registration error', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    const existing = makeSubscription();
    subscribe.mockRejectedValue(new DOMException('Error retrieving push subscription.', 'AbortError'));
    getSubscription.mockResolvedValue(existing as unknown as PushSubscription);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));

    await enableWebPush({ registration, publicKey });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('retries once when both subscribe and lookup transiently abort', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    const error = new DOMException('Error retrieving push subscription.', 'AbortError');
    subscribe.mockRejectedValueOnce(error).mockResolvedValueOnce(makeSubscription() as unknown as PushSubscription);
    getSubscription.mockRejectedValueOnce(error);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));

    await enableWebPush({ registration, publicKey });
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports an old signing key as disabled and replaces it when enabling', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    const old = makeSubscription(Uint8Array.of(4, 99));
    getSubscription.mockResolvedValue(old as unknown as PushSubscription);
    subscribe.mockRejectedValueOnce(new DOMException('Key mismatch', 'InvalidStateError'))
      .mockResolvedValueOnce(makeSubscription() as unknown as PushSubscription);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(isWebPushEnabled(registration, publicKey)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    await enableWebPush({ registration, publicKey });
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('leaves the browser subscription intact if the notification relay fails', async () => {
    const { registration, subscribe } = makeRegistration();
    const subscription = makeSubscription();
    subscribe.mockResolvedValue(subscription as unknown as PushSubscription);
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(enableWebPush({ registration, publicKey })).rejects.toThrow('notification relay is unavailable');
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('automatically re-pairs a signed-in browser if the notification session expired', async () => {
    const { registration, subscribe } = makeRegistration();
    subscribe.mockResolvedValue(makeSubscription() as unknown as PushSubscription);
    vi.mocked(browserSessionEnabled).mockReturnValue(true);
    vi.mocked(browserRelayAssertion).mockResolvedValue('fixture-assertion');
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await enableWebPush({ registration, publicKey });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/push/subscriptions', '/api/imap/v1/session', '/api/push/subscriptions',
    ]);
    expect(fetcher.mock.calls[1][1]?.body).toBe('{"assertion":"fixture-assertion"}');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('explains denied browser permission without retrying or registering', async () => {
    const { registration, subscribe, getSubscription } = makeRegistration();
    vi.stubGlobal('Notification', { permission: 'denied' });
    subscribe.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

    await expect(enableWebPush({ registration, publicKey })).rejects.toThrow('Allow notifications for this site');
    expect(getSubscription).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

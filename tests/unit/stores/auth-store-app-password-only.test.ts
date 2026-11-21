// @vitest-environment happy-dom

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({ initOidc: vi.fn() }));

vi.mock('../../../src/services/auth', () => ({
  initOidc: mocks.initOidc,
  getOidc: () => null,
}));

vi.mock('../../../src/defines', () => ({
  APP_PASSWORD_ONLY: true,
  JMAP_SERVER_URL: 'https://jmap.byk.im',
  JMAP_WS_PROXY_URL: 'wss://jmap.byk.im/jmap/ws',
  jmapAccountOriginForServer: (url: string) => new URL(url).origin,
}));

import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.initOidc.mockReset();
  localStorage.clear();
});

afterEach(() => {
  __resetRepositoryForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('auth-store app-password-only mode', () => {
  it('makes login available without starting OIDC', async () => {
    const authStore = useAuthStore();

    await authStore.initialize();

    expect(authStore.appPasswordMode).toBe(true);
    expect(authStore.status).toBe(AUTH_STATE.OIDC_READY);
    expect(mocks.initOidc).not.toHaveBeenCalled();
  });

  it('reopens the browser session without passing the password to the sync worker', async () => {
    vi.stubGlobal('location', { origin: 'https://webmail.byk.im' });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const startSyncAccount = vi.fn<(input: unknown) => Promise<{ accountId: number }>>()
      .mockResolvedValue({ accountId: 42 });
    __setRepositoryForTests({ startSyncAccount });

    const authStore = useAuthStore();
    await authStore.initialize();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await authStore.connectWithPassword({ username: 'test', password: 'test-app-password' })).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/imap/v1/session', expect.objectContaining({
      method: 'DELETE', credentials: 'same-origin',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://jmap.byk.im/jmap/browser-session', expect.objectContaining({
      method: 'POST', credentials: 'include',
      headers: { Authorization: `Basic ${btoa('test:test-app-password')}` },
    }));
    expect(localStorage.getItem('stormbox.bykBrowserSession')).toBe('remembered');

    setActivePinia(createPinia());
    const reopened = useAuthStore();
    await reopened.initialize();
    expect(reopened.isConnected).toBe(true);
    expect(reopened.accountId).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(startSyncAccount).toHaveBeenCalledTimes(2);
    for (const call of startSyncAccount.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        auth: { kind: 'browser-session' }, sessionUrl: 'https://jmap.byk.im/jmap/session',
      }));
    }
  });

  it('does not reopen a signed-out session while a device was offline', async () => {
    vi.stubGlobal('location', { origin: 'https://webmail.byk.im' });
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const startSyncAccount = vi.fn(async () => ({ accountId: 42 }));
    const stopSyncAccount = vi.fn();
    __setRepositoryForTests({ startSyncAccount, stopSyncAccount });

    const authStore = useAuthStore();
    expect(await authStore.connectWithPassword({ username: 'test', password: 'test-app-password' })).toBe(true);
    online.mockReturnValue(false);
    await authStore.logout();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    online.mockReturnValue(true);
    setActivePinia(createPinia());
    const reopened = useAuthStore();
    await reopened.initialize();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/imap/v1/session', expect.objectContaining({
      method: 'DELETE', credentials: 'same-origin',
    }));
    expect(fetchMock).toHaveBeenLastCalledWith('https://jmap.byk.im/jmap/browser-session', expect.objectContaining({
      method: 'DELETE', credentials: 'include',
    }));
    expect(reopened.status).toBe(AUTH_STATE.OIDC_READY);
    expect(startSyncAccount).toHaveBeenCalledOnce();
  });
});

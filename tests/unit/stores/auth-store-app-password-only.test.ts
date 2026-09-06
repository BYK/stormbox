// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
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
}));

import { AUTH_STATE } from '../../../src/constants/states';
import { useAuthStore } from '../../../src/stores/auth-store';

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.initOidc.mockReset();
});

describe('auth-store app-password-only mode', () => {
  it('makes login available without starting OIDC', async () => {
    const authStore = useAuthStore();

    await authStore.initialize();

    expect(authStore.status).toBe(AUTH_STATE.OIDC_READY);
    expect(mocks.initOidc).not.toHaveBeenCalled();
  });
});

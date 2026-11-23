// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';

import ImapAccountsDialog from '../../../src/components/ImapAccountsDialog.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import { replaceLocation } from '../../../src/services/navigation';
import type { RelayAccountSettings } from '../../../src/sync/backends/imap/attention-relay';

vi.mock('../../../src/services/navigation', () => ({ replaceLocation: vi.fn() }));

it('pairs through the browser session and adds, updates, and removes a Gmail account', async () => {
  const account = { id: 'managed_test', email: 'owner@gmail.com', name: 'Gmail', managed: true, host: 'imap.gmail.com' };
  const pairAttentionRelay = vi.fn(async () => []);
  const saveAttentionRelayAccount = vi.fn(async () => account);
  const removeAttentionRelayAccount = vi.fn(async () => {});
  __setRepositoryForTests({
    pairAttentionRelay, saveAttentionRelayAccount, removeAttentionRelayAccount,
    listAttentionRelayAccounts: vi.fn(async () => ({ accounts: [] })),
  });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: false, automatic: true, disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });

  try {
    await flushPromises();
    expect(pairAttentionRelay).toHaveBeenCalledWith(1, undefined, false);
    expect(wrapper.text()).not.toContain('Mail relay pairing token');
    await wrapper.get('input[type="email"]').setValue(account.email);
    await wrapper.get('input[type="password"]').setValue('0123 4567 89ab cdef');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(saveAttentionRelayAccount).toHaveBeenCalledWith(1, {
      email: account.email, name: 'Gmail', password: '0123456789abcdef',
    });
    expect(wrapper.get('[role="status"]').text()).toBe(`${account.email} is connected.`);

    const update = wrapper.findAll('button').find((button) => button.text() === 'Update password');
    await update!.trigger('click');
    expect(wrapper.get('input[type="email"]').attributes('readonly')).toBeDefined();
    expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe('');
    await wrapper.get('input[type="password"]').setValue('a-new-app-password');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(saveAttentionRelayAccount).toHaveBeenLastCalledWith(1, expect.objectContaining({
      email: account.email, password: 'a-new-app-password',
    }));

    await wrapper.get(`[aria-label="Remove ${account.email}"]`).trigger('click');
    expect(removeAttentionRelayAccount).not.toHaveBeenCalled();
    const remove = wrapper.findAll('button').find((button) => button.text() === 'Remove account');
    await remove!.trigger('click');
    await flushPromises();
    expect(removeAttentionRelayAccount).toHaveBeenCalledWith(1, account.id);
    expect(wrapper.emitted('account-change')).toHaveLength(3);
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

it('starts Google authorization without a password and shows the Workspace policy result on return', async () => {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?state=test';
  const startAttentionGoogleOAuth = vi.fn(async () => url);
  __setRepositoryForTests({
    pairAttentionRelay: vi.fn(async () => []),
    listAttentionRelayAccounts: vi.fn(async () => ({ accounts: [], googleOAuth: true })),
    startAttentionGoogleOAuth,
  });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: true, automatic: true, googleResult: 'blocked', disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });

  try {
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Google Workspace administrator');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(startAttentionGoogleOAuth).toHaveBeenCalledWith(1, undefined);
    expect(replaceLocation).toHaveBeenCalledWith(url);

    const appPassword = wrapper.findAll('button').find((button) => button.text() === 'Use an app password');
    await appPassword!.trigger('click');
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
    vi.mocked(replaceLocation).mockClear();
  }
});

it('passes the selected account ID when reconnecting Google', async () => {
  const startAttentionGoogleOAuth = vi.fn(async () => 'https://accounts.google.com/o/oauth2/v2/auth');
  __setRepositoryForTests({
    listAttentionRelayAccounts: vi.fn(async () => ({
      googleOAuth: true,
      accounts: [{ id: 'managed_work', email: 'owner@example.org', name: 'Work', managed: true, auth: 'google-oauth' }],
    })),
    startAttentionGoogleOAuth,
  });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: true, automatic: false, disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });

  try {
    await flushPromises();
    const reconnect = wrapper.findAll('button').find((button) => button.text() === 'Reconnect Google');
    await reconnect!.trigger('click');
    await flushPromises();
    expect(startAttentionGoogleOAuth).toHaveBeenCalledWith(1, 'managed_work');
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
    vi.mocked(replaceLocation).mockClear();
  }
});

it('shows cached accounts and dismisses the dialog while the live list is pending', async () => {
  const settings = { paired: true, accounts: [{ id: 'cached', email: 'cached@example.net', name: 'Cached mailbox' }] };
  let resolveLive!: (value: RelayAccountSettings) => void;
  const response = new Promise<RelayAccountSettings>((resolve) => { resolveLive = resolve; });
  const pairAttentionRelay = vi.fn();
  const listAttentionRelayAccounts = vi.fn((_ownerId: number, cachedOnly = false) =>
    cachedOnly ? Promise.resolve(settings) : response);
  __setRepositoryForTests({ pairAttentionRelay, listAttentionRelayAccounts });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: false, automatic: true, disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });
  try {
    await flushPromises();
    expect(wrapper.text()).toContain('Cached mailbox');
    expect(wrapper.get('[role="status"]').text()).toBe('Refreshing accounts…');
    expect(listAttentionRelayAccounts).toHaveBeenNthCalledWith(1, 1, true);
    expect(listAttentionRelayAccounts).toHaveBeenNthCalledWith(2, 1);
    expect(pairAttentionRelay).not.toHaveBeenCalled();
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toHaveLength(1);
    resolveLive({ accounts: [] });
    await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

it('allows cancel during session pairing', async () => {
  let finishPairing!: (value: string[]) => void;
  const pairing = new Promise<string[]>((resolve) => { finishPairing = resolve; });
  const listAttentionRelayAccounts = vi.fn(async () => ({ paired: false, accounts: [] }));
  __setRepositoryForTests({ pairAttentionRelay: vi.fn(() => pairing), listAttentionRelayAccounts });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: false, automatic: true, disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });
  try {
    await flushPromises();
    expect(wrapper.text()).toContain('Connecting to your mail relay…');
    await wrapper.get('.imap-accounts').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    finishPairing([]);
    await flushPromises();
    expect(wrapper.emitted('paired')).toBeUndefined();
    expect(listAttentionRelayAccounts).toHaveBeenCalledExactlyOnceWith(1, true);
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

it('ignores a Google authorization URL that arrives after the dialog closes', async () => {
  const settings = { accounts: [], googleOAuth: true };
  let finishAuthorization!: (url: string) => void;
  const authorization = new Promise<string>((resolve) => { finishAuthorization = resolve; });
  const startAttentionGoogleOAuth = vi.fn(() => authorization);
  __setRepositoryForTests({
    listAttentionRelayAccounts: vi.fn(async () => settings),
    startAttentionGoogleOAuth,
  });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: true, automatic: true, disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });
  try {
    await flushPromises();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(startAttentionGoogleOAuth).toHaveBeenCalledWith(1, undefined);
    await wrapper.get('[aria-label="Close IMAP accounts"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    finishAuthorization('https://accounts.google.com/o/oauth2/v2/auth?state=test');
    await flushPromises();
    expect(replaceLocation).not.toHaveBeenCalled();
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
    vi.mocked(replaceLocation).mockClear();
  }
});

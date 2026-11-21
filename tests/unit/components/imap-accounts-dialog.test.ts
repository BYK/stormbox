// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';

import ImapAccountsDialog from '../../../src/components/ImapAccountsDialog.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';

it('pairs through the browser session and adds, updates, and removes a Gmail account', async () => {
  const account = { id: 'managed_test', email: 'owner@gmail.com', name: 'Gmail', managed: true, host: 'imap.gmail.com' };
  const pairAttentionRelay = vi.fn(async () => []);
  const saveAttentionRelayAccount = vi.fn(async () => account);
  const removeAttentionRelayAccount = vi.fn(async () => {});
  __setRepositoryForTests({
    pairAttentionRelay, saveAttentionRelayAccount, removeAttentionRelayAccount,
    listAttentionRelayAccounts: vi.fn(async () => []),
  });
  const wrapper = mount(ImapAccountsDialog, {
    props: { ownerId: 1, paired: false, automatic: true, disconnect: vi.fn() },
    global: { stubs: { Teleport: true } },
  });

  try {
    await flushPromises();
    expect(pairAttentionRelay).toHaveBeenCalledWith(1, undefined);
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

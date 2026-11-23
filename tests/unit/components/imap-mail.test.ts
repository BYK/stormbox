// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, expect, it, vi } from 'vitest';
import ImapMail from '../../../src/components/ImapMail.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import type { CachedImapAccount } from '../../../src/db/attention';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

beforeEach(() => __resetRepositoryForTests());

it('shows a failed Google account in Mail and makes its messages available after refresh', async () => {
  const account: CachedImapAccount = {
    relay_id: 'work', address: 'work@example.org', name: 'Work', mailbox: null, uid_validity: null,
    messages: [], sync_error: 'Reconnect this Google account in Manage IMAP accounts.',
  };
  const body = vi.fn(async () => ({ text: 'Work message body.', html: '' }));
  const refresh = vi.fn(async () => []);
  const star = vi.fn(async () => {});
  const target = document.createElement('div');
  document.body.append(target);
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [structuredClone(account)], states: {} }),
    refreshAttentionRelay: refresh,
    refreshImapFolders: async () => {},
    readAttentionImapMessage: body,
    mutateAttentionImapMessage: star,
  });
  const wrapper = mount(ImapMail, { props: { ownerId: 1, search: '', folderTarget: target }, global: { plugins: [createPinia()] } });
  try {
    await flushPromises();
    expect(target.querySelector('summary')?.textContent).toContain('work@example.org');
    target.querySelector<HTMLButtonElement>('.folder-node__button')!.click();
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain('Reconnect this Google account');

    Object.assign(account, {
      mailbox: 'INBOX', uid_validity: '7', last_synced_at: Date.now(), sync_error: null,
      messages: [{ uid: 12, subject: 'Work update', receivedAt: '2026-11-23T09:00:00Z', seen: false,
        flagged: false, from: [{ name: 'Sender', address: 'sender@example.org' }], to: [] }],
    });
    await wrapper.get('button[aria-label="Refresh folder"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain('Last synced');
    await wrapper.setProps({ search: 'absent subject' });
    expect(wrapper.text()).toContain('No matches in downloaded messages.');
    await wrapper.setProps({ search: 'work update' });
    await wrapper.get('summary[aria-label="Message actions"]').trigger('click');
    expect(body).not.toHaveBeenCalled();
    await wrapper.get('.app-dropdown__item[aria-label="Star"]').trigger('click');
    expect(star).toHaveBeenCalledWith(1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 12 },
      { type: 'star', value: true });
    await wrapper.get('button[aria-label^="Open message: Work update"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Work message body.');
  } finally {
    wrapper.unmount();
    target.remove();
    __resetRepositoryForTests();
  }
});

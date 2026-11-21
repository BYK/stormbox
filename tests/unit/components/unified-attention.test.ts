// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { expect, it, vi } from 'vitest';
import { watch } from 'vue';

import UnifiedAttention from '../../../src/components/UnifiedAttention.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import type { FolderRow } from '../../../src/types';

vi.mock('../../../src/services/auth', () => ({ initOidc: vi.fn(), getOidc: vi.fn() }));

it('reopens account management once on return from Google', async () => {
  const before = window.location.href;
  window.history.replaceState(null, '', '/?view=attention&google_imap=connected');
  const refreshAttentionRelay = vi.fn(async () => []);
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [], states: {} }),
    folderByRole: async () => undefined,
    refreshAttentionRelay,
    listAttentionRelayAccounts: async () => ({
      accounts: [{ id: 'managed_work', email: 'owner@example.org', name: 'Work' }], googleOAuth: true,
    }),
  });
  const wrapper = mount(UnifiedAttention, {
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [createPinia()], stubs: { Teleport: true } },
  });

  try {
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain('Google account connected.');
    expect(window.location.search).toBe('?view=attention');
    expect(refreshAttentionRelay).toHaveBeenCalledWith(1);
    await wrapper.get('[aria-label="Close IMAP accounts"]').trigger('click');
    const manage = wrapper.findAll('button').find((button) => button.text() === 'Manage IMAP accounts');
    await manage!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).not.toContain('Google account connected.');
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
    window.history.replaceState(null, '', before);
  }
});

it('opens the regular JMAP reader in Attention and keeps the filter and focus on return', async () => {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  const mail = useMailStore(pinia);
  const folder = { id: 10, account_id: 1, role: 'inbox' } as FolderRow;
  const row = {
    id: 17, account_id: 1, is_seen: 1, is_flagged: 0, received_at: Date.now(),
    subject: 'Weekly digest', preview: 'This week in the project.',
    from_text: 'updates@example.org', to_text: 'owner@example.org',
  };
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: false, accounts: [], states: {} }),
    folderByRole: async () => folder,
    listMessagesForView: async () => [{ ...row }],
    ensureFolderWindow: async () => {},
  });
  auth.accountId = 1;
  mail.folders = [folder];
  const stop = watch(() => mail.selectedMessageId, (id) => {
    if (id) mail.messageBody = { text: 'This week in the project.' } as typeof mail.messageBody;
  });
  const star = vi.spyOn(mail, 'markManyFlagged').mockImplementation(async () => {
    row.is_flagged = 1;
    return 1;
  });
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [pinia] },
  });

  try {
    await flushPromises();
    const filters = wrapper.get('[aria-label="Smart Inbox filters"]');
    const updates = filters.findAll('button')[1];
    await updates.trigger('click');
    const preview = wrapper.get('.msg-list__open');
    await preview.trigger('click');
    await flushPromises();
    const reader = wrapper.get('[aria-label="Message detail"]');
    expect(reader.text()).toContain('This week in the project.');
    expect(preview.attributes('aria-current')).toBe('true');
    expect(wrapper.get('[aria-label="Smart Inbox filters"]').element).toBe(filters.element);
    await reader.get('[aria-label="Back to Attention"]').trigger('click');
    expect(updates.attributes('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(preview.element);

    const starButton = wrapper.get('[aria-label="Star"]');
    await starButton.trigger('click');
    await flushPromises();
    expect(star).toHaveBeenCalledWith([row.id], true, {
      sourceFolderId: folder.id, rows: [expect.objectContaining({ id: row.id })],
    });
    expect(wrapper.find('[aria-label="Message detail"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    stop();
    __resetRepositoryForTests();
  }
});

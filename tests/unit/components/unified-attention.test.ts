// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { expect, it, vi } from 'vitest';
import { watch } from 'vue';

import UnifiedAttention from '../../../src/components/UnifiedAttention.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useMailStore } from '../../../src/stores/mail-store';
import type { RelayMessageBody } from '../../../src/sync/backends/imap/attention-relay';
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

it('keeps the shared reader mounted while loading IMAP HTML and sends its toolbar actions to the relay account', async () => {
  const row = {
    uid: 17, subject: 'Newsletter issue', receivedAt: '2026-11-21T20:00:00Z', seen: true, flagged: false,
    from: [{ name: 'Newsletter', address: 'updates@example.org' }],
    to: [{ name: '', address: 'my-gmail@example.org' }],
    cc: [{ name: 'Subscriber', address: 'subscriber@example.net' }],
    replyTo: [{ name: '', address: 'replies@example.org' }],
    labels: ['Read later'], keywords: ['localtriage-category-newsletter'], gmailLabels: true,
  };
  let messages = [row];
  let receiveBody!: (body: RelayMessageBody) => void;
  const download = new Promise<RelayMessageBody>((resolve) => { receiveBody = resolve; });
  const readAttentionImapMessage = vi.fn(async (_owner, _location, cachedOnly) => cachedOnly
    ? { text: 'Previously downloaded text', html: null } : download);
  const mutateAttentionImapMessage = vi.fn(async (_owner, _location, action) => {
    if (action.type === 'star') row.flagged = action.value;
    if (action.type === 'seen') row.seen = action.value;
    if (action.type === 'tags') row.labels = row.labels.filter((label) => !action.tags.removeLabels?.includes(label));
    if (action.type === 'trash') messages = [];
  });
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [{
      relay_id: 'personal-gmail', address: 'my-gmail@example.org', name: 'Gmail',
      mailbox: 'INBOX', uid_validity: '3', can_send: true, messages,
    }], states: {} }),
    folderByRole: async () => undefined,
    refreshAttentionRelay: async () => [],
    readAttentionImapMessage,
    mutateAttentionImapMessage,
  });
  const pinia = createPinia();
  const compose = useComposeStore(pinia);
  const prepare = vi.spyOn(compose, 'prepareImapResponse');
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [pinia], stubs: { Teleport: true } },
  });

  try {
    await flushPromises();
    const open = wrapper.get('.msg-list__open');
    await open.trigger('click');
    await flushPromises();
    const reader = wrapper.get('.message-view');
    const header = reader.get('[aria-label="Message header"]');
    const back = reader.get('[aria-label="Back to Attention"]');
    expect(header.text()).toContain('Newsletter <updates@example.org>');
    expect(header.text()).toContain('my-gmail@example.org');
    expect(header.text()).toContain('Subscriber <subscriber@example.net>');
    expect(header.text()).toContain('Read later');
    expect(header.text()).toContain('localtriage-category-newsletter');
    expect(reader.text()).toContain('Previously downloaded text');
    expect(reader.find('iframe').exists()).toBe(false);
    const location = { accountId: 'personal-gmail', mailbox: 'INBOX', uidValidity: '3', uid: 17 };
    expect(readAttentionImapMessage).toHaveBeenNthCalledWith(1, 1, location, true);
    expect(readAttentionImapMessage).toHaveBeenNthCalledWith(2, 1, location);

    receiveBody({ text: '', html: '<p><strong>Formatted newsletter</strong></p>' });
    await flushPromises();
    expect(reader.get('iframe').attributes('srcdoc')).toContain('<strong>Formatted newsletter</strong>');
    expect(reader.get('[aria-label="Message header"]').element).toBe(header.element);
    expect(reader.get('[aria-label="Back to Attention"]').element).toBe(back.element);
    expect(reader.get('[aria-label="Archive"]').attributes('disabled')).toBeUndefined();
    expect(reader.get('[aria-label="Mark as junk"]').attributes('disabled')).toBeUndefined();
    await reader.get('[aria-label="Reply All"]').trigger('click');
    expect(prepare).toHaveBeenLastCalledWith('reply-all', {
      id: 'personal-gmail', email: 'my-gmail@example.org', name: 'Gmail',
    }, expect.objectContaining({ addresses: expect.arrayContaining([
      expect.objectContaining({ kind: 'replyTo', email: 'replies@example.org' }),
      expect.objectContaining({ kind: 'cc', email: 'subscriber@example.net' }),
    ]) }), expect.objectContaining({ html: expect.stringContaining('Formatted newsletter') }));
    await reader.get('[aria-label="Forward"]').trigger('click');
    expect(prepare.mock.lastCall?.[0]).toBe('forward');

    await reader.get('[data-tag-picker-trigger]').trigger('click');
    await flushPromises();
    const tag = wrapper.findAll('[role="menuitemcheckbox"]').find((item) => item.text().trim() === 'Read later');
    expect(tag?.attributes('aria-checked')).toBe('true');
    await tag!.trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, {
      type: 'tags', tags: { removeLabels: ['Read later'] },
    });
    expect(header.text()).not.toContain('Read later');
    await back.trigger('click');
    expect(document.activeElement).toBe(open.element);
    await open.trigger('click');
    await flushPromises();

    const reopened = wrapper.get('.message-view');
    const star = reopened.get('[aria-label="Star"]');
    await star.trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, { type: 'star', value: true });
    expect(star.attributes('aria-pressed')).toBe('true');
    await reopened.get('[aria-label="Mark as unread"]').trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, { type: 'seen', value: false });
    expect(reopened.find('[aria-label="Mark as read"]').exists()).toBe(true);
    await reopened.get('[aria-label="Delete"]').trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, { type: 'trash' });
    expect(wrapper.find('.message-view').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

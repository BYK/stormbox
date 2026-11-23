// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, expect, it, vi } from 'vitest';
import ImapMail from '../../../src/components/ImapMail.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import type { CachedImapAccount } from '../../../src/db/attention';
import { useAuthStore } from '../../../src/stores/auth-store';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

beforeEach(() => {
  __resetRepositoryForTests();
  localStorage.clear();
});

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
    target.querySelector<HTMLButtonElement>('details .folder-node__button')!.click();
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

it('restores the Unified Inbox from saved mail and expands a conversation across providers while sync is pending', async () => {
  const account: CachedImapAccount = {
    relay_id: 'work', address: 'work@example.org', name: 'Work', mailbox: 'INBOX', uid_validity: '7',
    messages: [{
      uid: 41, subject: 'Planning', messageId: '<start@example.org>', references: [], inReplyTo: null,
      receivedAt: '2026-11-23T09:00:00Z', seen: false, flagged: false,
      from: [{ name: 'First sender', address: 'sender@example.org' }], to: [],
    }],
  };
  const primaryInbox = { id: 23, role: 'inbox', account_id: 1, name: 'Inbox', total_emails: 1 };
  const reply = {
    id: 42, account_id: 1, subject: 'Re: Planning', rfc822_message_id: 'reply@example.org',
    references_json: '["start@example.org"]', received_at: Date.parse('2026-11-23T10:00:00Z'),
    from_text: 'Reply sender <reply@example.org>', is_seen: 1, is_flagged: 0,
  };
  const body = vi.fn(async () => ({ text: 'Saved IMAP message body.', html: '' }));
  let finishSync!: (result: []) => void;
  const pendingSync = new Promise<[]>((resolve) => { finishSync = resolve; });
  const refresh = vi.fn(() => pendingSync);
  const refreshJmap = vi.fn(async () => {});
  const target = document.createElement('div');
  document.body.append(target);
  localStorage.setItem('stormbox:mail-view:1', '{"kind":"unified"}');
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [account], states: {} }),
    refreshAttentionRelay: refresh,
    readAttentionImapMessage: body,
    folderByRole: async () => primaryInbox,
    listMessagesForView: async () => [reply],
    ensureFolderWindow: refreshJmap,
  });
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  auth.isOfflineSession = true;
  const wrapper = mount(ImapMail, { props: { ownerId: 1, search: '', folderTarget: target }, global: { plugins: [pinia] } });
  try {
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshJmap).not.toHaveBeenCalled();
    expect(wrapper.get('h2').text()).toBe('Unified Inbox');
    expect(wrapper.findAll('ul li')).toHaveLength(1);
    expect(wrapper.find('button[aria-label^="Open message: Re: Planning"]').exists()).toBe(true);
    await wrapper.get('button[aria-label="Show 1 earlier messages"]').trigger('click');
    expect(wrapper.findAll('ul li')).toHaveLength(2);
    await wrapper.get('button[aria-label^="Open message: Planning"]').trigger('click');
    await flushPromises();
    expect(body).toHaveBeenCalledWith(1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 41 }, true);
    expect(wrapper.text()).toContain('Saved IMAP message body.');
    await wrapper.get('button[aria-pressed="false"]').trigger('click');
    expect(wrapper.findAll('ul li')).toHaveLength(2);
    auth.isOfflineSession = false;
    await flushPromises();
    expect(refreshJmap).toHaveBeenCalledWith(1, primaryInbox.id, expect.objectContaining({ offset: 0 }));
  } finally {
    finishSync([]);
    wrapper.unmount();
    target.remove();
  }
});

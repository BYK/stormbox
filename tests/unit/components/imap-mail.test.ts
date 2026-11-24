// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, expect, it, vi } from 'vitest';
import ImapMail from '../../../src/components/ImapMail.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import type { CachedImapAccount } from '../../../src/db/attention';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

beforeEach(() => {
  __resetRepositoryForTests();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

it('shows a failed Google account in Mail and makes its messages available after refresh', async () => {
  const account: CachedImapAccount = {
    relay_id: 'work', address: 'work@example.org', name: 'Work', mailbox: null, uid_validity: null,
    messages: [], sync_error: 'Reconnect this Google account in Manage IMAP accounts.',
  };
  const body = vi.fn(async () => ({ text: 'Work message body.', html: '' }));
  const refresh = vi.fn(async () => []);
  const mutate = vi.fn(async () => {});
  const batch = vi.fn(async () => ({ mutationIds: [1, 2] }));
  const target = document.createElement('div');
  document.body.append(target);
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [structuredClone(account)], states: {} }),
    refreshAttentionRelay: refresh,
    refreshImapFolders: async () => {},
    readAttentionImapMessage: body,
    mutateAttentionImapMessage: mutate,
    mutateAttentionImapMessages: batch,
  });
  const wrapper = mount(ImapMail, { attachTo: document.body, props: { ownerId: 1, search: '', folderTarget: target }, global: { plugins: [createPinia()] } });
  try {
    await flushPromises();
    const accountToggle = target.querySelector<HTMLButtonElement>('.mail-account-label');
    expect(accountToggle?.textContent).toContain('work@example.org');
    expect(accountToggle?.getAttribute('aria-expanded')).toBe('false');
    accountToggle!.click();
    await flushPromises();
    expect(accountToggle?.getAttribute('aria-expanded')).toBe('true');
    target.querySelector<HTMLButtonElement>('.imap-nav__account .folder-node__button')!.click();
    await flushPromises();
    const header = wrapper.get('.msg-list__header').element;
    const scroller = wrapper.get('.msg-list__scroller').element;
    expect(wrapper.get('.msg-list__header [role="status"]').text()).toContain('Reconnect this Google account');

    const message = { uid: 12, subject: 'Work update', receivedAt: '2026-11-23T09:00:00Z', seen: false,
      flagged: false, from: [{ name: 'Sender', address: 'sender@example.org' }], to: [], gmailLabels: true, labels: ['Project'] };

    Object.assign(account, {
      mailbox: 'INBOX', uid_validity: '7', last_synced_at: Date.now(), sync_error: null,
      messages: [message, { ...message, uid: 13, subject: 'Other mail' }],
    });
    await wrapper.get('button[aria-label="Refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('.msg-list__header [role="status"]').text()).toContain('Last synced');
    expect(wrapper.get('.msg-list__header').element).toBe(header);
    expect(wrapper.get('.msg-list__scroller').element).toBe(scroller);
    expect(wrapper.find('.attention-row-menu').exists()).toBe(false);
    expect(wrapper.findAll('.msg-list__check input')).toHaveLength(2);
    expect(wrapper.findAll('.msg-list__state .msg-list__unread-dot')).toHaveLength(2);

    await wrapper.get('.msg-list__select-all input').trigger('change');
    await wrapper.get('[data-bulk-action="mark-read"]').trigger('click');
    expect(batch).toHaveBeenCalledWith(1, [12, 13].map((uid) => ({
      location: { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid }, action: { type: 'seen', value: true },
    })), true);
    await wrapper.setProps({ search: 'absent subject' });
    expect(wrapper.text()).toContain('No matches in downloaded messages.');
    await wrapper.setProps({ search: 'work update' });
    expect(body).not.toHaveBeenCalled();
    const location = { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 12 };
    await wrapper.get('.msg-list__actions button[aria-label="Star"]').trigger('click');
    await flushPromises();
    expect(mutate).toHaveBeenCalledWith(1, location, { type: 'star', value: true }, true);
    await wrapper.get('.msg-list__actions button[aria-label="Tags: Project"]').trigger('click');
    await flushPromises();
    const label = document.querySelector<HTMLButtonElement>('button[data-tag-keyword="gmail label:Project"]')!;
    expect(label.getAttribute('aria-checked')).toBe('true');
    label.click();
    await flushPromises();
    expect(mutate).toHaveBeenCalledWith(1, location, { type: 'tags', tags: { removeLabels: ['Project'] } }, true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wrapper.get('button[aria-label^="Open message: Work update"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Work message body.');
    expect(mutate).toHaveBeenCalledWith(1, location, { type: 'seen', value: true });
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
  const mutateImap = vi.fn(async () => {});
  const target = document.createElement('div');
  document.body.append(target);
  localStorage.setItem('stormbox:mail-view:1', '{"kind":"unified"}');
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [account], states: {} }),
    refreshAttentionRelay: refresh,
    readAttentionImapMessage: body,
    mutateAttentionImapMessage: mutateImap,
    folderByRole: async () => primaryInbox,
    listMessagesForView: async () => [reply],
    ensureFolderWindow: refreshJmap,
  });
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  const destroyJmap = vi.spyOn(useMailStore(pinia), 'destroyMessages');
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
    await wrapper.get('button[aria-label^="Open message: Re: Planning"]').trigger('click', { ctrlKey: true });
    expect(wrapper.get('.msg-list__header').text()).toContain('1 selected');
    expect(body).not.toHaveBeenCalled();
    await wrapper.get('button[aria-label^="Open message: Planning"]').trigger('click');
    await flushPromises();
    expect(body).toHaveBeenCalledWith(1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 41 }, true);
    expect(wrapper.text()).toContain('Saved IMAP message body.');
    await wrapper.get('button[aria-label="Unread"]').trigger('click');
    expect(wrapper.findAll('ul li')).toHaveLength(1);
    expect(wrapper.find('button[aria-label^="Open message: Re: Planning"]').exists()).toBe(false);
    await wrapper.get('.msg-list__select-all input').trigger('change');
    await wrapper.get('[data-bulk-action="delete"]').trigger('click');
    expect(mutateImap).toHaveBeenLastCalledWith(1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 41 }, { type: 'trash' }, true);
    expect(destroyJmap).not.toHaveBeenCalled();
    auth.isOfflineSession = false;
    await flushPromises();
    expect(refreshJmap).toHaveBeenCalledWith(1, primaryInbox.id, expect.objectContaining({ offset: 0 }));
  } finally {
    finishSync([]);
    wrapper.unmount();
    target.remove();
  }
});

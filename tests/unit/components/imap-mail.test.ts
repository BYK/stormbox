// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, expect, it, vi } from 'vitest';
import ImapMail from '../../../src/components/ImapMail.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import type { CachedImapAccount } from '../../../src/db/attention';
import { TABLE_FAMILIES } from '../../../src/db/protocol';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';
import type { FolderRow } from '../../../src/types/db';

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

    const reader = wrapper.get('.message-view').element;
    await wrapper.get('[data-more-menu]').trigger('click');
    await wrapper.get('[data-more-item="read-inline"]').trigger('click');
    await flushPromises();
    const row = wrapper.get('.imap-mail__rows > li');
    expect(row.get('[data-inline-mail-reader] .message-view').element).toBe(reader);
    expect(row.get('.msg-list__open').attributes('aria-expanded')).toBe('true');
    expect(wrapper.classes()).not.toContain('imap-mail--reading');
    await row.get('button[aria-label="Collapse message"]').trigger('click');
    expect(row.find('[data-inline-mail-reader]').exists()).toBe(false);
    expect(document.activeElement).toBe(row.get('.msg-list__open').element);
  } finally {
    wrapper.unmount();
    target.remove();
    __resetRepositoryForTests();
  }
});

it('treats a Unified Inbox conversation as one unit while sync is pending', async () => {
  const account: CachedImapAccount = {
    relay_id: 'work', address: 'work@example.org', name: 'Work', mailbox: 'INBOX', uid_validity: '7',
    messages: [{
      uid: 41, subject: 'Planning', messageId: '<start@example.org>', references: [], inReplyTo: null,
      receivedAt: '2026-11-23T09:00:00Z', seen: false, flagged: false,
      from: [{ name: 'First sender', address: 'sender@example.org' }], to: [],
    }],
  };
  const primaryInbox = { id: 23, role: 'inbox', account_id: 1, name: 'Inbox', total_emails: 2 };
  const reply = {
    id: 42, account_id: 1, thread_id: 111, subject: 'Re: Planning', rfc822_message_id: 'reply@example.org',
    references_json: '["start@example.org"]', received_at: Date.parse('2026-11-23T10:00:00Z'),
    from_text: 'Reply sender <reply@example.org>', is_seen: 1, is_flagged: 0,
  };
  const older = { ...reply, id: 40, rfc822_message_id: 'older@example.org', references_json: '[]',
    received_at: Date.parse('2026-11-23T08:00:00Z'), from_text: 'Earlier sender <early@example.org>' };
  const body = vi.fn(async () => ({ text: 'Saved IMAP message body.', html: '' }));
  let finishSync!: (result: []) => void;
  const pendingSync = new Promise<[]>((resolve) => { finishSync = resolve; });
  const refresh = vi.fn(() => pendingSync);
  const refreshJmap = vi.fn(async () => {});
  const mutateImap = vi.fn(async () => {});
  let jmapRows = [reply];
  let cachedThread = [older, reply];
  const imapMessage = account.messages[0];
  const listCachedThread = vi.fn(async () => cachedThread);
  let notify!: (tables: string[]) => void;
  const target = document.createElement('div');
  document.body.append(target);
  localStorage.setItem('stormbox:mail-view:1', '{"kind":"unified"}');
  __setRepositoryForTests({
    subscribe: (callback) => { notify = callback; return () => {}; },
    getAttentionCache: async () => ({ paired: true, accounts: [account], states: {} }),
    refreshAttentionRelay: refresh,
    readAttentionImapMessage: body,
    mutateAttentionImapMessage: mutateImap,
    folderByRole: async () => primaryInbox,
    listMessagesForView: async () => jmapRows,
    listMessagesForFolderThreads: listCachedThread,
    ensureFolderWindow: refreshJmap,
  });
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  const mailStore = useMailStore(pinia);
  const destroyJmap = vi.spyOn(mailStore, 'destroyMessages');
  auth.isOfflineSession = true;
  const wrapper = mount(ImapMail, { props: { ownerId: 1, search: '', folderTarget: target }, global: { plugins: [pinia] } });
  try {
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refreshJmap).not.toHaveBeenCalled();
    expect(wrapper.get('h2').text()).toBe('Unified Inbox');
    expect(listCachedThread).toHaveBeenCalledWith(1, 23, [111]);
    expect(wrapper.findAll('.imap-mail__rows > li')).toHaveLength(1);
    expect(wrapper.find('.imap-mail__rows button[aria-label="Delete"]').exists()).toBe(false);
    mailStore.folders = [
      { ...primaryInbox, may_read_items: 1, may_remove_items: 1 },
      { id: 24, name: 'Trash', role: 'trash', account_id: 1, may_add_items: 1 },
    ] as FolderRow[];
    await wrapper.setProps({ search: 'first sender' });
    const headCheckbox = wrapper.get<HTMLInputElement>('input[aria-label^="Select conversation: Re: Planning"]');
    await headCheckbox.trigger('click');
    expect(wrapper.get('.msg-list__header').text()).toContain('3 selected');
    const pill = wrapper.get('.thread-expand__pill');
    expect(pill.text()).toBe('Show 3 messages');
    expect(pill.element.closest('.msg-list__item')).toBeNull();
    await pill.trigger('click');
    expect(wrapper.findAll('.imap-mail__rows > li')).toHaveLength(4);
    const newest = wrapper.get<HTMLInputElement>('input[aria-label^="Select message: Re: Planning"]');
    await newest.trigger('click');
    expect(headCheckbox.element.indeterminate).toBe(true);
    expect(newest.element.checked).toBe(false);
    await newest.trigger('click');
    expect(headCheckbox.element.checked).toBe(true);
    await wrapper.get('input[aria-label^="Select message: Planning"]').trigger('click');
    expect(headCheckbox.element.indeterminate).toBe(true);
    expect(wrapper.get('.msg-list__header').text()).toContain('2 selected');
    expect(pill.text()).toBe('Hide 3 messages');
    await pill.trigger('click');
    expect(wrapper.get('.msg-list__header').text()).toContain('2 selected');
    await wrapper.get('button[aria-label="Clear selection"]').trigger('click');
    expect(body).not.toHaveBeenCalled();

    await pill.trigger('click');
    await wrapper.get('button[aria-label^="Open message: Planning"]').trigger('click');
    expect(wrapper.find('ol[aria-label="Messages in conversation"]').exists()).toBe(false);
    await wrapper.get('button[aria-label="Back"]').trigger('click');

    await wrapper.get('button[aria-label^="Open conversation: Re: Planning"]').trigger('click');
    const thread = wrapper.get('ol[aria-label="Messages in conversation"]');
    expect(thread.findAll('li')).toHaveLength(3);
    const firstSender = thread.findAll('button.conversation-reader__summary').find((button) => button.text().includes('First sender'))!;
    await firstSender.trigger('click');
    await flushPromises();
    expect(body).toHaveBeenCalledWith(1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 41 }, true);
    expect(thread.text()).toContain('Saved IMAP message body.');

    jmapRows = cachedThread = [older];
    notify([TABLE_FAMILIES.MESSAGES]);
    await flushPromises();
    expect(wrapper.find('ol[aria-label="Messages in conversation"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Saved IMAP message body.');
    account.messages = [];
    notify([TABLE_FAMILIES.ATTENTION]);
    await flushPromises();
    expect(wrapper.find('.imap-mail__reader').exists()).toBe(false);

    jmapRows = [reply];
    cachedThread = [older, reply];
    account.messages = [imapMessage];
    notify([TABLE_FAMILIES.MESSAGES, TABLE_FAMILIES.ATTENTION]);
    await flushPromises();
    await wrapper.get('button[aria-label^="Open conversation: Re: Planning"]').trigger('click');
    await wrapper.get('[data-more-item="read-inline"]').trigger('click');
    await flushPromises();
    const inline = wrapper.get('[data-inline-mail-reader]');
    expect(inline.findAll('ol[aria-label="Messages in conversation"] > li')).toHaveLength(3);
    await inline.get('button[aria-label="Delete conversation"]').trigger('click');
    expect(mutateImap).toHaveBeenLastCalledWith(1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '7', uid: 41 },
      { type: 'trash' }, true, expect.any(Number));
    expect(destroyJmap).toHaveBeenCalledWith([40, 42], expect.objectContaining({ sourceFolderId: 23 }));
    auth.isOfflineSession = false;
    await flushPromises();
    expect(refreshJmap).toHaveBeenCalledWith(1, primaryInbox.id, expect.objectContaining({ offset: 0 }));
  } finally {
    finishSync([]);
    wrapper.unmount();
    target.remove();
  }
});

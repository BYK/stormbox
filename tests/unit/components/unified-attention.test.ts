// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { expect, it, vi } from 'vitest';
import { nextTick, shallowRef, watch } from 'vue';

import UnifiedAttention from '../../../src/components/UnifiedAttention.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import { TABLE_FAMILIES } from '../../../src/db/protocol';
import { onWebPushRefresh, publishWebPushAttentionState } from '../../../src/push/client';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useComposeStore } from '../../../src/stores/compose-store';
import { useMailStore } from '../../../src/stores/mail-store';
import { useMailActionFeedbackStore } from '../../../src/stores/mail-action-feedback-store';
import type { ImapAttentionAction, ImapMessageLocation, RelayMessageBody } from '../../../src/sync/backends/imap/attention-relay';
import { matchingBundleStates, replaceBundleStates, type BundleStates } from '../../../src/triage/bundle-state-edits';
import type { FolderRow } from '../../../src/types';

vi.mock('../../../src/services/auth', () => ({ initOidc: vi.fn(), getOidc: vi.fn() }));
vi.mock('../../../src/push/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/push/client')>(),
  onWebPushRefresh: vi.fn(() => () => {}),
  publishWebPushAttentionState: vi.fn(async () => {}),
}));

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function mountBundleActions(overrides: object = {}) {
  const subjects = ['Please review the release', 'Please approve the estimate'];
  const arrived = Date.now();
  const pinia = createPinia();
  let states: BundleStates = {};
  let announce: (tables: string[]) => void = () => {};
  const persist = vi.fn(async () => {});
  const changeAttentionBundleStates = vi.fn(async (_ownerId, aliases: string[], replacements: BundleStates) => {
    await persist();
    const previous = matchingBundleStates(states, aliases);
    states = replaceBundleStates(states, aliases, replacements);
    announce([TABLE_FAMILIES.ATTENTION]);
    return { applied: true, previous };
  });
  __setRepositoryForTests({
    subscribe: (callback: typeof announce) => { announce = callback; return () => {}; },
    folderByRole: async () => undefined,
    getAttentionCache: async () => ({ paired: true, accounts: [{
      relay_id: 'work', address: 'owner@example.org', mailbox: 'INBOX', uid_validity: '3',
      messages: subjects.map((subject, uid) => ({
        uid: uid + 1, subject, receivedAt: new Date(arrived - uid * 60_000).toISOString(), seen: false, flagged: true,
        from: [{ address: `sender${uid}@example.org` }], to: [{ address: 'owner@example.org' }],
      })),
    }], states }),
    refreshAttentionRelay: async () => [],
    changeAttentionBundleStates,
    ...overrides,
  });
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [pinia] },
  });
  const feedback = useMailActionFeedbackStore(pinia);
  const currentSubjects = () => wrapper.findAll('.attention-inbox__bundle .msg-list__subject').map((node) => node.text());
  const select = (label: RegExp) => wrapper.findAll('.attention-inbox__filter')
    .find((button) => label.test(button.attributes('aria-label')))?.trigger('click');
  const act = async (subject: string, label: string) => {
    const row = wrapper.findAll('.attention-inbox__bundle').find((node) => node.text().includes(subject))!;
    await row.get(`button[aria-label="${label}"]`).trigger('click');
    if (label === 'Snooze') {
      document.querySelector<HTMLButtonElement>('.attention-snooze button[aria-label="1 hour"]')!.click();
      await nextTick();
    }
  };
  return {
    wrapper, feedback, persist, subjects, currentSubjects, select, act, changeAttentionBundleStates,
    notify: () => announce([TABLE_FAMILIES.ATTENTION]), currentStates: () => states,
    dispose: () => { wrapper.unmount(); feedback.$reset(); __resetRepositoryForTests(); },
  };
}

it('marks a bundle read and archives it with one early Undo, without writing disposition state', async () => {
  const pending = deferred();
  const mutateAttentionImapMessages = vi.fn(async () => {
    await pending.promise;
    return { mutationIds: [10, 11] };
  });
  const undoAttentionImapActions = vi.fn(async () => ({ canceledIds: [10, 11] }));
  const fixture = mountBundleActions({ mutateAttentionImapMessages, undoAttentionImapActions });
  const { feedback, subjects: [first, second], currentSubjects, act, changeAttentionBundleStates } = fixture;
  try {
    await flushPromises();
    const before = currentSubjects();
    await act(first, 'Mark done');
    expect(currentSubjects()).toEqual([second]);
    const entry = feedback.entries.find(({ action }) => action === 'Undo')!;
    expect(feedback.entries).toHaveLength(1);
    const location = { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 1 };
    expect(mutateAttentionImapMessages).toHaveBeenCalledExactlyOnceWith(1, [
      { location, action: { type: 'seen', value: true } },
      { location, action: { type: 'archive' } },
    ], true, entry.expiresAt);
    fixture.notify();
    await flushPromises();
    expect(currentSubjects()).toEqual([second]);
    const undoing = feedback.run(entry.id);
    await flushPromises();
    expect(currentSubjects()).toEqual(before);
    pending.resolve();
    await undoing;
    expect(undoAttentionImapActions).toHaveBeenCalledExactlyOnceWith(1, [10, 11], true);
    expect(changeAttentionBundleStates).not.toHaveBeenCalled();
  } finally {
    pending.resolve();
    fixture.dispose();
  }
});

it('snoozes a bundle and lets Undo restore it before a single SQLite write settles', async () => {
  const fixture = mountBundleActions();
  const { feedback, persist, subjects: [first, second], currentSubjects, act, changeAttentionBundleStates } = fixture;
  const done = deferred();
  const undo = deferred();
  persist.mockReturnValueOnce(done.promise).mockReturnValueOnce(undo.promise);
  vi.mocked(publishWebPushAttentionState).mockClear();
  try {
    await flushPromises();
    const order = currentSubjects();
    await act(first, 'Snooze');
    expect(currentSubjects()).toEqual([second]);
    expect(fixture.currentStates()).toEqual({});
    fixture.notify();
    await flushPromises();
    expect(currentSubjects()).toEqual([second]);
    expect(publishWebPushAttentionState).not.toHaveBeenCalled();

    const entry = feedback.entries.find(({ action }) => action === 'Undo')!;
    const undoing = feedback.run(entry.id);
    await flushPromises();
    expect(currentSubjects()).toEqual(order);
    expect(changeAttentionBundleStates).toHaveBeenCalledTimes(1);

    done.resolve();
    await flushPromises();
    expect(currentSubjects()).toEqual(order);
    expect(changeAttentionBundleStates).toHaveBeenCalledTimes(2);
    expect(publishWebPushAttentionState).not.toHaveBeenCalled();
    undo.resolve();
    await undoing;
    expect(fixture.currentStates()).toEqual({});
    expect(publishWebPushAttentionState).toHaveBeenCalledExactlyOnceWith(expect.any(String), null, expect.any(Array), expect.any(Number));
  } finally {
    done.resolve();
    undo.resolve();
    fixture.dispose();
  }
});

it('rolls back only the failed bundle, offers Retry, and makes Snooze and Restore immediately reversible', async () => {
  const fixture = mountBundleActions();
  const { feedback, persist, subjects: [first, second], currentSubjects, select, act } = fixture;
  const pending = deferred();
  persist.mockReturnValueOnce(pending.promise);
  try {
    await flushPromises();
    await act(first, 'Snooze');
    await act(second, 'Snooze');
    expect(currentSubjects()).toEqual([]);
    pending.reject(new Error('SQLite write failed'));
    await flushPromises();
    expect(currentSubjects()).toEqual([first]);

    const retry = feedback.entries.find(({ action }) => action === 'Retry')!;
    expect(retry.message).toContain(first);
    await feedback.run(retry.id);
    expect(currentSubjects()).toEqual([]);
    await select(/^Done & snoozed/);
    expect(currentSubjects()).toEqual(expect.arrayContaining([first, second]));
    expect(Object.values(fixture.currentStates()).map(({ disposition }) => disposition)).toEqual(['snoozed', 'snoozed']);
    const restore = deferred();
    persist.mockReturnValueOnce(restore.promise);
    try {
      await act(second, 'Cancel snooze');
      expect(currentSubjects()).toEqual([first]);
      const undo = feedback.entries.find(({ message }) => message === 'Bundle restored.')!;
      const undoing = feedback.run(undo.id);
      await flushPromises();
      expect(currentSubjects()).toEqual(expect.arrayContaining([first, second]));
      restore.resolve();
      await undoing;
      expect(Object.values(fixture.currentStates()).map(({ disposition }) => disposition)).toEqual(['snoozed', 'snoozed']);
    } finally {
      restore.resolve();
    }
  } finally {
    pending.resolve();
    fixture.dispose();
  }
});

it('coalesces arrivals during a refresh and shows the new mail without switching filters', async () => {
  let finishFirstRefresh!: (result: string[]) => void;
  const firstRefresh = new Promise<string[]>((resolve) => { finishFirstRefresh = resolve; });
  const messages: object[] = [];
  const refreshAttentionRelay = vi.fn()
    .mockReturnValueOnce(firstRefresh)
    .mockImplementationOnce(async () => {
      messages.push({
        uid: 42, subject: 'Please review the new brief', receivedAt: new Date().toISOString(), seen: false,
        from: [{ address: 'sender@example.org' }], to: [{ address: 'owner@example.org' }], flagged: true,
      });
      return [];
    });
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [{
      relay_id: 'work', address: 'owner@example.org', mailbox: 'INBOX', uid_validity: '3', messages: [...messages],
    }], states: {} }),
    folderByRole: async () => undefined,
    refreshAttentionRelay,
  });
  const wrapper = mount(UnifiedAttention, {
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [createPinia()] },
  });

  try {
    await flushPromises();
    const currentFilter = wrapper.get('.attention-inbox__filter[aria-pressed="true"]');
    expect(wrapper.get('[aria-label="Refreshing"]').attributes('disabled')).toBe('');
    const arrival = vi.mocked(onWebPushRefresh).mock.lastCall![0];
    arrival();
    arrival();
    expect(refreshAttentionRelay).toHaveBeenCalledTimes(1);

    finishFirstRefresh([]);
    await flushPromises();
    expect(refreshAttentionRelay).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('Please review the new brief');
    expect(wrapper.get('.attention-inbox__filter[aria-pressed="true"]').element).toBe(currentFilter.element);
    expect(wrapper.get('[aria-label="Refresh"]').attributes('disabled')).toBeUndefined();
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

it('refreshes a JMAP Inbox discovered after Smart Inbox opens', async () => {
  let inbox: FolderRow | undefined;
  let announce!: (tables: string[]) => void;
  const ensureFolderWindow = vi.fn(async () => {});
  __setRepositoryForTests({
    subscribe: (callback: typeof announce) => { announce = callback; return () => {}; },
    getAttentionCache: async () => ({ paired: false, accounts: [], states: {} }),
    folderByRole: async () => inbox,
    listMessagesForView: async () => [],
    ensureFolderWindow,
  });
  const wrapper = mount(UnifiedAttention, {
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [createPinia()] },
  });
  try {
    await flushPromises();
    expect(ensureFolderWindow).not.toHaveBeenCalled();
    inbox = { id: 10, role: 'inbox' } as FolderRow;
    announce([TABLE_FAMILIES.FOLDERS]);
    await flushPromises();
    expect(ensureFolderWindow).toHaveBeenCalledExactlyOnceWith(1, 10, { limit: 100 });
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

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
    const options = wrapper.get('summary[aria-label="Smart Inbox options"]');
    const manage = wrapper.findAll('button').find((button) => button.text() === 'Manage IMAP accounts');
    expect(options.element.closest('details')?.contains(manage!.element)).toBe(true);
    await options.trigger('click');
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

    await wrapper.get('summary[aria-label="Message actions"]').trigger('click');
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
  let announce: (tables: string[]) => void = () => {};
  const mutateAttentionImapMessage = vi.fn(async (_owner, _location, action) => {
    if (action.type === 'star') row.flagged = action.value;
    if (action.type === 'seen') row.seen = action.value;
    if (action.type === 'tags') row.labels = row.labels.filter((label) => !action.tags.removeLabels?.includes(label));
    if (action.type === 'trash') messages = [];
    announce([TABLE_FAMILIES.ATTENTION]);
    return { mutationIds: [1] };
  });
  __setRepositoryForTests({
    subscribe: (callback: typeof announce) => { announce = callback; return () => {}; },
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
    global: { plugins: [pinia] },
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
    ]) }), expect.objectContaining({ html: expect.stringContaining('Formatted newsletter') }), undefined);
    await reader.get('[aria-label="Forward"]').trigger('click');
    expect(prepare.mock.lastCall?.[0]).toBe('forward');

    await reader.get('[data-tag-picker-trigger]').trigger('click');
    await flushPromises();
    const tag = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
      .find((item) => item.textContent?.trim() === 'Read later');
    expect(tag?.getAttribute('aria-checked')).toBe('true');
    tag!.click();
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, {
      type: 'tags', tags: { removeLabels: ['Read later'] },
    }, true);
    expect(header.text()).not.toContain('Read later');
    await back.trigger('click');
    expect(document.activeElement).toBe(open.element);
    await open.trigger('click');
    await flushPromises();

    const reopened = wrapper.get('.message-view');
    const star = reopened.get('[aria-label="Star"]');
    await star.trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, { type: 'star', value: true }, true);
    expect(star.attributes('aria-pressed')).toBe('true');
    await reopened.get('[aria-label="Mark as unread"]').trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, { type: 'seen', value: false }, true);
    expect(reopened.find('[aria-label="Mark as read"]').exists()).toBe(true);
    await reopened.get('[aria-label="Delete"]').trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenLastCalledWith(1, location, { type: 'trash' }, true);
    expect(wrapper.find('.message-view').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    __resetRepositoryForTests();
  }
});

it('batches a conversation action and advances the stacked reader after deleting just one member', async () => {
  const pinia = createPinia();
  const gate = deferred();
  const latest = Date.now();
  const originalId = '<review@example.org>';
  let states: BundleStates = {};
  let messages = [
    {
      uid: 17, subject: 'Please review the project', receivedAt: new Date(latest - 60_000).toISOString(),
      messageId: originalId, seen: true, flagged: false,
      from: [{ name: 'Original sender', address: 'original@example.org' }],
      to: [{ address: 'owner@example.org' }],
    },
    {
      uid: 18, subject: 'Re: Please review the project', receivedAt: new Date(latest).toISOString(),
      messageId: '<followup@example.org>', references: [originalId], seen: true, flagged: true,
      from: [{ name: 'Follow-up sender', address: 'followup@example.org' }],
      to: [{ address: 'owner@example.org' }],
    },
  ];
  const mutateAttentionImapMessages = vi.fn(async (
    _owner: number, edits: { location: ImapMessageLocation; action: ImapAttentionAction }[],
  ) => {
    for (const { action, location } of edits) {
      const message = messages.find(({ uid }) => uid === location.uid);
      if (message && action.type === 'star') message.flagged = action.value;
    }
    return { mutationIds: [1, 2] };
  });
  const mutateAttentionImapMessage = vi.fn(async (_owner, location, action) => {
    await gate.promise;
    if (action.type === 'trash') messages = messages.filter(({ uid }) => uid !== location.uid);
    return { mutationIds: [3] };
  });
  const readAttentionImapMessage = vi.fn(async (_owner, location) =>
    ({ text: `Body of message ${location.uid}`, html: '' }));
  const changeAttentionBundleStates = vi.fn(async (_owner, aliases: string[], replacements: BundleStates) => {
    const previous = matchingBundleStates(states, aliases);
    states = replaceBundleStates(states, aliases, replacements);
    return { applied: true, previous };
  });
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [{
      relay_id: 'work', address: 'owner@example.org', mailbox: 'INBOX', uid_validity: '3', messages,
    }], states }),
    folderByRole: async () => undefined,
    refreshAttentionRelay: async () => [],
    readAttentionImapMessage,
    mutateAttentionImapMessage,
    mutateAttentionImapMessages,
    changeAttentionBundleStates,
  });
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [pinia] },
  });
  const feedback = useMailActionFeedbackStore(pinia);

  try {
    await flushPromises();
    const head = wrapper.get('.attention-inbox__bundle > .msg-list__item');
    await head.get('[aria-label^="Open conversation"]').trigger('click');
    await flushPromises();
    const stack = wrapper.get('[aria-label="Messages in conversation"]');
    const summaries = stack.findAll('.conversation-reader__summary');
    expect(summaries.map((button) => button.attributes('aria-expanded'))).toEqual(['false', 'true']);
    const toolbar = wrapper.get('.conversation-reader__toolbar');
    const chooseAction = async (label: string) => {
      await toolbar.get('summary[aria-label="Conversation actions"]').trigger('click');
      await toolbar.findAll('button').find((button) => button.text() === label)!.trigger('click');
      if (label === 'Snooze') document.querySelector<HTMLButtonElement>('.attention-snooze button[aria-label="1 hour"]')!.click();
      await flushPromises();
    };
    expect(toolbar.text()).toContain('Mark bundle done');
    expect(toolbar.text()).toContain('Snooze');
    await chooseAction('Snooze');
    expect(changeAttentionBundleStates).toHaveBeenCalledOnce();
    expect(Object.values(states)[0]).toMatchObject({ disposition: 'snoozed', observed: expect.any(Array) });
    expect(Object.values(states)[0].observed).toHaveLength(2);
    expect(wrapper.get('[aria-label="Messages in conversation"]').element).toBe(stack.element);
    await chooseAction('Cancel snooze');
    expect(changeAttentionBundleStates).toHaveBeenCalledTimes(2);
    expect(states).toEqual({});
    await chooseAction('Unstar');
    expect(mutateAttentionImapMessages).toHaveBeenCalledOnce();
    expect(mutateAttentionImapMessages.mock.calls[0][1]).toEqual([
      { location: { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 18 }, action: { type: 'star', value: false } },
      { location: { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 17 }, action: { type: 'star', value: false } },
    ]);
    expect(mutateAttentionImapMessage).not.toHaveBeenCalled();

    await summaries[0].trigger('click');
    await flushPromises();
    expect(summaries.map((button) => button.attributes('aria-expanded'))).toEqual(['true', 'true']);
    const originalPanel = stack.get(`[id="${summaries[0].attributes('aria-controls')}"]`);
    expect(originalPanel.text()).toContain('Body of message 17');
    const originalCard = stack.findAll('.conversation-reader__message')[0];
    await originalCard.get('summary[aria-label="Message actions"]').trigger('click');
    await originalCard.findAll('button').find((button) => button.text() === 'Delete')!.trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessage).toHaveBeenCalledExactlyOnceWith(
      1, { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid: 17 }, { type: 'trash' }, true,
    );
    expect(messages.map(({ uid }) => uid)).toEqual([17, 18]);
    expect(stack.findAll('.conversation-reader__summary')).toHaveLength(1);
    expect(stack.get('[aria-expanded="true"]').text()).toContain('Follow-up sender');
    expect(wrapper.find('[aria-label="Message header"]').text()).toContain('Follow-up sender');

    gate.resolve();
    await flushPromises();
    await toolbar.get('[aria-label="Back to Attention"]').trigger('click');
    expect(wrapper.find('[aria-label="Messages in conversation"]').exists()).toBe(false);
  } finally {
    gate.resolve();
    wrapper.unmount();
    feedback.$reset();
    __resetRepositoryForTests();
  }
});

it('keeps native conversation selection within the remaining messages and closes when they all move', async () => {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  const mail = useMailStore(pinia);
  const folder = { id: 10, account_id: 1, role: 'inbox' } as FolderRow;
  const latest = Date.now();
  const rows = [17, 18, 19].map((id) => ({
    id, thread_id: 5, account_id: 1, is_seen: 1, is_flagged: 0, received_at: latest + id,
    subject: 'Please review this change', preview: `Update from sender ${id}`,
    from_text: `Sender ${id} <sender${id}@example.org>`, to_text: 'owner@example.org',
  }));
  const removed = shallowRef(new Set<number>());
  vi.spyOn(mail, 'projectMailRows').mockImplementation((_folder, current) =>
    current.filter((row) => !removed.value.has(row.id)));
  const move = vi.spyOn(mail, 'destroyMessages').mockImplementation(async (ids) => {
    removed.value = new Set([...removed.value, ...ids]);
    if (mail.selectedMessageId != null && ids.includes(mail.selectedMessageId)) mail.selectMessage(null);
    return { succeeded: ids.length, failed: 0, skipped: 0 };
  });
  vi.spyOn(mail, 'destroyMessage').mockImplementation((id, options) => mail.destroyMessages([id], options));
  const stop = watch(() => mail.selectedMessageId, (id) => {
    if (id) mail.messageBody = { text: `Body of native message ${id}` } as typeof mail.messageBody;
  });
  const listMessagesForFolderThreads = vi.fn(async () => [rows[0], rows[2]]);
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: false, accounts: [], states: {} }),
    folderByRole: async () => folder,
    listMessagesForView: async () => rows.slice(1),
    listMessagesForFolderThreads,
    getMessageBodyForDisplay: async (_accountId, id) => ({ text: `Body of native message ${id}`, html: '', attachments: [] }),
    listMessageAddresses: async () => [],
    ensureFolderWindow: async () => {},
  });
  auth.accountId = 1;
  mail.folders = [folder];
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [pinia] },
  });

  try {
    await flushPromises();
    expect(listMessagesForFolderThreads).toHaveBeenCalledWith(1, 10, [5]);
    await wrapper.get('[aria-label^="Open conversation"]').trigger('click');
    await flushPromises();
    expect(mail.selectedMessageId).toBe(19);
    const stack = wrapper.get('[aria-label="Messages in conversation"]');
    expect(stack.findAll('.conversation-reader__summary')).toHaveLength(3);
    await stack.get('summary[aria-label="Message actions"]').trigger('click');
    await stack.findAll('button').find((button) => button.text() === 'Delete')!.trigger('click');
    await flushPromises();
    expect(move.mock.calls[0][0]).toEqual([19]);
    expect(mail.selectedMessageId).toBe(18);
    expect(stack.get('[aria-expanded="true"]').text()).toContain('Sender 18');
    expect(stack.text()).toContain('Body of native message 18');

    const toolbar = wrapper.get('.conversation-reader__toolbar');
    await toolbar.get('summary[aria-label="Conversation actions"]').trigger('click');
    await toolbar.findAll('button').find((button) => button.text() === 'Move to Trash')!.trigger('click');
    await flushPromises();
    expect(move.mock.calls[1][0]).toEqual([18, 17]);
    expect(mail.selectedMessageId).toBeNull();
    expect(wrapper.find('[aria-label="Messages in conversation"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    stop();
    __resetRepositoryForTests();
  }
});

it('trashes only the checked members of a bundle in one optimistic batch with one Undo', async () => {
  const pinia = createPinia();
  const gate = deferred();
  const latest = Date.now();
  const messages = [17, 18, 19].map((uid) => ({
    uid, subject: `Please review message ${uid}`, receivedAt: new Date(latest + uid).toISOString(),
    messageId: `<review-${uid}@example.org>`, references: ['<thread@example.org>'],
    seen: true, flagged: false,
    from: [{ address: 'sender@example.org' }], to: [{ address: 'owner@example.org' }],
  }));
  const mutateAttentionImapMessages = vi.fn(async (
    _owner: number, _edits: { location: ImapMessageLocation; action: ImapAttentionAction }[],
  ) => {
    await gate.promise;
    return { mutationIds: [1, 2] };
  });
  const undoAttentionImapActions = vi.fn(async () => ({ canceledIds: [1, 2] }));
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [{
      relay_id: 'work', address: 'owner@example.org', mailbox: 'INBOX', uid_validity: '3', messages,
    }], states: {} }),
    folderByRole: async () => undefined,
    refreshAttentionRelay: async () => [],
    mutateAttentionImapMessages,
    undoAttentionImapActions,
  });
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [pinia] },
  });
  const feedback = useMailActionFeedbackStore(pinia);

  try {
    await flushPromises();
    await wrapper.get('[aria-label^="Select conversation"]').trigger('click');
    await wrapper.get('.msg-list__stack-toggle').trigger('click');
    await wrapper.get('[aria-label^="Select message: Please review message 18"]').trigger('click');
    expect(wrapper.text()).toContain('2 selected');
    await wrapper.get('[aria-label="Selection actions"]').get('[aria-label="Move to Trash"]').trigger('click');
    await flushPromises();
    expect(mutateAttentionImapMessages).toHaveBeenCalledOnce();
    expect(mutateAttentionImapMessages.mock.calls[0][1]).toEqual([19, 17].map((uid) => ({
      location: { accountId: 'work', mailbox: 'INBOX', uidValidity: '3', uid },
      action: { type: 'trash' },
    })));
    expect(wrapper.findAll('.msg-list__subject').map((node) => node.text())).toEqual(['Please review message 18']);

    const undo = feedback.entries.filter(({ action }) => action === 'Undo');
    expect(undo).toHaveLength(1);
    const undoing = feedback.run(undo[0].id);
    await flushPromises();
    expect(wrapper.find('[aria-label^="Open conversation"]').exists()).toBe(true);
    gate.resolve();
    await undoing;
    expect(undoAttentionImapActions).toHaveBeenCalledExactlyOnceWith(1, [1, 2], true);
  } finally {
    gate.resolve();
    wrapper.unmount();
    feedback.$reset();
    __resetRepositoryForTests();
  }
});

it('opens conversations or individual messages under their rows when Read in place is enabled', async () => {
  const latest = Date.now();
  const thread = '<inline-thread@example.org>';
  const messages = [17, 18, 19].map((uid) => ({
    uid, subject: `Please review message ${uid}`, receivedAt: new Date(latest + uid).toISOString(),
    messageId: `<review-${uid}@example.org>`, references: uid < 19 ? [thread] : [],
    seen: true, flagged: false,
    from: [{ address: `sender${uid}@example.org` }], to: [{ address: 'owner@example.org' }],
  }));
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: async () => ({ paired: true, accounts: [{
      relay_id: 'work', address: 'owner@example.org', mailbox: 'INBOX', uid_validity: '3', messages,
    }], states: {} }),
    folderByRole: async () => undefined,
    refreshAttentionRelay: async () => [],
    readAttentionImapMessage: async (_owner, location) => ({ text: `Body ${location.uid}`, html: '' }),
  });
  const wrapper = mount(UnifiedAttention, {
    attachTo: document.body,
    props: { ownerId: 1, address: 'owner@example.org' },
    global: { plugins: [createPinia()] },
  });

  try {
    await flushPromises();
    const head = wrapper.get('[aria-label^="Open conversation"]');
    const row = wrapper.findAll('.attention-inbox__bundle').find(({ element }) => element.contains(head.element))!;
    const other = wrapper.get('[aria-label^="Open message: Please review message 19"]');
    await head.trigger('click');
    await flushPromises();
    expect(wrapper.find('.unified-attention__reader .conversation-reader').exists()).toBe(true);
    expect(wrapper.find('[data-inline-mail-reader]').exists()).toBe(false);
    await wrapper.get('[aria-label="Back to Attention"]').trigger('click');

    const options = wrapper.get('summary[aria-label="Smart Inbox options"]');
    const toggle = wrapper.get('button[role="checkbox"]');
    expect(toggle.text()).toBe('Read in place');
    expect(toggle.attributes('aria-checked')).toBe('false');
    await options.trigger('click');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-checked')).toBe('true');
    expect(head.attributes('aria-expanded')).toBe('false');

    await head.trigger('click');
    await flushPromises();
    const inline = row.get('[data-inline-mail-reader]');
    expect(head.attributes('aria-controls')).toBe(inline.attributes('id'));
    expect(head.attributes('aria-expanded')).toBe('true');
    expect(inline.find('[aria-label="Messages in conversation"]').exists()).toBe(true);
    expect(inline.find('.conversation-reader__toolbar').exists()).toBe(false);
    expect(row.findAll('summary[aria-label="Conversation actions"]')).toHaveLength(1);
    expect(inline.get('.conversation-reader__message--expanded .message-view__details').isVisible()).toBe(false);
    const headerDetails = inline.get('[aria-label="Show message details"]');
    await headerDetails.trigger('click');
    expect(inline.get('.conversation-reader__message--expanded .message-view__details').isVisible()).toBe(true);
    await headerDetails.trigger('click');
    await inline.get('.message-view').trigger('keydown', { ctrlKey: true, key: 'a' });
    expect(wrapper.find('[aria-label="Selection actions"]').exists()).toBe(false);
    expect(other.isVisible()).toBe(true);
    const messageView = inline.get('.message-view').element;
    await inline.get('summary[aria-label="Message actions"]').trigger('click');
    await inline.findAll('button').find((button) => button.text() === 'Maximize message view')!.trigger('click');
    await flushPromises();
    expect(wrapper.get('.unified-attention__reader .message-view').element).toBe(messageView);
    expect(wrapper.find('[data-inline-mail-reader]').exists()).toBe(false);
    const maximizedReader = wrapper.get('.unified-attention__reader');
    await maximizedReader.get('summary[aria-label="Message actions"]').trigger('click');
    await maximizedReader.findAll('button').find((button) => button.text() === 'Restore message view')!.trigger('click');
    await flushPromises();
    expect(row.get('[data-inline-mail-reader] .message-view').element).toBe(messageView);
    await row.get('[aria-label="Collapse conversation"]').trigger('click');
    expect(row.find('[data-inline-mail-reader]').exists()).toBe(false);
    expect(document.activeElement).toBe(head.element);

    const pill = row.get('.msg-list__stack-toggle');
    await pill.trigger('click');
    const child = row.get('[aria-label^="Open message: Please review message 17"]');
    await child.trigger('click');
    await flushPromises();
    const childReader = row.get('.attention-inbox__messages [data-inline-mail-reader]');
    expect(childReader.find('.message-view').exists()).toBe(true);
    expect(childReader.find('.conversation-reader').exists()).toBe(false);
    expect(child.attributes('aria-controls')).toBe(childReader.attributes('id'));
    await childReader.get('[aria-label="Collapse reader"]').trigger('click');
    expect(document.activeElement).toBe(child.element);

    await child.trigger('click');
    await flushPromises();
    await pill.trigger('click');
    await flushPromises();
    expect(row.find('[data-inline-mail-reader]').exists()).toBe(false);
    expect(wrapper.find('.message-view').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    window.localStorage.removeItem('stormbox.mail.inline-reading');
    __resetRepositoryForTests();
  }
});

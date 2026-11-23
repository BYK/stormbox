// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';

import ImapMessageListRow from '../../../src/components/ImapMessageListRow.vue';
import { imapEntry } from '../../../src/composables/useImapReader';
import type { CachedImapAccount } from '../../../src/db/attention';
import type { RelayMessage } from '../../../src/sync/backends/imap/attention-relay';
import { DEFAULT_MESSAGE_TAGS } from '../../../src/utils/message-tags';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

const message: RelayMessage = {
  uid: 12, subject: 'Work update', receivedAt: '2026-11-23T09:00:00Z',
  messageId: '<work@example.org>', references: [], inReplyTo: null,
  seen: false, flagged: false, from: [], to: [], gmailLabels: true, labels: ['Project'],
};

const account: CachedImapAccount = {
  relay_id: 'work', address: 'work@example.org', name: 'Work',
  mailbox: 'INBOX', uid_validity: '7', messages: [message],
};

const mounted: Array<{ unmount(): void }> = [];
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
});

function mountRow(mailbox: string, hoverActions = false) {
  const wrapper = mount(ImapMessageListRow, {
    attachTo: document.body,
    props: {
      entry: imapEntry(account, mailbox, '7', message),
      definitions: DEFAULT_MESSAGE_TAGS,
      hoverActions,
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

it('uses the inbox hover actions, including the shared picker for Gmail labels', async () => {
  const wrapper = mountRow('INBOX', true);
  const inline = wrapper.get('.msg-list__actions');
  await inline.get('button[aria-label="Star"]').trigger('click');
  await inline.get('button[aria-label="Archive"]').trigger('click');
  await inline.get('button[aria-label="Delete"]').trigger('click');
  const tags = inline.get('button[aria-label="Tags: Project"]');
  await tags.trigger('click');
  await flushPromises();
  const label = document.querySelector<HTMLButtonElement>('button[data-tag-keyword="gmail label:Project"]')!;
  expect(label.getAttribute('aria-checked')).toBe('true');
  label.click();
  expect(wrapper.emitted('action')).toEqual([
    [{ type: 'star', value: true }], [{ type: 'archive' }], [{ type: 'trash' }],
    [{ type: 'tags', tags: { removeLabels: ['Project'] } }],
  ]);
  expect(wrapper.emitted('row-click')).toBeUndefined();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  expect(tags.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(tags.element);
});

it('offers touch and keyboard menu actions and hides Gmail archive outside Inbox', async () => {
  const wrapper = mountRow('Project');
  expect(wrapper.find('.msg-list__actions').exists()).toBe(false);
  const summary = wrapper.get('summary[aria-label="Message actions"]');
  await summary.trigger('click');
  const items = wrapper.findAll<HTMLButtonElement>('button.app-dropdown__item');
  expect(items.map((button) => button.text())).toEqual(['Star', 'Mark as read', 'Tags', 'Move to Trash']);
  await items[1]!.trigger('click');
  expect(wrapper.emitted('action')).toEqual([[{ type: 'seen', value: true }]]);
  await summary.trigger('click');
  await items[2]!.trigger('click');
  await flushPromises();
  expect(document.querySelector('button[data-tag-keyword="gmail label:Project"]')).toBeTruthy();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flushPromises();
  expect(document.activeElement).toBe(summary.element);
});

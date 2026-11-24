// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AttentionInbox from '../../../src/components/AttentionInbox.vue';
import { browserTriageMessageKey } from '../../../src/triage/browser-model';
import type { TriageBundle } from '../../../src/triage/smart-sort';

const receivedAt = new Date(2026, 10, 18, 14, 0).getTime();

function bundle(id: string, status: TriageBundle['status'], subject: string): TriageBundle {
  const leading = {
    message: { id, accountId: 1, receivedAt, subject },
    classification: { disposition: 'action' as const, reason: 'Explicit request', baseScore: 80 },
  };
  return {
    id,
    accountId: 1,
    messages: [leading],
    leading,
    status,
    reason: 'Explicit request',
    priority: 'P0',
    score: 80,
    latestAt: receivedAt,
    aliases: [id],
    resolved: [],
  };
}

afterEach(() => vi.useRealTimers());

describe('AttentionInbox', () => {
  it('preserves the filter bar while grouping active, routine, and handled bundles', async () => {
    const wrapper = mount(AttentionInbox, {
      props: {
        bundles: [
          bundle('req', 'action', 'Approval requested'),
          bundle('maybe', 'uncertain', 'Can you check?'),
          bundle('status', 'update', 'Price update'),
          bundle('accepted', 'done', 'Already approved'),
          bundle('later', 'snoozed', 'Discuss next week'),
        ],
        accountLabels: { 1: 'Work' },
      },
    });

    const filters = wrapper.get('[role="group"][aria-label="Smart Inbox filters"]');
    const [attention, updates, handled] = filters.findAll('button');
    expect(filters.findAll('.attention-inbox__filter-label').map((label) => label.text())).toEqual(['Attention', 'Updates', 'Done']);
    expect(attention.attributes('aria-label')).toBe('Needs attention, 2 bundles');
    expect(handled.attributes('aria-label')).toBe('Done & snoozed, 2 bundles');
    expect(attention.attributes('aria-pressed')).toBe('true');
    expect(wrapper.text()).toContain('Approval requested');
    expect(wrapper.text()).toContain('Can you check?');
    expect(wrapper.text()).toContain('Work');
    expect(wrapper.text()).not.toContain('Price update');

    await updates.trigger('click');
    expect(wrapper.text()).toContain('Price update');
    expect(wrapper.text()).not.toContain('Approval requested');
    await handled.trigger('click');
    expect(wrapper.text()).toContain('Already approved');
    expect(wrapper.text()).toContain('Discuss next week');
    expect(wrapper.get('[aria-label="Smart Inbox filters"]').element).toBe(filters.element);
  });

  it('opens a conversation from its head and just one message from an expanded child', async () => {
    const request = bundle('req', 'action', 'Review these changes');
    const followup = bundle('progress', 'update', 'Progress update').leading;
    request.messages.push(followup);
    const wrapper = mount(AttentionInbox, { attachTo: document.body, props: { bundles: [request] } });

    const head = wrapper.get('[aria-label^="Open conversation"]');
    await head.trigger('click');
    const expand = wrapper.get('.thread-expand__pill');
    const members = wrapper.get('[aria-label="Messages in bundle"]');
    expect(expand.attributes('aria-label')).toBe('Show 2 messages');
    expect(expand.find('.lucide-chevron-down').exists()).toBe(true);
    expect(head.element.closest('.msg-list__item')?.nextElementSibling).toBe(expand.element.parentElement);
    expect(expand.element.parentElement?.nextElementSibling).toBe(members.element);
    expect(expand.attributes('aria-controls')).toBe(members.attributes('id'));
    expect(members.isVisible()).toBe(false);
    await expand.trigger('click');
    expect(expand.attributes('aria-expanded')).toBe('true');
    expect(expand.attributes('aria-label')).toBe('Hide 2 messages');
    expect(expand.find('.lucide-chevron-up').exists()).toBe(true);
    expect(members.isVisible()).toBe(true);
    const child = members.findAll('[aria-label^="Open message"]')[1];
    await child.trigger('click');

    expect(wrapper.emitted('open-bundle')).toEqual([[request, head.element]]);
    expect(wrapper.emitted('open')).toEqual([[followup.message, child.element]]);
    wrapper.unmount();
  });

  it('uses Inbox row markup and dispatches the Attention actions independently of open', async () => {
    const request = bundle('relay-uid', 'action', 'Please review');
    const message = request.leading.message;
    const key = browserTriageMessageKey(message);
    const wrapper = mount(AttentionInbox, {
      props: {
        bundles: [request],
        rows: new Map([[key, {
          id: message.id, from_text: 'Work sender <sender@example.org>',
          subject: message.subject, preview: 'Message preview', received_at: receivedAt,
          is_seen: 0, is_flagged: 1,
        }]]),
      },
    });

    const row = wrapper.get('.attention-inbox__bundle');
    expect(row.classes()).toContain('is-unread');
    expect(row.get('.msg-list__from').text()).toBe('Work sender');
    expect(row.get('.msg-list__subject').text()).toBe('Please review');
    expect(row.get('.msg-list__preview').text()).toContain('Message preview');
    expect(row.get('.msg-list__avatar').classes()).toContain('msg-list__avatar--unread');
    expect(row.get('.msg-list__item').classes()).toContain('msg-list__item--avatar-selection');
    expect(row.find('.msg-list__unread-dot').exists()).toBe(false);
    expect(row.get('.msg-list__open').attributes('aria-label')).toMatch(/, unread$/);

    const trigger = row.get('summary[aria-label="Message actions"]');
    expect(row.findAll('summary')).toHaveLength(1);
    expect(row.findAll('.msg-list__star')).toHaveLength(1);
    expect(row.find('.msg-list__actions').exists()).toBe(false);
    await trigger.trigger('click');
    const star = row.get('button[aria-label="Star"]');
    expect(star.attributes('aria-pressed')).toBe('true');
    await star.trigger('click');
    await trigger.trigger('click');
    await row.findAll('button').find((button) => button.text() === 'Mark as read')?.trigger('click');
    await trigger.trigger('click');
    await row.findAll('button').find((button) => button.text() === 'Move to Trash')?.trigger('click');
    expect(wrapper.emitted('bundle-action')).toEqual([
      [request, { type: 'star', value: false }],
      [request, { type: 'seen', value: true }],
      [request, { type: 'trash' }],
    ]);
    expect(wrapper.emitted('open')).toBeUndefined();
    await wrapper.setProps({ disabledActions: new Set([key]) });
    expect(star.attributes('disabled')).toBe('');
    expect(row.findAll('button').find((button) => button.text() === 'Mark bundle done')?.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('reflects member flags on the head and leaves expanded actions scoped to one message', async () => {
    const request = bundle('req', 'action', 'Please review');
    const followup = bundle('progress', 'update', 'Progress').leading;
    request.messages.push(followup);
    const wrapper = mount(AttentionInbox, {
      props: {
        bundles: [request],
        rows: new Map(request.messages.map(({ message }, index) => [browserTriageMessageKey(message), {
          id: message.id, subject: message.subject, is_seen: 1 - index, is_flagged: index,
        }])),
      },
    });
    const head = wrapper.get('.attention-inbox__bundle > .msg-list__item');
    expect(wrapper.get('.attention-inbox__bundle').classes()).toContain('is-unread');
    expect(head.get('[aria-label="Star"]').attributes('aria-pressed')).toBe('true');
    const markRead = head.findAll('button').find((button) => button.text() === 'Mark as read')!;
    await markRead.trigger('click');
    await wrapper.get('.thread-expand__pill').trigger('click');
    const child = wrapper.get('[aria-label="Messages in bundle"]').findAll('.msg-list__item')[0];
    await child.get('[aria-label="Star"]').trigger('click');

    expect(wrapper.emitted('bundle-action')).toEqual([[request, { type: 'seen', value: true }]]);
    expect(wrapper.emitted('message-action')).toEqual([[request.leading.message, { type: 'star', value: true }]]);
    wrapper.unmount();
  });

  it('selects a whole bundle, keeps a child deselected when collapsed, and scopes bulk actions to the other message', async () => {
    const request = bundle('req', 'action', 'Please review');
    const followup = bundle('progress', 'update', 'Follow-up').leading;
    request.messages.push(followup);
    const wrapper = mount(AttentionInbox, { props: { bundles: [request] } });

    const head = wrapper.get<HTMLInputElement>('input[aria-label^="Select conversation"]');
    await head.trigger('click');
    expect(head.element.checked).toBe(true);
    expect(wrapper.text()).toContain('2 selected');
    expect(wrapper.emitted('open-bundle')).toBeUndefined();

    const expander = wrapper.get('button[aria-controls]');
    await expander.trigger('click');
    const children = wrapper.get('[aria-label="Messages in bundle"]');
    const member = children.findAll<HTMLInputElement>('input[aria-label^="Select message"]')[1];
    await member.trigger('click');
    expect(head.element.checked).toBe(false);
    expect(head.element.indeterminate).toBe(true);
    expect(member.element.checked).toBe(false);
    await expander.trigger('click');
    await expander.trigger('click');
    expect(member.element.checked).toBe(false);
    expect(wrapper.text()).toContain('1 selected');

    const actions = wrapper.get('[aria-label="Selection actions"]');
    await actions.get('[aria-label="Star"]').trigger('click');
    await actions.get('[aria-label="Mark as unread"]').trigger('click');
    await actions.get('[aria-label="Move to Trash"]').trigger('click');
    expect(wrapper.emitted('selection-action')).toEqual([
      [[request.leading.message], { type: 'star', value: true }],
      [[request.leading.message], { type: 'seen', value: false }],
      [[request.leading.message], { type: 'trash' }],
    ]);
    await actions.get('[aria-label="Clear selection"]').trigger('click');
    expect(head.element.indeterminate).toBe(false);
    expect(wrapper.find('[aria-label="Smart Inbox filters"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('preserves the selection anchor when a preceding bundle expands', async () => {
    const first = bundle('first', 'action', 'Earlier conversation');
    first.messages.push(bundle('reply', 'action', 'Earlier reply').leading);
    const anchor = bundle('anchor', 'action', 'Anchor');
    const last = bundle('last', 'action', 'Last');
    const wrapper = mount(AttentionInbox, { props: { bundles: [first, anchor, last] } });

    await wrapper.get('input[aria-label^="Select message: Anchor"]').trigger('click');
    await wrapper.get('button[aria-controls]').trigger('click');
    await wrapper.get('input[aria-label^="Select message: Last"]').trigger('click', { shiftKey: true });
    await wrapper.get('[aria-label="Selection actions"] [aria-label="Move to Trash"]').trigger('click');

    expect(wrapper.emitted('selection-action')).toEqual([[[anchor.leading.message, last.leading.message], { type: 'trash' }]]);
    wrapper.unmount();
  });

  it('reports snooze, restores keyboard focus, and offers restore for handled mail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(receivedAt);
    const request = bundle('req', 'action', 'Please follow up');
    const wrapper = mount(AttentionInbox, {
      attachTo: document.body,
      props: {
        bundles: [request],
        onSnooze: (value, until) => {
          void wrapper.setProps({ bundles: [{ ...value, status: 'snoozed', snoozedUntil: until }] });
        },
      },
    });

    const summary = wrapper.get('summary[aria-label="Message actions"]');
    const dropdown = summary.element.closest('details');
    if (!(dropdown instanceof HTMLDetailsElement)) throw new Error('Missing snooze dropdown');
    dropdown.open = true;
    const firstOption = wrapper.findAll<HTMLButtonElement>('button').find((button) => button.text() === 'Snooze for one hour')!;
    firstOption.element.focus();
    await firstOption.trigger('click');
    await nextTick();

    expect(wrapper.emitted('snooze')).toEqual([[request, receivedAt + 60 * 60 * 1000]]);
    expect(document.activeElement).toBe(wrapper.get('[aria-pressed="true"]').element);

    await wrapper.get('[aria-label="Smart Inbox filters"]').findAll('button')[2].trigger('click');
    expect(wrapper.text()).toContain('Snoozed until');
    await wrapper.get('summary[aria-label="Message actions"]').trigger('click');
    await wrapper.findAll('button').find((button) => button.text() === 'Cancel snooze')?.trigger('click');
    expect(wrapper.emitted('restore')).toEqual([[{ ...request, status: 'snoozed', snoozedUntil: receivedAt + 60 * 60 * 1000 }]]);
    wrapper.unmount();
  });
});

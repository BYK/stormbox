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

  it('opens the outstanding message or a specific member of an expanded bundle', async () => {
    const request = bundle('req', 'action', 'Review these changes');
    const followup = bundle('progress', 'update', 'Progress update').leading;
    request.messages.push(followup);
    const wrapper = mount(AttentionInbox, { attachTo: document.body, props: { bundles: [request] } });

    await wrapper.get('.attention-inbox__bundle > .msg-list__item .msg-list__open').trigger('click');
    const expand = wrapper.get('[aria-expanded="false"]');
    const members = wrapper.get('[aria-label="Messages in bundle"]');
    expect(members.isVisible()).toBe(false);
    await expand.trigger('click');
    expect(expand.attributes('aria-expanded')).toBe('true');
    expect(members.isVisible()).toBe(true);
    await members.findAll('.msg-list__open')[1].trigger('click');

    expect(wrapper.emitted('open')).toEqual([
      [request.leading.message, wrapper.get('.attention-inbox__bundle > .msg-list__item .msg-list__open').element],
      [followup.message, members.findAll('.msg-list__open')[1].element],
    ]);
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
    expect(row.find('.msg-list__avatar').exists()).toBe(true);

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
    expect(wrapper.emitted('message-action')).toEqual([
      [message, { type: 'star', value: false }],
      [message, { type: 'seen', value: true }],
      [message, { type: 'trash' }],
    ]);
    expect(wrapper.emitted('open')).toBeUndefined();
    await wrapper.setProps({ disabledActions: new Set([key]) });
    expect(star.attributes('disabled')).toBe('');
    expect(row.findAll('button').find((button) => button.text() === 'Mark bundle done')?.attributes('disabled')).toBeUndefined();
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

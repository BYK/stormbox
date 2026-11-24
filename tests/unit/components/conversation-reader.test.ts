// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ConversationReader, { type ConversationReaderMessage } from '../../../src/components/ConversationReader.vue';

describe('ConversationReader', () => {
  it('keeps multiple readers open in chronological order and collapses them independently', async () => {
    const earlier = { key: 'imap:"First folder":4', sender: 'Ada', preview: 'Earlier reply', timestamp: 1_700_000_000_000, unread: true };
    const later = { key: 'jmap:9', sender: 'Grace', preview: 'Most recent reply', timestamp: 1_700_080_000_000 };
    const messages: ConversationReaderMessage[] = [later, earlier];
    const wrapper = mount(ConversationReader, {
      attachTo: document.body,
      props: { subject: 'Shared conversation', messages, activeKey: later.key, backLabel: 'Back to inbox' },
      slots: {
        actions: '<button type="button">Archive conversation</button>',
        default: '<article data-test="message-detail">Message reader</article>',
      },
    });

    try {
      await nextTick();
      const list = wrapper.get('[aria-label="Messages in conversation"]');
      const [first, second] = list.findAll('button');
      const reader = wrapper.get('[data-test="message-detail"]').element;
      const firstPanel = document.getElementById(first.attributes('aria-controls'));
      const secondPanel = document.getElementById(second.attributes('aria-controls'));

      expect(wrapper.get('h2').text()).toBe('Shared conversation');
      expect(first.text()).toContain('Ada');
      expect(first.text()).toContain('Earlier reply');
      expect(first.text()).toContain('unread');
      expect(second.text()).toContain('Grace');
      expect(first.attributes('aria-expanded')).toBe('false');
      expect(second.attributes('aria-expanded')).toBe('true');
      expect(secondPanel?.contains(reader)).toBe(true);

      first.element.focus();
      await first.trigger('click');
      expect(first.attributes('aria-expanded')).toBe('true');
      expect(second.attributes('aria-expanded')).toBe('true');
      expect(firstPanel?.querySelector('[data-test="message-detail"]')).toBeTruthy();
      expect(secondPanel?.contains(reader)).toBe(true);
      expect(document.activeElement).toBe(first.element);

      await second.trigger('click');
      expect(secondPanel?.contains(reader)).toBe(false);
      expect(first.attributes('aria-expanded')).toBe('true');
      expect(second.attributes('aria-expanded')).toBe('false');

      await wrapper.get('button[aria-label="Back to inbox"]').trigger('click');
      expect(wrapper.emitted('back')).toEqual([[]]);
      expect(wrapper.get('header').text()).toContain('Archive conversation');
    } finally {
      wrapper.unmount();
    }
  });

  it('prunes removed readers and opens the new initial message in a detached mount', async () => {
    const earlier = { key: 'old', sender: 'Ada', timestamp: 1_700_000_000_000 };
    const later = { key: 'new', sender: 'Grace', timestamp: 1_700_080_000_000 };
    const wrapper = mount(ConversationReader, {
      props: { subject: 'Detached conversation', messages: [earlier, later], activeKey: later.key },
      slots: { default: '<article data-test="message-detail">Message reader</article>' },
    });

    try {
      await nextTick();
      const reader = wrapper.get('[data-test="message-detail"]').element;
      const activeReader = () => wrapper.get('.conversation-reader__message--expanded [data-test="message-detail"]').element;
      expect(wrapper.element.isConnected).toBe(false);
      expect(activeReader()).toBe(reader);

      await wrapper.setProps({ messages: [earlier], activeKey: earlier.key });
      expect(activeReader()).not.toBe(reader);

      await wrapper.setProps({ messages: [] });
      expect(wrapper.find('.conversation-reader__message').exists()).toBe(false);
      expect(wrapper.element.contains(reader)).toBe(false);

      await wrapper.setProps({ messages: [later], activeKey: later.key });
      expect(activeReader()).not.toBe(reader);
    } finally {
      wrapper.unmount();
    }
  });
});

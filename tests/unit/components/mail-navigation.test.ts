// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { defineComponent, h, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import FolderTree from '../../../src/components/FolderTree.vue';
import ImapMail from '../../../src/components/ImapMail.vue';
import MailAccountLabel from '../../../src/components/MailAccountLabel.vue';
import { __resetRepositoryForTests, __setRepositoryForTests } from '../../../src/composables/useRepository';
import type { AttentionCache } from '../../../src/db/attention';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

afterEach(() => {
  __resetRepositoryForTests();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

it('shows a linked Unified Inbox above the account groups with the combined unread badge during startup', async () => {
  window.history.replaceState(null, '', '/?view=unified');
  let finishCache!: (result: AttentionCache) => void;
  const cache = new Promise<AttentionCache>((resolve) => { finishCache = resolve; });
  const selected = vi.fn();
  __setRepositoryForTests({
    subscribe: () => () => {},
    getAttentionCache: () => cache,
    folderByRole: async () => null,
  });

  const Mail = defineComponent(() => {
    const unifiedTarget = ref<HTMLElement>();
    const folderTarget = ref<HTMLElement>();
    const imapMail = ref<InstanceType<typeof ImapMail>>();
    return () => [
      h(FolderTree, {}, {
        'unified-inbox': () => h('div', { ref: unifiedTarget }),
        'primary-account': () => h(MailAccountLabel, { address: 'primary@example.org' }),
        'connected-accounts': () => h('div', { ref: folderTarget }),
      }),
      folderTarget.value && unifiedTarget.value ? h(ImapMail, {
        ref: imapMail,
        ownerId: 1,
        search: '',
        folderTarget: folderTarget.value,
        unifiedTarget: unifiedTarget.value,
        unreadCount: 23,
        onFolderSelected: selected,
      }) : null,
    ];
  });
  const wrapper = mount(Mail, { attachTo: document.body, global: { plugins: [createPinia()] } });
  try {
    await flushPromises();
    const nav = wrapper.get('nav');
    expect(nav.find('[data-tour="unified-inbox"]').get('button').attributes('aria-current')).toBe('page');
    expect(nav.find('[data-tour="unified-inbox"]').get('.folder-node__count').text()).toBe('23');
    expect(nav.text().indexOf('Unified Inbox')).toBeLessThan(nav.text().indexOf('primary@example.org'));
    expect(nav.get('.mail-account-label').element.tagName).toBe('DIV');
    expect(nav.find('button[aria-label="Manage mail accounts"]').exists()).toBe(true);
    expect(selected).toHaveBeenCalledWith(true);
    expect(window.location.search).toBe('?view=unified');

    wrapper.getComponent(ImapMail).vm.clearFolder();
    await flushPromises();
    expect(nav.find('[data-tour="unified-inbox"]').get('button').attributes('aria-current')).toBeUndefined();
    expect(selected).toHaveBeenLastCalledWith(false);
    expect(window.location.search).toBe('');
  } finally {
    finishCache({ paired: false, accounts: [], states: {} });
    wrapper.unmount();
  }
});

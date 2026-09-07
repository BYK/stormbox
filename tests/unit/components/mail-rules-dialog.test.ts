// @vitest-environment happy-dom

import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../../src/services/auth', () => ({
  initOidc: async () => null,
  getOidc: () => null,
}));

import MailRulesDialog from '../../../src/components/MailRulesDialog.vue';
import {
  __resetRepositoryForTests,
  __setRepositoryForTests,
} from '../../../src/composables/useRepository';
import { useAuthStore } from '../../../src/stores/auth-store';
import { useMailStore } from '../../../src/stores/mail-store';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    accountId: 'remote-1',
    state: 'sieve-state-1',
    capabilities: {
      sieveExtensions: ['copy', 'fileinto', 'imap4flags', 'mailboxid'],
      maxSizeScript: 64_000,
      maxNumberRedirects: 4,
    },
    scripts: [],
    managedScript: null,
    editableScript: null,
    foreignActiveScript: null,
    document: { version: 2, rules: [] },
    parseError: null,
    ...overrides,
  };
}

function folder(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    account_id: 1,
    remote_id: `mailbox-${id}`,
    parent_id: null,
    name: `Folder ${id}`,
    role: null,
    sort_order: 0,
    is_deleted: 0,
    is_subscribed: 1,
    total_emails: 0,
    unread_emails: 0,
    rights_json: null,
    may_add_items: 1,
    ...overrides,
  } as any;
}

function mountDialog() {
  return mount(MailRulesDialog, {
    global: { stubs: { teleport: true } },
  });
}

function installRepo({
  foreign = false,
  saveGate = null,
}: { foreign?: boolean; saveGate?: Promise<void> | null } = {}) {
  let serverSnapshot = snapshot(foreign ? {
    scripts: [{ id: 'foreign', name: 'Handwritten filters', isActive: true }],
    foreignActiveScript: { id: 'foreign', name: 'Handwritten filters' },
  } : {});
  let pendingRequest: any = null;
  const repo = {
    getMailRules: vi.fn(async () => structuredClone(serverSnapshot)),
    insertPendingMutation: vi.fn(async (input) => {
      pendingRequest = JSON.parse(input.requestJson);
      return { id: 72 };
    }),
    runMutation: vi.fn(async () => {
      if (saveGate) await saveGate;
      serverSnapshot = snapshot({
        state: 'sieve-state-2',
        document: pendingRequest.document,
        scripts: [{ id: 'managed', name: 'Stormbox Mail Rules', isActive: true }],
        managedScript: { id: 'managed', name: 'Stormbox Mail Rules', isActive: true },
        editableScript: { id: 'managed', name: 'Stormbox Mail Rules', isActive: true },
      });
      return { attempted: 1, succeeded: 1, failed: 0 };
    }),
    getPendingMutationError: vi.fn(),
  };
  __setRepositoryForTests(repo);
  return repo;
}

beforeEach(() => {
  setActivePinia(createPinia());
  __resetRepositoryForTests();
  useAuthStore().accountId = 1;
  useMailStore().folders = [
    folder(1, { name: 'Projects' }),
    folder(2, { name: 'Receipts', parent_id: 1 }),
  ];
});

describe('MailRulesDialog', () => {
  it('creates and saves a visual rule through the durable mutation path', async () => {
    const repo = installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.text()).toContain('No rules yet');
    await wrapper.get('[data-mail-rules-add]').trigger('click');
    expect(wrapper.find('select').exists()).toBe(false);
    await wrapper.get('input[aria-label="Condition value"]').setValue('newsletter');
    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    expect(repo.insertPendingMutation).toHaveBeenCalledTimes(1);
    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued.takeover).toBe(false);
    expect(queued.document.rules).toHaveLength(1);
    expect(queued.document.rules[0]).toMatchObject({
      name: 'New rule',
      conditions: [{ field: 'from', operator: 'contains', value: 'newsletter' }],
      actions: [{ type: 'markRead' }],
    });
    expect(wrapper.text()).toContain('Rules saved, validated, and activated.');
  });

  it('builds nested any/all condition groups', async () => {
    const repo = installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    await wrapper.get('input[aria-label="Condition value"]').setValue('project');
    const addGroup = wrapper.findAll('button').find((button) => button.text().trim() === 'Group');
    expect(addGroup).toBeTruthy();
    await addGroup!.trigger('click');

    await wrapper.get('.condition-group--nested summary[aria-label="Nested condition match mode"]')
      .trigger('click');
    await wrapper.get('.condition-group--nested [data-rule-option="any"]').trigger('click');
    await wrapper.get('.condition-group--nested .condition-group__header input[type="checkbox"]')
      .setValue(true);
    await wrapper.get('.condition-group--nested input[aria-label="Condition value"]')
      .setValue('lead@example.com');
    const addNestedCondition = wrapper.get('.condition-group--nested').findAll('button')
      .find((button) => button.text().trim() === 'Condition');
    await addNestedCondition!.trigger('click');
    const nestedValues = wrapper.get('.condition-group--nested')
      .findAll('input[aria-label="Condition value"]');
    expect(nestedValues).toHaveLength(2);
    await nestedValues[1].setValue('manager@example.com');

    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued.document.rules[0]).toMatchObject({
      match: 'all',
      conditions: [
        { type: 'condition', value: 'project' },
        {
          type: 'group',
          match: 'any',
          negated: true,
          conditions: [
            { type: 'condition', value: 'lead@example.com' },
            { type: 'condition', value: 'manager@example.com' },
          ],
        },
      ],
    });
  });

  it('locks the draft while a server save is in flight', async () => {
    let releaseSave = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    installRepo({ saveGate });
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    const condition = wrapper.get('input[aria-label="Condition value"]');
    await condition.setValue('locked');
    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-mail-rules-save]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('input[aria-label="Condition value"]').attributes('disabled')).toBeDefined();

    releaseSave();
    await flushPromises();
    expect(wrapper.text()).toContain('Rules saved, validated, and activated.');
  });

  it('requires confirmation before replacing a foreign active script', async () => {
    const repo = installRepo({ foreign: true });
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.text()).toContain('Handwritten filters');
    await wrapper.get('[data-mail-rules-add]').trigger('click');
    await wrapper.get('input[aria-label="Condition value"]').setValue('invoice');
    await wrapper.get('[data-mail-rules-save]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Activate Stormbox rules?');
    expect(repo.insertPendingMutation).not.toHaveBeenCalled();

    await wrapper.get('[data-mail-rules-confirm]').trigger('click');
    await flushPromises();
    const queued = JSON.parse(repo.insertPendingMutation.mock.calls[0][0].requestJson);
    expect(queued.takeover).toBe(true);
  });

  it('confirms before discarding an edited draft', async () => {
    installRepo();
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.get('[data-mail-rules-add]').trigger('click');
    await wrapper.get('button[aria-label="Close mail rules"]').trigger('click');
    expect(wrapper.get('[role="alertdialog"]').text()).toContain('Discard unsaved changes?');

    await wrapper.get('[data-mail-rules-confirm]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});

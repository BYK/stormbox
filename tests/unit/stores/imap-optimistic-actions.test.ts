// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Repository } from '../../../src/db/repository';
import { useImapOptimisticActions } from '../../../src/stores/imap-optimistic-actions-store';
import { useMailActionFeedbackStore } from '../../../src/stores/mail-action-feedback-store';
import type { RelayMessage } from '../../../src/sync/backends/imap/attention-relay';

vi.mock('../../../src/services/auth', () => ({ initOidc: async () => null, getOidc: () => null }));

const location = { accountId: 'work', mailbox: 'INBOX', uidValidity: '2', uid: 12 };
const row: RelayMessage = {
  uid: 12, subject: 'Request', receivedAt: '2026-11-23T09:00:00Z',
  seen: false, flagged: false, messageId: '<request@example.org>', references: [], inReplyTo: null,
  from: [], to: [],
};
const entry = { location, row };

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => {
  useMailActionFeedbackStore().$reset();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('hides a message and restores it before the enqueue and Undo RPCs settle', async () => {
  const store = useImapOptimisticActions();
  const feedback = useMailActionFeedbackStore();
  const enqueue = deferred<{ mutationIds: number[] }>();
  const cancel = deferred<void>();
  const undo = vi.fn(() => cancel.promise);
  const repo = {
    mutateAttentionImapMessage: vi.fn(() => enqueue.promise), undoAttentionImapActions: undo,
  } as unknown as Repository;
  const project = (messages: RelayMessage[]) => store.projectFolder(1, 'work', 'INBOX', '2', messages);
  const startedBeforeWrite = store.cacheCheckpoint();
  const removing = store.run(1, repo, [{ entry, action: { type: 'trash' } }], { refresh: vi.fn() });
  expect(project([row])).toEqual([]);
  expect(store.projectFolder(2, 'work', 'INBOX', '2', [row])).toEqual([row]);
  enqueue.resolve({ mutationIds: [24] });
  expect(await removing).toBe(true);
  store.reconcileCache(1, startedBeforeWrite, 'INBOX');
  expect(project([row])).toEqual([]);
  store.reconcileCache(1, store.cacheCheckpoint(), 'INBOX');
  const undoing = feedback.run(feedback.entries[0].id);
  expect(project([])).toEqual([row]);
  await vi.advanceTimersByTimeAsync(0);
  expect(undo).toHaveBeenCalledWith(1, [24]);
  cancel.resolve();
  await undoing;
  store.reconcileCache(1, store.cacheCheckpoint(), 'INBOX');
  expect(project([row])).toEqual([row]);
});

it('keeps later tag edits when undoing an earlier edit in the same row', async () => {
  const store = useImapOptimisticActions();
  const feedback = useMailActionFeedbackStore();
  const repo = {
    mutateAttentionImapMessage: vi.fn()
      .mockResolvedValueOnce({ mutationIds: [1] }).mockResolvedValueOnce({ mutationIds: [2] }),
    undoAttentionImapActions: vi.fn().mockResolvedValue(undefined),
  } as unknown as Repository;
  const refresh = vi.fn();
  const project = (messages: RelayMessage[]) => store.projectFolder(1, 'work', 'INBOX', '2', messages);
  await store.run(1, repo, [{ entry, action: { type: 'tags', tags: { add: ['FollowUp'] } } }], { refresh });
  await store.run(1, repo, [{ entry, action: { type: 'tags', tags: { add: ['FOLLOWUP'], addLabels: ['Later'] } } }], { refresh });
  const newest = { ...row, keywords: ['FollowUp'], labels: ['Later'] };
  store.reconcileCache(1, store.cacheCheckpoint(), 'INBOX');
  const undoing = feedback.run(feedback.entries[0].id);
  expect(project([newest])).toMatchObject([{ keywords: ['FOLLOWUP'], labels: ['Later'] }]);
  await undoing;
});

it('restores the first baseline when consecutive edits on one field are both undone', async () => {
  const store = useImapOptimisticActions();
  const feedback = useMailActionFeedbackStore();
  const undoNewest = deferred<void>();
  const undoOldest = deferred<void>();
  const repo = {
    mutateAttentionImapMessage: vi.fn()
      .mockResolvedValueOnce({ mutationIds: [1] }).mockResolvedValueOnce({ mutationIds: [2] }),
    undoAttentionImapActions: vi.fn().mockReturnValueOnce(undoNewest.promise).mockReturnValueOnce(undoOldest.promise),
  } as unknown as Repository;
  const refresh = vi.fn();
  const project = () => store.projectFolder(1, 'work', 'INBOX', '2', [row]);
  await store.run(1, repo, [{ entry, action: { type: 'star', value: true } }], { refresh });
  await store.run(1, repo, [{ entry: { location, row: project()[0] }, action: { type: 'star', value: false } }], { refresh });
  store.reconcileCache(1, store.cacheCheckpoint(), 'INBOX');
  const [older, newer] = feedback.entries;
  const revertingNewer = feedback.run(newer.id);
  expect(project()).toMatchObject([{ flagged: true }]);
  const revertingOlder = feedback.run(older.id);
  expect(project()).toMatchObject([{ flagged: false }]);
  undoNewest.resolve();
  await revertingNewer;
  undoOldest.resolve();
  await revertingOlder;
  store.reconcileCache(1, store.cacheCheckpoint(), 'INBOX');
  expect(project()).toEqual([row]);
});

it('rolls back a failed enqueue and leaves other edits in place with a Retry action', async () => {
  const store = useImapOptimisticActions();
  const feedback = useMailActionFeedbackStore();
  const rejection = deferred<{ mutationIds: number[] }>();
  const repo = {
    mutateAttentionImapMessage: vi.fn().mockReturnValueOnce(rejection.promise).mockResolvedValue({ mutationIds: [3] }),
  } as unknown as Repository;
  const refresh = vi.fn();
  const first = store.run(1, repo, [{ entry, action: { type: 'star', value: true } }], { refresh });
  const second = store.run(1, repo, [{ entry, action: { type: 'seen', value: true } }], { refresh });
  const project = () => store.projectFolder(1, 'work', 'INBOX', '2', [row]);
  expect(project()).toMatchObject([{ flagged: true, seen: true }]);
  rejection.reject(new Error('The local queue is unavailable.'));
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(project()).toMatchObject([{ flagged: false, seen: true }]);
  const failure = feedback.entries.find(({ action }) => action === 'Retry');
  expect(failure?.message).toContain('Couldn’t star “Request”');
  await feedback.run(failure!.id);
  expect(project()).toMatchObject([{ flagged: true, seen: true }]);
});

it('withdraws a local Retry when a newer action changes the same field', async () => {
  const store = useImapOptimisticActions();
  const feedback = useMailActionFeedbackStore();
  const mutate = vi.fn().mockRejectedValueOnce(new Error('Couldn’t write to the queue.')).mockResolvedValue({ mutationIds: [2] });
  const repo = { mutateAttentionImapMessage: mutate } as unknown as Repository;
  const refresh = vi.fn();
  await store.run(1, repo, [{ entry, action: { type: 'star', value: true } }], { refresh });
  const retry = feedback.entries.find(({ action }) => action === 'Retry');
  await store.run(1, repo, [{ entry, action: { type: 'star', value: false } }], { refresh });
  expect(feedback.entries.find(({ kind }) => kind === 'error')?.action).toBeUndefined();
  await feedback.run(retry!.id);
  expect(mutate).toHaveBeenCalledTimes(2);
});

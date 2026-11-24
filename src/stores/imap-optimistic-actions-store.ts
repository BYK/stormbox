import { defineStore } from 'pinia';
import { shallowRef, watch } from 'vue';
import { MAIL_UNDO_MS } from '../constants/mail-actions';
import type { Repository } from '../db/repository';
import type { ImapAttentionAction, ImapMessageLocation, RelayMessage } from '../sync/backends/imap/attention-relay';
import { describeImapAction, imapActionFields, isImapMove, projectImapAction, revertImapProjection } from '../sync/backends/imap/project-action';
import { useAuthStore } from './auth-store';
import { useMailActionFeedbackStore } from './mail-action-feedback-store';

interface ImapEdit {
  entry: { location: ImapMessageLocation; row: RelayMessage };
  action: ImapAttentionAction;
}

interface Projection {
  id: number;
  ownerId: number;
  edits: readonly ImapEdit[];
  undo: boolean;
  revision: number | null;
  reconciled: ReadonlySet<number>;
  expiresAt: number;
}

interface EditOptions {
  undo?: boolean;
  refresh: () => void | Promise<void>;
}

interface LocalFailure {
  item: Projection;
  message: string;
  toast: number;
  superseded: boolean;
}

function editsOverlap(left: ImapEdit, right: ImapEdit): boolean {
  const a = left.entry.location;
  const b = right.entry.location;
  if (a.accountId !== b.accountId) return false;
  const sameUid = a.mailbox === b.mailbox && a.uid === b.uid && a.uidValidity === b.uidValidity;
  const gmailAlias = a.mailbox !== b.mailbox && left.entry.row.gmailLabels === true && right.entry.row.gmailLabels === true
    && left.entry.row.messageId && left.entry.row.messageId === right.entry.row.messageId;
  if (!sameUid && !gmailAlias) return false;
  if (isImapMove(left.action) || isImapMove(right.action)) return true;
  const fields = new Set(imapActionFields(left.action));
  return imapActionFields(right.action).some((field) => fields.has(field));
}

function projectsOver(earlier: Projection, later: Projection): boolean {
  return !later.undo && earlier.ownerId === later.ownerId && earlier.id < later.id
    && earlier.edits.some((before) => later.edits.some((after) => editsOverlap(before, after)));
}

export const useImapOptimisticActions = defineStore('imap-optimistic-actions', () => {
  const auth = useAuthStore();
  const feedback = useMailActionFeedbackStore();
  const projections = shallowRef<Projection[]>([]);
  const writes = new Map<number, Promise<void>>();
  const localFailures = new Map<number, LocalFailure>();
  let nextId = 0;
  let revision = 0;
  let session = 0;

  watch(() => auth.accountId, (_, previous) => {
    if (previous == null) return;
    session += 1;
    projections.value = [];
    localFailures.clear();
  }, { flush: 'sync' });

  function prune() {
    const hasUndoInProgress = projections.value.some((item) => item.undo && item.edits.length > item.reconciled.size);
    if (!hasUndoInProgress) projections.value = projections.value.filter((item) =>
      Date.now() < item.expiresAt || item.edits.length > item.reconciled.size);
  }

  function store(projection: Projection) {
    projections.value = [...projections.value.filter(({ id }) => id !== projection.id), projection]
      .sort((left, right) => left.id - right.id);
  }

  function persist<T>(ownerId: number, write: () => Promise<T>): Promise<T> {
    const result = Promise.resolve(writes.get(ownerId)).then(write);
    const tail = result.then(() => undefined, () => undefined);
    writes.set(ownerId, tail);
    void tail.then(() => { if (writes.get(ownerId) === tail) writes.delete(ownerId); });
    return result;
  }

  function cacheCheckpoint() {
    return revision;
  }

  function reconcileCache(ownerId: number, checkpoint: number, mailbox: string, accountId?: string) {
    const next = projections.value.map((item) => {
      if (item.ownerId !== ownerId || item.revision == null || item.revision > checkpoint) return item;
      const reconciled = new Set(item.reconciled);
      item.edits.forEach(({ entry: { location } }, index) => {
        if (location.mailbox === mailbox && (accountId === undefined || location.accountId === accountId)) reconciled.add(index);
      });
      return reconciled.size === item.reconciled.size ? item : { ...item, reconciled };
    });
    if (next.some((value, index) => value !== projections.value[index])) projections.value = next;
    prune();
  }

  function projectFolder(ownerId: number, accountId: string, mailbox: string, uidValidity: string,
    messages: RelayMessage[]): RelayMessage[] {
    let projected: Map<number, RelayMessage> | undefined;
    let added = false;
    const undone = new Map<number, Set<string>>();
    for (const item of projections.value) {
      if (item.ownerId !== ownerId) continue;
      for (const [index, { entry: { location, row }, action }] of item.edits.entries()) {
        const { uid } = location;
        if (location.accountId !== accountId || location.mailbox !== mailbox || location.uidValidity !== uidValidity) continue;
        if (item.reconciled.has(index) && (item.undo || !undone.has(uid))) continue;
        projected ??= new Map(messages.map((message) => [message.uid, message]));
        const current = projected.get(uid);
        let next: RelayMessage | null | undefined;
        if (item.undo) {
          const fields = undone.get(uid) ?? new Set<string>();
          next = revertImapProjection(current, row, action, fields);
          for (const field of imapActionFields(action)) fields.add(field);
          undone.set(uid, fields);
        } else next = current && projectImapAction(current, action);
        if (next) {
          added ||= !current;
          projected.set(uid, next);
        } else projected.delete(uid);
      }
    }
    if (!projected) return messages;
    const result = [...projected.values()];
    return added ? result.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.uid - a.uid) : result;
  }

  function supersedeLocalRetries(later: Projection) {
    const visible = new Set(feedback.entries.map(({ id }) => id));
    for (const [id, failure] of localFailures) {
      if (!visible.has(failure.toast)) localFailures.delete(id);
      else if (projectsOver(failure.item, later)) {
        failure.superseded = true;
        localFailures.delete(id);
        feedback.dismiss(failure.toast);
        feedback.showFailure(failure.message);
      }
    }
  }

  async function run(ownerId: number, repo: Repository, edits: readonly ImapEdit[],
    { undo: undoable = true, refresh }: EditOptions): Promise<boolean> {
    if (!edits.length) return false;
    const generation = session;
    const expiresAt = undoable ? Date.now() + MAIL_UNDO_MS : 0;
    const item: Projection = { id: ++nextId, ownerId, edits, undo: false, revision: null, reconciled: new Set(), expiresAt };
    supersedeLocalRetries(item);
    store(item);
    const subject = edits.length === 1 ? `“${edits[0].entry.row.subject || '(no subject)'}”` : `${edits.length} messages`;
    const { attempt, success } = describeImapAction(edits[0].action, subject);
    let undoStarted = false;
    let enqueueFailed = false;
    const refreshLocal = () => { void Promise.resolve().then(refresh).catch(() => {}); };
    const requests = edits.map(({ entry, action }) => ({ location: entry.location, action }));
    const enqueue = persist(ownerId, () => {
      if (session !== generation) throw new Error('The mail session changed.');
      if (requests.length === 1) {
        const { location, action } = requests[0];
        return undoable ? repo.mutateAttentionImapMessage(ownerId, location, action, true)
          : repo.mutateAttentionImapMessage(ownerId, location, action);
      }
      return undoable ? repo.mutateAttentionImapMessages(ownerId, requests, true) : repo.mutateAttentionImapMessages(ownerId, requests);
    });

    const toast = undoable ? feedback.showUndo(success, async () => {
      if (session !== generation) return;
      undoStarted = true;
      store({ ...item, undo: true });
      try {
        await persist(ownerId, async () => {
          const { mutationIds } = await enqueue;
          if (session === generation) await repo.undoAttentionImapActions(ownerId, mutationIds);
        });
        if (session === generation) store({ ...item, undo: true, revision: ++revision });
      } catch (cause) {
        if (!enqueueFailed && session === generation) {
          projections.value = projections.value.filter(({ id }) => id !== item.id);
          throw cause;
        }
      } finally {
        if (session === generation) refreshLocal();
      }
    }, expiresAt) : undefined;

    if (undoable) setTimeout(prune, MAIL_UNDO_MS);
    try {
      await enqueue;
      if (session === generation && !undoStarted) store({ ...item, revision: ++revision });
      return true;
    } catch (cause) {
      enqueueFailed = true;
      if (session === generation) {
        projections.value = projections.value.filter(({ id }) => id !== item.id);
        if (toast !== undefined) feedback.dismiss(toast);
        const detail = cause instanceof Error ? ` ${cause.message}` : '';
        const message = `Couldn’t ${attempt}.${detail}`;
        if (projections.value.some((later) => projectsOver(item, later))) feedback.showFailure(message);
        else {
          const failure: LocalFailure = { item, message, toast: 0, superseded: false };
          failure.toast = feedback.showFailure(message, async () => {
            localFailures.delete(item.id);
            if (!failure.superseded && session === generation) await run(ownerId, repo, edits, { undo: undoable, refresh });
          });
          localFailures.set(item.id, failure);
        }
      }
      return false;
    } finally {
      if (session === generation) refreshLocal();
    }
  }

  return { cacheCheckpoint, reconcileCache, projectFolder, run };
});

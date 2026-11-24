import { computed, shallowReactive } from 'vue';
import type { MutationType } from '../constants/states';
import type { Repository } from '../db/repository';
import { mailActionPatch, type MailActionPatch, type MailActionRow } from '../types/mail-action';
import { MAIL_UNDO_MS, useMailActionFeedbackStore } from './mail-action-feedback-store';

type DisplayRow = { id: number; keywords_json?: string | null; is_seen?: number | null; is_flagged?: number | null; is_junk?: number | null };
type OutboxInput = {
  accountId: number;
  mutationType: MutationType;
  targetMessageId: number | null;
  requestJson: string;
};

const FAILURE_LOOKBACK = 10 * 60_000;
const keywordColumns = { $seen: 'is_seen', $flagged: 'is_flagged', $junk: 'is_junk' } as const;

export function useJmapMailActions({ repository, account, publish, reload, showNotice }: {
  repository: () => Repository | null;
  account: () => number | null;
  publish: () => void;
  reload: () => Promise<unknown>;
  showNotice: (message: string) => void;
}) {
  const feedback = useMailActionFeedbackStore();
  const rows = shallowReactive(new Map<number, MailActionPatch>());
  const preparing = shallowReactive(new Map<number, MailActionPatch>());
  const canceling = shallowReactive(new Set<number>());
  const undoToasts = new Map<number, number>();
  const displayedErrors = new Set<number>();
  const mutationIntents = new Map<number, number>();
  const lastIntentByMessage = new Map<number, number>();
  let temporaryId = 0;
  let generation = 0;
  let request = 0;
  let revision = 0;

  const byMessage = computed(() => {
    const edits = new Map<number, MailActionPatch[]>();
    const actions = [...rows.entries()].sort(([a], [b]) => a - b)
      .filter(([id]) => !canceling.has(id)).map(([, action]) => action);
    actions.push(...preparing.values());
    for (const action of actions) {
      for (const id of action.messageIds) {
        const previous = edits.get(id);
        if (previous) previous.push(action);
        else edits.set(id, [action]);
      }
    }
    return edits;
  });
  const cancelingMessages = computed(() => new Set([...canceling].flatMap((id) => rows.get(id)?.messageIds ?? [])));

  function belongsToFolder(folderId: number, edits: readonly MailActionPatch[], original: boolean, tagKeyword?: string | null) {
    let included = original;
    for (const edit of edits) {
      if (edit.removeFrom === 'all' || edit.removeFrom === 'other'
        || (edit.removeFrom === 'source' && edit.sourceFolderId === folderId)
        || (tagKeyword && edit.excludeFromTags)) included = false;
      if (!tagKeyword && edit.destinationFolderId === folderId) included = true;
    }
    return included;
  }

  function incomingMessageIds(folderId: number) {
    const ids: number[] = [];
    for (const [messageId, edits] of byMessage.value) {
      if (belongsToFolder(folderId, edits, false)) ids.push(messageId);
    }
    return ids;
  }

  function tracksMessage(id: number) {
    return byMessage.value.has(id) || cancelingMessages.value.has(id);
  }

  function project<T extends DisplayRow | undefined>(folderId: number, input: readonly T[], tagKeyword?: string | null): T[] {
    if (!byMessage.value.size) return input.slice();
    const output: T[] = [];
    for (const row of input) {
      if (!row) { output.push(row); continue; }
      const edits = byMessage.value.get(row.id);
      if (!edits) { output.push(row); continue; }
      if (!belongsToFolder(folderId, edits, true, tagKeyword)) continue;
      const keywordEdits = edits.filter((edit) => edit.add?.length || edit.remove?.length);
      if (!keywordEdits.length) { output.push(row); continue; }
      let keywords: Record<string, boolean>;
      try { keywords = { ...JSON.parse(row.keywords_json ?? '{}') }; } catch { keywords = {}; }
      const next = { ...row };
      const flag = (keyword: string, value: 0 | 1) => {
        const column = keywordColumns[keyword as keyof typeof keywordColumns];
        if (column) next[column] = value;
      };
      for (const edit of keywordEdits) {
        for (const key of edit.remove ?? []) {
          for (const spelling of Object.keys(keywords)) {
            if (spelling.toLowerCase() === key.toLowerCase()) delete keywords[spelling];
          }
          flag(key.toLowerCase(), 0);
        }
        for (const key of edit.add ?? []) {
          keywords[key] = true;
          flag(key, 1);
        }
      }
      if (tagKeyword && !(tagKeyword === '$flagged' ? next.is_flagged === 1 : keywords[tagKeyword] === true)) continue;
      next.keywords_json = JSON.stringify(keywords);
      output.push(next as T);
    }
    return output;
  }

  function reset() {
    generation += 1;
    rows.clear();
    preparing.clear();
    canceling.clear();
    displayedErrors.clear();
    mutationIntents.clear();
    lastIntentByMessage.clear();
    for (const toast of undoToasts.values()) feedback.dismiss(toast);
    undoToasts.clear();
  }

  function enabled() {
    const repo = repository();
    return typeof repo?.listMailActions === 'function' && typeof repo.cancelMailAction === 'function';
  }

  function reportFailure(row: MailActionRow, patch: MailActionPatch, ownerId: number) {
    if (displayedErrors.has(row.id)) return;
    displayedErrors.add(row.id);
    let detail: { type?: string; description?: string; result?: { succeededIds?: number[] } } = {};
    try { detail = JSON.parse(row.error_json ?? '{}'); } catch { /* Unknown cause. */ }
    const successful = new Set((detail.result?.succeededIds ?? []).map(Number));
    const failed = patch.messageIds.filter((id) => !successful.has(id));
    const object = failed.length === 1 ? (patch.subject ? `“${patch.subject}”` : 'a message') : `${failed.length} messages`;
    const canRetry = !['copyPartialSuccess', 'outcomeUnknown', 'copyOutcomeUnknown', 'scheduleAlreadySent', 'scheduleStateUnknown'].includes(detail.type ?? '');
    const intent = mutationIntents.get(row.id);
    const retryable = () => failed.filter((id) => intent != null && lastIntentByMessage.get(id) === intent);
    const retry = canRetry && retryable().length > 0 ? async () => {
      if (account() !== ownerId) return;
      const ids = retryable();
      if (ids.length === 0) {
        feedback.showFailure('A more recent change replaced this action.');
        return;
      }
      const args = JSON.parse(row.request_json);
      await stage({ accountId: ownerId, mutationType: row.mutation_type as MutationType,
        targetMessageId: ids.length === 1 ? ids[0] : null,
        requestJson: JSON.stringify({ ...args, messageIds: ids }),
      }, { ...patch, messageIds: ids }, patch.undoable !== false);
    } : undefined;
    const scheduleError = detail.type === 'scheduleAlreadySent' || detail.type === 'scheduleStateUnknown';
    feedback.showFailure((scheduleError && detail.description) || `Couldn’t ${patch.failureAction} ${object}.`, retry);
  }

  async function cancelPending(repo: Repository, ownerId: number, id: number, current: () => boolean) {
    if (!current()) return;
    canceling.add(id);
    publish();
    try {
      const result = await repo.cancelMailAction(ownerId, id);
      if (!current()) return;
      if (result.canceled) rows.delete(id);
      else feedback.showFailure('This change already started syncing.');
    } catch {
      if (current()) feedback.showFailure('Couldn’t undo this change.', () => cancelPending(repo, ownerId, id, current));
    } finally {
      if (current()) {
        canceling.delete(id);
        undoToasts.delete(id);
        revision += 1;
        publish();
        void sync();
      }
    }
  }

  async function sync() {
    const repo = repository();
    const ownerId = account();
    if (!enabled() || !repo || ownerId == null) return;
    const gen = generation;
    const seq = ++request;
    const version = revision;
    try {
      const current = await repo.listMailActions(ownerId, Date.now() - FAILURE_LOOKBACK);
      if (generation !== gen || request !== seq || version !== revision) return;
      const pending = new Map<number, MailActionPatch>();
      const failed = new Set<number>();
      for (const item of current) {
        const patch = mailActionPatch(item.optimistic_patch_json);
        if (!patch) continue;
        if (item.local_status === 'conflicted') {
          failed.add(item.id);
          reportFailure(item, patch, ownerId);
        }
        else {
          pending.set(item.id, patch);
          const deadline = Number(item.not_before);
          if (!preparing.size && item.local_status === 'pending' && deadline > Date.now() && !undoToasts.has(item.id)) {
            const hasSameAccount = () => generation === gen && account() === ownerId && repository() === repo;
            undoToasts.set(item.id, feedback.showUndo(patch.label,
              () => cancelPending(repo, ownerId, item.id, hasSameAccount), deadline));
          }
        }
      }
      if ([...rows.keys()].some((id) => !pending.has(id) && !canceling.has(id))) await reload();
      if (generation !== gen || request !== seq || version !== revision) return;
      for (const [id, patch] of rows) {
        if (pending.has(id)) continue;
        rows.delete(id);
        if (patch.successNotice && !failed.has(id) && !canceling.has(id)) showNotice(patch.successNotice);
        const toast = undoToasts.get(id);
        if (toast != null) feedback.dismiss(toast);
        undoToasts.delete(id);
      }
      for (const [id, patch] of pending) rows.set(id, patch);
      publish();
    } catch (err) {
      console.warn('[mail-store] could not read staged mail actions', err);
    }
  }

  async function stage(input: OutboxInput, patch: MailActionPatch, undoable = true): Promise<boolean> {
    const repo = repository();
    const ownerId = account();
    if (!repo || ownerId == null) return false;
    const gen = generation;
    const localId = ++temporaryId;
    if (!undoable) patch = { ...patch, undoable: false };
    const deadline = Date.now() + MAIL_UNDO_MS;
    const current = () => generation === gen && repository() === repo && account() === ownerId;
    preparing.set(localId, patch);
    for (const id of patch.messageIds) lastIntentByMessage.set(id, localId);
    publish();
    const write = repo.insertPendingMutation({
      ...input, optimisticPatchJson: JSON.stringify(patch), notBefore: undoable ? deadline : null,
    });
    let toast: number | undefined;
    let undoRequested = false;
    const undo = async () => {
      if (!current()) return;
      undoRequested = true;
      // An Undo can arrive before the insert returns from the worker.
      preparing.delete(localId);
      publish();
      const committed = await write.catch(() => null);
      if (!committed || !current()) return;
      await cancelPending(repo, input.accountId, committed.id, current);
    };
    if (undoable) toast = feedback.showUndo(patch.label, undo, deadline);
    try {
      const { id } = await write;
      if (!current()) return true;
      revision += 1;
      preparing.delete(localId);
      rows.set(id, patch);
      mutationIntents.set(id, localId);
      if (undoRequested) canceling.add(id);
      if (toast != null) undoToasts.set(id, toast);
      publish();
      void sync();
      return true;
    } catch {
      if (!current()) return false;
      if (toast != null) feedback.dismiss(toast);
      preparing.delete(localId);
      publish();
      if (!undoRequested) {
        const object = patch.messageIds.length === 1 ? (patch.subject ? `“${patch.subject}”` : 'a message') : `${patch.messageIds.length} messages`;
        feedback.showFailure(`Couldn’t ${patch.failureAction} ${object}.`, async () => {
          if (!current()) return;
          const ids = patch.messageIds.filter((id) => lastIntentByMessage.get(id) === localId);
          if (ids.length === 0) {
            feedback.showFailure('A more recent change replaced this action.');
            return;
          }
          const args = JSON.parse(input.requestJson);
          await stage({ ...input, targetMessageId: ids.length === 1 ? ids[0] : null,
            requestJson: JSON.stringify({ ...args, messageIds: ids }),
          }, { ...patch, messageIds: ids }, undoable);
        });
      }
      return false;
    }
  }

  return { enabled, reset, sync, stage, project, incomingMessageIds, tracksMessage };
}

import { defineStore } from 'pinia';
import { shallowRef, watch } from 'vue';
import { MAIL_UNDO_MS } from '../constants/mail-actions';
import { useAuthStore } from './auth-store';

export { MAIL_UNDO_MS };

type Callback = () => void | Promise<void>;
export type MailUndoResult = { canceled: number; failed: number };
type UndoChange = () => Promise<MailUndoResult>;

export interface MailUndoGroup {
  expiresAt: number;
  isCanceled: () => boolean;
  register: (change: UndoChange) => () => void;
}

interface MailActionFeedback {
  id: number;
  kind: 'success' | 'error';
  message: string;
  action?: 'Undo' | 'Retry';
  expiresAt?: number;
  run?: Callback;
}

export const useMailActionFeedbackStore = defineStore('mail-action-feedback', () => {
  const auth = useAuthStore();
  const entries = shallowRef<readonly MailActionFeedback[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;
  let generation = 0;

  function dismiss(id: number) {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    entries.value = entries.value.filter((entry) => entry.id !== id);
  }

  function add(entry: Omit<MailActionFeedback, 'id'>) {
    const id = ++nextId;
    entries.value = [...entries.value, { ...entry, id }];
    if (entry.expiresAt !== undefined) {
      timers.set(id, setTimeout(() => dismiss(id), Math.max(0, entry.expiresAt - Date.now())));
    }
    return id;
  }

  function showUndo(message: string, undo: Callback, expiresAt = Date.now() + MAIL_UNDO_MS) {
    return add({ kind: 'success', message, action: 'Undo', run: undo, expiresAt });
  }

  function showFailure(message: string, retry?: Callback) {
    return add({ kind: 'error', message, action: retry ? 'Retry' : undefined, run: retry });
  }

  function createUndoGroup(message: string, isCurrent: () => boolean): MailUndoGroup & { finish: () => void } {
    const createdIn = generation;
    const expiresAt = Date.now() + MAIL_UNDO_MS;
    const changes = new Set<UndoChange>();
    let canceled = false;
    let finished = false;
    const active = () => generation === createdIn && isCurrent();

    async function undo() {
      if (!active()) return;
      canceled = true;
      const results = await Promise.allSettled([...changes].map(async (change) => change()));
      if (!active()) return;
      let count = 0;
      let failed = 0;
      for (const result of results) {
        if (result.status === 'rejected') failed += 1;
        else {
          count += result.value.canceled;
          failed += result.value.failed;
        }
      }
      if (failed) showFailure(count ? 'Couldn’t undo every message in this action.' : 'Couldn’t undo this conversation action.');
    }

    const toast = showUndo(message, undo, expiresAt);
    const dismissIfEmpty = () => {
      if (finished && changes.size === 0) dismiss(toast);
    };
    return {
      expiresAt,
      isCanceled: () => canceled || !active(),
      register(change) {
        changes.add(change);
        return () => {
          changes.delete(change);
          dismissIfEmpty();
        };
      },
      finish() {
        finished = true;
        dismissIfEmpty();
      },
    };
  }

  async function run(id: number) {
    const entry = entries.value.find((item) => item.id === id);
    if (!entry?.run) return;
    dismiss(id);
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) return;
    const current = generation;
    try {
      await entry.run();
    } catch {
      if (current !== generation) return;
      if (entry.action === 'Undo') showFailure('Couldn’t undo the mail action.');
      else showFailure(entry.message, entry.run);
    }
  }

  function latestUndo(): number | undefined {
    const now = Date.now();
    return [...entries.value].reverse().find((entry) => entry.action === 'Undo' && (entry.expiresAt ?? 0) > now)?.id;
  }

  function $reset() {
    generation += 1;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    entries.value = [];
  }

  watch(() => auth.accountId, (_, previous) => {
    if (previous != null) $reset();
  }, { flush: 'sync' });

  return { entries, dismiss, latestUndo, showUndo, showFailure, createUndoGroup, run, $reset };
});

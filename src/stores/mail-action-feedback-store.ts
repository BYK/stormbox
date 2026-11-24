import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import { MAIL_UNDO_MS } from '../constants/mail-actions';

export { MAIL_UNDO_MS };

type Callback = () => void | Promise<void>;

interface MailActionFeedback {
  id: number;
  kind: 'success' | 'error';
  message: string;
  action?: 'Undo' | 'Retry';
  expiresAt?: number;
  run?: Callback;
}

export const useMailActionFeedbackStore = defineStore('mail-action-feedback', () => {
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

  return { entries, dismiss, latestUndo, showUndo, showFailure, run, $reset };
});

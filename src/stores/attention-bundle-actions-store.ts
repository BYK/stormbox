import { defineStore } from 'pinia';
import { computed, shallowRef } from 'vue';
import type { Repository } from '../db/repository';
import { offlineSessionRevision } from '../pwa/cached-account';
import { publishWebPushAttentionState } from '../push/client';
import { matchingBundleStates, replaceBundleStates, type BundleStates } from '../triage/bundle-state-edits';
import { markBundleDone, snoozeBundle, type BundleState, type TriageBundle } from '../triage/smart-sort';
import { useAuthStore } from './auth-store';
import { useMailActionFeedbackStore } from './mail-action-feedback-store';

type Action = 'done' | 'restore' | { snoozeUntil: number };
type BundleChange = { aliases: readonly string[]; replacements: BundleStates; expected?: BundleStates };

function actionMessages(bundle: TriageBundle, action: Action) {
  const subject = bundle.leading.message.subject?.trim();
  const name = subject ? `“${subject}”` : 'this bundle';
  if (action === 'done') return { done: 'Bundle marked done.', failure: `Could not mark ${name} done.` };
  if (action === 'restore') return { done: 'Bundle restored.', failure: `Could not restore ${name}.` };
  return { done: 'Bundle snoozed.', failure: `Could not snooze ${name}.` };
}

export const useAttentionBundleActionsStore = defineStore('attention-bundle-actions', () => {
  const auth = useAuthStore();
  const feedback = useMailActionFeedbackStore();
  const owners = new Map<number, ReturnType<typeof createOwner>>();
  let lastStamp = 0;

  function nextStamp() {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
  }

  function createOwner(ownerId: number) {
    const base = shallowRef<BundleStates>({});
    const pending = shallowRef<BundleChange[]>([]);
    const latest = new Map<string, symbol>();
    let version = 0;
    let tail: Promise<unknown> = Promise.resolve();

    const states = computed(() => pending.value.reduce((current, { aliases, replacements }) =>
      replaceBundleStates(current, aliases, replacements), base.value));

    function observe(observedVersion: number, current: BundleStates) {
      if (observedVersion === version) base.value = current;
    }

    function enqueue(repo: Repository, projection: BundleChange, prepare: () => BundleChange | Promise<BundleChange | null> = () => projection) {
      pending.value = [...pending.value, projection];
      const result = tail.then(async () => {
        const change = await prepare();
        if (!change) return null;
        const { aliases, replacements, expected } = change;
        const outcome = await repo.changeAttentionBundleStates(ownerId, aliases, replacements, expected);
        version += 1;
        base.value = replaceBundleStates(base.value, aliases, outcome.applied ? replacements : outcome.previous);
        return { ...outcome, replacements };
      }).finally(() => { pending.value = pending.value.filter((change) => change !== projection); });
      tail = result.catch(() => {});
      return result;
    }

    function publish(bundle: TriageBundle, previous: BundleStates, replacements: BundleStates, sameSession: () => boolean) {
      if (!String(bundle.accountId).startsWith('imap:')) return;
      const removed = Object.keys(previous).filter((id) => !Object.hasOwn(replacements, id));
      const entries = Object.entries(replacements).sort(([, a], [, b]) => a.changedAt - b.changedAt);
      const send = (id: string, state: BundleState | null, replacedIds: string[]) => {
        const changedAt = nextStamp();
        void Promise.resolve().then(() => {
          if (sameSession()) return publishWebPushAttentionState(id, state, replacedIds, changedAt);
        }).catch(() => {
          if (sameSession()) feedback.showFailure('Could not update Smart Inbox notifications.');
        });
      };
      if (entries.length === 0) {
        send(bundle.id, null, removed);
        return;
      }
      entries.forEach(([id, state], index) => send(id, state, index ? [] : removed));
    }

    function save(repo: Repository, bundle: TriageBundle, action: Action) {
      const aliases = [...new Set([bundle.id, ...bundle.aliases])];
      const previous = matchingBundleStates(states.value, aliases);
      const touched = new Set([...aliases, ...Object.keys(previous), ...Object.values(previous).flatMap((state) => state.aliases)]);
      const token = Symbol();
      for (const id of touched) latest.set(id, token);
      const account = auth.accountId;
      const session = offlineSessionRevision();
      const sameSession = () => auth.accountId === account && offlineSessionRevision() === session;
      const isLatest = () => [...touched].every((id) => latest.get(id) === token);
      const now = nextStamp();
      const next = action === 'done' ? markBundleDone(bundle, now)
        : action === 'restore' ? null : snoozeBundle(bundle, action.snoozeUntil, now);
      const replacements: BundleStates = next ? { [bundle.id]: next } : {};
      const change = enqueue(repo, { aliases, replacements });
      const messages = actionMessages(bundle, action);
      let undoRequested = false;
      let publishedForward = false;
      const undoId = feedback.showUndo(messages.done, undo);
      const persisted = change.then((result) => {
        if (result?.applied && sameSession() && !undoRequested) {
          publishedForward = true;
          publish(bundle, result.previous, result.replacements, sameSession);
        }
        return result;
      }, () => {
        feedback.dismiss(undoId);
        if (sameSession()) feedback.showFailure(messages.failure, isLatest() ? () => {
          if (sameSession() && isLatest()) save(repo, bundle, action);
        } : undefined);
        return null;
      });

      async function undo() {
        if (!sameSession() || undoRequested) return;
        if (!isLatest()) {
          feedback.showFailure('This bundle changed after that action.');
          return;
        }
        undoRequested = true;
        const projection = { aliases: [...new Set([...aliases, ...Object.keys(previous)])], replacements: previous };
        try {
          const result = await enqueue(repo, projection, async () => {
            const original = await persisted;
            if (!original?.applied || !sameSession()) return null;
            return {
              aliases: [...new Set([...aliases, ...Object.keys(original.previous)])],
              replacements: original.previous,
              expected: original.replacements,
            };
          });
          if (!result || !sameSession()) return;
          if (result.applied) publish(bundle, result.previous, result.replacements, sameSession);
          else feedback.showFailure('This bundle changed before Undo could be saved.');
        } catch {
          if (!sameSession()) return;
          const original = await persisted;
          if (original?.applied && !publishedForward && isLatest()) {
            publishedForward = true;
            publish(bundle, original.previous, original.replacements, sameSession);
          }
          feedback.showFailure('Could not undo the bundle change.', isLatest() ? () => {
            undoRequested = false;
            return undo();
          } : undefined);
        }
      }
    }

    return { states, observe, revision: () => version, save };
  }

  function forOwner(ownerId: number) {
    const existing = owners.get(ownerId);
    if (existing) return existing;
    const owner = createOwner(ownerId);
    owners.set(ownerId, owner);
    return owner;
  }

  return { forOwner };
});

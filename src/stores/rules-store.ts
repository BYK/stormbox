import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';

import { getRepositoryAsync } from '../composables/useRepository';
import { MUTATION_TYPE } from '../constants/states';
import {
  cloneRuleDocument,
  compileRules,
  emptyRuleDocument,
  normalizeRuleDocument,
} from '../sieve/rules';
import type { MailRuleDocument, SieveRuleCapabilities } from '../sieve/rules';
import { useAuthStore } from './auth-store';
import { useMailActionFeedbackStore } from './mail-action-feedback-store';

interface RuleScriptSummary {
  id: string;
  name: string | null;
  isActive?: boolean;
}

export interface MailRulesSnapshot {
  supported: boolean;
  accountId: string | null;
  state: string | null;
  capabilities: SieveRuleCapabilities;
  scripts: RuleScriptSummary[];
  managedScript: RuleScriptSummary | null;
  editableScript: RuleScriptSummary | null;
  source: string;
  document: MailRuleDocument;
  visualizationError: string | null;
  parseError: string | null;
}

export class MailRulesSaveError extends Error {
  code: string;
  detail: any;

  constructor(code: string, message: string, detail: any = null) {
    super(message);
    this.name = 'MailRulesSaveError';
    this.code = code;
    this.detail = detail;
  }
}

type RulesDraft = { mode: 'visual'; document: MailRuleDocument } | { mode: 'source'; source: string };
interface PendingActivation {
  accountId: number;
  mutationId: number;
  draft: RulesDraft;
  snapshot: MailRulesSnapshot;
}

export const useRulesStore = defineStore('rules', () => {
  const authStore = useAuthStore();
  const feedback = useMailActionFeedbackStore();
  const loading = ref(false);
  const monitoring = ref(false);
  const error = ref<string | null>(null);
  const snapshot = ref<MailRulesSnapshot | null>(null);
  const submittedDraft = shallowRef<RulesDraft | null>(null);
  const pending = shallowRef<PendingActivation | null>(null);
  const appliedMode = ref<RulesDraft['mode'] | null>(null);
  const needsReview = ref(false);
  let generation = 0;
  let failureToastId: number | undefined;

  const saving = computed(() => monitoring.value || pending.value !== null);
  const queued = computed(() => pending.value !== null);
  const canResume = computed(() => queued.value && !monitoring.value);
  const supported = computed(() => snapshot.value?.supported === true);
  const capabilities = computed<SieveRuleCapabilities>(() =>
    snapshot.value?.capabilities ?? { sieveExtensions: [] });

  async function load(): Promise<MailRulesSnapshot> {
    const accountId = authStore.accountId;
    if (accountId == null) {
      throw new MailRulesSaveError('notConnected', 'Sign in before managing mail rules.');
    }
    const owner = generation;
    loading.value = true;
    error.value = null;
    try {
      const result = await fetchSnapshot(accountId);
      if (owner !== generation) {
        throw new MailRulesSaveError('accountChanged', 'The mail account changed while loading rules.');
      }
      snapshot.value = result;
      needsReview.value = false;
      dismissFailure();
      return result;
    } catch (cause) {
      if (owner === generation) error.value = errorMessage(cause);
      throw cause;
    } finally {
      if (owner === generation) loading.value = false;
    }
  }

  async function fetchSnapshot(accountId: number): Promise<MailRulesSnapshot> {
    const repo = await getRepositoryAsync();
    const result = await repo.getMailRules(accountId) as MailRulesSnapshot;
    return {
      ...result,
      document: normalizeRuleDocument(result?.document ?? emptyRuleDocument()),
    };
  }

  async function save(input: MailRuleDocument): Promise<MailRulesSnapshot> {
    const document = normalizeRuleDocument(input);
    const current = writableSnapshot(snapshot.value ?? await load());
    // Give immediate editor feedback; the SharedWorker compiles again
    // against a freshly fetched capability snapshot before uploading.
    compileRules(document, current.capabilities, {
      managed: current.managedScript !== null || current.editableScript === null,
    });
    return persist({ mode: 'visual', document }, current);
  }

  async function saveSource(source: string): Promise<MailRulesSnapshot> {
    const current = writableSnapshot(snapshot.value ?? await load());
    const size = new TextEncoder().encode(source).byteLength;
    if (
      typeof current.capabilities.maxSizeScript === 'number'
      && size > current.capabilities.maxSizeScript
    ) {
      throw new MailRulesSaveError(
        'invalidSieve',
        `The script is ${size} bytes; the server limit is ${current.capabilities.maxSizeScript}.`,
      );
    }
    return persist({ mode: 'source', source }, current);
  }

  function writableSnapshot(current: MailRulesSnapshot): MailRulesSnapshot {
    if (authStore.accountId == null) {
      throw new MailRulesSaveError('notConnected', 'Sign in before saving mail rules.');
    }
    if (!current.supported) {
      throw new MailRulesSaveError('sieveUnsupported', 'This account does not support JMAP for Sieve.');
    }
    if (current.parseError) {
      throw new MailRulesSaveError('managedScriptUnreadable', current.parseError);
    }
    if (saving.value || loading.value || needsReview.value) {
      throw new MailRulesSaveError('saveUnavailable', 'Wait for the current save or review the server rules.');
    }
    return current;
  }

  async function persist(
    draft: RulesDraft,
    current: MailRulesSnapshot,
  ): Promise<MailRulesSnapshot> {
    const accountId = authStore.accountId;
    if (accountId == null) {
      throw new MailRulesSaveError('notConnected', 'Sign in before saving mail rules.');
    }
    const owner = generation;
    monitoring.value = true;
    submittedDraft.value = draft;
    appliedMode.value = null;
    error.value = null;
    dismissFailure();
    let activation: PendingActivation;
    try {
      const repo = await getRepositoryAsync();
      if (owner !== generation) return current;
      const inserted = await repo.insertPendingMutation({
        accountId,
        mutationType: MUTATION_TYPE.SET_SIEVE_RULES,
        targetMessageId: null,
        requestJson: JSON.stringify({
          ...draft,
          expectedState: current.state,
        }),
        optimisticPatchJson: null,
      });
      if (owner !== generation) return current;
      activation = { accountId, mutationId: inserted.id, draft, snapshot: current };
      pending.value = activation;
    } catch (cause) {
      if (owner === generation) {
        showFailure(cause, 'Couldn’t queue mail rules. Open Mail Rules to review your draft.');
      }
      throw cause;
    } finally {
      if (owner === generation) monitoring.value = false;
    }
    return monitorActivation(activation);
  }

  async function monitorActivation(activation: PendingActivation): Promise<MailRulesSnapshot> {
    const owner = generation;
    const { accountId, mutationId, draft, snapshot: current } = activation;
    monitoring.value = true;
    error.value = null;
    dismissFailure();
    try {
      const repo = await getRepositoryAsync();
      if (owner !== generation) return current;
      const outcome = await repo.runMutation(accountId, mutationId);
      if (owner !== generation || outcome?.errorType === 'stopped') return current;
      if ((outcome?.failed ?? 0) > 0) {
        const row = await repo.getPendingMutationError(mutationId);
        if (owner !== generation) return current;
        pending.value = null;
        const detail = parseErrorJson(row?.error_json);
        const code = detail?.type ?? outcome.errorType ?? 'saveFailed';
        needsReview.value = code === 'sieveStateMismatch';
        throw new MailRulesSaveError(
          code,
          detail?.message ?? 'The server did not save the mail rules.',
          detail?.result ?? detail,
        );
      }
      if ((outcome?.succeeded ?? 0) === 0) return current;

      pending.value = null;
      try {
        const result = await fetchSnapshot(accountId);
        if (owner === generation) {
          snapshot.value = result;
          submittedDraft.value = null;
          appliedMode.value = draft.mode;
        }
        return result;
      } catch (cause) {
        if (owner === generation) {
          needsReview.value = true;
          showFailure(
            cause,
            'Rules were activated. Open Mail Rules to reload the server version before editing again.',
          );
        }
        return current;
      }
    } catch (cause) {
      if (owner === generation) {
        if (pending.value) {
          showFailure(cause, 'Couldn’t check whether mail rules were activated.', resumeActivation);
        } else {
          showFailure(cause, 'Couldn’t activate mail rules. Open Mail Rules to review your draft.');
        }
      }
      throw cause;
    } finally {
      if (owner === generation) monitoring.value = false;
    }
  }

  async function resumeActivation() {
    const activation = pending.value;
    if (!activation || monitoring.value) return;
    try {
      await monitorActivation(activation);
    } catch {
      // The action already reported the error and kept the draft available.
    }
  }

  function dismissFailure() {
    if (failureToastId !== undefined) feedback.dismiss(failureToastId);
    failureToastId = undefined;
  }

  function showFailure(cause: unknown, message: string, retry?: () => Promise<void>) {
    error.value = errorMessage(cause);
    failureToastId = feedback.showFailure(message, retry);
  }

  watch(() => authStore.accountId, $reset, { flush: 'sync' });
  watch(
    () => authStore.isConnected && !authStore.isOfflineSession,
    (online) => {
      if (online) void resumeActivation();
    },
  );

  function freshDocument(): MailRuleDocument {
    return cloneRuleDocument(snapshot.value?.document ?? emptyRuleDocument());
  }

  function freshSource(): string {
    return snapshot.value?.source ?? '';
  }

  function $reset() {
    generation += 1;
    loading.value = false;
    monitoring.value = false;
    error.value = null;
    snapshot.value = null;
    submittedDraft.value = null;
    pending.value = null;
    appliedMode.value = null;
    needsReview.value = false;
    dismissFailure();
  }

  return {
    loading,
    saving,
    queued,
    error,
    snapshot,
    submittedDraft,
    appliedMode,
    needsReview,
    supported,
    capabilities,
    load,
    save,
    saveSource,
    canResume,
    resumeActivation,
    freshDocument,
    freshSource,
    $reset,
  };
});

function parseErrorJson(value: unknown): any {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

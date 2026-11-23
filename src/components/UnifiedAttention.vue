<script setup lang="ts">
import { AtSign, Bell, BellOff, RefreshCw, Sparkles } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useOnline, useStorage } from '@vueuse/core';
import AppIconButton from './AppIconButton.vue';
import AttentionActionMenu from './AttentionActionMenu.vue';
import AttentionInbox from './AttentionInbox.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import MessageView from './MessageView.vue';
import { imapEntry, useImapReader } from '../composables/useImapReader';
import { useMessageTags } from '../composables/useMessageTags';
import { getRepositoryAsync } from '../composables/useRepository';
import { TABLE_FAMILIES } from '../db/protocol';
import { JMAP_SERVER_URL } from '../defines';
import type { AttentionCache } from '../db/attention';
import type { Repository } from '../db/repository';
import { useAuthStore } from '../stores/auth-store';
import { useMailStore } from '../stores/mail-store';
import { browserSessionEnabled } from '../services/browser-session';
import { GOOGLE_IMAP_RESULTS, type GoogleImapResult, type ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import { browserTriageMessageKey, createBrowserTriageRanker, type BrowserTriageProgress } from '../triage/browser-model';
import { buildTriageBundles, markBundleDone, snoozeBundle, type BundleState, type TriageBundle, type TriageClassification, type TriageMessage } from '../triage/smart-sort';
import { disableWebPush, enableWebPush, getWebPushPublicKey, isWebPushEnabled, onWebPushRefresh, publishWebPushAttentionState } from '../push/client';
import type { MessageRow, FolderRow } from '../types';
import { parseAddressList } from '../utils/address-list';
import { closeContainingDropdown } from '../utils/dropdown';
import type { MessageRowLike } from '../utils/message-row-presentation';

const props = defineProps<{
  ownerId: number;
  address: string;
  search?: string;
}>();
const WINDOW_SIZE = 100;
const REFRESH_INTERVAL = 60_000;
const online = useOnline();
const clock = ref(Date.now());
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const manageImap = ref(false);
const googleImapResult = ref<GoogleImapResult>();
const jmapFolder = shallowRef<FolderRow>();
const jmapRows = shallowRef<MessageRow[]>([]);
const cache = shallowRef<AttentionCache>({ paired: false, accounts: [], states: {} });
type Reading = { kind: 'jmap' | 'imap'; message: TriageMessage };
const mailStore = useMailStore();
const authStore = useAuthStore();
const { definitions: tagDefinitions } = useMessageTags();
const reading = shallowRef<Reading>();
const reader = ref<HTMLElement>();
const list = ref<HTMLElement>();
const maximized = ref(false);
const pendingActions = ref(new Set<string>());
let openingButton: HTMLElement | undefined;
const pushRegistration = shallowRef<ServiceWorkerRegistration>();
const pushKey = shallowRef<Uint8Array<ArrayBuffer>>();
const pushEnabled = ref(false);
const pushBusy = ref(false);
let repo: Repository;
let unsubscribe: (() => void) | undefined;
let removePushRefresh: (() => void) | undefined;
let heartbeat: number;
let active = true;
let loadSequence = 0;
let refreshRequested = false;
const localModelEnabled = useStorage('stormbox.attention.use-local-model', false);
const modelScores = shallowRef(new Map<string, TriageClassification>());
const modelProgress = ref<BrowserTriageProgress>();
const modelFailed = ref(false);
let ranker: ReturnType<typeof createBrowserTriageRanker> | undefined;
let modelRunning = false;
let modelNeedsPass = false;

function jmapMessage(row: MessageRow): TriageMessage {
  return {
    id: row.id,
    accountId: `jmap:${row.account_id}`,
    receivedAt: row.received_at ?? 0,
    subject: row.subject,
    preview: row.preview,
    threadId: row.thread_id,
    messageId: row.rfc822_message_id,
    references: parseHeaderList(row.references_json),
    inReplyTo: parseHeaderList(row.in_reply_to_json),
    sender: parseAddressList(row.from_text ?? '')[0]?.email,
    directRecipient: parseAddressList(row.to_text ?? '').some((recipient) =>
      recipient.email.toLowerCase() === props.address.toLowerCase()),
    isFlagged: Boolean(row.is_flagged),
    isAnswered: Boolean(row.is_answered),
  };
}

function parseHeaderList(value: string | null): string[] {
  if (!value) return [];
  try {
    const entries: unknown = JSON.parse(value);
    return Array.isArray(entries) ? entries.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

const imap = computed(() => cache.value.accounts.flatMap((account) => {
  const { mailbox, uid_validity: uidValidity } = account;
  if (!mailbox || !uidValidity) return [];
  return account.messages.map((row) => {
    const entry = imapEntry(account, mailbox, uidValidity, row);
    const message: TriageMessage = {
      id: JSON.stringify([mailbox, uidValidity, row.uid]),
      accountId: `imap:${account.relay_id}`,
      receivedAt: entry.presentation.received_at,
      subject: row.subject,
      preview: row.preview,
      messageId: row.messageId,
      references: row.references,
      inReplyTo: row.inReplyTo,
      sender: row.from[0]?.address,
      directRecipient: row.to.some((recipient) => recipient.address.toLowerCase() === account.address.toLowerCase()),
      isFlagged: row.flagged,
    };
    return { ...entry, message };
  });
}));
const imapById = computed(() => new Map(imap.value.map((entry) => [entry.id, entry])));
const imapReading = useImapReader(() => props.ownerId, () => repo, (id) => imapById.value.get(id), report);
const imapReader = imapReading.view;
const jmapRowsById = computed(() => new Map(jmapRows.value.map((row) => [row.id, row])));
const rows = computed(() => new Map<string, MessageRowLike & { id: number | string }>([
  ...jmapRows.value.map((row) => [
    browserTriageMessageKey({ accountId: `jmap:${row.account_id}`, id: row.id }), row,
  ] as const),
  ...imap.value.map(({ message, presentation }) => [
    browserTriageMessageKey(message), presentation,
  ] as const),
]));
const disabledActions = computed(() => new Set([
  ...pendingActions.value,
  ...imap.value.filter(({ id }) => imapReading.disabled(id)).map(({ message }) => browserTriageMessageKey(message)),
]));
const accountLabels = computed(() => Object.fromEntries([
  [`jmap:${props.ownerId}`, props.address],
  ...cache.value.accounts.map((account) => [`imap:${account.relay_id}`, account.address]),
]));
const baseMessages = computed(() => [...jmapRows.value.map(jmapMessage), ...imap.value.map(({ message }) => message)]);
const bundles = computed(() => {
  const messages = baseMessages.value.map((message) => ({
    ...message, classification: modelScores.value.get(browserTriageMessageKey(message)),
  }));
  const query = props.search?.trim().toLowerCase();
  return buildTriageBundles(messages, cache.value.states, clock.value).filter((bundle) =>
    !query || bundle.messages.some(({ message }) =>
      [message.subject, message.sender, message.preview, accountLabels.value[String(message.accountId)]]
        .some((value) => value?.toLowerCase().includes(query))),
  );
});


async function runLocalModel() {
  modelNeedsPass = true;
  if (modelRunning || !localModelEnabled.value || modelFailed.value || !baseMessages.value.length) return;
  ranker ??= createBrowserTriageRanker();
  const worker = ranker;
  modelRunning = true;
  modelNeedsPass = false;
  try {
    const scores = await worker.classify(baseMessages.value, (progress) => {
      if (ranker === worker) modelProgress.value = progress;
    });
    if (ranker === worker) modelScores.value = scores;
  } catch {
    if (ranker === worker) modelFailed.value = true;
  } finally {
    modelRunning = false;
    if (ranker === worker) modelProgress.value = undefined;
    if (modelNeedsPass && active) void runLocalModel();
  }
}

watch(baseMessages, () => { void runLocalModel(); });
watch(localModelEnabled, (enabled) => {
  if (pushRegistration.value && pushKey.value && online.value) {
    void isWebPushEnabled(pushRegistration.value, pushKey.value, enabled).catch(() => {});
  }
  if (enabled) {
    modelFailed.value = false;
    void runLocalModel();
    return;
  }
  ranker?.dispose();
  ranker = undefined;
  modelProgress.value = undefined;
  modelScores.value = new Map();
});

async function loadCache() {
  const request = ++loadSequence;
  const [nextCache, folder] = await Promise.all([
    repo.getAttentionCache(props.ownerId),
    repo.folderByRole(props.ownerId, 'inbox'),
  ]);
  const rows = folder ? await repo.listMessagesForView({
    accountId: props.ownerId, folderId: folder.id, limit: WINDOW_SIZE,
  }) : [];
  if (!active || request !== loadSequence) return;
  const inboxDiscovered = folder != null && folder.id !== jmapFolder.value?.id;
  cache.value = nextCache;
  jmapFolder.value = folder;
  jmapRows.value = rows;
  if (inboxDiscovered && !loading.value) requestRefresh();
}

function report(cause: unknown) {
  if (active) error.value = cause instanceof Error ? cause.message : 'Attention could not load mail.';
}

function showFailedAccounts(accounts: string[]) {
  if (accounts.length) error.value = `Could not refresh ${accounts.join(', ')}. Showing saved mail.`;
}

async function refresh() {
  if (!active || !repo || busy.value || !online.value) return;
  busy.value = true;
  try {
    do {
      refreshRequested = false;
      clock.value = Date.now();
      error.value = '';
      try {
        const jobs: Promise<unknown>[] = [];
        if (jmapFolder.value && !authStore.isOfflineSession) {
          jobs.push(repo.ensureFolderWindow(props.ownerId, jmapFolder.value.id, { limit: WINDOW_SIZE }));
        }
        if (cache.value.paired) jobs.push(repo.refreshAttentionRelay(props.ownerId).then(showFailedAccounts));
        for (const result of await Promise.allSettled(jobs)) {
          if (result.status === 'rejected') report(result.reason);
        }
        if (active) await loadCache();
      } catch (cause) {
        report(cause);
      }
    } while (refreshRequested && active && online.value);
  } finally {
    busy.value = false;
  }
}

function requestRefresh() {
  refreshRequested = true;
  void refresh();
}

watch(() => authStore.isOfflineSession, (isOffline, wasOffline) => {
  if (wasOffline && !isOffline) requestRefresh();
});
watch(online, (connected) => {
  if (connected && cache.value.paired) void prepareWebPush();
});

async function prepareWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    // Get the key before the click so Safari sees the permission request as a user gesture.
    const [registration, key] = await Promise.all([
      navigator.serviceWorker.ready,
      getWebPushPublicKey(),
    ]);
    const enabled = await isWebPushEnabled(registration, key, localModelEnabled.value).catch(() => false);
    if (!active) return;
    pushEnabled.value = enabled;
    pushRegistration.value = registration;
    pushKey.value = key;
  } catch {
    // Push is optional for a deployment that only configures mail sync.
  }
}

async function togglePush() {
  if (pushBusy.value || !pushRegistration.value || !pushKey.value) return;
  pushBusy.value = true;
  error.value = '';
  const enabling = !pushEnabled.value;
  try {
    if (enabling) {
      await enableWebPush({
        registration: pushRegistration.value, publicKey: pushKey.value, confirmedOnly: localModelEnabled.value,
      });
    } else await disableWebPush(pushRegistration.value);
    if (active) pushEnabled.value = enabling;
  } catch (cause) {
    report(cause);
  } finally {
    pushBusy.value = false;
  }
}

function relayPaired(failedAccounts: string[]) {
  showFailedAccounts(failedAccounts);
  void loadCache().catch(report);
  void prepareWebPush();
}

async function refreshAfterAccountChange() {
  try {
    error.value = '';
    showFailedAccounts(await repo.refreshAttentionRelay(props.ownerId));
    await loadCache();
  } catch (cause) {
    report(cause);
  }
}

async function disconnectRelay() {
  busy.value = true;
  error.value = '';
  try {
    if (pushEnabled.value && pushRegistration.value) {
      await disableWebPush(pushRegistration.value).catch(report);
    }
    pushEnabled.value = false;
    await repo.disconnectAttentionRelay(props.ownerId);
  } finally {
    busy.value = false;
    await loadCache().catch(report);
  }
}

async function saveState(bundle: TriageBundle, state: BundleState | null) {
  try {
    const aliases = new Set(bundle.aliases);
    const replacedIds = Object.entries(cache.value.states)
      .filter(([id, previous]) => aliases.has(id) || previous.aliases.some((alias) => aliases.has(alias)))
      .map(([id]) => id);
    await repo.setAttentionBundleState(props.ownerId, bundle.id, state, replacedIds);
    if (typeof bundle.accountId === 'string' && bundle.accountId.startsWith('imap:')) {
      void publishWebPushAttentionState(bundle.id, state, replacedIds).catch(report);
    }
    await loadCache();
  } catch (cause) {
    report(cause);
  }
}

function releaseJmapReader(previous?: Reading) {
  if (previous?.kind === 'jmap' && mailStore.selectedMessageId === previous.message.id) {
    mailStore.selectMessage(null);
  }
}

async function closeReader() {
  const previous = reading.value;
  reading.value = undefined;
  imapReading.close();
  maximized.value = false;
  releaseJmapReader(previous);
  await nextTick();
  if (!active || reading.value) return;
  if (openingButton?.isConnected) openingButton.focus({ preventScroll: true });
  else list.value?.querySelector<HTMLElement>('.attention-inbox__filter[aria-pressed="true"]')
    ?.focus({ preventScroll: true });
  openingButton = undefined;
}

function findImapMessage(message: TriageMessage) {
  return imap.value.find(({ message: candidate }) =>
    candidate.id === message.id && candidate.accountId === message.accountId);
}

async function openMessage(message: TriageMessage, trigger: EventTarget | null) {
  if (trigger instanceof HTMLElement) openingButton = trigger;
  const messageId = message.id;
  if (typeof messageId === 'number' && jmapFolder.value) {
    imapReading.close();
    reading.value = { kind: 'jmap', message };
    mailStore.selectMessage(messageId, jmapFolder.value.id, () => jmapRowsById.value.get(messageId));
    await nextTick();
    reader.value?.focus({ preventScroll: true });
    return;
  }
  const row = findImapMessage(message);
  if (!row) return;
  releaseJmapReader(reading.value);
  reading.value = { kind: 'imap', message };
  void nextTick(() => reader.value?.focus({ preventScroll: true }));
  await imapReading.open(row);
}

async function runMessageAction(message: TriageMessage, action: ImapAttentionAction) {
  error.value = '';
  if (typeof message.id !== 'number') {
    const entry = findImapMessage(message);
    if (!entry) return;
    await imapReading.runAction(entry, action);
    return;
  }
  const key = browserTriageMessageKey(message);
  if (pendingActions.value.has(key)) return;
  pendingActions.value.add(key);
  try {
    const row = jmapRowsById.value.get(message.id);
    if (!row || !jmapFolder.value) return;
    const source = { sourceFolderId: jmapFolder.value.id, rows: [row] };
    if (action.type === 'star') await mailStore.markManyFlagged([message.id], action.value, source);
    else if (action.type === 'seen') await mailStore.markManySeen([message.id], action.value, source);
    else if (action.type === 'trash') await mailStore.destroyMessage(message.id, source);
    await loadCache();
  } catch (cause) {
    report(cause);
  } finally {
    pendingActions.value.delete(key);
  }
}

watch([() => mailStore.selectedMessageId, jmapRowsById, imap], () => {
  const current = reading.value;
  if (current?.kind === 'jmap'
    && (mailStore.selectedMessageId !== current.message.id || !jmapRowsById.value.has(Number(current.message.id)))) {
    void closeReader();
  } else if (current?.kind === 'imap' && !findImapMessage(current.message)) {
    void closeReader();
  }
});

function onVisible() {
  if (document.visibilityState === 'visible') {
    clock.value = Date.now();
    void refresh();
  }
}

onMounted(async () => {
  try {
    repo = await getRepositoryAsync();
    if (!active) return;
    removePushRefresh = onWebPushRefresh(requestRefresh);
    unsubscribe = repo.subscribe((tables) => {
      if ([TABLE_FAMILIES.MESSAGES, TABLE_FAMILIES.FOLDERS, TABLE_FAMILIES.ATTENTION].some((table) => tables.includes(table))) {
        void loadCache().catch(report);
      }
    });
    await loadCache();
    if (!active) return;
    const url = new URL(window.location.href);
    const result = GOOGLE_IMAP_RESULTS.find((status) => status === url.searchParams.get('google_imap'));
    if (result) {
      googleImapResult.value = result;
      manageImap.value = true;
      url.searchParams.delete('google_imap');
      window.history.replaceState(window.history.state, '', url);
    }
    void refresh();
    if (cache.value.paired) void prepareWebPush();
    window.addEventListener('online', requestRefresh);
    document.addEventListener('visibilitychange', onVisible);
    heartbeat = window.setInterval(onVisible, REFRESH_INTERVAL);
  } catch (cause) {
    report(cause);
  } finally {
    loading.value = false;
  }
});
onBeforeUnmount(() => {
  active = false;
  releaseJmapReader(reading.value);
  unsubscribe?.();
  removePushRefresh?.();
  ranker?.dispose();
  ranker = undefined;
  window.removeEventListener('online', requestRefresh);
  document.removeEventListener('visibilitychange', onVisible);
  window.clearInterval(heartbeat);
});
</script>

<template>
  <section
    class="unified-attention"
    :class="{ 'unified-attention--reading': reading, 'unified-attention--maximized': maximized }"
    aria-label="Attention"
  >
    <div ref="list" v-show="!maximized" class="unified-attention__list">
      <AttentionInbox
        :bundles="bundles"
        :account-labels="accountLabels"
        :loading="loading"
        :error="error || cache.actionFailure?.message"
        :open-message="reading?.message"
        :rows="rows"
        :disabled-actions="disabledActions"
        :tag-definitions="tagDefinitions"
        @open="openMessage"
        @message-action="runMessageAction"
        @done="(bundle) => saveState(bundle, markBundleDone(bundle))"
        @snooze="(bundle, until) => saveState(bundle, snoozeBundle(bundle, until))"
        @restore="(bundle) => saveState(bundle, null)"
      >
        <template #actions>
          <div class="unified-attention__tools">
            <AppIconButton
              :disabled="busy || loading || !online"
              :aria-label="busy ? 'Refreshing' : 'Refresh'"
              :title="busy ? 'Refreshing…' : 'Refresh'"
              @click="refresh"
            >
              <RefreshCw :size="16" :stroke-width="1.75" :class="{ 'unified-attention__refresh--busy': busy }" aria-hidden="true" />
            </AppIconButton>
            <AttentionActionMenu label="Smart Inbox options">
              <button
                class="app-dropdown__item"
                type="button"
                :disabled="loading || !online"
                @click="closeContainingDropdown($event, true); manageImap = true"
              >
                <AtSign :size="16" aria-hidden="true" />
                {{ cache.paired ? 'Manage IMAP accounts' : 'Connect IMAP accounts' }}
              </button>
              <button
                v-if="cache.paired && pushKey"
                class="app-dropdown__item"
                type="button"
                :disabled="pushBusy || !online"
                @click="closeContainingDropdown($event, true); togglePush()"
              >
                <component :is="pushEnabled ? BellOff : Bell" :size="16" aria-hidden="true" />
                {{ pushEnabled ? 'Disable notifications' : 'Enable notifications' }}
              </button>
              <button
                class="app-dropdown__item"
                type="button"
                :title="localModelEnabled ? 'Use rules only' : 'Download multilingual E5 and rank on this device'"
                @click="closeContainingDropdown($event, true); localModelEnabled = !localModelEnabled"
              >
                <Sparkles :size="16" aria-hidden="true" />
                {{ localModelEnabled ? 'Turn off local model' : 'Use local model' }}
              </button>
            </AttentionActionMenu>
          </div>
        </template>
        <template #progress>
          <p v-if="modelProgress" role="status" class="unified-attention__progress">
            {{ modelProgress.phase === 'preparing' ? 'Preparing local model…' : 'Ranking mail locally…' }}
          </p>
          <p v-else-if="localModelEnabled && modelFailed" role="status" class="unified-attention__progress">
            Local model unavailable. Showing rules-based rankings.
          </p>
        </template>
      </AttentionInbox>
    </div>
    <ImapAccountsDialog
      v-if="manageImap"
      :owner-id="ownerId"
      :paired="cache.paired"
      :automatic="browserSessionEnabled(JMAP_SERVER_URL)"
      :google-result="googleImapResult"
      :disconnect="disconnectRelay"
      @paired="relayPaired"
      @account-change="refreshAfterAccountChange"
      @close="manageImap = false; googleImapResult = undefined"
    />
    <div ref="reader" class="unified-attention__reader" tabindex="-1">
      <MessageView
        v-if="reading?.kind === 'jmap' || imapReader"
        back-label="Back to Attention"
        :maximized="maximized"
        :imap="imapReader"
        @back="closeReader"
        @toggle-maximized="maximized = !maximized"
        @imap-action="(action) => reading?.kind === 'imap' && runMessageAction(reading.message, action)"
        @imap-compose="imapReading.composeResponse"
      />
      <p v-else class="unified-attention__empty">Select a message to read it.</p>
    </div>
  </section>
</template>

<style scoped>
.unified-attention {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}
.unified-attention:not(.unified-attention--maximized) {
  grid-template-columns: minmax(330px, 2fr) minmax(0, 3fr);
}
.unified-attention__list,
.unified-attention__reader {
  min-width: 0;
  min-height: 0;
}
.unified-attention__reader {
  background: var(--panel);
}
.unified-attention__reader:focus {
  outline: none;
}
.unified-attention:not(.unified-attention--maximized) .unified-attention__reader {
  border-inline-start: 1px solid var(--border);
}
.unified-attention__empty {
  display: grid;
  height: 100%;
  margin: 0;
  place-items: center;
  color: var(--muted);
}
@media (max-width: 839px) {
  .unified-attention:not(.unified-attention--maximized) {
    grid-template-columns: minmax(0, 1fr);
  }
  .unified-attention--reading .unified-attention__list {
    display: none;
  }
  .unified-attention:not(.unified-attention--reading) .unified-attention__reader {
    display: none;
  }
  .unified-attention:not(.unified-attention--maximized) .unified-attention__reader {
    border-inline-start: 0;
  }
}
.unified-attention__progress {
  margin: 0;
  padding: 8px 18px;
  color: var(--muted);
  font-size: .8rem;
}
.unified-attention__tools {
  display: flex;
  align-items: center;
  gap: 2px;
}
@media (prefers-reduced-motion: no-preference) {
  .unified-attention__refresh--busy { animation: attention-refresh 1.2s linear infinite; }
}
@keyframes attention-refresh {
  to { transform: rotate(360deg); }
}
@media (pointer: coarse) {
  .unified-attention__tools .app-icon-button {
    width: 44px;
    height: 44px;
    flex-basis: 44px;
  }
}
</style>

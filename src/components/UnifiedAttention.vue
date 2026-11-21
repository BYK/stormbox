<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useOnline, useStorage } from '@vueuse/core';
import AppButton from './AppButton.vue';
import AttentionInbox from './AttentionInbox.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import MessageView from './MessageView.vue';
import { useMessageTags } from '../composables/useMessageTags';
import { getRepositoryAsync } from '../composables/useRepository';
import { TABLE_FAMILIES } from '../db/protocol';
import { JMAP_SERVER_URL } from '../defines';
import type { AttentionCache } from '../db/attention';
import type { Repository } from '../db/repository';
import { useMailStore } from '../stores/mail-store';
import { browserSessionEnabled } from '../services/browser-session';
import type { ImapAttentionAction, ImapMessageLocation } from '../sync/backends/imap/attention-relay';
import { browserTriageMessageKey, createBrowserTriageRanker, type BrowserTriageProgress } from '../triage/browser-model';
import { buildTriageBundles, markBundleDone, snoozeBundle, type BundleState, type TriageBundle, type TriageClassification, type TriageMessage } from '../triage/smart-sort';
import { disableWebPush, enableWebPush, getWebPushPublicKey, isWebPushEnabled, onWebPushRefresh } from '../push/client';
import type { MessageRow, FolderRow } from '../types';
import { parseAddressList } from '../utils/address-list';
import { formatAddressList } from '../utils/address-parse';
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
const jmapFolder = shallowRef<FolderRow>();
const jmapRows = shallowRef<MessageRow[]>([]);
const cache = shallowRef<AttentionCache>({ paired: false, accounts: [], states: {} });
type Reading = { kind: 'jmap'; message: TriageMessage } |
  { kind: 'imap'; message: TriageMessage; body?: string; error?: string };
const mailStore = useMailStore();
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

const imap = computed(() => cache.value.accounts.flatMap((account) => account.messages.map((row) => {
  const id = JSON.stringify([account.mailbox, account.uid_validity, row.uid]);
  const location: ImapMessageLocation = {
    accountId: account.relay_id, mailbox: account.mailbox,
    uidValidity: account.uid_validity, uid: row.uid,
  };
  const message: TriageMessage = {
    id,
    accountId: `imap:${account.relay_id}`,
    receivedAt: Date.parse(row.receivedAt) || 0,
    subject: row.subject,
    preview: row.preview,
    messageId: row.messageId,
    references: row.references,
    inReplyTo: row.inReplyTo,
    sender: row.from[0]?.address,
    directRecipient: row.to.some((recipient) => recipient.address.toLowerCase() === account.address.toLowerCase()),
    isFlagged: row.flagged,
  };
  const presentation: MessageRowLike & { id: string } = {
    id,
    subject: row.subject,
    preview: row.preview,
    from_text: formatAddressList(row.from.map(({ name, address }) => ({ name, email: address }))),
    received_at: message.receivedAt,
    is_seen: Number(row.seen),
    is_flagged: Number(row.flagged),
  };
  return { message, location, presentation };
})));
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
  ...(!online.value ? imap.value.map(({ message }) => browserTriageMessageKey(message)) : []),
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
  cache.value = nextCache;
  jmapFolder.value = folder;
  jmapRows.value = rows;
}

function report(cause: unknown) {
  if (active) error.value = cause instanceof Error ? cause.message : 'Attention could not load mail.';
}

function showFailedAccounts(accounts: string[]) {
  if (accounts.length) error.value = `Could not refresh ${accounts.join(', ')}. Showing saved mail.`;
}

async function refresh() {
  if (!repo || busy.value || !online.value) return;
  busy.value = true;
  error.value = '';
  try {
    const jobs: Promise<unknown>[] = [];
    if (jmapFolder.value) jobs.push(repo.ensureFolderWindow(props.ownerId, jmapFolder.value.id, { limit: WINDOW_SIZE }));
    if (cache.value.paired) jobs.push(repo.refreshAttentionRelay(props.ownerId).then(showFailedAccounts));
    for (const result of await Promise.allSettled(jobs)) {
      if (result.status === 'rejected') report(result.reason);
    }
    await loadCache();
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

async function prepareWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    // Get the key before the click so Safari sees the permission request as a user gesture.
    const [registration, key] = await Promise.all([
      navigator.serviceWorker.ready,
      getWebPushPublicKey(),
    ]);
    if (!active) return;
    pushRegistration.value = registration;
    pushKey.value = key;
    pushEnabled.value = await isWebPushEnabled(registration);
  } catch {
    // Push is optional for a deployment that only configures mail sync.
  }
}

async function togglePush() {
  if (!pushRegistration.value || !pushKey.value) return;
  pushBusy.value = true;
  error.value = '';
  try {
    if (pushEnabled.value) await disableWebPush(pushRegistration.value);
    else await enableWebPush({ registration: pushRegistration.value, publicKey: pushKey.value });
    pushEnabled.value = !pushEnabled.value;
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
    reading.value = { kind: 'jmap', message };
    mailStore.selectMessage(messageId, jmapFolder.value.id, () => jmapRowsById.value.get(messageId));
    await nextTick();
    reader.value?.focus({ preventScroll: true });
    return;
  }
  const row = findImapMessage(message);
  if (!row) return;
  releaseJmapReader(reading.value);
  const pending = { kind: 'imap', message } as const;
  reading.value = pending;
  maximized.value = false;
  void nextTick(() => reader.value?.focus({ preventScroll: true }));
  try {
    const body = await repo.readAttentionImapMessage(props.ownerId, row.location);
    if (reading.value === pending) reading.value = { ...pending, body };
  } catch (cause) {
    if (reading.value === pending) {
      reading.value = { ...pending, error: online.value && cause instanceof Error
        ? cause.message : 'This message body has not been downloaded for offline reading.' };
    }
  }
}

async function runMessageAction(message: TriageMessage, action: ImapAttentionAction) {
  const key = browserTriageMessageKey(message);
  if (pendingActions.value.has(key)) return;
  pendingActions.value.add(key);
  error.value = '';
  try {
    if (typeof message.id === 'number') {
      const row = jmapRowsById.value.get(message.id);
      if (!row || !jmapFolder.value) return;
      const source = { sourceFolderId: jmapFolder.value.id, rows: [row] };
      if (action.type === 'star') await mailStore.markManyFlagged([message.id], action.value, source);
      else if (action.type === 'seen') await mailStore.markManySeen([message.id], action.value, source);
      else await mailStore.destroyMessage(message.id, source);
    } else {
      const row = findImapMessage(message);
      if (!row) return;
      await repo.mutateAttentionImapMessage(props.ownerId, row.location, action);
    }
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
    removePushRefresh = onWebPushRefresh(() => { void refresh(); });
    unsubscribe = repo.subscribe((tables) => {
      if ([TABLE_FAMILIES.MESSAGES, TABLE_FAMILIES.FOLDERS, TABLE_FAMILIES.ATTENTION].some((table) => tables.includes(table))) {
        void loadCache().catch(report);
      }
    });
    await loadCache();
    if (!active) return;
    void refresh();
    if (cache.value.paired) void prepareWebPush();
    window.addEventListener('online', onVisible);
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
  window.removeEventListener('online', onVisible);
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
        :error="error"
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
          <AppButton :disabled="loading || !online" @click="manageImap = true">
            {{ cache.paired ? 'Manage IMAP accounts' : 'Connect IMAP accounts' }}
          </AppButton>
          <AppButton v-if="cache.paired && pushKey" :disabled="pushBusy || !online" @click="togglePush">
            {{ pushEnabled ? 'Disable notifications' : 'Enable notifications' }}
          </AppButton>
          <AppButton :disabled="busy || loading || !online" @click="refresh">Refresh</AppButton>
          <AppButton
            variant="outline"
            :title="localModelEnabled ? 'Use rules only' : 'Download multilingual E5 and rank on this device'"
            :aria-pressed="localModelEnabled"
            @click="localModelEnabled = !localModelEnabled"
          >{{ localModelEnabled ? 'Turn off local model' : 'Use local model' }}</AppButton>
          <span v-if="modelProgress" role="status" class="unified-attention__progress">
            {{ modelProgress.phase === 'preparing' ? 'Preparing local model…' : 'Ranking mail locally…' }}
          </span>
          <span v-else-if="localModelEnabled && modelFailed" role="status" class="unified-attention__progress">
            Local model unavailable. Showing rules-based rankings.
          </span>
        </template>
      </AttentionInbox>
    </div>
    <ImapAccountsDialog
      v-if="manageImap"
      :owner-id="ownerId"
      :paired="cache.paired"
      :automatic="browserSessionEnabled(JMAP_SERVER_URL)"
      :disconnect="disconnectRelay"
      @paired="relayPaired"
      @account-change="refreshAfterAccountChange"
      @close="manageImap = false"
    />
    <div ref="reader" class="unified-attention__reader" tabindex="-1">
      <MessageView
        v-if="reading?.kind === 'jmap'"
        back-label="Back to Attention"
        :maximized="maximized"
        @back="closeReader"
        @toggle-maximized="maximized = !maximized"
      />
      <section v-else-if="reading" class="unified-attention__imap" aria-label="Message detail">
        <AppButton @click="closeReader">Back to Attention</AppButton>
        <h2>{{ reading.message.subject || '(No subject)' }}</h2>
        <p v-if="reading.message.sender">{{ reading.message.sender }}</p>
        <p v-if="reading.error" role="alert">{{ reading.error }}</p>
        <p v-else-if="reading.body === undefined" role="status">Loading message…</p>
        <p v-else class="unified-attention__body">{{ reading.body || 'This message has no plain-text body.' }}</p>
      </section>
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
.unified-attention__imap {
  width: min(100%, 760px);
  height: 100%;
  margin-inline: auto;
  padding: 24px;
  box-sizing: border-box;
  overflow: auto;
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
.unified-attention__body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
}
.unified-attention__progress {
  color: var(--muted);
  font-size: .8rem;
}
</style>

<script setup lang="ts">
import { AtSign, Bell, BellOff, Check, RefreshCw, Sparkles } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useOnline, useStorage } from '@vueuse/core';
import AppIconButton from './AppIconButton.vue';
import AttentionActionMenu from './AttentionActionMenu.vue';
import AttentionInbox from './AttentionInbox.vue';
import AttentionRowMenu from './AttentionRowMenu.vue';
import ConversationReader from './ConversationReader.vue';
import ConversationMessage, { type ConversationMessageSource } from './ConversationMessage.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import MessageView from './MessageView.vue';
import { imapEntry, useImapReader } from '../composables/useImapReader';
import { useInlineReading } from '../composables/useInlineReading';
import { useMailListActions, type MailListAction, type MailListSource } from '../composables/useMailListActions';
import { useMessageTags } from '../composables/useMessageTags';
import { getRepositoryAsync } from '../composables/useRepository';
import { TABLE_FAMILIES } from '../db/protocol';
import { JMAP_SERVER_URL } from '../defines';
import type { AttentionCache } from '../db/attention';
import type { Repository } from '../db/repository';
import { useAttentionBundleActionsStore } from '../stores/attention-bundle-actions-store';
import { useAuthStore } from '../stores/auth-store';
import { useComposeStore } from '../stores/compose-store';
import { useImapOptimisticActions } from '../stores/imap-optimistic-actions-store';
import { useMailStore } from '../stores/mail-store';
import { browserSessionEnabled } from '../services/browser-session';
import { GOOGLE_IMAP_RESULTS, type GoogleImapResult, type ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import { browserTriageMessageKey, createBrowserTriageRanker, type BrowserTriageProgress } from '../triage/browser-model';
import { buildTriageBundles, type TriageBundle, type TriageClassification, type TriageMessage } from '../triage/smart-sort';
import { disableWebPush, enableWebPush, getWebPushPublicKey, isWebPushEnabled, onWebPushRefresh } from '../push/client';
import type { MessageRow, FolderRow } from '../types';
import { parseAddressList } from '../utils/address-list';
import { closeContainingDropdown } from '../utils/dropdown';
import { threadSubject } from '../utils/mail-threads';
import { conversationRow, correspondentLabel, type MessageRowLike } from '../utils/message-row-presentation';

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
const cachedJmapRows = shallowRef<MessageRow[]>([]);
const cache = shallowRef<AttentionCache>({ paired: false, accounts: [], states: {} });
type Reading = { kind: 'jmap' | 'imap'; message: TriageMessage };
const mailStore = useMailStore();
const imapActions = useImapOptimisticActions();
const jmapRows = computed(() => jmapFolder.value
  ? mailStore.projectMailRows(jmapFolder.value.id, cachedJmapRows.value) : cachedJmapRows.value);
const authStore = useAuthStore();
const composeStore = useComposeStore();
const bundleActions = useAttentionBundleActionsStore().forOwner(props.ownerId);
const { definitions: tagDefinitions } = useMessageTags();
const reading = shallowRef<Reading>();
const openedBundle = shallowRef<TriageBundle>();
const showConversation = ref(false);
const reader = ref<HTMLElement>();
const inlineTarget = shallowRef<HTMLElement>();
const list = ref<HTMLElement>();
const maximized = ref(false);
const inlineReading = useInlineReading();
const inPlace = computed(() => inlineReading.value && !maximized.value);
const readerTarget = computed(() => (inPlace.value && inlineTarget.value) || reader.value);
const readerBackLabel = computed(() => inPlace.value ? 'Collapse reader' : 'Back to Attention');
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

const ownJmapAddresses = computed(() => new Set([
  props.address.toLowerCase(),
  ...composeStore.identities.filter((identity) => identity.account_id === props.ownerId)
    .map((identity) => identity.email.toLowerCase()),
]));
const statusText = computed(() => {
  if (modelProgress.value) return modelProgress.value.phase === 'preparing' ? 'Preparing local model…' : 'Ranking mail locally…';
  if (localModelEnabled.value && modelFailed.value) return 'Local model unavailable. Showing rules-based rankings.';
  return busy.value ? 'Refreshing…' : '';
});

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
      ownJmapAddresses.value.has(recipient.email.toLowerCase())),
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
  return imapActions.projectFolder(props.ownerId, account.relay_id, mailbox, uidValidity, account.messages).map((row) => {
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
const imapByMessage = computed(() => new Map(imap.value.map((entry) => [browserTriageMessageKey(entry.message), entry])));
const imapReading = useImapReader(() => props.ownerId, () => repo, (id) => imapById.value.get(id), loadCache);
const imapReader = imapReading.view;
const runListAction = useMailListActions(() => props.ownerId, () => repo, loadCache);
const jmapRowsById = computed(() => new Map(jmapRows.value.map((row) => [row.id, row])));
const rows = computed(() => new Map<string, MessageRowLike & { id: number | string }>([
  ...jmapRows.value.map((row) => [
    browserTriageMessageKey({ accountId: `jmap:${row.account_id}`, id: row.id }), row,
  ] as const),
  ...imap.value.map(({ message, presentation }) => [
    browserTriageMessageKey(message), presentation,
  ] as const),
]));
const accountLabels = computed(() => Object.fromEntries([
  [`jmap:${props.ownerId}`, props.address],
  ...cache.value.accounts.map((account) => [`imap:${account.relay_id}`, account.address]),
]));
const baseMessages = computed(() => [...jmapRows.value.map(jmapMessage), ...imap.value.map(({ message }) => message)]);
const unfilteredBundles = computed(() => {
  const messages = baseMessages.value.map((message) => ({
    ...message, classification: modelScores.value.get(browserTriageMessageKey(message)),
  }));
  return buildTriageBundles(messages, bundleActions.states.value, clock.value);
});
const bundles = computed(() => {
  const query = props.search?.trim().toLowerCase();
  return query ? unfilteredBundles.value.filter((bundle) =>
    bundle.messages.some(({ message }) =>
      [message.subject, message.sender, message.preview, rows.value.get(browserTriageMessageKey(message))?.to_text,
        accountLabels.value[String(message.accountId)]]
        .some((value) => value?.toLowerCase().includes(query)))) : unfilteredBundles.value;
});

const activeMessageKey = computed(() => reading.value && browserTriageMessageKey(reading.value.message));
const activeBundle = computed(() => {
  const previous = openedBundle.value;
  if (!previous) return undefined;
  const memberKeys = new Set(previous.messages.map(({ message }) => browserTriageMessageKey(message)));
  return unfilteredBundles.value.find((bundle) =>
    bundle.messages.some(({ message }) => browserTriageMessageKey(message) === activeMessageKey.value))
    ?? unfilteredBundles.value.find((bundle) => bundle.id === previous.id)
    ?? unfilteredBundles.value.find((bundle) =>
      bundle.messages.some(({ message }) => memberKeys.has(browserTriageMessageKey(message))));
});
const conversationMessages = computed(() => activeBundle.value?.messages.map(({ message }) => {
  const key = browserTriageMessageKey(message);
  const row = rows.value.get(key);
  return {
    key,
    sender: correspondentLabel(row ?? { from_text: message.sender }, false),
    subject: message.subject,
    preview: message.preview,
    timestamp: message.receivedAt,
    unread: Number(row?.is_seen) === 0,
  };
}) ?? []);
const conversationSources = computed(() => {
  const sources = new Map<string, ConversationMessageSource>();
  for (const { message } of activeBundle.value?.messages ?? []) {
    const key = browserTriageMessageKey(message);
    if (typeof message.id === 'number') {
      const row = jmapRowsById.value.get(message.id);
      if (row && jmapFolder.value) sources.set(key, { kind: 'jmap', row, folderId: jmapFolder.value.id });
    } else {
      const entry = imapByMessage.value.get(key);
      if (entry) sources.set(key, { kind: 'imap', entry });
    }
  }
  return sources;
});
const activeBundleRow = computed(() => {
  const bundle = activeBundle.value;
  if (!bundle) return {};
  return conversationRow(
    rows.value.get(browserTriageMessageKey(bundle.leading.message)) ?? {},
    bundle.messages.flatMap(({ message }) => rows.value.get(browserTriageMessageKey(message)) ?? []),
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
  const checkpoint = imapActions.cacheCheckpoint();
  const bundleRevision = bundleActions.revision();
  const [nextCache, folder] = await Promise.all([
    repo.getAttentionCache(props.ownerId),
    repo.folderByRole(props.ownerId, 'inbox'),
  ]);
  const rows: MessageRow[] = folder ? await repo.listMessagesForView({
    accountId: props.ownerId, folderId: folder.id, limit: WINDOW_SIZE,
  }) : [];
  if (!active || request !== loadSequence) return;
  const threadIds = [...new Set(rows.flatMap(({ thread_id }) => thread_id == null ? [] : [thread_id]))];
  const cachedThreadRows: MessageRow[] = folder && threadIds.length
    ? await repo.listMessagesForFolderThreads(folder.account_id, folder.id, threadIds) : [];
  if (!active || request !== loadSequence) return;
  const inboxDiscovered = folder != null && folder.id !== jmapFolder.value?.id;
  bundleActions.observe(bundleRevision, nextCache.states);
  cache.value = nextCache;
  imapActions.reconcileCache(props.ownerId, checkpoint, 'INBOX');
  jmapFolder.value = folder;
  const listed = new Set(rows.map(({ id }) => id));
  cachedJmapRows.value = [...rows, ...cachedThreadRows.filter(({ id }) => !listed.has(id))];
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

function releaseJmapReader(previous?: Reading) {
  if (previous?.kind === 'jmap' && mailStore.selectedMessageId === previous.message.id) {
    mailStore.selectMessage(null);
  }
}

async function closeReader() {
  const previous = reading.value;
  reading.value = undefined;
  openedBundle.value = undefined;
  showConversation.value = false;
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
  return imapByMessage.value.get(browserTriageMessageKey(message));
}

function readMessage(message: TriageMessage) {
  const messageId = message.id;
  if (typeof messageId === 'number' && jmapFolder.value) {
    imapReading.close();
    reading.value = { kind: 'jmap', message };
    mailStore.selectMessage(messageId, jmapFolder.value.id, () => jmapRowsById.value.get(messageId));
    return;
  }
  const row = findImapMessage(message);
  if (!row) return;
  releaseJmapReader(reading.value);
  reading.value = { kind: 'imap', message };
  if (!showConversation.value) void imapReading.open(row);
}

function focusReader(trigger: EventTarget | null) {
  openingButton = trigger instanceof HTMLElement ? trigger : undefined;
  const opened = reading.value;
  void nextTick(() => {
    if (reading.value === opened) readerTarget.value?.focus({ preventScroll: true });
  });
}

function openMessage(message: TriageMessage, trigger: EventTarget | null) {
  if (inPlace.value && !openedBundle.value && activeMessageKey.value === browserTriageMessageKey(message)) {
    void closeReader();
    return;
  }
  openedBundle.value = undefined;
  showConversation.value = false;
  readMessage(message);
  focusReader(trigger);
}

function openBundle(bundle: TriageBundle, trigger: EventTarget | null) {
  if (inPlace.value && activeBundle.value?.id === bundle.id) {
    void closeReader();
    return;
  }
  openedBundle.value = bundle;
  showConversation.value = bundle.messages.length > 1;
  readMessage(bundle.leading.message);
  focusReader(trigger);
}

async function runBatchAction(messages: readonly TriageMessage[], action: MailListAction | { type: 'trash' }, undoLabel?: string) {
  const targets: MailListSource[] = [];
  for (const message of messages) {
    if (typeof message.id === 'number') {
      const row = jmapRowsById.value.get(message.id);
      if (row && jmapFolder.value) targets.push({ kind: 'jmap', row, folder: jmapFolder.value });
    } else {
      const entry = findImapMessage(message);
      if (entry) targets.push({ kind: 'imap', entry });
    }
  }
  const listAction = action.type === 'trash' ? { type: 'delete' as const } : action;
  error.value = '';
  try {
    await runListAction(targets, listAction, tagDefinitions.value, {
      undoLabel: targets.length > 1 || listAction.type === 'read-and-archive' ? undoLabel : undefined,
    });
  } catch (cause) {
    report(cause);
  }
}

function runBundleAction(bundle: TriageBundle, action: ImapAttentionAction) {
  if (action.type === 'tags') return;
  const undoLabels = {
    star: action.type === 'star' && action.value ? 'Star conversation' : 'Unstar conversation',
    seen: action.type === 'seen' && action.value ? 'Mark conversation as read' : 'Mark conversation as unread',
    archive: 'Archive conversation',
    junk: 'Move conversation to Junk',
    trash: 'Move conversation to Trash',
  };
  return runBatchAction(bundle.messages.map(({ message }) => message), action, undoLabels[action.type]);
}

function runSelectionAction(messages: TriageMessage[], action: ImapAttentionAction) {
  if (action.type === 'tags') return;
  const label = action.type === 'trash' ? `Move ${messages.length} messages to Trash` : `Update ${messages.length} messages`;
  return runBatchAction(messages, action, label);
}

async function runMessageAction(message: TriageMessage, action: ImapAttentionAction) {
  error.value = '';
  if (typeof message.id !== 'number') {
    const entry = findImapMessage(message);
    if (!entry) return;
    await imapReading.runAction(entry, action);
    return;
  }
  try {
    const row = jmapRowsById.value.get(message.id);
    if (!row || !jmapFolder.value) return;
    const source = { sourceFolderId: jmapFolder.value.id, rows: [row] };
    if (action.type === 'star') await mailStore.markManyFlagged([message.id], action.value, source);
    else if (action.type === 'seen') await mailStore.markManySeen([message.id], action.value, source);
    else if (action.type === 'trash') await mailStore.destroyMessage(message.id, source);
  } catch (cause) {
    report(cause);
  }
}

watch([() => mailStore.selectedMessageId, jmapRowsById, imap, activeBundle], () => {
  const current = reading.value;
  if (!current) return;
  const bundle = activeBundle.value;
  if (bundle && bundle !== openedBundle.value) openedBundle.value = bundle;
  const available = current.kind === 'imap'
    ? Boolean(findImapMessage(current.message))
    : jmapRowsById.value.has(Number(current.message.id));
  if (!available && bundle) {
    readMessage(bundle.leading.message);
  } else if (!available || (current.kind === 'jmap' && mailStore.selectedMessageId !== current.message.id)) {
    void closeReader();
  }
});

function setBundleDisposition(bundle: TriageBundle, disposition: Parameters<typeof bundleActions.save>[2], event?: MouseEvent) {
  if (event) closeContainingDropdown(event, true);
  if (disposition === 'done') {
    return runBatchAction(bundle.messages.map(({ message }) => message), { type: 'read-and-archive' }, 'Marked as read and archived');
  }
  return bundleActions.save(repo, bundle, disposition);
}

const readerProps = computed(() => ({
  backLabel: readerBackLabel.value,
  maximized: maximized.value,
  imap: imapReader.value,
}));
const readerEvents = {
  back: closeReader,
  toggleMaximized: () => { maximized.value = !maximized.value; },
  imapAction: (action: ImapAttentionAction) =>
    reading.value?.kind === 'imap' && runMessageAction(reading.value.message, action),
  imapCompose: imapReading.composeResponse,
};

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
    :class="{
      'unified-attention--reading': reading && !inPlace,
      'unified-attention--maximized': maximized,
      'unified-attention--inline': inPlace,
    }"
    aria-label="Attention"
  >
    <div ref="list" v-show="!maximized" class="unified-attention__list">
      <AttentionInbox
        :bundles="bundles"
        :loading="loading"
        :error="error"
        :status="statusText"
        :inline-reading="inPlace"
        :open-bundle-id="activeBundle?.id"
        :open-message="reading?.message"
        :rows="rows"
        :tag-definitions="tagDefinitions"
        @open-bundle="openBundle"
        @open="openMessage"
        @bundle-action="runBundleAction"
        @message-action="runMessageAction"
        @selection-action="runSelectionAction"
        @inline-target="inlineTarget = $event"
        @inline-hidden="closeReader"
        @done="(bundle) => setBundleDisposition(bundle, 'done')"
        @snooze="(bundle, until) => setBundleDisposition(bundle, { snoozeUntil: until })"
        @restore="(bundle) => setBundleDisposition(bundle, 'restore')"
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
                role="checkbox"
                :aria-checked="inlineReading"
                @click="closeContainingDropdown($event, true); inlineReading = !inlineReading"
              >
                <Check :size="16" :style="{ visibility: inlineReading ? 'visible' : 'hidden' }" aria-hidden="true" />
                Read in place
              </button>
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
    <div v-show="!inPlace" ref="reader" class="unified-attention__reader" tabindex="-1">
      <p v-if="!reading" class="unified-attention__empty">Select a message to read it.</p>
    </div>
    <Teleport v-if="readerTarget" :to="readerTarget">
      <ConversationReader
        v-if="showConversation && activeBundle && activeMessageKey"
        :subject="threadSubject(activeBundle.messages.at(-1)?.message.subject)"
        :messages="conversationMessages"
        :active-key="activeMessageKey"
        :inline="inPlace && activeBundle.messages.length > 1"
        :back-label="readerBackLabel"
        @back="closeReader"
      >
        <template #actions>
          <AttentionRowMenu
            :row="activeBundleRow"
            :bundle="activeBundle"
            label="Conversation actions"
            @action="(action) => activeBundle && runBundleAction(activeBundle, action)"
            @done="(bundle, event) => setBundleDisposition(bundle, 'done', event)"
            @snooze="(bundle, until) => setBundleDisposition(bundle, { snoozeUntil: until })"
            @restore="(bundle, event) => setBundleDisposition(bundle, 'restore', event)"
          />
        </template>
        <template #default="{ messageKey, actionsTarget }">
          <ConversationMessage v-if="conversationSources.has(messageKey)"
            :source="conversationSources.get(messageKey)!" :owner-id="ownerId"
            :actions-target="actionsTarget"
            :repository="repo" :refresh-imap="loadCache" :maximized="maximized"
            @toggle-maximized="readerEvents.toggleMaximized" />
        </template>
      </ConversationReader>
      <MessageView
        v-else-if="reading?.kind === 'jmap' || imapReader"
        v-bind="readerProps"
        v-on="readerEvents"
      />
    </Teleport>
  </section>
</template>

<style scoped>
.unified-attention {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}
.unified-attention:not(.unified-attention--maximized, .unified-attention--inline) {
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
.unified-attention__tools {
  display: flex;
  flex: 0 0 auto;
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

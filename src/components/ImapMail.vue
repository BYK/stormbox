<script setup lang="ts">
import { AtSign, ChevronDown, List, RefreshCw, X } from '@lucide/vue';
import { useElementSize, useMediaQuery, useOnline } from '@vueuse/core';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { MailboxRole } from '../constants/states';
import { imapEntry, useImapReader } from '../composables/useImapReader';
import { useMessageTags } from '../composables/useMessageTags';
import { getRepositoryAsync } from '../composables/useRepository';
import { provideSenderAvatars } from '../composables/useSenderAvatars';
import { requestTagManager } from '../composables/useTagManagerRequest';
import type { AttentionCache, CachedImapAccount, CachedImapFolder } from '../db/attention';
import { TABLE_FAMILIES } from '../db/protocol';
import type { Repository } from '../db/repository';
import { JMAP_SERVER_URL } from '../defines';
import { disableWebPush, onWebPushRefresh } from '../push/client';
import { browserSessionEnabled } from '../services/browser-session';
import { useAuthStore } from '../stores/auth-store';
import { useComposeStore } from '../stores/compose-store';
import { useMailStore } from '../stores/mail-store';
import { GOOGLE_IMAP_RESULTS, GOOGLE_IMAP_RETURN_SPACE, type GoogleImapResult, type RelayFolder } from '../sync/backends/imap/attention-relay';
import type { FolderRow, MessageRow } from '../types/db';
import { folderPresentation } from '../utils/folder-presentation';
import { groupMailThreads, parseThreadHeaders, type ThreadMessage } from '../utils/mail-threads';
import { CARD_LAYOUT_WIDTH, CARD_ROW_HEIGHT, ROW_HEIGHT } from '../utils/message-row-presentation';
import AppIconButton from './AppIconButton.vue';
import FolderNode from './FolderNode.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import ImapMessageListRow from './ImapMessageListRow.vue';
import MessageListRow from './MessageListRow.vue';
import MessageView from './MessageView.vue';
import TagPickerPopover, { type PopoverAnchor } from './TagPickerPopover.vue';

type ImapEntry = ReturnType<typeof imapEntry>;
type InboxFolder = Pick<FolderRow, 'id' | 'account_id' | 'name' | 'role' | 'total_emails'>;
type ThreadEntry = ThreadMessage & (
  | { kind: 'imap'; entry: ImapEntry; row: ImapEntry['presentation'] }
  | { kind: 'jmap'; folder: InboxFolder; row: MessageRow }
);
type SavedView = { kind: 'unified' } | { kind: 'imap'; accountId: string; path: string };

const PAGE_SIZE = 120;
const THREAD_PAGE_SIZE = 60;
const unifiedFolderId = 'unified-inbox';

const props = defineProps<{ ownerId: number; search: string; folderTarget: HTMLElement }>();
const emit = defineEmits<{
  'folder-selected': [selected: boolean];
  'detail-visible': [visible: boolean];
  maximized: [maximized: boolean];
}>();
const online = useOnline();
const authStore = useAuthStore();
const composeStore = useComposeStore();
const mailStore = useMailStore();
const { definitions } = useMessageTags();
provideSenderAvatars();
const supportsRowHover = useMediaQuery('(hover: hover) and (pointer: fine)');
const cache = shallowRef<AttentionCache>({ paired: false, accounts: [], states: {} });
const managing = ref(false);
const googleResult = ref<GoogleImapResult>();
const selected = shallowRef<{ accountId: string; path: string }>();
const unified = ref(false);
const threadedFolder = shallowRef<InboxFolder>();
const cachedPrimaryInbox = shallowRef<InboxFolder>();
const folderWindow = shallowRef<CachedImapFolder | null>(null);
const folderLoading = ref(false);
const inboxLoading = ref(false);
const jmapLoading = ref(false);
const jmapLoadingOlder = ref(false);
const jmapError = ref('');
const jmapMessages = shallowRef<Array<{ folder: InboxFolder; row: MessageRow }>>([]);
const jmapLimit = ref(PAGE_SIZE);
const jmapReading = shallowRef<{ id: number; folderId: number }>();
const unreadOnly = ref(false);
const starredOnly = ref(false);
const expandedThreads = ref(new Set<string>());
const visibleThreadLimit = ref(THREAD_PAGE_SIZE);
const dismissedActionFailure = ref<number>();
const tagPopover = shallowRef<{ key: string; trigger: HTMLElement; anchor: PopoverAnchor }>();
const accountError = ref('');
const folderError = ref('');
const actionError = ref('');
const listHeading = ref<HTMLElement>();
const listElement = ref<HTMLElement>();
const { width: listWidth } = useElementSize(listElement);
const cardLayout = computed(() => listWidth.value > 0 && listWidth.value < CARD_LAYOUT_WIDTH);
const readerPane = ref<HTMLElement>();
const maximized = ref(false);
const listingByAccount = new Set<string>();
const expandedAccounts = new Set<string>();
const listErrors = ref(new Map<string, string>());
let repo: Repository;
let unsubscribe: (() => void) | undefined;
let unsubscribePush: (() => void) | undefined;
let heartbeat: number;
let mounted = false;
let cacheSequence = 0;
let folderSequence = 0;
let jmapSequence = 0;
let viewGeneration = 0;
let refreshJmapRequested = false;
let viewChosen = false;
let openingButton: HTMLElement | null = null;

const roles: Record<string, MailboxRole> = {
  '\\archive': 'archive', '\\all': 'all', '\\drafts': 'drafts', '\\sent': 'sent',
  '\\junk': 'junk', '\\trash': 'trash', '\\flagged': 'flagged', '\\important': 'important',
};
const inbox: RelayFolder = { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', delimiter: null };

function folders(account: CachedImapAccount) {
  return [inbox, ...(account.folders ?? []).filter(({ path }) => path.toUpperCase() !== 'INBOX')];
}

function folderRole(folder: RelayFolder) {
  return folder.path === 'INBOX' ? 'inbox' : roles[folder.specialUse?.toLowerCase() ?? ''];
}

function folderNode(folder: RelayFolder) {
  const role = folderRole(folder);
  const name = !role && folder.delimiter ? folder.path.split(folder.delimiter).join(' / ') : folder.name;
  const { icon, color: tone } = folderPresentation({ name, role });
  return { id: folder.path, name, icon, tone };
}

const account = computed(() => cache.value.accounts.find(({ relay_id }) => relay_id === selected.value?.accountId));
const active = computed(() => unified.value || threadedFolder.value != null || (selected.value != null && account.value != null));
const isInbox = computed(() => selected.value?.path === 'INBOX');
const folder = computed(() => account.value && folders(account.value).find(({ path }) => path === selected.value?.path));
const role = computed(() => unified.value ? 'inbox' : threadedFolder.value?.role ?? (folder.value && folderRole(folder.value)));
const loading = computed(() => {
  if (unified.value) return inboxLoading.value || jmapLoading.value;
  return threadedFolder.value ? jmapLoading.value : isInbox.value ? inboxLoading.value : folderLoading.value;
});
const syncedAt = computed(() => isInbox.value ? account.value?.last_synced_at : folderWindow.value?.syncedAt);
const total = computed(() => isInbox.value ? account.value?.total_messages : folderWindow.value?.total);
const syncError = computed(() => isInbox.value ? account.value?.sync_error : folderError.value);
const visibleSyncError = computed(() => {
  if (unified.value) return jmapError.value || accountError.value;
  return threadedFolder.value ? jmapError.value : syncError.value || accountError.value;
});
const asyncActionFailure = computed(() => {
  const failure = cache.value.actionFailure;
  return failure && failure.id !== dismissedActionFailure.value
    && (unified.value || failure.accountId === account.value?.relay_id) ? failure : undefined;
});
const imapEntries = computed(() => {
  if (unified.value) return cache.value.accounts.flatMap((source) => {
    const uidValidity = source.uid_validity;
    return uidValidity ? source.messages.map((row) => imapEntry(source, inbox.path, uidValidity, row)) : [];
  });
  const source = account.value;
  const path = selected.value?.path;
  if (!source || !path) return [];
  const uidValidity = isInbox.value ? source.uid_validity : folderWindow.value?.uidValidity;
  const rows = isInbox.value ? source.messages : folderWindow.value?.messages;
  return uidValidity && rows ? rows.map((row) => imapEntry(source, path, uidValidity, row)) : [];
});
const entries = computed<ThreadEntry[]>(() => [
  ...jmapMessages.value.map(({ folder: sourceFolder, row }) => ({
    kind: 'jmap' as const, key: `jmap:${row.id}`, folder: sourceFolder, row,
    accountKey: `jmap:${row.account_id}`, subject: row.subject,
    receivedAt: (mailStore.sortForFolder(sourceFolder.id) === 'sent' ? row.sent_at ?? row.received_at : row.received_at) ?? 0,
    nativeThreadId: row.remote_thread_id ?? row.thread_id, messageId: row.rfc822_message_id,
    references: parseThreadHeaders(row.references_json), inReplyTo: parseThreadHeaders(row.in_reply_to_json),
  })),
  ...imapEntries.value.map((entry) => ({
    kind: 'imap' as const, key: `imap:${entry.id}`, entry, row: entry.presentation,
    accountKey: `imap:${entry.account.relay_id}`, subject: entry.row.subject, receivedAt: entry.presentation.received_at,
    messageId: entry.row.messageId, references: entry.row.references,
    inReplyTo: entry.row.inReplyTo ? [entry.row.inReplyTo] : [],
  })),
]);
const threads = computed(() => groupMailThreads(entries.value));
const filteredThreads = computed(() => {
  const terms = props.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length && !unreadOnly.value && !starredOnly.value) return threads.value;
  return threads.value.filter(({ newest, previous }) => [newest, ...previous].some(({ row }) => {
    if (unreadOnly.value && row.is_seen !== 0) return false;
    if (starredOnly.value && row.is_flagged !== 1) return false;
    const haystack = [row.from_text, row.to_text, row.subject, row.preview].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }));
});
const visibleRows = computed(() => filteredThreads.value.slice(0, visibleThreadLimit.value).flatMap((thread) => [
  { entry: thread.newest, stack: thread.previous.length ? thread : undefined, nested: false },
  ...(expandedThreads.value.has(thread.key) ? thread.previous.map((entry) => ({ entry, stack: undefined, nested: true })) : []),
]));
const imapById = computed(() => new Map(imapEntries.value.map((entry) => [entry.id, entry])));
const jmapById = computed(() => new Map(jmapMessages.value.map(({ row }) => [row.id, row])));
const tagEntry = computed(() => entries.value.find((entry) => entry.kind === 'jmap' && entry.key === tagPopover.value?.key));
const reader = useImapReader(() => props.ownerId, () => repo, (id) => imapById.value.get(id), (cause) => {
  actionError.value = errorMessage(cause);
});
const readerProps = computed(() => reader.view.value && {
  ...reader.view.value,
  canArchive: role.value !== 'archive' && (!reader.view.value.gmailLabels || role.value === 'inbox'),
  canJunk: role.value !== 'junk',
  canTrash: role.value !== 'trash',
});
const reading = computed(() => Boolean(readerProps.value || jmapReading.value));
const canCompose = computed(() => unified.value || threadedFolder.value != null || account.value?.can_send === true);
const heading = computed(() => unified.value ? 'Unified Inbox' : threadedFolder.value?.name ?? folder.value?.name ?? selected.value?.path ?? '');
const jmapFolders = computed<InboxFolder[]>(() => {
  if (threadedFolder.value) {
    const saved = threadedFolder.value;
    return [mailStore.folders.find(({ id }) => id === saved.id) ?? saved];
  }
  if (!unified.value) return [];
  const found = mailStore.folders.filter((folder) => folder.role === 'inbox' && folder.may_read_items !== 0);
  return found.length ? found : cachedPrimaryInbox.value ? [cachedPrimaryInbox.value] : [];
});
const jmapFolderKey = computed(() => jmapFolders.value.map(({ id }) => id).join(','));
const canSyncJmap = computed(() => online.value && !authStore.isOfflineSession);
const canShowMore = computed(() => filteredThreads.value.length > visibleThreadLimit.value);
const canLoadMore = computed(() => canShowMore.value || (canSyncJmap.value
  && jmapFolders.value.some(({ total_emails }) => Number(total_emails) > jmapLimit.value)));
const jmapAccountName = computed(() => new Map(mailStore.accounts
  .map(({ id, primary_email, display_name }) => [id, primary_email ?? display_name])));

function rowContext(entry: ThreadEntry) {
  if (!unified.value) return undefined;
  return entry.kind === 'imap' ? entry.entry.account.address : jmapAccountName.value.get(entry.row.account_id) ?? undefined;
}

function toggleThread(key: string) {
  if (expandedThreads.value.has(key)) expandedThreads.value.delete(key);
  else expandedThreads.value.add(key);
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Could not sync this mail account.';
}

async function loadCache() {
  const sequence = ++cacheSequence;
  const next = await repo.getAttentionCache(props.ownerId);
  if (!mounted || sequence !== cacheSequence) return;
  cache.value = next;
  if (!viewChosen) restoreMailView();
  if (selected.value && !account.value) clearFolder();
}

async function loadSelectedFolder() {
  const current = selected.value;
  if (!current || current.path === 'INBOX') return;
  const sequence = ++folderSequence;
  const snapshot = await repo.getImapFolder(props.ownerId, current.accountId, current.path);
  if (mounted && selected.value === current && sequence === folderSequence) folderWindow.value = snapshot;
}

async function loadJmap() {
  if (!repo || !(unified.value || threadedFolder.value)) return;
  const sequence = ++jmapSequence;
  if (unified.value && !jmapFolders.value.length) {
    const storedInbox: InboxFolder | null = await repo.folderByRole(props.ownerId, 'inbox');
    if (!mounted || sequence !== jmapSequence) return;
    cachedPrimaryInbox.value = storedInbox ?? undefined;
  }
  const foldersForView = jmapFolders.value;
  const results = await Promise.allSettled(foldersForView.map(async (folder) => {
    const rows: MessageRow[] = await repo.listMessagesForView({
      accountId: folder.account_id, folderId: folder.id, sort: mailStore.sortForFolder(folder.id), limit: jmapLimit.value,
    });
    return rows.map((row) => ({ folder, row }));
  }));
  if (!mounted || sequence !== jmapSequence) return;
  const messages: typeof jmapMessages.value = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') messages.push(...result.value);
    else {
      jmapError.value = errorMessage(result.reason);
      messages.push(...jmapMessages.value.filter(({ folder }) => folder.id === foldersForView[index].id));
    }
  }
  jmapMessages.value = messages;
}

function reportJmapError(cause: unknown) {
  if (mounted && (unified.value || threadedFolder.value)) jmapError.value = errorMessage(cause);
}

async function syncJmapWindow(offset = 0) {
  const generation = viewGeneration;
  const results = await Promise.allSettled(jmapFolders.value.map((folder) => repo.ensureFolderWindow(folder.account_id, folder.id, {
    ...mailStore.jmapSortFor(mailStore.sortForFolder(folder.id)), offset, limit: PAGE_SIZE,
  })));
  if (!mounted || generation !== viewGeneration || !canSyncJmap.value) return;
  for (const result of results) if (result.status === 'rejected') reportJmapError(result.reason);
  await loadJmap();
}

async function refreshJmap() {
  if (!repo || !canSyncJmap.value || !(unified.value || threadedFolder.value)) return;
  if (jmapLoading.value) {
    refreshJmapRequested = true;
    return;
  }
  jmapLoading.value = true;
  jmapError.value = '';
  try {
    do {
      refreshJmapRequested = false;
      await syncJmapWindow();
    } while (refreshJmapRequested && mounted && (unified.value || threadedFolder.value) && canSyncJmap.value);
  } catch (cause) {
    reportJmapError(cause);
  } finally {
    jmapLoading.value = false;
  }
}

async function loadMore() {
  const revealingCached = canShowMore.value;
  visibleThreadLimit.value += THREAD_PAGE_SIZE;
  if (revealingCached || !repo || !canSyncJmap.value) return;
  const offset = jmapLimit.value;
  jmapLimit.value += PAGE_SIZE;
  void loadJmap().catch(reportJmapError);
  const generation = viewGeneration;
  jmapLoadingOlder.value = true;
  try {
    await syncJmapWindow(offset);
  } catch (cause) {
    if (generation === viewGeneration) reportJmapError(cause);
  } finally {
    if (generation === viewGeneration) jmapLoadingOlder.value = false;
  }
}

watch(jmapFolderKey, () => {
  if (!repo || !(unified.value || threadedFolder.value)) return;
  void loadJmap().catch(reportJmapError);
  void refreshJmap();
});
watch(() => authStore.isOfflineSession, (cachedSession) => {
  if (!cachedSession) void refreshJmap();
});

async function refreshInboxes() {
  if (!repo || !cache.value.paired || inboxLoading.value || !online.value) return;
  inboxLoading.value = true;
  accountError.value = '';
  try {
    await repo.refreshAttentionRelay(props.ownerId);
    await loadCache();
  } catch (cause) {
    accountError.value = errorMessage(cause);
  } finally {
    inboxLoading.value = false;
  }
}

async function refreshFolder() {
  const current = selected.value;
  if (!current || folderLoading.value || !online.value) return;
  if (current.path === 'INBOX') return refreshInboxes();
  folderLoading.value = true;
  folderError.value = '';
  try {
    await repo.getImapFolder(props.ownerId, current.accountId, current.path, true);
    if (selected.value === current) await loadSelectedFolder();
  } catch (cause) {
    if (selected.value === current) folderError.value = errorMessage(cause);
  } finally {
    if (selected.value === current) folderLoading.value = false;
  }
}

async function refreshFolderList(accountId: string) {
  if (!repo || !online.value || listingByAccount.has(accountId)) return;
  listingByAccount.add(accountId);
  listErrors.value.delete(accountId);
  try {
    await repo.refreshImapFolders(props.ownerId, accountId);
    await loadCache();
  } catch (cause) {
    listErrors.value.set(accountId, errorMessage(cause));
  } finally {
    listingByAccount.delete(accountId);
  }
}

function onAccountToggle(accountId: string, event: Event) {
  if (!(event.target as HTMLDetailsElement).open) {
    expandedAccounts.delete(accountId);
    return;
  }
  expandedAccounts.add(accountId);
  void refreshFolderList(accountId);
}

function refreshCurrent() {
  if (unified.value) {
    void refreshJmap();
    void refreshInboxes();
    return;
  }
  if (threadedFolder.value) {
    void refreshJmap();
    return;
  }
  if (!selected.value) return;
  void refreshFolder();
  void refreshFolderList(selected.value.accountId);
}

function rememberView(view?: SavedView) {
  try {
    const key = `stormbox:mail-view:${props.ownerId}`;
    if (view) localStorage.setItem(key, JSON.stringify(view));
    else localStorage.removeItem(key);
  } catch {
    // Mail navigation still works if storage has been disabled.
  }
}

function savedView(): SavedView | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(`stormbox:mail-view:${props.ownerId}`) ?? 'null');
    if (value?.kind === 'unified') return { kind: 'unified' };
    if (value?.kind === 'imap' && typeof value.accountId === 'string' && typeof value.path === 'string' && value.path) {
      return { kind: 'imap', accountId: value.accountId, path: value.path };
    }
  } catch {
    // Ignore unavailable or outdated preferences.
  }
  return undefined;
}

function restoreMailView() {
  const view = savedView();
  viewChosen = true;
  if (view?.kind === 'unified') pickUnified(false);
  else if (view?.kind === 'imap') {
    if (cache.value.accounts.some(({ relay_id }) => relay_id === view.accountId)) {
      void pickFolder(view.accountId, view.path, false);
    } else rememberView();
  }
}

function closeReader() {
  const current = jmapReading.value;
  jmapReading.value = undefined;
  if (current && mailStore.selectedMessageId === current.id && mailStore.selectedMessageFolderId === current.folderId) {
    mailStore.selectMessage(null);
  }
  reader.close();
}

function resetView() {
  viewChosen = true;
  viewGeneration += 1;
  closeReader();
  selected.value = undefined;
  unified.value = false;
  threadedFolder.value = undefined;
  folderWindow.value = null;
  folderLoading.value = false;
  folderError.value = '';
  actionError.value = '';
  jmapError.value = '';
  jmapSequence += 1;
  jmapLoadingOlder.value = false;
  jmapLimit.value = PAGE_SIZE;
  jmapMessages.value = [];
  unreadOnly.value = false;
  starredOnly.value = false;
  expandedThreads.value.clear();
  visibleThreadLimit.value = THREAD_PAGE_SIZE;
  tagPopover.value = undefined;
  openingButton = null;
  maximized.value = false;
}

function clearFolder() {
  resetView();
  rememberView();
  emit('folder-selected', false);
}

function focusHeading() {
  return nextTick(() => listHeading.value?.focus({ preventScroll: true }));
}

function pickUnified(focus = true) {
  if (unified.value) return;
  resetView();
  unified.value = true;
  rememberView({ kind: 'unified' });
  emit('folder-selected', true);
  if (focus) void focusHeading();
  void loadJmap().catch(reportJmapError);
  void refreshInboxes();
}

function openJmapFolder(folder: InboxFolder | null | undefined) {
  if (!folder || threadedFolder.value?.id === folder.id) return;
  resetView();
  threadedFolder.value = folder;
  rememberView();
  emit('folder-selected', true);
  void focusHeading();
  void loadJmap().catch(reportJmapError);
}

async function pickFolder(accountId: string, path: string, focus = true) {
  if (selected.value?.accountId === accountId && selected.value.path === path) return;
  resetView();
  selected.value = { accountId, path };
  rememberView({ kind: 'imap', accountId, path });
  emit('folder-selected', true);
  if (focus) void focusHeading();
  const current = selected.value;
  await loadSelectedFolder().catch((cause) => {
    if (selected.value === current) folderError.value = errorMessage(cause);
  });
  if (selected.value === current) void refreshFolder();
}

function openMessage(entry: ThreadEntry, button: HTMLElement | null) {
  openingButton = button;
  if (entry.kind === 'imap') {
    if (jmapReading.value) closeReader();
    void reader.open(entry.entry);
  } else {
    reader.close();
    jmapReading.value = { id: entry.row.id, folderId: entry.folder.id };
    mailStore.selectMessage(entry.row.id, entry.folder.id, () => jmapById.value.get(entry.row.id));
  }
  openingButton = button;
  void nextTick(() => readerPane.value?.focus({ preventScroll: true }));
}

watch([() => mailStore.selectedMessageId, () => mailStore.selectedMessageFolderId, jmapById], ([id, folderId]) => {
  const current = jmapReading.value;
  if (current && (current.id !== id || current.folderId !== folderId || !jmapById.value.has(current.id))) closeReader();
});

watch(reading, (next) => {
  emit('detail-visible', next);
  if (next) return;
  maximized.value = false;
  void nextTick(() => {
    if (reading.value || !active.value) return;
    if (openingButton?.isConnected) openingButton.focus({ preventScroll: true });
    else listHeading.value?.focus({ preventScroll: true });
    openingButton = null;
  });
});
watch(maximized, (value) => emit('maximized', value));

function startCompose() {
  if (unified.value || threadedFolder.value) {
    composeStore.open();
    return;
  }
  const sender = account.value;
  if (!sender?.can_send) return;
  composeStore.open({}, { origin: 'new', imapAccount: {
    id: sender.relay_id, email: sender.address, name: sender.name, ownerId: props.ownerId,
  } });
}

function openTagMenu(entry: ThreadEntry, event: MouseEvent) {
  const trigger = event.currentTarget;
  if (entry.kind !== 'jmap' || !(trigger instanceof HTMLElement)) return;
  if (tagPopover.value?.key === entry.key) {
    closeTagMenu();
    return;
  }
  const { top, left, width, height } = trigger.getBoundingClientRect();
  tagPopover.value = { key: entry.key, trigger, anchor: { top, left, width, height } };
}

function closeTagMenu() {
  tagPopover.value?.trigger.focus({ preventScroll: true });
  tagPopover.value = undefined;
}

type JmapRowAction = 'star' | 'archive' | 'delete' | 'tag' | 'clear-tags';
async function runJmapAction(entry: ThreadEntry | undefined, action: JmapRowAction, value = false, keyword = '') {
  if (entry?.kind !== 'jmap') return;
  const { row, folder } = entry;
  const source = { sourceFolderId: folder.id, rows: [row] };
  actionError.value = '';
  try {
    switch (action) {
      case 'star': await mailStore.markManyFlagged([row.id], value, source); break;
      case 'archive': await mailStore.archiveMessages([row.id], source); break;
      case 'delete': await mailStore.destroyMessage(row.id, source); break;
      case 'tag': await mailStore.setTagsMany([row.id], value ? { add: [keyword] } : { remove: [keyword] }, source); break;
      case 'clear-tags': await mailStore.clearTagsMany([row.id], source); break;
    }
    await loadJmap();
  } catch (cause) {
    if (active.value) actionError.value = errorMessage(cause);
  }
}

async function disconnect() {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration && 'pushManager' in registration) await disableWebPush(registration).catch(() => {});
  await repo.disconnectAttentionRelay(props.ownerId);
  await loadCache();
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  void refreshInboxes();
  if (!isInbox.value) void refreshFolder();
  void refreshJmap();
}

onMounted(async () => {
  mounted = true;
  try {
    repo = await getRepositoryAsync();
    if (!mounted) return;
    unsubscribe = repo.subscribe((tables) => {
      if (tables.includes(TABLE_FAMILIES.IMAP_MUTATIONS)) onVisible();
      if (tables.includes(TABLE_FAMILIES.ATTENTION)) {
        void Promise.all([loadCache(), loadSelectedFolder()]).catch((cause) => { accountError.value = errorMessage(cause); });
      }
      if (tables.includes(TABLE_FAMILIES.MESSAGES) || tables.includes(TABLE_FAMILIES.FOLDERS)) {
        void loadJmap().catch(reportJmapError);
      }
    });
    unsubscribePush = onWebPushRefresh(onVisible);
    await loadCache().catch((cause) => { accountError.value = errorMessage(cause); });
    if (!mounted) return;
    const url = new URL(window.location.href);
    const result = GOOGLE_IMAP_RESULTS.find((value) => value === url.searchParams.get('google_imap'));
    if (result) {
      googleResult.value = result;
      managing.value = true;
      window.sessionStorage.removeItem(GOOGLE_IMAP_RETURN_SPACE);
      url.searchParams.delete('google_imap');
      url.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', url);
    }
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
    heartbeat = window.setInterval(onVisible, 60_000);
  } catch (cause) {
    accountError.value = errorMessage(cause);
  }
});

watch(online, (value) => {
  if (!value || !repo) return;
  onVisible();
  for (const accountId of expandedAccounts) void refreshFolderList(accountId);
});
onBeforeUnmount(() => {
  mounted = false;
  resetView();
  emit('folder-selected', false);
  emit('detail-visible', false);
  emit('maximized', false);
  unsubscribe?.();
  unsubscribePush?.();
  document.removeEventListener('visibilitychange', onVisible);
  window.clearInterval(heartbeat);
});

defineExpose({ canCompose, clearFolder, openJmapFolder, startCompose });
</script>

<template>
  <Teleport :to="folderTarget">
    <FolderNode :folder="{ ...folderNode(inbox), name: 'Unified Inbox', id: unifiedFolderId }"
      :current-folder-id="unified ? unifiedFolderId : null" :is-collapsed="() => false" :on-toggle="() => {}"
      :on-pick="() => pickUnified()" />
    <div class="imap-nav__heading">
      <h3>IMAP accounts</h3>
      <AppIconButton title="Manage IMAP accounts" aria-label="Manage IMAP accounts" @click="managing = true">
        <AtSign :size="16" aria-hidden="true" />
      </AppIconButton>
    </div>
    <p v-if="accountError && !active" class="imap-nav__status" role="alert">{{ accountError }}</p>
    <details v-for="entry in cache.accounts" :key="entry.relay_id" class="imap-nav__account"
      :open="selected?.accountId === entry.relay_id || undefined"
      @toggle="onAccountToggle(entry.relay_id, $event)">
      <summary :title="entry.address">
        <span>{{ entry.address }}</span>
        <span v-if="entry.sync_error" class="imap-nav__error" aria-label="Inbox sync failed">!</span>
      </summary>
      <FolderNode v-for="option in folders(entry)" :key="option.path" :folder="folderNode(option)"
        :current-folder-id="selected?.accountId === entry.relay_id ? selected.path : null"
        :is-collapsed="() => false" :on-toggle="() => {}" :on-pick="() => pickFolder(entry.relay_id, option.path)" />
      <p v-if="listErrors.has(entry.relay_id)" class="imap-nav__status" role="status">{{ listErrors.get(entry.relay_id) }}</p>
    </details>
  </Teleport>

  <section v-if="active" class="imap-mail" :aria-label="heading"
    :class="{ 'imap-mail--reading': reading, 'imap-mail--maximized': maximized }">
    <div v-show="!maximized" ref="listElement" class="imap-mail__list msg-list" :class="{ 'msg-list--card': cardLayout }">
      <header class="imap-mail__header">
        <div>
          <h2 ref="listHeading" tabindex="-1">{{ heading }}</h2>
          <p v-if="account">{{ account.address }}</p>
        </div>
        <div class="imap-mail__header-actions">
          <AppIconButton v-if="threadedFolder" title="Flat message list" aria-label="Flat message list" @click="clearFolder">
            <List :size="17" aria-hidden="true" />
          </AppIconButton>
          <AppIconButton title="Refresh folder" aria-label="Refresh folder" :disabled="loading || !online" @click="refreshCurrent">
            <RefreshCw :size="17" aria-hidden="true" />
          </AppIconButton>
        </div>
      </header>
      <div class="imap-mail__filters" aria-label="Filter conversations" role="group">
        <button type="button" :aria-pressed="unreadOnly" @click="unreadOnly = !unreadOnly">Unread</button>
        <button type="button" :aria-pressed="starredOnly" @click="starredOnly = !starredOnly">Starred</button>
      </div>
      <div class="imap-mail__status" role="status">
        <p v-if="visibleSyncError" class="imap-nav__error">{{ visibleSyncError }}</p>
        <p v-if="loading && !entries.length">Syncing…</p>
        <p v-else-if="syncedAt">Last synced {{ new Date(syncedAt).toLocaleString() }}</p>
        <p v-if="total != null && total > imapEntries.length">{{ imapEntries.length }} most recent of {{ total.toLocaleString() }} messages</p>
        <p v-if="actionError" class="imap-nav__error">{{ actionError }}</p>
        <div v-if="asyncActionFailure" class="imap-mail__failure imap-nav__error">
          <p>{{ asyncActionFailure.message }}</p>
          <AppIconButton title="Dismiss sync error" aria-label="Dismiss sync error" @click="dismissedActionFailure = asyncActionFailure?.id">
            <X :size="15" aria-hidden="true" />
          </AppIconButton>
        </div>
      </div>
      <div class="imap-mail__scroll">
        <ul v-if="visibleRows.length" class="imap-mail__rows msg-list__items" aria-label="Conversations">
          <template v-for="{ entry, stack, nested } in visibleRows" :key="entry.key">
            <ImapMessageListRow v-if="entry.kind === 'imap'" :entry="entry.entry" :size="cardLayout ? CARD_ROW_HEIGHT : ROW_HEIGHT"
              :class="{ 'imap-mail__nested': nested }" :context="rowContext(entry)" :focused="readerProps?.id === entry.entry.id"
              :shows-recipients="role === 'sent' || role === 'drafts'" :disabled="reader.disabled(entry.entry.id)"
              :can-archive="role !== 'archive'" :can-trash="role !== 'trash'" :can-junk="role !== 'junk'"
              :definitions="definitions" :hover-actions="supportsRowHover"
              @row-click="(_event, button) => openMessage(entry, button)"
              @action="actionError = ''; reader.runAction(entry.entry, $event)">
              <template v-if="stack" #controls>
                <button type="button" class="imap-mail__stack" :aria-expanded="expandedThreads.has(stack.key)"
                  :aria-label="`${expandedThreads.has(stack.key) ? 'Hide' : 'Show'} ${stack.previous.length} earlier messages`"
                  @click.stop="toggleThread(stack.key)">
                  +{{ stack.previous.length }} <ChevronDown :size="14" aria-hidden="true" />
                </button>
              </template>
            </ImapMessageListRow>
            <MessageListRow v-else :message="entry.row" :size="cardLayout ? CARD_ROW_HEIGHT : ROW_HEIGHT"
              :class="{ 'imap-mail__nested': nested }" :context="rowContext(entry)" dom-id-prefix="threaded-mail-row-"
              :focused="jmapReading?.id === entry.row.id" :selectable="false" :draggable="false" unread-on-avatar
              :shows-recipients="role === 'sent' || role === 'drafts'" :sort="mailStore.sortForFolder(entry.folder.id)"
              :tag-definitions="definitions" :hover-actions="supportsRowHover"
              :archive-action="role !== 'archive'" :tag-menu-open="tagPopover?.key === entry.key"
              @row-click="(_event, button) => openMessage(entry, button)" @tag="openTagMenu(entry, $event)"
              @star="runJmapAction(entry, 'star', $event)" @archive="runJmapAction(entry, 'archive')"
              @delete="runJmapAction(entry, 'delete')">
              <template v-if="stack" #controls>
                <div class="msg-list__row-controls" @click.stop>
                  <button type="button" class="imap-mail__stack" :aria-expanded="expandedThreads.has(stack.key)"
                    :aria-label="`${expandedThreads.has(stack.key) ? 'Hide' : 'Show'} ${stack.previous.length} earlier messages`"
                    @click="toggleThread(stack.key)">
                    +{{ stack.previous.length }} <ChevronDown :size="14" aria-hidden="true" />
                  </button>
                </div>
              </template>
            </MessageListRow>
          </template>
        </ul>
        <p v-else-if="entries.length || !loading" class="imap-mail__empty">
          {{ search.trim() || unreadOnly || starredOnly ? 'No matches in downloaded messages.'
            : !online ? 'No downloaded mail.' : selected && isInbox && !syncedAt && !syncError ? 'Waiting for first sync.' : 'This folder is empty.' }}
        </p>
        <button v-if="canLoadMore || jmapLoadingOlder" type="button" class="imap-mail__more"
          :disabled="jmapLoadingOlder && !canShowMore" @click="loadMore">{{ jmapLoadingOlder ? 'Loading older mail…' : 'Load older mail' }}</button>
      </div>
    </div>
    <div v-if="reading" ref="readerPane" class="imap-mail__reader" tabindex="-1">
      <MessageView :imap="readerProps" :maximized="maximized" back-label="Back to conversations"
        @back="closeReader" @toggle-maximized="maximized = !maximized"
        @imap-action="reader.current.value && reader.runAction(reader.current.value, $event)"
        @imap-compose="reader.composeResponse" />
    </div>
    <TagPickerPopover :anchor="tagPopover?.anchor ?? null" :trigger="tagPopover?.trigger ?? null"
      :return-focus="tagPopover?.trigger ?? null" :targets="tagEntry ? [tagEntry.row] : []" :definitions="definitions"
      @close="closeTagMenu" @manage="closeTagMenu(); requestTagManager()"
      @toggle="(keyword, on) => runJmapAction(tagEntry, 'tag', on, keyword)" @clear="runJmapAction(tagEntry, 'clear-tags')" />
  </section>

  <ImapAccountsDialog v-if="managing" :owner-id="ownerId" :paired="cache.paired"
    :automatic="browserSessionEnabled(JMAP_SERVER_URL)" :google-result="googleResult" :disconnect="disconnect" return-to-mail
    @paired="loadCache" @account-change="refreshInboxes" @close="managing = false; googleResult = undefined" />
</template>

<style scoped>
.imap-nav__heading { display: flex; align-items: center; justify-content: space-between; margin: 8px 4px 0 10px; }
.imap-nav__heading h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--muted); }
.imap-nav__account summary { padding: 7px 10px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imap-nav__account summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
.imap-nav__account summary span + span { margin-inline-start: 5px; font-weight: 700; }
.imap-nav__status { margin: 4px 10px; color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.imap-nav__error { color: var(--error-fg); }
.imap-mail { grid-column: 4 / -1; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
.imap-mail--reading:not(.imap-mail--maximized) { grid-template-columns: minmax(280px, var(--message-columns-width)) minmax(0, 1fr); }
.imap-mail__list { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.imap-mail__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.imap-mail__header > div { min-width: 0; }
.imap-mail__header-actions { display: flex; align-items: center; gap: 4px; }
.imap-mail__header h2 { margin: 0; font-size: 1rem; }
.imap-mail__header p, .imap-mail__status p { margin: 0; overflow-wrap: anywhere; }
.imap-mail__header p, .imap-mail__status, .imap-mail__empty { color: var(--muted); font-size: .82rem; }
.imap-mail__status:has(p), .imap-mail__empty { margin: 0; padding: 8px 14px; }
.imap-mail__failure { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.imap-mail__filters { display: flex; gap: 6px; padding: 6px 14px; border-bottom: 1px solid var(--border); }
.imap-mail__filters button, .imap-mail__stack, .imap-mail__more {
  border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted);
  font: inherit; font-size: .8rem; cursor: pointer;
}
.imap-mail__filters button { padding: 4px 9px; }
.imap-mail__filters button:hover, .imap-mail__stack:hover, .imap-mail__more:hover { background: var(--rowHover); color: var(--text); }
.imap-mail__filters button[aria-pressed='true'] { background: var(--rowActive); color: var(--text); font-weight: 600; }
.imap-mail__stack { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 2px; min-height: 34px; white-space: nowrap; padding: 0 4px; }
.imap-mail__stack[aria-expanded='true'] svg { transform: rotate(180deg); }
.imap-mail__more { display: block; margin: 10px auto; padding: 6px 10px; }
.imap-mail__more:disabled { cursor: default; opacity: .6; }
.imap-mail__scroll { flex: 1; min-height: 0; overflow: auto; }
.imap-mail__rows { padding: 0; margin: 0; list-style: none; }
.imap-mail__nested { margin-inline-start: 14px; border-inline-start: 2px solid var(--border); }
.imap-mail__reader { min-height: 0; min-width: 0; border-inline-start: 1px solid var(--border); outline: none; }
.imap-mail__reader :deep(.message-view) { height: 100%; }
.imap-mail--maximized .imap-mail__reader { position: fixed; inset: 0; z-index: 45; }
@media (pointer: coarse) {
  .imap-mail__stack { min-width: 44px; min-height: 44px; }
}
@media (max-width: 839px) {
  .imap-mail--reading:not(.imap-mail--maximized) { grid-template-columns: minmax(0, 1fr); }
  .imap-mail--reading .imap-mail__list { display: none; }
}
</style>

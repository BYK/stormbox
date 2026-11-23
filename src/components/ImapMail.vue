<script setup lang="ts">
import { ChevronDown, Layers, List, X } from '@lucide/vue';
import { useElementSize, useMediaQuery, useOnline } from '@vueuse/core';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { MailboxRole } from '../constants/states';
import { useBulkActionItems } from '../composables/useBulkActionItems';
import { imapEntry, useImapReader } from '../composables/useImapReader';
import { useListSelection } from '../composables/useListSelection';
import { useMailListActions, usesGmailLabels, type MailListAction } from '../composables/useMailListActions';
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
import { folderCompare, folderPresentation } from '../utils/folder-presentation';
import { gmailLabelTags } from '../utils/imap-message-tags';
import { groupMailThreads, parseThreadHeaders, type ThreadMessage } from '../utils/mail-threads';
import { CARD_LAYOUT_WIDTH, CARD_ROW_HEIGHT, ROW_HEIGHT, folderShowsRecipients } from '../utils/message-row-presentation';
import { tagKeywordsOf } from '../utils/message-tags';
import { isScheduledMessage } from '../utils/scheduled-message';
import AppIconButton from './AppIconButton.vue';
import FolderNode from './FolderNode.vue';
import FolderTreeHeading from './FolderTreeHeading.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import MailAccountLabel from './MailAccountLabel.vue';
import type { MoreMenuItem } from './MessageListMoreMenu.vue';
import MessageListRow from './MessageListRow.vue';
import MessageListToolbar from './MessageListToolbar.vue';
import MessageView from './MessageView.vue';
import TagPickerDropdown from './TagPickerDropdown.vue';
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

const props = defineProps<{
  ownerId: number;
  search: string;
  folderTarget: HTMLElement;
  unifiedTarget?: HTMLElement | null;
  unreadCount?: number;
}>();
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
const imapThreaded = ref(false);
const expandedThreads = ref(new Set<string>());
const visibleThreadLimit = ref(THREAD_PAGE_SIZE);
const dismissedActionFailure = ref<number>();
const tagPopover = shallowRef<{ key?: string; trigger: HTMLElement; anchor: PopoverAnchor }>();
const accountError = ref('');
const folderError = ref('');
const actionError = ref('');
const listHeading = ref<HTMLElement>();
const listElement = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const { width: listWidth } = useElementSize(listElement);
const singlePane = useMediaQuery('(max-width: 839px)');
const cardLayout = computed(() => listWidth.value > 0 && listWidth.value < CARD_LAYOUT_WIDTH);
const readerPane = ref<HTMLElement>();
const maximized = ref(false);
const listingByAccount = new Set<string>();
const expandedAccounts = ref(new Set<string>());
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

function folderNode(folder: RelayFolder, unread = 0) {
  const role = folderRole(folder);
  const name = !role && folder.delimiter ? folder.path.split(folder.delimiter).join(' / ') : folder.name;
  const { icon, color: tone } = folderPresentation({ name, role });
  return { id: folder.path, name, role, icon, tone, unread_emails: unread };
}

const connectedAccounts = computed(() => cache.value.accounts.map((entry) => ({
  entry,
  headingId: `mail-account-folders-${props.ownerId}-${encodeURIComponent(entry.relay_id)}`,
  nodes: folders(entry).map((folder) => folderNode(folder, folder.path === inbox.path
    ? entry.messages.filter(({ seen }) => !seen).length : 0)).sort(folderCompare),
})));

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
const showThreads = computed(() => unified.value || threadedFolder.value != null || imapThreaded.value);
const threads = computed(() => showThreads.value ? groupMailThreads(entries.value) : entries.value.map((newest) => ({
  key: newest.key, newest, previous: [],
})));
const filteredThreads = computed(() => {
  const terms = props.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length && !unreadOnly.value && !starredOnly.value) return threads.value;
  const matches = ({ row }: ThreadEntry) => {
    if (unreadOnly.value && row.is_seen !== 0) return false;
    if (starredOnly.value && row.is_flagged !== 1) return false;
    const haystack = [row.from_text, row.to_text, row.subject, row.preview].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  return threads.value.flatMap(({ key, newest, previous }) => {
    const rows = [...previous, newest].filter(matches);
    const latest = rows.pop();
    return latest ? [{ key, newest: latest, previous: rows }] : [];
  }).sort((a, b) => b.newest.receivedAt - a.newest.receivedAt || a.key.localeCompare(b.key));
});
const visibleRows = computed(() => filteredThreads.value.slice(0, visibleThreadLimit.value).flatMap((thread) => [
  { entry: thread.newest, stack: thread.previous.length ? thread : undefined, nested: false },
  ...(expandedThreads.value.has(thread.key) ? thread.previous.map((entry) => ({ entry, stack: undefined, nested: true })) : []),
]));
const selectableRows = computed(() => visibleRows.value.map(({ entry }) => entry));
const visibleCount = computed(() => selectableRows.value.length);
const selection = useListSelection({ rows: selectableRows, total: visibleCount, getKey: (entry) => entry.key });
const { selectionCount, focusedId } = selection;
const allSelected = computed(() => visibleCount.value > 0 && selectionCount.value === visibleCount.value);
const selectedEntries = computed(() => selectableRows.value.filter(({ key }) => selection.isSelected(key)));
watch(selectableRows, (rows) => selection.retainOnly(rows.map(({ key }) => key)));
const imapById = computed(() => new Map(imapEntries.value.map((entry) => [entry.id, entry])));
const jmapById = computed(() => new Map(jmapMessages.value.map(({ row }) => [row.id, row])));
const tagEntries = computed(() => {
  if (!tagPopover.value) return [];
  const { key } = tagPopover.value;
  return key == null ? selectedEntries.value : entries.value.filter((entry) => entry.key === key);
});
const listActions = useMailListActions(() => props.ownerId, () => repo);
const pendingRows = ref(new Set<string>());
const reader = useImapReader(() => props.ownerId, () => repo, (id) => imapById.value.get(id), (cause) => {
  actionError.value = errorMessage(cause);
});
const readerProps = computed(() => reader.view.value && {
  ...reader.view.value,
  canArchive: role.value !== 'archive' && (!reader.view.value.gmailLabels || role.value === 'inbox'),
  canJunk: role.value !== 'junk',
  canTrash: role.value !== 'trash',
});
const reading = computed(() => !selectionCount.value && Boolean(readerProps.value || jmapReading.value));
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
const folderKey = computed(() => unified.value ? unifiedFolderId : threadedFolder.value?.id
  ?? (selected.value && JSON.stringify([selected.value.accountId, selected.value.path])) ?? null);
const totalCount = computed(() => {
  if (props.search.trim() || unreadOnly.value || starredOnly.value) {
    return filteredThreads.value.reduce((count, thread) => count + thread.previous.length + 1, 0);
  }
  if (unified.value) return jmapFolders.value.reduce((count, row) => count + (row.total_emails ?? 0), 0)
    + cache.value.accounts.reduce((count, source) => count + (source.total_messages ?? source.messages.length), 0);
  return threadedFolder.value ? (jmapFolders.value[0]?.total_emails ?? entries.value.length)
    : total.value ?? imapEntries.value.length;
});
const listStatus = computed(() => [...new Set([
  visibleSyncError.value, actionError.value, asyncActionFailure.value?.message,
  loading.value ? 'Syncing…' : syncedAt.value ? `Last synced ${new Date(syncedAt.value).toLocaleString()}` : '',
  total.value != null && total.value > imapEntries.value.length
    ? `${imapEntries.value.length} most recent of ${total.value.toLocaleString()} messages` : '',
].filter((item): item is string => Boolean(item)))]);
const listStatusError = computed(() => Boolean(visibleSyncError.value || actionError.value || asyncActionFailure.value));
const viewActions = computed<MoreMenuItem[]>(() => {
  if (unified.value) return [];
  if (threadedFolder.value) return [{ id: 'flat-view', label: 'Flat message list', icon: List, run: clearFolder }];
  return [{ id: 'threads', label: imapThreaded.value ? 'Flat message list' : 'Threaded view',
    icon: imapThreaded.value ? List : Layers, run: toggleImapThreads }];
});
const additionalTagsByEntry = computed(() => new Map(imapEntries.value.map((entry) => [
  entry.id, gmailLabelTags(entry.row.labels ?? [], definitions.value),
])));
function tagPickerFor(targets: readonly ThreadEntry[]) {
  const imap = targets.filter((entry): entry is Extract<ThreadEntry, { kind: 'imap' }> => usesGmailLabels(entry));
  if (!imap.length || imap.length !== targets.length) return {
    labels: [], definitions: definitions.value,
    rows: targets.map((entry) => {
      if (!usesGmailLabels(entry)) return entry.row;
      const keywords = tagKeywordsOf(entry.row.keywords_json, definitions.value);
      for (const { keyword, name } of definitions.value) {
        if (entry.entry.row.labels?.includes(name)) keywords.push(keyword);
      }
      return { ...entry.row, keywords_json: JSON.stringify(Object.fromEntries(keywords.map((keyword) => [keyword, true]))) };
    }),
  };
  const sources = new Set(imap.map(({ entry }) => entry.account));
  const known = [...sources].flatMap(({ messages }) => messages.flatMap((row) => row.labels ?? []));
  const labels = gmailLabelTags(imap.flatMap(({ entry }) => entry.row.labels ?? []), definitions.value, known)
    .map((tag) => ({ ...tag, applied: imap.every(({ entry }) => entry.row.labels?.includes(tag.name)) }));
  return { labels, rows: targets.map(({ row }) => row), definitions: definitions.value.filter(({ keyword }) =>
    targets.some(({ row }) => row.keywords_json?.includes(JSON.stringify(keyword)))) };
}

const rowTagPicker = computed(() => tagPickerFor(tagEntries.value));
const bulkTagPicker = computed(() => tagPickerFor(selectedEntries.value));
const never = computed(() => false);
const availableBulkActions = useBulkActionItems({
  folder: computed(() => ({ role: role.value || null })),
  canWhitelist: never,
  whitelisting: never,
  anyStarred: computed(() => selectedEntries.value.some(({ row }) => row.is_flagged === 1)),
  anyScheduled: never,
  handlers: {
    archive: () => runSelected({ type: 'archive' }),
    junk: () => runSelected({ type: 'junk' }),
    delete: () => runSelected({ type: 'delete' }),
    toggleStar: () => runSelected({ type: 'star', value: selectedEntries.value.every(({ row }) => row.is_flagged !== 1) }),
    markRead: () => runSelected({ type: 'seen', value: true }),
    markUnread: () => runSelected({ type: 'seen', value: false }),
    tag: () => openTagMenu(undefined, listElement.value?.querySelector('.msg-list__header')),
    cancelSend: () => {},
    whitelist: () => {},
  },
});
const bulkActionItems = computed(() => availableBulkActions.value.filter(({ id }) => {
  if (id === 'archive') return selectedEntries.value.every(canArchiveEntry);
  if (id === 'delete') return selectedEntries.value.every(canDeleteEntry);
  return true;
}).map((item) => ({ ...item, disabled: item.disabled || selectedEntries.value.some(rowBusy) })));

function rowBusy(entry: ThreadEntry) {
  return pendingRows.value.has(entry.key) || (entry.kind === 'imap' && reader.disabled(entry.entry.id));
}

function canArchiveEntry(entry: ThreadEntry) {
  return role.value !== 'archive' && (!usesGmailLabels(entry) || entry.entry.location.mailbox === inbox.path);
}

function canDeleteEntry(entry: ThreadEntry) {
  return entry.kind === 'jmap' || role.value !== 'trash';
}

function toggleImapThreads() {
  imapThreaded.value = !imapThreaded.value;
  expandedThreads.value.clear();
  selection.selectNone();
}

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

function expandAccount(accountId: string) {
  if (expandedAccounts.value.has(accountId)) return;
  expandedAccounts.value.add(accountId);
  void refreshFolderList(accountId);
}

function toggleAccount(accountId: string) {
  if (!expandedAccounts.value.delete(accountId)) expandAccount(accountId);
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
  const url = new URL(window.location.href);
  if (!url.searchParams.has('google_imap')) {
    if (view?.kind === 'unified') url.searchParams.set('view', 'unified');
    else if (url.searchParams.get('view') === 'unified') url.searchParams.delete('view');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }
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
  imapThreaded.value = false;
  selection.selectNone();
  focusedId.value = null;
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
  if (!folder || folder.role === 'scheduled' || threadedFolder.value?.id === folder.id) return;
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
  expandAccount(accountId);
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
  focusedId.value = entry.key;
  openingButton = button;
  if (entry.kind === 'imap') {
    if (jmapReading.value) closeReader();
    void reader.open(entry.entry);
    if (!entry.entry.row.seen) void reader.runAction(entry.entry, { type: 'seen', value: true });
  } else {
    reader.close();
    jmapReading.value = { id: entry.row.id, folderId: entry.folder.id };
    mailStore.selectMessage(entry.row.id, entry.folder.id, () => jmapById.value.get(entry.row.id));
  }
  openingButton = button;
  if (singlePane.value) void nextTick(() => (readerPane.value?.querySelector<HTMLElement>('.message-view') ?? readerPane.value)
    ?.focus({ preventScroll: true }));
}

function clickRow(entry: ThreadEntry, index: number, event: MouseEvent, button: HTMLElement | null) {
  scroller.value?.focus({ preventScroll: true });
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    selection.handleCheckboxClick(index, event, 0);
    return;
  }
  const wasSelecting = selection.hasSelection.value;
  selection.selectNone();
  focusedId.value = entry.key;
  const isOpen = entry.kind === 'imap' ? readerProps.value?.id === entry.entry.id : jmapReading.value?.id === entry.row.id;
  if (!wasSelecting && isOpen) closeReader();
  else openMessage(entry, button);
}

watch([() => mailStore.selectedMessageId, () => mailStore.selectedMessageFolderId, jmapById], ([id, folderId]) => {
  const current = jmapReading.value;
  if (current && (current.id !== id || current.folderId !== folderId || !jmapById.value.has(current.id))) closeReader();
});

watch(reading, (next) => {
  emit('detail-visible', next);
  if (next) return;
  maximized.value = false;
  if (selection.hasSelection.value) return;
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

function openTagMenu(entry: ThreadEntry | undefined, trigger: EventTarget | null | undefined) {
  if (!(trigger instanceof HTMLElement)) return;
  if (tagPopover.value && tagPopover.value.key === entry?.key && tagPopover.value.trigger === trigger) {
    closeTagMenu();
    return;
  }
  const { top, left, width, height } = trigger.getBoundingClientRect();
  tagPopover.value = { key: entry?.key, trigger, anchor: { top, left, width, height } };
}

function closeTagMenu() {
  tagPopover.value?.trigger.focus({ preventScroll: true });
  tagPopover.value = undefined;
}

async function runActions(targets: readonly ThreadEntry[], action: MailListAction) {
  if (!targets.length || targets.some(rowBusy)) return;
  const generation = viewGeneration;
  for (const target of targets) pendingRows.value.add(target.key);
  actionError.value = '';
  try {
    await listActions(targets, action, definitions.value);
    if (targets.some(({ kind }) => kind === 'jmap') && viewGeneration === generation) await loadJmap();
  } catch (cause) {
    if (active.value && viewGeneration === generation) actionError.value = errorMessage(cause);
  } finally {
    for (const target of targets) pendingRows.value.delete(target.key);
  }
}

function runSelected(action: MailListAction) {
  void runActions(selectedEntries.value, action);
}

function toggleSelectAll() {
  if (selection.hasSelection.value) selection.selectNone();
  else selection.selectAllLoaded();
}

function onListKeydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLElement && event.target.closest('[data-message-control], .imap-mail__stack')
      && (event.key === 'Enter' || event.key === ' ')) return;
  const result = selection.handleKeyDown(event);
  if (result.focusChanged) {
    const index = selection.focusedIndex.value;
    const entry = selectableRows.value[index];
    const row = scroller.value?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (entry && !event.shiftKey) openMessage(entry, row?.querySelector('.msg-list__open') ?? null);
  } else if (event.key === 'Enter' && !result.consumed && event.target === scroller.value) {
    scroller.value?.querySelector<HTMLButtonElement>(`[data-index="${Math.max(0, selection.focusedIndex.value)}"] .msg-list__open`)?.click();
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
    if (!viewChosen && (new URL(window.location.href).searchParams.get('view') === 'unified'
      || savedView()?.kind === 'unified')) pickUnified(false);
    await loadCache().catch((cause) => { accountError.value = errorMessage(cause); });
    if (!mounted) return;
    const url = new URL(window.location.href);
    const result = GOOGLE_IMAP_RESULTS.find((value) => value === url.searchParams.get('google_imap'));
    if (result) {
      googleResult.value = result;
      managing.value = true;
      window.sessionStorage.removeItem(GOOGLE_IMAP_RETURN_SPACE);
      url.searchParams.delete('google_imap');
      if (unified.value) url.searchParams.set('view', 'unified');
      else url.searchParams.delete('view');
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
  for (const accountId of expandedAccounts.value) void refreshFolderList(accountId);
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
  <Teleport :to="unifiedTarget ?? folderTarget">
    <FolderNode :folder="{ ...folderNode(inbox, unreadCount), name: 'Unified Inbox', id: unifiedFolderId }"
      tour-hook="unified-inbox"
      :current-folder-id="unified ? unifiedFolderId : null" :is-collapsed="() => false" :on-toggle="() => {}"
      :on-pick="() => pickUnified()" />
  </Teleport>
  <Teleport :to="folderTarget">
    <FolderTreeHeading label="Mail accounts" action-label="Manage mail accounts" @manage="managing = true" />
    <p v-if="accountError && !active" class="imap-nav__status" role="alert">{{ accountError }}</p>
    <section v-for="{ entry, nodes, headingId } in connectedAccounts" :key="entry.relay_id" class="imap-nav__account">
      <MailAccountLabel :address="entry.address" :expanded="expandedAccounts.has(entry.relay_id)"
        :controls="headingId" @toggle="toggleAccount(entry.relay_id)">
        <span v-if="entry.sync_error" class="imap-nav__error" aria-label="Inbox sync failed">!</span>
      </MailAccountLabel>
      <div v-show="expandedAccounts.has(entry.relay_id)" :id="headingId">
        <FolderNode v-for="node in nodes" :key="node.id" :folder="node"
          :current-folder-id="selected?.accountId === entry.relay_id ? selected.path : null"
          :is-collapsed="() => false" :on-toggle="() => {}" :on-pick="() => pickFolder(entry.relay_id, node.id)" />
        <p v-if="listErrors.has(entry.relay_id)" class="imap-nav__status" role="status">{{ listErrors.get(entry.relay_id) }}</p>
      </div>
    </section>
  </Teleport>

  <section v-if="active" class="imap-mail" :aria-label="heading"
    :class="{ 'imap-mail--reading': reading, 'imap-mail--maximized': maximized }">
    <div v-show="!maximized" ref="listElement" class="imap-mail__list msg-list" :class="{ 'msg-list--card': cardLayout }">
      <h2 ref="listHeading" class="imap-mail__focus-title" tabindex="-1">{{ heading }}</h2>
      <MessageListToolbar
        :list-width="listWidth"
        :folder-id="folderKey"
        :folder-name="heading"
        :total-count="totalCount"
        :all-selected="allSelected"
        :selected-count="selectionCount"
        :unread-only="unreadOnly"
        :starred-only="starredOnly"
        :is-loading="loading"
        :refresh-disabled="loading || !online"
        :status="listStatus"
        :status-error="listStatusError"
        :bulk-action-items="bulkActionItems"
        :view-actions="viewActions"
        @toggle-all="toggleSelectAll"
        @clear-selection="selection.selectNone()"
        @toggle-unread="unreadOnly = !unreadOnly"
        @toggle-starred="starredOnly = !starredOnly"
        @refresh="refreshCurrent"
      >
        <template #tag="{ item }">
          <TagPickerDropdown :targets="bulkTagPicker.rows" :definitions="bulkTagPicker.definitions" :disabled="item.disabled"
            :additional-tags="bulkTagPicker.labels" :label="item.ariaLabel" :title="item.title"
            trigger-class="msg-list__bulk-action msg-list__bulk-action--tag"
            @toggle="(keyword, value) => runSelected({ type: 'tag', keyword, value })"
            @clear="runSelected({ type: 'clear-tags' })" @manage="requestTagManager" />
        </template>
        <template v-if="asyncActionFailure" #status-actions>
          <AppIconButton title="Dismiss sync error" aria-label="Dismiss sync error" @click="dismissedActionFailure = asyncActionFailure?.id">
            <X :size="15" aria-hidden="true" />
          </AppIconButton>
        </template>
      </MessageListToolbar>
      <div ref="scroller" class="imap-mail__scroll msg-list__scroller" role="region" aria-label="Messages"
        tabindex="0" @keydown="onListKeydown">
        <ul v-if="visibleRows.length" class="imap-mail__rows msg-list__items" aria-label="Messages">
          <MessageListRow v-for="({ entry, stack, nested }, index) in visibleRows" :key="entry.key"
            :message="entry.row" :index="index" :size="cardLayout ? CARD_ROW_HEIGHT : ROW_HEIGHT"
            :class="{ 'imap-mail__nested': nested }" :context="rowContext(entry)" dom-id-prefix="account-mail-row-"
            :focused="entry.kind === 'imap' ? readerProps?.id === entry.entry.id : jmapReading?.id === entry.row.id"
            :cursor="focusedId === entry.key" :selected="selection.isSelected(entry.key)" :draggable="false"
            :shows-recipients="folderShowsRecipients({ role })"
            :sort="entry.kind === 'jmap' ? mailStore.sortForFolder(entry.folder.id) : 'received'"
            :tag-definitions="definitions"
            :additional-tags="entry.kind === 'imap' ? additionalTagsByEntry.get(entry.entry.id) : undefined"
            :hover-actions="!isScheduledMessage(entry.row)" :archive-action="canArchiveEntry(entry)"
            :delete-action="canDeleteEntry(entry)" :tag-menu-open="tagPopover?.key === entry.key" :actions-disabled="rowBusy(entry)"
            @row-click="(event, button) => clickRow(entry, index, event, button)"
            @checkbox-click="selection.handleCheckboxClick(index, $event, 0)"
            @tag="openTagMenu(entry, $event.currentTarget)"
            @star="runActions([entry], { type: 'star', value: $event })"
            @archive="runActions([entry], { type: 'archive' })"
            @delete="runActions([entry], { type: 'delete' })"
          >
            <template v-if="stack" #controls>
              <div class="msg-list__row-controls" @click.stop>
                <button type="button" class="imap-mail__stack" :aria-expanded="expandedThreads.has(stack.key)"
                  :aria-label="`${expandedThreads.has(stack.key) ? 'Hide' : 'Show'} ${stack.previous.length} earlier messages`"
                  @click.stop="toggleThread(stack.key)">
                  +{{ stack.previous.length }} <ChevronDown :size="14" aria-hidden="true" />
                </button>
              </div>
            </template>
          </MessageListRow>
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
      <MessageView :imap="readerProps" :maximized="maximized" back-label="Back"
        @back="closeReader" @toggle-maximized="maximized = !maximized"
        @imap-action="reader.current.value && reader.runAction(reader.current.value, $event)"
        @imap-compose="reader.composeResponse" />
    </div>
    <TagPickerPopover :anchor="tagPopover?.anchor ?? null" :trigger="tagPopover?.trigger ?? null"
      :return-focus="tagPopover?.trigger ?? null" :targets="rowTagPicker.rows" :busy="tagEntries.some(rowBusy)"
      :definitions="rowTagPicker.definitions" :additional-tags="rowTagPicker.labels"
      @close="closeTagMenu" @manage="closeTagMenu(); requestTagManager()"
      @toggle="(keyword, value) => runActions(tagEntries, { type: 'tag', keyword, value })"
      @clear="runActions(tagEntries, { type: 'clear-tags' })" />
  </section>

  <ImapAccountsDialog v-if="managing" :owner-id="ownerId" :paired="cache.paired"
    :automatic="browserSessionEnabled(JMAP_SERVER_URL)" :google-result="googleResult" :disconnect="disconnect" return-to-mail
    @paired="loadCache" @account-change="refreshInboxes" @close="managing = false; googleResult = undefined" />
</template>

<style scoped>
.imap-nav__status { margin: 4px 10px; color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.imap-nav__error { color: var(--error-fg); font-weight: 700; }
.imap-mail { grid-column: 4 / -1; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
.imap-mail--reading:not(.imap-mail--maximized) { grid-template-columns: minmax(280px, var(--message-columns-width)) minmax(0, 1fr); }
.imap-mail__list { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.imap-mail__focus-title { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; }
.imap-mail__empty { margin: 0; padding: 8px 14px; color: var(--muted); font-size: .82rem; }
.imap-mail__stack, .imap-mail__more {
  border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted);
  font: inherit; font-size: .8rem; cursor: pointer;
}
.imap-mail__stack:hover, .imap-mail__more:hover { background: var(--rowHover); color: var(--text); }
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

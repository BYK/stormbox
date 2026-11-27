<script setup lang="ts">
import { Archive, Layers, List, Mail, MailOpen, PanelTopOpen, Star, Trash2 } from '@lucide/vue';
import { useElementSize, useMediaQuery, useOnline } from '@vueuse/core';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, useId, watch } from 'vue';
import type { MailboxRole } from '../constants/states';
import { useBulkActionItems } from '../composables/useBulkActionItems';
import { imapEntry, useImapReader } from '../composables/useImapReader';
import { useInlineReading } from '../composables/useInlineReading';
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
import { useImapOptimisticActions } from '../stores/imap-optimistic-actions-store';
import { useMailActionFeedbackStore } from '../stores/mail-action-feedback-store';
import { useMailStore } from '../stores/mail-store';
import { GOOGLE_IMAP_RESULTS, GOOGLE_IMAP_RETURN_SPACE, type GoogleImapResult, type ImapAttentionAction, type RelayFolder } from '../sync/backends/imap/attention-relay';
import type { FolderRow, MessageRow } from '../types/db';
import { folderCapabilities } from '../utils/folder-capabilities';
import { folderCompare, folderPresentation } from '../utils/folder-presentation';
import { gmailLabelTags } from '../utils/imap-message-tags';
import { groupMailThreads, parseThreadHeaders, threadSubject, type MailThread, type ThreadMessage } from '../utils/mail-threads';
import { CARD_LAYOUT_WIDTH, CARD_ROW_HEIGHT, ROW_HEIGHT, conversationRow, correspondentLabel, folderShowsRecipients, recipientLabel } from '../utils/message-row-presentation';
import { tagKeywordsOf } from '../utils/message-tags';
import { isScheduledMessage } from '../utils/scheduled-message';
import AppIconButton from './AppIconButton.vue';
import AttentionRowMenu from './AttentionRowMenu.vue';
import ConversationReader from './ConversationReader.vue';
import ConversationMessage, { type ConversationMessageSource } from './ConversationMessage.vue';
import FolderNode from './FolderNode.vue';
import FolderTreeHeading from './FolderTreeHeading.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import InlineMailReader from './InlineMailReader.vue';
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
type ListRow = { key: string; entry: ThreadEntry; targets: ThreadEntry[]; stack?: MailThread<ThreadEntry>; stackSubject?: string; nested: boolean };
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
const inlineReading = useInlineReading();
const authStore = useAuthStore();
const composeStore = useComposeStore();
const mailStore = useMailStore();
const imapActions = useImapOptimisticActions();
const feedback = useMailActionFeedbackStore();
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
const activeMessageKey = ref<string>();
const lastExpandedMessageKey = ref<string>();
const openedThread = shallowRef<MailThread<ThreadEntry>>();
const unreadOnly = ref(false);
const starredOnly = ref(false);
const imapThreaded = ref(false);
const expandedThreads = ref(new Set<string>());
const selectedKeys = shallowRef(new Set<string>());
const visibleThreadLimit = ref(THREAD_PAGE_SIZE);
const tagPopover = shallowRef<{ key?: string; targets?: string[]; trigger: HTMLElement; anchor: PopoverAnchor }>();
const accountError = ref('');
const folderError = ref('');
const listHeading = ref<HTMLElement>();
const listElement = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const { width: listWidth } = useElementSize(listElement);
const singlePane = useMediaQuery('(max-width: 839px)');
const cardLayout = computed(() => listWidth.value > 0 && listWidth.value < CARD_LAYOUT_WIDTH);
const readerPane = ref<HTMLElement>();
const inlineTargets = shallowReactive(new Map<string, HTMLElement>());
const inlineReaderId = useId();
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

const imapInboxes = computed(() => new Map(cache.value.accounts.map((source) => [source.relay_id,
  source.uid_validity ? imapActions.projectFolder(props.ownerId, source.relay_id, inbox.path, source.uid_validity, source.messages) : [],
])));
const connectedAccounts = computed(() => cache.value.accounts.map((entry) => ({
  entry,
  headingId: `mail-account-folders-${props.ownerId}-${encodeURIComponent(entry.relay_id)}`,
  nodes: folders(entry).map((folder) => folderNode(folder, folder.path === inbox.path
    ? (imapInboxes.value.get(entry.relay_id) ?? []).filter(({ seen }) => !seen).length : 0)).sort(folderCompare),
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
const imapEntries = computed(() => {
  if (unified.value) return cache.value.accounts.flatMap((source) => {
    const uidValidity = source.uid_validity;
    return uidValidity ? (imapInboxes.value.get(source.relay_id) ?? [])
      .map((row) => imapEntry(source, inbox.path, uidValidity, row)) : [];
  });
  const source = account.value;
  const path = selected.value?.path;
  if (!source || !path) return [];
  const uidValidity = isInbox.value ? source.uid_validity : folderWindow.value?.uidValidity;
  if (!uidValidity) return [];
  const rows = isInbox.value ? imapInboxes.value.get(source.relay_id) : folderWindow.value?.messages;
  const projected = !isInbox.value && rows ? imapActions.projectFolder(props.ownerId, source.relay_id, path, uidValidity, rows) : rows;
  return (projected ?? []).map((row) => imapEntry(source, path, uidValidity, row));
});
const projectedJmapMessages = computed(() => {
  const groups = new Map<InboxFolder, MessageRow[]>();
  for (const { folder, row } of jmapMessages.value) {
    const rows = groups.get(folder) ?? [];
    rows.push(row);
    groups.set(folder, rows);
  }
  return Array.from(groups, ([folder, rows]) => mailStore.projectMailRows(folder.id, rows).map((row) => ({ folder, row }))).flat();
});
const entries = computed<ThreadEntry[]>(() => [
  ...projectedJmapMessages.value.map(({ folder: sourceFolder, row }) => ({
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
const entriesByKey = computed(() => new Map(entries.value.map((entry) => [entry.key, entry])));

function threadEntries(thread: MailThread<ThreadEntry>) {
  return [...thread.previous, thread.newest];
}

const threadByMember = computed(() => new Map(threads.value.flatMap((thread) =>
  threadEntries(thread).map(({ key }) => [key, thread] as const))));

const filteredThreads = computed(() => {
  const terms = props.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length && !unreadOnly.value && !starredOnly.value) return threads.value;
  return threads.value.filter((thread) => {
    const members = threadEntries(thread);
    const readingMember = inlineReading.value && members.some(({ key }) => key === activeMessageKey.value);
    if (!readingMember && unreadOnly.value && members.every(({ row }) => row.is_seen !== 0)) return false;
    if (!readingMember && starredOnly.value && members.every(({ row }) => row.is_flagged !== 1)) return false;
    return !terms.length || members.some(({ row }) => {
      const haystack = [row.from_text, row.to_text, row.subject, row.preview].join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  });
});
const visibleThreads = computed(() => filteredThreads.value.slice(0, visibleThreadLimit.value));
const visibleRows = computed<ListRow[]>(() => visibleThreads.value.flatMap((thread) => {
  const targets = threadEntries(thread);
  const stack = targets.length > 1 ? thread : undefined;
  const stackSubject = stack ? threadSubject(targets[0].subject) : undefined;
  const readingStack = inlineReading.value && !maximized.value && !selectedKeys.value.size
    && activeMessageKey.value != null && openedThread.value?.key === thread.key;
  return [
    { key: stack ? `conversation:${thread.key}` : thread.newest.key, entry: thread.newest, targets, stack, stackSubject, nested: false },
    ...(stack && expandedThreads.value.has(thread.key) && !readingStack
      ? targets.map((entry) => ({ key: entry.key, entry, targets: [entry], stackSubject, nested: true })) : []),
  ];
}));
const selectableEntries = computed(() => visibleThreads.value.flatMap(threadEntries));
const selection = useListSelection({
  rows: visibleRows, total: computed(() => visibleRows.value.length), getKey: ({ key }) => key, selectedIds: selectedKeys,
  getSelectionKeys: ({ targets }) => targets.map(({ key }) => key),
});
const { selectionCount, focusedId } = selection;
const allSelected = computed(() => selectableEntries.value.length > 0 && selectionCount.value === selectableEntries.value.length);
const selectedEntries = computed(() => selectableEntries.value.filter(({ key }) => selection.isSelected(key)));
watch(selectableEntries, (rows) => selection.retainOnly(rows.map(({ key }) => key)));
const imapById = computed(() => new Map(imapEntries.value.map((entry) => [entry.id, entry])));
const jmapById = computed(() => new Map(projectedJmapMessages.value.map(({ row }) => [row.id, row])));
const tagEntries = computed(() => {
  if (!tagPopover.value) return [];
  const { targets } = tagPopover.value;
  return targets == null ? selectedEntries.value : targets.flatMap((key) => entriesByKey.value.get(key) ?? []);
});
const listActions = useMailListActions(() => props.ownerId, () => repo, refreshLocalImap);
const reader = useImapReader(() => props.ownerId, () => repo, (id) => imapById.value.get(id), refreshLocalImap);
const readerProps = computed(() => reader.view.value && {
  ...reader.view.value,
  canArchive: role.value !== 'archive' && (!reader.view.value.gmailLabels || role.value === 'inbox'),
  canJunk: role.value !== 'junk',
  canTrash: role.value !== 'trash',
});
const activeThread = computed(() => activeMessageKey.value ? threadByMember.value.get(activeMessageKey.value) : undefined);
watch(activeThread, (thread) => {
  if (openedThread.value && thread) openedThread.value = thread;
});
const conversationEntries = computed(() => {
  const saved = openedThread.value;
  if (!saved) return [];
  if (activeThread.value) return threadEntries(activeThread.value);
  const lastExpanded = lastExpandedMessageKey.value;
  const surviving = (lastExpanded ? threadByMember.value.get(lastExpanded) : undefined)
    ?? threads.value.find(({ key }) => key === saved.key)
    ?? threadEntries(saved).reverse().map(({ key }) => threadByMember.value.get(key)).find(Boolean);
  return surviving ? threadEntries(surviving) : [];
});
const threadReaderOpen = computed(() => Boolean(openedThread.value
  && (openedThread.value.previous.length || conversationEntries.value.length > 1)));
watch([activeMessageKey, threadReaderOpen], ([key, threaded]) => {
  const entry = key ? entriesByKey.value.get(key) : undefined;
  if (threaded || entry?.kind !== 'imap') return reader.close();
  void reader.open(entry.entry);
  if (!entry.entry.row.seen) void reader.runAction(entry.entry, { type: 'seen', value: true }, { undo: false });
});
const conversationMessages = computed(() => conversationEntries.value.map((entry) => ({
  key: entry.key,
  sender: correspondentLabel(entry.row, folderShowsRecipients({ role: role.value })),
  subject: entry.subject,
  preview: entry.row.preview,
  timestamp: entry.receivedAt,
  unread: entry.row.is_seen === 0,
})));
const conversationSources = computed(() => new Map<string, ConversationMessageSource>(
  conversationEntries.value.map((entry) => [entry.key, entry.kind === 'jmap'
    ? { kind: 'jmap', row: entry.row, folderId: entry.folder.id }
    : { kind: 'imap', entry: entry.entry, canArchive: canArchiveEntry(entry),
      canJunk: role.value !== 'junk', canTrash: canDeleteEntry(entry) }]),
));
const reading = computed(() => !selectionCount.value && Boolean(activeMessageKey.value));
const inlineAnchorKey = computed(() => inlineReading.value && reading.value
  ? visibleRows.value.find(rowFocused)?.key : undefined);
const readingInline = computed(() => Boolean(inlineAnchorKey.value && !maximized.value));
const inlineConversationKey = computed(() => readingInline.value && threadReaderOpen.value ? inlineAnchorKey.value : undefined);
const sideReading = computed(() => reading.value && !readingInline.value);
const inlineTarget = computed(() => inlineAnchorKey.value ? inlineTargets.get(inlineAnchorKey.value) : undefined);
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
  visibleSyncError.value,
  loading.value ? 'Syncing…' : syncedAt.value ? `Last synced ${new Date(syncedAt.value).toLocaleString()}` : '',
  total.value != null && total.value > imapEntries.value.length
    ? `${imapEntries.value.length} most recent of ${total.value.toLocaleString()} messages` : '',
].filter((item): item is string => Boolean(item)))]);
const listStatusError = computed(() => Boolean(visibleSyncError.value));
const viewActions = computed<MoreMenuItem[]>(() => {
  const actions: MoreMenuItem[] = [{ id: 'read-inline', label: 'Read in place', icon: PanelTopOpen,
    checked: inlineReading.value, run: () => { inlineReading.value = !inlineReading.value; } }];
  if (threadedFolder.value) actions.push({ id: 'flat-view', label: 'Flat message list', icon: List, run: clearFolder });
  else if (!unified.value) actions.push({ id: 'threads', label: imapThreaded.value ? 'Flat message list' : 'Threaded view',
    icon: imapThreaded.value ? List : Layers, run: toggleImapThreads });
  return actions;
});
const additionalTagsByEntry = computed(() => new Map(imapEntries.value.map((entry) => [
  entry.id, gmailLabelTags(entry.row.labels ?? [], definitions.value),
])));

function rowPresentation({ entry, stack, targets }: ListRow) {
  if (!stack) return entry.row;
  return conversationRow(entry.row, targets.map(({ row }) => row), definitions.value);
}

function rowAdditionalTags(targets: readonly ThreadEntry[]) {
  const tags = targets.flatMap((entry) => entry.kind === 'imap' ? additionalTagsByEntry.value.get(entry.entry.id) ?? [] : []);
  return [...new Map(tags.map((tag) => [tag.keyword, tag])).values()];
}

function rowChecked({ targets }: ListRow) {
  return targets.every(({ key }) => selection.isSelected(key));
}

function rowMixed(row: ListRow) {
  return !rowChecked(row) && row.targets.some(({ key }) => selection.isSelected(key));
}

function rowFocused({ entry, nested, stack }: ListRow) {
  if (!openedThread.value) return !stack && activeMessageKey.value === entry.key;
  return !nested && conversationEntries.value.some(({ key }) => key === entry.key);
}

function setInlineTarget(key: string, element: unknown) {
  if (element instanceof HTMLElement) inlineTargets.set(key, element);
  else inlineTargets.delete(key);
}
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
  if (id === 'junk') return selectedEntries.value.every((entry) => entry.kind === 'imap' || canFileJmap(entry, 'junk'));
  return true;
}));

function canFileJmap(entry: Extract<ThreadEntry, { kind: 'jmap' }>, destination: 'archive' | 'trash' | 'junk') {
  const source = mailStore.folders.find(({ id }) => id === entry.folder.id);
  if (!source || !folderCapabilities(source, props.ownerId).mayRemoveItems) return false;
  if (source.role === destination) return destination === 'trash';
  const target = mailStore.folders.find((folder) => folder.account_id === source.account_id && folder.role === destination);
  return Boolean(target && folderCapabilities(target, props.ownerId).mayAddItems);
}

function canArchiveEntry(entry: ThreadEntry) {
  if (role.value === 'archive') return false;
  return entry.kind === 'jmap' ? canFileJmap(entry, 'archive')
    : !usesGmailLabels(entry) || entry.entry.location.mailbox === inbox.path;
}

function canDeleteEntry(entry: ThreadEntry) {
  return entry.kind === 'jmap' ? canFileJmap(entry, 'trash') : role.value !== 'trash';
}

function toggleImapThreads() {
  imapThreaded.value = !imapThreaded.value;
  closeReader();
  expandedThreads.value.clear();
  selection.selectNone();
}

function rowContext(entry: ThreadEntry) {
  if (!unified.value) return undefined;
  return recipientLabel(entry.row);
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
  const checkpoint = imapActions.cacheCheckpoint();
  const next = await repo.getAttentionCache(props.ownerId);
  if (!mounted || sequence !== cacheSequence) return;
  cache.value = next;
  imapActions.reconcileCache(props.ownerId, checkpoint, inbox.path);
  if (!viewChosen) restoreMailView();
  if (selected.value && !account.value) clearFolder();
}

async function loadSelectedFolder() {
  const current = selected.value;
  if (!current || current.path === 'INBOX') return;
  const sequence = ++folderSequence;
  const checkpoint = imapActions.cacheCheckpoint();
  const snapshot = await repo.getImapFolder(props.ownerId, current.accountId, current.path);
  if (mounted && selected.value === current && sequence === folderSequence) {
    folderWindow.value = snapshot;
    imapActions.reconcileCache(props.ownerId, checkpoint, current.path, current.accountId);
  }
}

async function refreshLocalImap() {
  await Promise.all([loadCache(), loadSelectedFolder()]);
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
    const threadIds = [...new Set(rows.flatMap(({ thread_id }) => thread_id == null ? [] : [thread_id]))];
    if (!threadIds.length) return rows.map((row) => ({ folder, row }));
    const cached: MessageRow[] = await repo.listMessagesForFolderThreads(folder.account_id, folder.id, threadIds);
    const listed = new Set(rows.map(({ id }) => id));
    return [...rows, ...cached.filter(({ id }) => !listed.has(id))].map((row) => ({ folder, row }));
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

function releaseJmapMessage() {
  const current = jmapReading.value;
  jmapReading.value = undefined;
  if (current && mailStore.selectedMessageId === current.id && mailStore.selectedMessageFolderId === current.folderId) {
    mailStore.selectMessage(null);
  }
}

function closeReader() {
  openedThread.value = undefined;
  lastExpandedMessageKey.value = undefined;
  activeMessageKey.value = undefined;
  releaseJmapMessage();
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

function showMessage(entry: ThreadEntry) {
  activeMessageKey.value = entry.key;
  if (entry.kind === 'imap') {
    releaseJmapMessage();
  } else {
    reader.close();
    jmapReading.value = { id: entry.row.id, folderId: entry.folder.id };
    mailStore.selectMessage(entry.row.id, entry.folder.id, () => jmapById.value.get(entry.row.id));
  }
}

function openRow({ entry, nested, key }: ListRow, button: HTMLElement | null) {
  focusedId.value = key;
  lastExpandedMessageKey.value = undefined;
  openedThread.value = showThreads.value && !nested ? threadByMember.value.get(entry.key) : undefined;
  showMessage(entry);
  openingButton = button;
  if (singlePane.value && !inlineReading.value) void nextTick(() => readerPane.value?.focus({ preventScroll: true }));
}

function clickRow(row: ListRow, index: number, event: MouseEvent, button: HTMLElement | null) {
  scroller.value?.focus({ preventScroll: true });
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    selection.handleCheckboxClick(index, event, 0);
    return;
  }
  const wasSelecting = selection.hasSelection.value;
  selection.selectNone();
  focusedId.value = row.key;
  const isOpen = rowFocused(row);
  if (!wasSelecting && isOpen) closeReader();
  else openRow(row, button);
}

watch([() => mailStore.selectedMessageId, () => mailStore.selectedMessageFolderId, entriesByKey], ([id, folderId, entries]) => {
  const key = activeMessageKey.value;
  if (key && !entries.has(key)) {
    const remaining = conversationEntries.value.at(-1);
    if (remaining) showMessage(remaining);
    else closeReader();
    return;
  }
  const current = jmapReading.value;
  if (current && (current.id !== id || current.folderId !== folderId)) closeReader();
});

watch(sideReading, (next) => emit('detail-visible', next));
watch(inlineAnchorKey, (key, previous) => {
  if (previous && !key && inlineReading.value && reading.value && !maximized.value) closeReader();
});
watch(reading, (next) => {
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

function openTagMenu(row: ListRow | undefined, trigger: EventTarget | null | undefined) {
  if (!(trigger instanceof HTMLElement)) return;
  const key = row?.key;
  if (tagPopover.value && tagPopover.value.key === key && tagPopover.value.trigger === trigger) {
    closeTagMenu();
    return;
  }
  const { top, left, width, height } = trigger.getBoundingClientRect();
  tagPopover.value = { key, targets: row?.targets.map((entry) => entry.key), trigger, anchor: { top, left, width, height } };
}

function closeTagMenu() {
  tagPopover.value?.trigger.focus({ preventScroll: true });
  tagPopover.value = undefined;
}

async function runActions(targets: readonly ThreadEntry[], action: MailListAction) {
  if (!targets.length) return;
  try {
    const undoLabel = showThreads.value && targets.length > 1
      ? `${action.type === 'delete' ? 'Delete' : action.type === 'archive' ? 'Archive' : 'Update'} ${targets.length} messages` : undefined;
    await listActions(targets, action, definitions.value, { undoLabel });
  } catch (cause) {
    feedback.showFailure(errorMessage(cause));
  }
}

function runSelected(action: MailListAction) {
  void runActions(selectedEntries.value, action);
}

function runConversationAction(targets: readonly ThreadEntry[], action: ImapAttentionAction) {
  if (action.type === 'tags') return;
  void runActions(targets, action.type === 'trash' ? { type: 'delete' } : action);
}

function toggleSelectAll() {
  if (allSelected.value) selection.selectNone();
  else selection.selectAllLoaded();
}

function onListKeydown(event: KeyboardEvent) {
  if (event.target instanceof HTMLElement) {
    if (event.target.closest('[data-inline-mail-reader]')) return;
    if (event.target.closest('[data-message-control]') && (event.key === 'Enter' || event.key === ' ')) return;
  }
  const result = selection.handleKeyDown(event);
  if (result.focusChanged) {
    const index = selection.focusedIndex.value;
    const item = visibleRows.value[index];
    const row = scroller.value?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (item && !event.shiftKey) openRow(item, row?.querySelector('.msg-list__open') ?? null);
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

let moveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMoveRefresh() {
  clearTimeout(moveRefreshTimer);
  moveRefreshTimer = setTimeout(() => {
    moveRefreshTimer = undefined;
    if (document.visibilityState !== 'visible') return;
    if (unified.value || isInbox.value) void refreshInboxes();
    else void refreshFolder();
  }, 1000);
}

onMounted(async () => {
  mounted = true;
  try {
    repo = await getRepositoryAsync();
    if (!mounted) return;
    unsubscribe = repo.subscribe((tables) => {
      if (tables.includes(TABLE_FAMILIES.IMAP_MUTATIONS)) scheduleMoveRefresh();
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
  clearTimeout(moveRefreshTimer);
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
    :class="{ 'imap-mail--reading': sideReading, 'imap-mail--maximized': maximized }">
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
      </MessageListToolbar>
      <div ref="scroller" class="imap-mail__scroll msg-list__scroller" role="region" aria-label="Messages"
        tabindex="0" @keydown="onListKeydown">
        <ul v-if="visibleRows.length" class="imap-mail__rows msg-list__items" aria-label="Messages">
          <MessageListRow v-for="(item, index) in visibleRows" :key="item.key"
            :message="rowPresentation(item)" :index="index" :size="cardLayout ? CARD_ROW_HEIGHT : ROW_HEIGHT"
            :class="{ 'imap-mail__nested': item.nested }" :nested="item.nested" :context="rowContext(item.entry)"
            :dom-id-prefix="item.stack ? 'account-mail-conversation-' : 'account-mail-row-'"
            :focused="rowFocused(item)" :cursor="focusedId === item.key" :selected="rowChecked(item)"
            :expanded="inlineReading ? readingInline && inlineAnchorKey === item.key : undefined"
            :reader-controls="readingInline && inlineAnchorKey === item.key ? inlineReaderId : undefined"
            :selection-mixed="rowMixed(item)" :conversation-count="item.stack ? item.targets.length : undefined" :draggable="false"
            :stack-expanded="item.stack ? expandedThreads.has(item.stack.key) : undefined"
            :stack-subject="item.stackSubject"
            :shows-recipients="folderShowsRecipients({ role })"
            :sort="item.entry.kind === 'jmap' ? mailStore.sortForFolder(item.entry.folder.id) : 'received'"
            :tag-definitions="definitions"
            :additional-tags="rowAdditionalTags(item.targets)"
            :hover-actions="item.key !== inlineConversationKey && !item.targets.some((target) => target.kind === 'jmap' && isScheduledMessage(target.row))"
            :archive-action="item.targets.every(canArchiveEntry)"
            :delete-action="item.targets.every(canDeleteEntry)" :tag-menu-open="tagPopover?.key === item.key"
            @row-click="(event, button) => clickRow(item, index, event, button)"
            @checkbox-click="selection.handleCheckboxClick(index, $event, 0)"
            @tag="openTagMenu(item, $event.currentTarget)"
            @star="runActions(item.targets, { type: 'star', value: $event })"
            @archive="runActions(item.targets, { type: 'archive' })"
            @delete="runActions(item.targets, { type: 'delete' })"
            @toggle-stack="item.stack && toggleThread(item.stack.key)"
          >
            <template v-if="item.stack && item.key === inlineConversationKey" #controls>
              <AttentionRowMenu :row="rowPresentation(item)" label="Conversation actions" can-tag
                :can-archive="item.targets.every(canArchiveEntry)" :can-trash="item.targets.every(canDeleteEntry)"
                @tag="openTagMenu(item, $event)" @action="runConversationAction(item.targets, $event)" />
            </template>
            <template #after-row>
              <InlineMailReader v-if="readingInline && inlineAnchorKey === item.key" :id="inlineReaderId">
                <div :ref="(element) => setInlineTarget(item.key, element)" class="imap-mail__inline-target" />
              </InlineMailReader>
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
    <Teleport v-if="reading" :to="inlineTarget" :disabled="!readingInline || !inlineTarget">
    <div v-show="!readingInline || inlineTarget" ref="readerPane" class="imap-mail__reader"
      :class="{ 'imap-mail__reader--inline': readingInline }" tabindex="-1">
      <ConversationReader v-if="threadReaderOpen && activeMessageKey" class="imap-mail__reader-content"
        :subject="threadSubject(conversationEntries[0]?.subject)" :messages="conversationMessages" :active-key="activeMessageKey"
        :inline="readingInline && conversationEntries.length > 1"
        :back-label="readingInline ? 'Collapse conversation' : undefined"
        @expand="lastExpandedMessageKey = $event" @back="closeReader">
        <template #actions>
          <AppIconButton v-if="conversationEntries.some(({ row }) => row.is_flagged === 1)"
            title="Unstar conversation" aria-label="Unstar conversation"
            @click="runActions(conversationEntries, { type: 'star', value: false })"><Star :size="18" fill="#facc15" /></AppIconButton>
          <AppIconButton v-else title="Star conversation" aria-label="Star conversation"
            @click="runActions(conversationEntries, { type: 'star', value: true })"><Star :size="18" /></AppIconButton>
          <AppIconButton v-if="conversationEntries.some(({ row }) => row.is_seen === 0)"
            title="Mark conversation as read" aria-label="Mark conversation as read"
            @click="runActions(conversationEntries, { type: 'seen', value: true })"><MailOpen :size="18" /></AppIconButton>
          <AppIconButton v-else title="Mark conversation as unread" aria-label="Mark conversation as unread"
            @click="runActions(conversationEntries, { type: 'seen', value: false })"><Mail :size="18" /></AppIconButton>
          <AppIconButton v-if="conversationEntries.every(canArchiveEntry)" title="Archive conversation" aria-label="Archive conversation"
            @click="runActions(conversationEntries, { type: 'archive' })"><Archive :size="18" /></AppIconButton>
          <AppIconButton v-if="conversationEntries.every(canDeleteEntry)" danger title="Delete conversation" aria-label="Delete conversation"
            @click="runActions(conversationEntries, { type: 'delete' })"><Trash2 :size="18" /></AppIconButton>
        </template>
        <template #default="{ messageKey, actionsTarget }">
          <ConversationMessage v-if="conversationSources.has(messageKey)"
            :source="conversationSources.get(messageKey)!" :owner-id="ownerId"
            :actions-target="actionsTarget"
            :repository="repo" :refresh-imap="refreshLocalImap" :maximized="maximized"
            @toggle-maximized="maximized = !maximized" />
        </template>
      </ConversationReader>
      <div v-else class="imap-mail__reader-content">
        <MessageView v-if="jmapReading || readerProps" :imap="readerProps" :maximized="maximized" :back-label="readingInline ? 'Collapse message' : 'Back'"
          @back="closeReader" @toggle-maximized="maximized = !maximized"
          @imap-action="reader.current.value && reader.runAction(reader.current.value, $event)"
          @imap-compose="reader.composeResponse" />
      </div>
    </div>
    </Teleport>
    <TagPickerPopover :anchor="tagPopover?.anchor ?? null" :trigger="tagPopover?.trigger ?? null"
      :return-focus="tagPopover?.trigger ?? null" :targets="rowTagPicker.rows"
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
.imap-mail__more {
  border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted);
  font: inherit; font-size: .8rem; cursor: pointer;
}
.imap-mail__more:hover { background: var(--rowHover); color: var(--text); }
.imap-mail__more { display: block; margin: 10px auto; padding: 6px 10px; }
.imap-mail__more:disabled { cursor: default; opacity: .6; }
.imap-mail__scroll { container-type: size; flex: 1; min-height: 0; overflow: auto; }
.imap-mail__rows { padding: 0; margin: 0; list-style: none; }
.imap-mail__reader { min-height: 0; min-width: 0; border-inline-start: 1px solid var(--border); outline: none; }
.imap-mail__inline-target, .imap-mail__reader--inline { height: 100%; }
.imap-mail__reader--inline { border-inline-start: 0; }
.imap-mail__reader-content { height: 100%; min-height: 0; }
.imap-mail__reader :deep(.message-view) { height: 100%; }
.imap-mail--maximized .imap-mail__reader { position: fixed; inset: 0; z-index: 45; }
@media (max-width: 839px) {
  .imap-mail--reading:not(.imap-mail--maximized) { grid-template-columns: minmax(0, 1fr); }
  .imap-mail--reading .imap-mail__list { display: none; }
}
</style>

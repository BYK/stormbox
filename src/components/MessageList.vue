<script setup lang="ts">
import {
  computed, nextTick, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import { Layers, PanelTopOpen, RefreshCw } from '@lucide/vue';
import { useResizeObserver } from '@vueuse/core';

import { useMailStore } from '../stores/mail-store';
import { useBulkActionItems } from '../composables/useBulkActionItems';
import { useInlineReading } from '../composables/useInlineReading';
import { useListSelection } from '../composables/useListSelection';
import {
  useMessageDragDrop,
  useMessageDropTarget,
} from '../composables/useMessageDragDrop';
import { useMessageListFilters } from '../composables/useMessageListFilters';
import { useMessageListViewport } from '../composables/useMessageListViewport';
import { useMessageTags } from '../composables/useMessageTags';
import { provideSenderAvatars } from '../composables/useSenderAvatars';
import { requestTagManager } from '../composables/useTagManagerRequest';
import {
  registerMessageListCommands,
  type MessageListNavigationCommand,
} from '../composables/useThunderbirdShortcuts';
import { folderShowsRecipients } from '../utils/message-row-presentation';
import { isScheduledMessage } from '../utils/scheduled-message';
import type { CachedRow } from '../stores/mail-store-types';
import type { FolderRow } from '../types';
import InlineMailReader from './InlineMailReader.vue';
import MessageListHeaderTitle from './MessageListHeaderTitle.vue';
import type { MoreMenuItem } from './MessageListMoreMenu.vue';
import MessageListRow from './MessageListRow.vue';
import MessageListToolbar from './MessageListToolbar.vue';
import TagPickerDropdown from './TagPickerDropdown.vue';
import TagPickerPopover, { type PopoverAnchor } from './TagPickerPopover.vue';

const mailStore = useMailStore();

/**
 * One message list column. The primary column follows the folder the
 * folder list selects (`mailStore.currentFolderId`) and carries the
 * "add column" control; every other column picks its own folder from
 * the dropdown at the start of its header and can be removed. Apart
 * from that, every column is the same list: the folder's cached window,
 * the shared one-row header, selection, keyboard navigation and bulk
 * actions.
 */
const props = withDefaults(defineProps<{
  /** Folder to list; omitted means the primary column's folder. */
  folderId?: number | null;
  /** Stable per-column key that keeps row DOM ids unique across columns. */
  listId?: string;
  /** 1-based position, for the region label. */
  columnIndex?: number;
  primary?: boolean;
  /**
   * True while this is the only column. The folder list already names
   * the folder then, so the header keeps the single list's layout: no
   * title, filters at the start.
   */
  soleColumn?: boolean;
  quickFilterQuery?: string;
  canAddColumn?: boolean;
  enableThreadedView?: boolean;
  inlineReadingColumn?: boolean;
}>(), {
  folderId: undefined,
  listId: '',
  columnIndex: 1,
  primary: true,
  soleColumn: true,
  quickFilterQuery: '',
  canAddColumn: true,
});

/** The primary column names its folder only beside other columns. */
const showsTitle = computed(() => !props.primary || !props.soleColumn);

const emit = defineEmits<{
  'add-column': [];
  'remove-column': [];
  'change-folder': [folderId: number];
  'show-threads': [folder: FolderRow];
  /** A row was opened in this column. */
  'open': [messageId: number];
}>();

// Failed avatar domains are remembered for this list's lifetime and
// shared by its rows; a remount (mail → contacts → mail) retries them.
provideSenderAvatars();

const folderId = computed<number | null>(() => (
  props.folderId === undefined ? mailStore.currentFolderId : props.folderId
));
const folder = computed<FolderRow | null>(() => mailStore.folderById(folderId.value));
const folderName = computed(() => folder.value?.name ?? 'Mail');
const regionLabel = computed(() => (
  folder.value
    ? `${folder.value.name} messages, column ${props.columnIndex}`
    : `Column ${props.columnIndex}, no folder chosen`
));
const rowDomIdPrefix = computed(() => (props.listId ? `msg-row-${props.listId}-` : 'msg-row-'));
const gridId = computed(() => (props.listId ? `msg-listbox-${props.listId}` : 'msg-listbox'));
const readInPlace = useInlineReading();
const inlineReaderId = computed(() => `${gridId.value}-inline-reader`);

// Every column binds its folder's cached window; the store keeps the
// bound folders fresh on broadcasts and asks the sync layer to keep
// reconciling them on push. The release runs on change and unmount.
watch(folderId, (id, _previous, onCleanup) => {
  if (id == null) return;
  const release = mailStore.bindFolderView(id);
  onCleanup(release);
}, { immediate: true });

const view = computed(() => mailStore.folderView(folderId.value));
const messages = computed(() => view.value.snapshot.messages);
const isLoading = computed(() => view.value.isLoading);
const listSort = computed(() => mailStore.sortForFolder(folderId.value));

// One selection and one keyboard cursor exist across all columns, each
// attributed to a folder. This column sees them only while they belong
// to its folder, and claims them for its folder when it writes.
const EMPTY_SELECTION: Set<number> = new Set();
const selectedIds = computed<Set<number>>({
  get: () => (
    folderId.value != null && Number(mailStore.selectionFolderId) === Number(folderId.value)
      ? mailStore.selectedIds
      : EMPTY_SELECTION
  ),
  set: (ids) => {
    mailStore.setSelection(folderId.value, ids);
  },
});
const focusedMessageId = computed<number | null>({
  get: () => (
    folderId.value != null && Number(mailStore.focusedFolderId) === Number(folderId.value)
      ? mailStore.focusedMessageId
      : null
  ),
  set: (id) => {
    mailStore.setFocusedMessage(id, folderId.value);
  },
});
/** The open message when it was opened from this column's folder. */
const openMessageId = computed<number | null>(() => (
  folderId.value != null
  && mailStore.selectedMessageId != null
  && Number(mailStore.openMessageFolderId) === Number(folderId.value)
    ? mailStore.selectedMessageId
    : null
));
const inlineMessageId = computed(() => props.inlineReadingColumn ? openMessageId.value : null);
const inlineReaderTarget = ref<HTMLElement | null>(null);
const inlineReaderRegion = computed(() => inlineReaderTarget.value?.parentElement ?? null);
const inlineReaderHeight = ref(0);

function setInlineReaderTarget(key: string | number | bigint, element: unknown) {
  if (element instanceof HTMLElement) inlineReaderTarget.value = element;
  else if (inlineReaderTarget.value?.dataset.inlineMessageId === String(key)) inlineReaderTarget.value = null;
}

function measureInlineReader() {
  if (inlineReaderRegion.value) inlineReaderHeight.value = inlineReaderRegion.value.getBoundingClientRect().height;
}

watch(inlineReaderRegion, measureInlineReader, { flush: 'post' });
useResizeObserver(inlineReaderRegion, measureInlineReader, { box: 'border-box' });

function openMessage(id: number | null) {
  mailStore.selectMessage(id, id == null ? undefined : folderId.value);
  if (id != null) emit('open', id);
}

const {
  unreadOnly,
  flaggedOnly,
  quickFilterActive,
  denseLocalFilterActive,
  visibleMessages,
  selectAllTargetMessages,
  toggleUnreadFilter,
  toggleFlaggedFilter,
} = useMessageListFilters({
  messages,
  quickFilterQuery: computed(() => props.quickFilterQuery),
  openMessageId,
  selectedIds,
  closeOpenMessage: () => openMessage(null),
  expandFolderView: () => { void mailStore.expandFolderViewIntoMemory(folderId.value); },
});

// Virtualizer count is the FOLDER TOTAL, not loaded count. That way
// the scrollbar reflects reality from the very first round trip and
// the user can scroll into "unloaded" territory; placeholders render
// there until ensureLoaded() pulls the matching page. Dense filters
// use their materialized row count.
const folderRowCount = computed(() => Math.max(
  view.value.snapshot.total,
  messages.value.length,
));
const rowCount = computed(() => (denseLocalFilterActive.value ? visibleMessages.value.length : folderRowCount.value));

const {
  selectionCount,
  hasSelection,
  isSelected,
  handleCheckboxClick,
  handleKeyDown: rawHandleKeyDown,
  selectNone,
  setFocused,
} = useListSelection({
  rows: visibleMessages,
  total: computed(() => rowCount.value),
  selectedIds,
  // The keyboard cursor is the store's focusedMessageId, so the global
  // list commands and arrow navigation share one source of truth, and
  // the scroll-follow watcher below tracks it.
  focusedId: focusedMessageId,
});

const {
  draggedIds,
  startMessageDrag,
  endMessageDrag,
} = useMessageDragDrop();

// Rows dragged from another column land in this column's folder under
// the same rules as a drop on the folder list. A drag from this very
// folder is a no-op with no highlight.
const {
  dropState,
  onDragEnter: onColumnDragEnter,
  onDragOver: onColumnDragOver,
  onDragLeave: onColumnDragLeave,
  onDrop: onColumnDrop,
} = useMessageDropTarget({
  targetFolderId: () => folderId.value,
  transferMode: (target, source) => mailStore.transferModeForFolder(target, source),
  drop: (ids, sourceFolderId) => mailStore.moveMessages(ids, folderId.value!, { sourceFolderId }),
});

function rowControls(row: Element): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('[data-message-control]')]
    .filter((control) => getComputedStyle(control).display !== 'none'
      && getComputedStyle(control).visibility !== 'hidden')
    .sort((a, b) => Number(b.matches('input')) - Number(a.matches('input')));
}

function onControlPointerInteraction(event: MouseEvent) {
  if ((event.type === 'contextmenu' ? event.button === 2 : event.detail > 0) && event.target instanceof Element
    && event.target.closest('[data-message-control], .msg-list__check')) {
    scrollEl.value?.focus({ preventScroll: true });
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (event.target instanceof Element && event.target.closest('[data-inline-mail-reader]')) return;
  if ((event.metaKey || event.ctrlKey) && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    selectAllForCurrentFilter();
    return;
  }
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  const control = event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-message-control]')
    : null;
  const row = control?.closest<HTMLElement>('[role="row"]');
  if (control && row) {
    if (event.key === 'Tab') {
      scrollEl.value?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Escape' || event.key === 'F2') {
      event.preventDefault();
      setFocused(Number(row.dataset.index));
      scrollEl.value?.focus({ preventScroll: true });
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const controls = rowControls(row);
      const index = controls.indexOf(control);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
        : index + (event.key === 'ArrowRight' ? 1 : -1);
      controls[Math.max(0, Math.min(controls.length - 1, next))]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Enter' && control instanceof HTMLInputElement) {
      event.preventDefault();
      control.dispatchEvent(new MouseEvent('click', {
        bubbles: true, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      }));
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    setFocused(Number(row.dataset.index));
    scrollEl.value?.focus({ preventScroll: true });
  } else if (event.key === 'F2' || event.key === 'ArrowRight' || event.key === 'Enter') {
    const rows = Array.from(scrollEl.value?.querySelectorAll<HTMLElement>('[role="row"]') ?? []);
    const viewport = scrollEl.value?.getBoundingClientRect();
    const inViewport = (row: HTMLElement) => {
      const bounds = row.getBoundingClientRect();
      return viewport != null && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    };
    const cursorRow = activeRowDomId.value ? document.getElementById(activeRowDomId.value) : null;
    const activeRow = cursorRow && inViewport(cursorRow) ? cursorRow
      : rows.find(inViewport) ?? cursorRow ?? rows[0];
    if (!activeRow) return;
    event.preventDefault();
    setFocused(Number(activeRow.dataset.index));
    if (event.key === 'Enter') {
      activeRow.querySelector<HTMLButtonElement>('.msg-list__open')?.click();
    } else {
      rowControls(activeRow)[0]?.focus();
    }
    return;
  }
  // Widget-scoped so the page keeps Home/End when the list is not focused.
  if ((event.key === 'Home' || event.key === 'End')
      && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    navigateMessageList(event.key === 'Home' ? 'first' : 'last');
    return;
  }
  const result = rawHandleKeyDown(event);
  // Plain Arrow nav also drives the preview pane (caller decides;
  // composable only knows about focus/selection, not body loads).
  if (result.consumed && result.focusChanged && result.focusedId != null
      && !event.shiftKey) {
    openMessage(result.focusedId);
  }
}

function navigateMessageList(command: MessageListNavigationCommand): void {
  switch (command) {
    case 'first':
      navigateToBoundary(1);
      return;
    case 'last':
      navigateToBoundary(-1);
      return;
    case 'next':
      navigateRelative(1, false);
      return;
    case 'nextUnread':
      navigateRelative(1, true);
      return;
    case 'previous':
      navigateRelative(-1, false);
      return;
    case 'previousUnread':
      navigateRelative(-1, true);
      return;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function navigateToBoundary(direction: 1 | -1): void {
  const rows = visibleMessages.value;
  for (
    let index = direction > 0 ? 0 : rows.length - 1;
    direction > 0 ? index < rows.length : index >= 0;
    index += direction
  ) {
    const id = rows[index]?.id;
    if (id == null) continue;
    openMessage(id);
    return;
  }
}

function navigateRelative(direction: 1 | -1, unreadOnly: boolean): void {
  const rows = visibleMessages.value;
  if (rows.length === 0) return;
  let index = focusedMessageId.value == null
    ? -1
    : rows.findIndex((row) => row?.id === focusedMessageId.value);
  if (index < 0) index = direction > 0 ? -1 : rows.length;
  for (
    let next = index + direction;
    direction > 0 ? next < rows.length : next >= 0;
    next += direction
  ) {
    const row = rows[next];
    if (row?.id == null) continue;
    if (unreadOnly && Number(row.is_seen) === 1) continue;
    openMessage(row.id);
    return;
  }
}

const msgListEl = ref<HTMLElement | null>(null);
const {
  scrollEl,
  listWidth,
  cardLayout,
  summaryHeight,
  totalSize,
  virtualItems,
  onScroll,
} = useMessageListViewport({
  listEl: msgListEl,
  folderId,
  primary: computed(() => props.primary),
  visibleMessages,
  rowCount,
  denseFilterActive: denseLocalFilterActive,
  focusedMessageId,
  inlineMessageId,
  inlineReaderHeight,
});

// Virtual rows outside the rendered window cannot be active descendants.
const activeRowDomId = computed(() => {
  const id = focusedMessageId.value;
  return id != null && virtualItems.value.some((item) => visibleMessages.value[item.index]?.id === id)
    ? `${rowDomIdPrefix.value}${id}`
    : undefined;
});

let unregisterMessageListCommands: (() => void) | null = null;

onMounted(() => {
  unregisterMessageListCommands = registerMessageListCommands({
    navigate: navigateMessageList,
    selectAll: selectAllForCurrentFilter,
    openTagMenu: openTagMenuForTargets,
    folderId: () => folderId.value,
    primary: () => props.primary,
    containsFocus: () => msgListEl.value?.contains(document.activeElement) === true,
  });
});

onBeforeUnmount(() => {
  unregisterMessageListCommands?.();
  unregisterMessageListCommands = null;
});

/**
 * Fastmail interaction model: a plain row-body click opens the
 * message, while modifier row-body clicks participate in the same
 * anchored multi-select model as checkbox clicks.
 */
function onRowClick(index, event) {
  scrollEl.value?.focus({ preventScroll: true });
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    handleCheckboxClick(index, event, firstVisibleIndex());
    return;
  }

  const hadSelection = hasSelection.value;
  const id = setFocused(index);
  if (id == null) return;
  if (hadSelection) {
    selectNone();
  }
  if (!hadSelection && id === openMessageId.value) {
    openMessage(null);
    return;
  }
  openMessage(id);
}

function onCheckboxClick(index, event) {
  event.stopPropagation();
  handleCheckboxClick(index, event, firstVisibleIndex());
}

function firstVisibleIndex() {
  return virtualItems.value[0]?.index ?? 0;
}

function onRowDragStart(message, event) {
  scrollEl.value?.focus({ preventScroll: true });
  startMessageDrag(event, {
    messageId: message?.id,
    selectedIds: selectedIds.value,
    sourceFolderId: folderId.value,
  });
}

function isDraggingMessage(messageId) {
  const id = Number(messageId);
  return Number.isFinite(id) && draggedIds.value.includes(id);
}

const listShowsRecipients = computed(() => folderShowsRecipients(folder.value));
// Archiving from Archive is a no-op; the row overlay and the bulk toolbar leave it out.
const isArchiveFolder = computed(() => folder.value?.role === 'archive');
const isTagView = computed(() => mailStore.isTagViewId(folderId.value));
/** Share of the account the indexer has covered; a tag view lists what is indexed. */
const tagViewCoverage = computed(() => (
  isTagView.value ? mailStore.tagViewCoverage : null
));
/**
 * Explain which of the account's mail a tag view can show when the index
 * is incomplete or has a narrower scope than the account list.
 */
const tagViewNote = computed(() => {
  if (!isTagView.value) return '';
  const parts: string[] = [];
  const coverage = tagViewCoverage.value;
  if (coverage !== null && coverage < 100) {
    parts.push(`Showing tagged mail from the folders indexed so far (${coverage}%).`);
  }
  const truncation = mailStore.tagViewTruncation;
  if (truncation) {
    parts.push(`Showing the newest ${truncation.shown.toLocaleString()} of ${truncation.total.toLocaleString()} tagged messages.`);
  }
  // A tag view reads the signed-in account only (MK-3.4).
  if (mailStore.sharedAccounts.length > 0) {
    parts.push('Shared folders are not included.');
  }
  return parts.join(' ');
});
const headerStatus = computed(() => tagViewNote.value ? [tagViewNote.value] : []);

const allLoadedSelected = computed(() => {
  const loadedIds = [];
  for (const row of selectAllTargetMessages.value) {
    if (row?.id != null) loadedIds.push(row.id);
  }
  if (loadedIds.length === 0) return false;
  for (const id of loadedIds) {
    if (!selectedIds.value.has(id)) return false;
  }
  return true;
});

function selectAllForCurrentFilter() {
  if (quickFilterActive.value) {
    const next = new Set<number>();
    for (const row of selectAllTargetMessages.value) {
      const id = Number(row?.id);
      if (Number.isFinite(id)) next.add(id);
    }
    selectedIds.value = next;
    return;
  }
  void mailStore.selectAllLoadedMessages({
    unreadOnly: unreadOnly.value,
    flaggedOnly: flaggedOnly.value,
    folderId: folderId.value,
  });
}

function toggleSelectAll() {
  if (hasSelection.value) {
    selectNone();
  } else {
    selectAllForCurrentFilter();
  }
}

/** Every store action names this column's folder as the rows' source. */
const source = computed(() => ({ sourceFolderId: folderId.value }));

// Bulk actions for the checkbox selection. They live here (not in the
// message view) because multi-selecting hides the reading pane
// entirely; the list header is the only surface that is always
// visible, including in single-column layouts.
const canWhitelistInJunk = computed(() => {
  const current = folder.value;
  return current?.role === 'junk'
    && mailStore.primaryFolders.some((candidate) => candidate.id === current.id);
});
const bulkWhitelisting = ref(false);

// Per-row hover actions (star, archive, delete). A pending scheduled
// send has neither archive nor plain delete, so its row gets none;
// anything else in the Scheduled folder is ordinary mail.
function rowHoverActions(message: { scheduled_undo_status?: string | null }) {
  return !isScheduledMessage(message);
}

async function toggleStar(message: { id: number; is_flagged?: number | null }) {
  await mailStore.markManyFlagged([message.id], Number(message.is_flagged) !== 1, source.value);
}

async function archiveOne(id: number) {
  try {
    await mailStore.archiveMessages([id], source.value);
  } catch (err) {
    console.warn('[message-list] archive failed', err?.message ?? err);
  }
}

async function deleteOne(id: number) {
  try {
    await mailStore.destroyMessages([id], source.value);
  } catch (err) {
    console.warn('[message-list] delete failed', err?.message ?? err);
  }
}

async function bulkMarkRead() {
  await mailStore.markManySeen([...selectedIds.value], true, source.value);
}

function isRowSelected(row: CachedRow): boolean {
  return row?.id != null && selectedIds.value.has(row.id);
}

const anySelectedStarred = computed(() => messages.value.some(
  (row) => isRowSelected(row) && Number(row?.is_flagged) === 1,
));

const anySelectedScheduled = computed(() => messages.value.some(
  (row) => isRowSelected(row) && isScheduledMessage(row),
));

async function bulkToggleStar() {
  await mailStore.toggleManyFlagged([...selectedIds.value], source.value);
}

// ----- tags (MK-6.6): one menu, three anchors ----------------------------
// The bulk toolbar hosts the menu as a dropdown; a row's Tag button and
// the header's overflow menu open the same panel as a popover anchored to
// the control that raised it, since neither can host a <details>.

const { definitions: tagDefinitions } = useMessageTags();

const selectedRows = computed<CachedRow[]>(() => messages.value.filter(isRowSelected));

interface TagPopoverState {
  ids: number[];
  /** Rows as they were when the menu opened; live rows override them by id. */
  targets: CachedRow[];
  anchor: PopoverAnchor;
  /** The control that opened the menu: exempt from outside-click dismissal, and where focus returns. */
  trigger: HTMLElement | null;
  returnFocus: HTMLElement | null;
}
const tagPopover = ref<TagPopoverState | null>(null);

/** Viewport rectangle of a laid-out element; null for a missing or unpainted one. */
function anchorOf(element: Element | null | undefined): PopoverAnchor | null {
  if (!element || element.getClientRects().length === 0) return null;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top, left: rect.left, width: rect.width, height: rect.height,
  };
}

async function applyTagToggle(ids: number[], keyword: string, on: boolean) {
  if (ids.length === 0) return;
  await mailStore.setTagsMany(ids, on ? { add: [keyword] } : { remove: [keyword] }, source.value);
}

async function clearTagsOn(ids: number[], rows: ReadonlyArray<CachedRow | undefined>) {
  if (ids.length === 0) return;
  await mailStore.clearTagsMany(ids, { ...source.value, rows });
}

/** A row's Tag button toggles its menu: a second click closes it. */
function openRowTagPicker(message: CachedRow & { id: number }, event: MouseEvent) {
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (tagPopover.value && tagPopover.value.ids.length === 1 && tagPopover.value.ids[0] === message.id) {
    closeTagPopover();
    return;
  }
  const anchor = anchorOf(trigger);
  if (!anchor) return;
  tagPopover.value = {
    ids: [message.id],
    targets: [message],
    anchor,
    trigger,
    returnFocus: event.detail === 0 ? trigger : scrollEl.value,
  };
}

/** The overflowed bulk Tag action: the popover hangs off the More menu. */
function openBulkTagPicker() {
  const trigger = msgListEl.value?.querySelector<HTMLElement>('[data-more-menu]')
    ?? msgListEl.value?.querySelector<HTMLElement>('.msg-list__header')
    ?? null;
  const anchor = anchorOf(trigger);
  if (!anchor) return;
  tagPopover.value = {
    ids: [...selectedIds.value],
    targets: selectedRows.value,
    anchor,
    trigger,
    returnFocus: trigger,
  };
}

function closeTagPopover() {
  // The trigger must receive focus before its menu-open visibility is removed.
  const target = tagPopover.value?.returnFocus;
  const fallback = scrollEl.value ?? msgListEl.value?.querySelector<HTMLElement>('input, button');
  (target?.isConnected ? target : fallback)?.focus({ preventScroll: true });
  tagPopover.value = null;
}

/** The row whose Tag button owns the open menu, for its aria-expanded. */
const tagMenuRowId = computed<number | null>(() => {
  const state = tagPopover.value;
  return state && state.ids.length === 1 && state.trigger?.classList.contains('msg-list__action--tag')
    ? state.ids[0]
    : null;
});

/**
 * `T` (MK-4.2): the menu for the checked rows hangs off the toolbar's Tag
 * button (or the More menu holding it); for the open message alone it
 * hangs off that row's Tag button, or the header when the row is not
 * painted.
 */
function openTagMenuForTargets() {
  if (selectedIds.value.size > 0) {
    const inlineTrigger = msgListEl.value?.querySelector<HTMLElement>('[data-tag-picker-trigger]');
    if (inlineTrigger) {
      const details = inlineTrigger.closest('details');
      if (details && !details.open) details.open = true;
      return;
    }
    openBulkTagPicker();
    return;
  }
  const openId = openMessageId.value;
  if (openId == null) return;
  const row = messages.value.find((candidate) => candidate?.id === openId);
  if (!row || isScheduledMessage(row)) return;
  const trigger = document.getElementById(`${rowDomIdPrefix.value}${openId}`)
    ?.querySelector<HTMLElement>('.msg-list__action--tag') ?? null;
  const anchor = anchorOf(trigger) ?? anchorOf(msgListEl.value?.querySelector<HTMLElement>('.msg-list__header'));
  if (!anchor) return;
  tagPopover.value = {
    ids: [openId],
    targets: [row],
    anchor,
    trigger,
    returnFocus: scrollEl.value,
  };
}

/**
 * Rows re-render as keywords change; the open popover reads each target
 * from the live window when it is painted and from its opening snapshot
 * otherwise, so the tri-state covers every id it acts on.
 */
const tagPopoverTargets = computed<CachedRow[]>(() => {
  const state = tagPopover.value;
  if (!state) return [];
  const live = new Map<number, CachedRow>();
  for (const row of messages.value) {
    if (row?.id != null) live.set(row.id, row);
  }
  const snapshot = new Map<number, CachedRow>();
  for (const row of state.targets) {
    if (row?.id != null) snapshot.set(row.id, row);
  }
  return state.ids.map((id) => live.get(id) ?? snapshot.get(id));
});

function manageTags() {
  closeTagPopover();
  requestTagManager();
}

/**
 * Empty state under the dense filters, naming every active one:
 * "No unread starred messages in Inbox."
 */
const filteredEmptyText = computed(() => {
  const qualifiers = [
    unreadOnly.value ? 'unread' : null,
    flaggedOnly.value ? 'starred' : null,
  ].filter((part): part is string => part !== null);
  const prefix = qualifiers.length > 0 ? `${qualifiers.join(' ')} ` : '';
  return `No ${prefix}messages in ${folderName.value}.`;
});

async function bulkMarkUnread() {
  await mailStore.markManySeen([...selectedIds.value], false, source.value);
}

async function bulkArchive() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.archiveMessages(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk archive failed', err?.message ?? err);
  }
}

async function bulkJunk() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.junkMessages(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk junk failed', err?.message ?? err);
  }
}

async function bulkDelete() {
  const ids = [...selectedIds.value];
  if (ids.length === 0) return;
  try {
    await mailStore.destroyMessages(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk delete failed', err?.message ?? err);
  }
}

/** Cancel the pending sends in the selection; other selected rows are left alone. */
async function bulkCancelSend() {
  const ids = messages.value
    .filter((row) => isRowSelected(row) && isScheduledMessage(row))
    .map((row) => row!.id);
  if (ids.length === 0) return;
  try {
    await mailStore.cancelScheduledSends(ids);
  } catch (err) {
    console.warn('[message-list] bulk cancel send failed', err?.message ?? err);
  }
}

async function bulkWhitelist() {
  const ids = [...selectedIds.value];
  if (ids.length === 0 || bulkWhitelisting.value) return;
  bulkWhitelisting.value = true;
  try {
    await mailStore.whitelistSenders(ids, source.value);
  } catch (err) {
    console.warn('[message-list] bulk whitelist failed', err?.message ?? err);
  } finally {
    bulkWhitelisting.value = false;
  }
}

// ----- header row: title, filters, count, controls and the More menu ----

const bulkActionItems = useBulkActionItems({
  folder,
  canWhitelist: canWhitelistInJunk,
  whitelisting: bulkWhitelisting,
  anyStarred: anySelectedStarred,
  anyScheduled: anySelectedScheduled,
  handlers: {
    archive: bulkArchive,
    junk: bulkJunk,
    delete: bulkDelete,
    cancelSend: bulkCancelSend,
    toggleStar: bulkToggleStar,
    tag: openBulkTagPicker,
    markRead: bulkMarkRead,
    markUnread: bulkMarkUnread,
    whitelist: bulkWhitelist,
  },
});

function refresh() {
  void mailStore.refresh(folderId.value);
}

const viewActions = computed<MoreMenuItem[]>(() => {
  const actions: MoreMenuItem[] = [{
    id: 'read-in-place',
    label: 'Read in place',
    icon: PanelTopOpen,
    checked: readInPlace.value,
    run: () => { readInPlace.value = !readInPlace.value; },
  }];
  const current = folder.value;
  if (props.enableThreadedView && current && current.role !== 'scheduled' && current.id > 0 && current.account_id > 0) {
    actions.push({ id: 'threads', label: 'Threaded view', icon: Layers, run: () => emit('show-threads', current) });
  }
  return actions;
});

const titleEl = ref<InstanceType<typeof MessageListHeaderTitle> | null>(null);
const toolbar = ref<InstanceType<typeof MessageListToolbar> | null>(null);

function focusFolderPicker() {
  titleEl.value?.focusTrigger();
}

function focusColumnControl() {
  toolbar.value?.focusColumnControl();
}

// Keyboard focus survives a row removal: when the focused element left
// the DOM with its row (Delete, Archive, a move), focus goes to the list
// itself instead of falling to the document body.
let focusWithin = false;
function onListFocusIn() {
  focusWithin = true;
}
function onListFocusOut(event: FocusEvent) {
  const next = event.relatedTarget;
  if (next instanceof Node && msgListEl.value?.contains(next)) return;
  focusWithin = false;
}
watch(() => visibleMessages.value.length, async (count, previous) => {
  if (!focusWithin || count >= previous) return;
  await nextTick();
  const active = document.activeElement;
  if (active && active !== document.body && msgListEl.value?.contains(active)) return;
  (scrollEl.value ?? msgListEl.value?.querySelector<HTMLElement>('input, button'))?.focus();
});

defineExpose({ focusColumnControl, focusFolderPicker, inlineReaderTarget });
</script>

<template>
  <section
    ref="msgListEl"
    class="msg-list"
    :class="{
      'msg-list--card': cardLayout,
      'msg-list--primary': primary,
      'is-drop-valid': dropState === 'move',
      'is-drop-copy': dropState === 'copy',
      'is-drop-invalid': dropState === 'invalid',
    }"
    role="region"
    :aria-label="regionLabel"
    :data-column-id="listId || undefined"
    @focusin="onListFocusIn"
    @focusout="onListFocusOut"
    @dragenter="onColumnDragEnter"
    @dragover="onColumnDragOver"
    @dragleave="onColumnDragLeave"
    @drop="onColumnDrop"
  >
    <MessageListToolbar
      ref="toolbar"
      :list-width="listWidth"
      :folder-id="folderId"
      :folder-name="folderName"
      :total-count="rowCount"
      :all-selected="allLoadedSelected"
      :selected-count="selectionCount"
      :unread-only="unreadOnly"
      :starred-only="flaggedOnly"
      :is-loading="isLoading"
      :status="headerStatus"
      column-controls
      :column-index="columnIndex"
      :primary="primary"
      :can-add-column="canAddColumn"
      :bulk-action-items="bulkActionItems"
      :view-actions="viewActions"
      @clear-selection="selectNone"
      @toggle-all="toggleSelectAll"
      @toggle-unread="toggleUnreadFilter"
      @toggle-starred="toggleFlaggedFilter"
      @refresh="refresh"
      @add-column="emit('add-column')"
      @remove-column="emit('remove-column')"
    >
      <template v-if="showsTitle" #title="{ compact }">
        <MessageListHeaderTitle
          ref="titleEl"
          :primary="primary"
          :folder="folder"
          :folder-id="folderId"
          :column-index="columnIndex"
          :compact="compact"
          @pick="emit('change-folder', $event)"
        />
      </template>
      <template #tag="{ item }">
        <TagPickerDropdown
          :targets="selectedRows"
          :definitions="tagDefinitions"
          :label="item.ariaLabel"
          :title="item.title"
          trigger-class="msg-list__bulk-action msg-list__bulk-action--tag"
          @toggle="(keyword, on) => applyTagToggle([...selectedIds], keyword, on)"
          @clear="clearTagsOn([...selectedIds], selectedRows)"
          @manage="manageTags"
        />
      </template>
    </MessageListToolbar>

    <span :id="`${gridId}-instructions`" hidden>
      Use Up and Down arrows to navigate messages, Space to select, and Enter to toggle the message preview.
      Press Right Arrow or F2 for message controls, then Left and Right arrows to move between them.
      Escape returns to message navigation. Tab leaves the message list.
    </span>
    <div
      v-if="rowCount > 0"
      :id="gridId"
      ref="scrollEl"
      class="msg-list__scroller"
      tabindex="0"
      role="grid"
      aria-multiselectable="true"
      :aria-rowcount="rowCount"
      :aria-busy="isLoading"
      aria-colcount="1"
      :aria-describedby="`${gridId}-instructions`"
      aria-label="Messages"
      :aria-activedescendant="activeRowDomId"
      @scroll="onScroll"
      @keydown="handleKeyDown"
      @click.capture="onControlPointerInteraction"
      @contextmenu.capture="onControlPointerInteraction"
    >
      <div
        v-if="isLoading && messages.length === 0"
        class="msg-list__loader"
      >
        <RefreshCw :size="18" class="is-spinning" />
        <p>Loading {{ folderName }}…</p>
      </div>
      <ol class="msg-list__items" role="presentation" :style="{ height: totalSize + 'px' }">
        <template v-for="v in virtualItems" :key="v.key">
          <MessageListRow
            v-if="visibleMessages[v.index]"
            :message="visibleMessages[v.index]"
            :index="v.index"
            :start="v.start"
            :size="v.size"
            :class="{ 'msg-list__item-with-reader': inlineMessageId === visibleMessages[v.index].id }"
            :style="inlineMessageId === visibleMessages[v.index].id ? { '--message-summary-height': `${summaryHeight}px` } : undefined"
            :dom-id-prefix="rowDomIdPrefix"
            :focused="openMessageId === visibleMessages[v.index].id"
            :expanded="readInPlace ? inlineMessageId === visibleMessages[v.index].id : undefined"
            :reader-controls="inlineMessageId === visibleMessages[v.index].id ? inlineReaderId : undefined"
            :cursor="focusedMessageId === visibleMessages[v.index].id"
            :selected="isSelected(visibleMessages[v.index].id)"
            :dragging="isDraggingMessage(visibleMessages[v.index].id)"
            :shows-recipients="listShowsRecipients"
            :sort="listSort"
            :hover-actions="rowHoverActions(visibleMessages[v.index])"
            :archive-action="!isArchiveFolder"
            :draggable="!isTagView"
            :tag-definitions="tagDefinitions"
            :tag-menu-open="tagMenuRowId === visibleMessages[v.index].id"
            @row-click="onRowClick(v.index, $event)"
            @checkbox-click="onCheckboxClick(v.index, $event)"
            @dragstart="onRowDragStart(visibleMessages[v.index], $event)"
            @dragend="endMessageDrag"
            @star="toggleStar(visibleMessages[v.index])"
            @tag="openRowTagPicker(visibleMessages[v.index], $event)"
            @archive="archiveOne(visibleMessages[v.index].id)"
            @delete="deleteOne(visibleMessages[v.index].id)"
          >
            <template #after-row>
              <InlineMailReader v-if="inlineMessageId === visibleMessages[v.index].id" :id="inlineReaderId">
                <div :ref="(element) => setInlineReaderTarget(v.key, element)" :data-inline-message-id="v.key"
                  class="msg-list__inline-target" />
              </InlineMailReader>
            </template>
          </MessageListRow>
          <li
            v-else
            :data-index="v.index"
            :data-placeholder="true"
            role="presentation"
            aria-hidden="true"
            class="msg-list__item--placeholder"
            :style="{
              position: 'absolute',
              top: '0px',
              left: '0px',
              right: '0px',
              transform: `translateY(${v.start}px)`,
              height: v.size + 'px',
            }"
          >
            <div class="msg-list__skeleton">
              <div class="msg-list__skel-line msg-list__skel-line--from" />
              <div class="msg-list__skel-line msg-list__skel-line--subject" />
              <div class="msg-list__skel-line msg-list__skel-line--preview" />
            </div>
          </li>
        </template>
      </ol>
    </div>

    <div v-else-if="isLoading" class="msg-list__placeholder">
      <RefreshCw :size="18" class="is-spinning" />
      <p>Loading {{ folderName }}…</p>
    </div>
    <div v-else-if="quickFilterActive" class="msg-list__placeholder">
      <p>No messages matching "{{ props.quickFilterQuery.trim() }}" in {{ folderName }}.</p>
    </div>
    <div v-else-if="unreadOnly || flaggedOnly" class="msg-list__placeholder">
      <p>{{ filteredEmptyText }}</p>
    </div>
    <div v-else-if="isTagView" class="msg-list__placeholder">
      <p>No messages are tagged {{ folderName }}.</p>
    </div>
    <div v-else-if="folderId != null" class="msg-list__placeholder">
      <p>{{ folderName }} is empty.</p>
    </div>
    <div v-else-if="primary" class="msg-list__placeholder">
      <p>Select a folder to view its messages.</p>
    </div>
    <div v-else class="msg-list__placeholder">
      <p>Choose a folder above to show its messages here.</p>
    </div>

    <TagPickerPopover
      :anchor="tagPopover?.anchor ?? null"
      :targets="tagPopoverTargets"
      :definitions="tagDefinitions"
      :trigger="tagPopover?.trigger ?? null"
      :return-focus="tagPopover?.returnFocus ?? null"
      @close="closeTagPopover"
      @toggle="(keyword, on) => applyTagToggle(tagPopover?.ids ?? [], keyword, on)"
      @clear="clearTagsOn(tagPopover?.ids ?? [], tagPopoverTargets)"
      @manage="manageTags"
    />
  </section>
</template>

<style scoped>
.msg-list__item-with-reader > :deep(.msg-list__item) {
  height: var(--message-summary-height);
}

.msg-list__inline-target {
  height: 100%;
  min-height: 0;
}

.msg-list {
  display: grid;
  /* The header's nowrap row must never size the column: the track is
     the column's width and the header shrinks into it. */
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-width: 0;
  min-height: 0;
  height: 100%;
}
/* Drop feedback for rows dragged from another column; same colours as
   the folder list's nodes. A drag from this column's own folder shows
   nothing. */
.msg-list.is-drop-valid {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
}
.msg-list.is-drop-copy {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, #188038 60%, transparent);
}
.msg-list.is-drop-invalid {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, #d93025 55%, transparent);
}
.is-spinning {
  animation: msg-spin 1.2s linear infinite;
}
@keyframes msg-spin {
  to { transform: rotate(360deg); }
}

.msg-list__scroller {
  container-type: size;
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  contain: strict;
  will-change: scroll-position;
  outline: none;
}
.msg-list__scroller:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.msg-list__loader {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--panel);
  color: var(--muted);
  font-size: 13px;
}
.msg-list__loader p { margin: 0; }
.msg-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  width: 100%;
}
.msg-list__item--placeholder {
  border-bottom: 1px solid var(--border-soft);
  padding: 10px 14px 10px 22px;
}
.msg-list__skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  justify-content: center;
}
.msg-list__skel-line {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--text) 6%, transparent) 0%,
    color-mix(in srgb, var(--text) 12%, transparent) 50%,
    color-mix(in srgb, var(--text) 6%, transparent) 100%
  );
  background-size: 200% 100%;
  animation: skel-shimmer 1.4s linear infinite;
}
.msg-list__skel-line--from { width: 35%; }
.msg-list__skel-line--subject { width: 75%; }
.msg-list__skel-line--preview { width: 90%; height: 8px; }
@keyframes skel-shimmer {
  to { background-position: -200% 0; }
}

.msg-list__placeholder {
  margin: 0;
  padding: 32px 24px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  text-align: center;
}
.msg-list__placeholder p { margin: 0; }
</style>

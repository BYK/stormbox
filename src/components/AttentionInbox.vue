<script setup lang="ts">
import { Bell, Check, CircleAlert, Mail, MailOpen, Star, Trash2 } from '@lucide/vue';
import { useElementSize } from '@vueuse/core';
import { computed, nextTick, ref, shallowReactive, useId, watch, watchPostEffect } from 'vue';

import { useAttentionRowSwipe } from '../composables/useAttentionRowSwipe';
import { useListSelection } from '../composables/useListSelection';
import { provideSenderAvatars } from '../composables/useSenderAvatars';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import { browserTriageMessageKey } from '../triage/browser-model';
import { UNTIL_NEW_ACTIVITY } from '../triage/snooze-time';
import type { TriageBundle, TriageMessage } from '../triage/smart-sort';
import { closeContainingDropdown } from '../utils/dropdown';
import { threadSubject } from '../utils/mail-threads';
import { CARD_LAYOUT_WIDTH, CARD_ROW_HEIGHT, ROW_HEIGHT, conversationRow, recipientLabel, type MessageRowLike } from '../utils/message-row-presentation';
import type { MessageTagDefinition, ResolvedTag } from '../utils/message-tags';
import AppIconButton from './AppIconButton.vue';
import AttentionRowMenu from './AttentionRowMenu.vue';
import AttentionSwipeActions from './AttentionSwipeActions.vue';
import InlineMailReader from './InlineMailReader.vue';
import MessageListRow from './MessageListRow.vue';
import SelectableListHeader from './SelectableListHeader.vue';

const props = withDefaults(defineProps<{
  bundles: readonly TriageBundle[];
  loading?: boolean;
  error?: string | null;
  status?: string;
  inlineReading?: boolean;
  openBundleId?: string;
  openMessage?: TriageMessage;
  rows?: ReadonlyMap<string, MessageRowLike & { id: number | string }>;
  disabledActions?: ReadonlySet<string>;
  tagDefinitions?: ReadonlyArray<MessageTagDefinition>;
  additionalTags?: ReadonlyMap<string, readonly ResolvedTag[]>;
}>(), {
  loading: false,
  error: null,
});

const emit = defineEmits<{
  'open-bundle': [bundle: TriageBundle, trigger: EventTarget | null];
  open: [message: TriageMessage, trigger: EventTarget | null];
  'bundle-action': [bundle: TriageBundle, action: ImapAttentionAction];
  'message-action': [message: TriageMessage, action: ImapAttentionAction];
  'selection-action': [messages: TriageMessage[], action: ImapAttentionAction];
  'inline-target': [target: HTMLElement | undefined];
  'inline-hidden': [];
  done: [bundle: TriageBundle];
  snooze: [bundle: TriageBundle, until: number];
  restore: [bundle: TriageBundle];
}>();

const filters = [
  { key: 'attention', label: 'Attention', name: 'Needs attention', icon: CircleAlert, empty: 'Nothing needs your attention.' },
  { key: 'updates', label: 'Updates', name: 'Updates', icon: Bell, empty: 'No updates.' },
  { key: 'handled', label: 'Done', name: 'Done & snoozed', icon: Check, empty: 'No done or snoozed mail.' },
] as const;

type Filter = typeof filters[number]['key'];
const selectedFilter = ref<Filter>('attention');
const headingId = useId();
const filterBar = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const { width } = useElementSize(listEl);
const cardLayout = computed(() => width.value > 0 && width.value < CARD_LAYOUT_WIDTH);
const rowHeight = computed(() => cardLayout.value ? CARD_ROW_HEIGHT : ROW_HEIGHT);
const expandedBundles = ref(new Set<string>());
const inlineTargets = shallowReactive(new Map<string, HTMLElement>());
provideSenderAvatars();

const bundleKey = (bundle: TriageBundle) => `bundle:${bundle.id}`;
const messageKey = (message: TriageMessage) => `message:${browserTriageMessageKey(message)}`;
const inlinePanelId = (rowKey: string) => `${headingId}-reader-${encodeURIComponent(rowKey)}`;
const inlineKey = computed(() => {
  if (!props.inlineReading) return undefined;
  if (props.openBundleId) return `bundle:${props.openBundleId}`;
  return props.openMessage && messageKey(props.openMessage);
});

function setInlineTarget(key: string, element: unknown) {
  if (element instanceof HTMLElement) inlineTargets.set(key, element);
  else inlineTargets.delete(key);
}

watchPostEffect(() => {
  const key = inlineKey.value;
  const target = key ? inlineTargets.get(key) : undefined;
  emit('inline-target', target);
  if (key && !target) void nextTick(() => {
    if (inlineKey.value === key && !inlineTargets.has(key)) emit('inline-hidden');
  });
});

const bundlesByFilter = computed(() => {
  const groups: Record<Filter, TriageBundle[]> = { attention: [], updates: [], handled: [] };
  for (const bundle of props.bundles) {
    switch (bundle.status) {
      case 'action':
      case 'uncertain':
        groups.attention.push(bundle);
        break;
      case 'update':
        groups.updates.push(bundle);
        break;
      case 'done':
      case 'snoozed':
        groups.handled.push(bundle);
        break;
    }
  }
  return groups;
});
const visibleBundles = computed(() => bundlesByFilter.value[selectedFilter.value]);
const stackSubjects = computed(() => new Map(visibleBundles.value.filter(({ messages }) => messages.length > 1).map(({ id, messages }) => [
  id, threadSubject(messages.at(-1)?.message.subject),
])));
const visibleMessages = computed(() => visibleBundles.value.flatMap(({ messages }) => messages.map(({ message }) => message)));
const chronologicalItems = (bundle: TriageBundle) => [...bundle.messages].reverse();
const showMembers = (bundle: TriageBundle) => expandedBundles.value.has(bundle.id) && inlineKey.value !== bundleKey(bundle);
const selectionRows = computed(() => visibleBundles.value.flatMap((bundle) => [
  { key: bundleKey(bundle), row: bundle, messages: bundle.messages.map(({ message }) => message) },
  ...(showMembers(bundle) && bundle.messages.length > 1
    ? chronologicalItems(bundle).map(({ message }) => ({ key: messageKey(message), row: message, messages: [message] })) : []),
]));
const selectionIndex = computed(() => new Map(selectionRows.value.map(({ row }, index) => [row, index])));
const selection = useListSelection({
  rows: selectionRows,
  total: computed(() => selectionRows.value.length),
  getKey: ({ key }) => key,
  getSelectionKeys: ({ messages }) => messages.map(browserTriageMessageKey),
});
const { selectionCount, hasSelection } = selection;
const selectedMessages = computed(() => visibleMessages.value.filter(messageChecked));
const swipeMenus = new Map<string, InstanceType<typeof AttentionRowMenu>>();
const { activeKey: swipeKey, offset: swipeOffset, dragging: swipeDragging, armed: swipeArmed,
  handlers: swipeHandlers, onClick: onSwipeClick, close: closeSwipe } = useAttentionRowSwipe((key, row) => {
  const bundle = visibleBundles.value.find(({ id }) => id === key);
  if (!bundle || !canSwipe(bundle)) return;
  emit('done', bundle);
  void keepFilterFocus(row.querySelector('.msg-list__open'));
});
watch(() => swipeKey.value == null || visibleBundles.value.some((bundle) => bundle.id === swipeKey.value && canSwipe(bundle)),
  (available) => { if (!available) closeSwipe(); });
const allSelected = computed(() => hasSelection.value && selectionCount.value === visibleMessages.value.length);
const selectionUnread = computed(() => selectedMessages.value.some((message) => Number(rowFor(message).is_seen) === 0));
const selectionStarred = computed(() => selectedMessages.value.some((message) => Number(rowFor(message).is_flagged) === 1));
const selectionDisabled = computed(() => selectedMessages.value.some(actionDisabled));
watch(visibleMessages, (messages) => selection.retainOnly(messages.map(browserTriageMessageKey)));
watch(hasSelection, (hasSelection, hadSelection) => {
  if (hasSelection || !hadSelection) return;
  const focus = document.activeElement;
  if (listEl.value?.contains(focus) && focus?.closest('.attention-inbox__header')) void keepFilterFocus(focus);
});
const emptyMessage = computed(() => filters.find(({ key }) => key === selectedFilter.value)?.empty);
const statusText = computed(() => props.error || (props.loading ? 'Loading mail…' : props.status) || '');

function messageChecked(message: TriageMessage): boolean {
  return selection.isSelected(browserTriageMessageKey(message));
}

function bundleChecked(bundle: TriageBundle): boolean {
  return bundle.messages.every(({ message }) => messageChecked(message));
}

function bundleMixed(bundle: TriageBundle): boolean {
  return !bundleChecked(bundle) && bundle.messages.some(({ message }) => messageChecked(message));
}

function toggleSelection(row: TriageBundle | TriageMessage, event: MouseEvent) {
  const index = selectionIndex.value.get(row);
  if (index != null) selection.handleCheckboxClick(index, event, 0);
}

function toggleAll() {
  if (allSelected.value) selection.selectNone();
  else selection.selectAllLoaded();
}

function selectionKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (event.target instanceof Element && event.target.closest('[data-inline-mail-reader]')) return;
  if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) {
    selection.handleKeyDown(event);
  }
}

function applySelectionAction(action: ImapAttentionAction, event: MouseEvent) {
  emit('selection-action', selectedMessages.value, action);
  if (action.type === 'trash') void keepFilterFocus(event.currentTarget);
}

function filterName(filter: typeof filters[number]): string {
  const count = bundlesByFilter.value[filter.key].length;
  return `${filter.name}, ${count} ${count === 1 ? 'bundle' : 'bundles'}`;
}

function rowFor(message: TriageMessage): MessageRowLike & { id: number | string } {
  return props.rows?.get(browserTriageMessageKey(message)) ?? {
    id: message.id,
    from_text: message.sender,
    subject: message.subject,
    preview: message.preview,
    received_at: message.receivedAt,
    is_flagged: Number(message.isFlagged ?? false),
  };
}

function bundleRow(bundle: TriageBundle) {
  const rows = bundle.messages.map(({ message }) => rowFor(message));
  return conversationRow(rows[0], rows, props.tagDefinitions);
}

function bundleAdditionalTags(bundle: TriageBundle) {
  const tags = bundle.messages.flatMap(({ message }) => props.additionalTags?.get(browserTriageMessageKey(message)) ?? []);
  return [...new Map(tags.map((tag) => [tag.keyword, tag])).values()];
}

function isOpen(message: TriageMessage): boolean {
  return props.openMessage?.id === message.id && props.openMessage?.accountId === message.accountId;
}

function actionDisabled(message: TriageMessage): boolean {
  return props.disabledActions?.has(browserTriageMessageKey(message)) ?? false;
}

function canSwipe(bundle: TriageBundle): boolean {
  return bundle.status !== 'done' && bundle.status !== 'snoozed'
    && !hasSelection.value && !showMembers(bundle) && inlineKey.value !== bundleKey(bundle)
    && !bundle.messages.some(({ message }) => actionDisabled(message));
}

function setSwipeMenu(key: string, menu: unknown) {
  if (menu) swipeMenus.set(key, menu as InstanceType<typeof AttentionRowMenu>);
  else swipeMenus.delete(key);
}

function swipeSnooze(bundle: TriageBundle, event: MouseEvent) {
  const anchor = event.currentTarget instanceof HTMLElement
    ? event.currentTarget.closest('.attention-inbox__bundle')?.querySelector<HTMLElement>('.msg-list__open')
    : undefined;
  closeSwipe();
  if (anchor) swipeMenus.get(bundle.id)?.showSnooze(anchor);
}

function bundleContext(bundle: TriageBundle): string {
  const status = bundle.status === 'snoozed' ? snoozeLabel(bundle.snoozedUntil)
    : bundle.status === 'done' ? 'Done' : bundle.reason;
  return [
    recipientLabel(rowFor(bundle.messages[0].message)),
    bundle.status === 'action' ? bundle.priority : '',
    status,
  ].filter(Boolean).join(' · ');
}

function detailId(bundle: TriageBundle): string {
  return `${headingId}-${encodeURIComponent(bundle.id)}`;
}

function toggleBundle(bundle: TriageBundle): void {
  if (expandedBundles.value.has(bundle.id)) expandedBundles.value.delete(bundle.id);
  else expandedBundles.value.add(bundle.id);
}

function stackAction(bundle: TriageBundle): string | undefined {
  if (bundle.messages.length < 2) return undefined;
  if (inlineKey.value === bundleKey(bundle)) return 'Collapse conversation';
  return expandedBundles.value.has(bundle.id) ? 'Hide conversation messages' : 'Show conversation messages';
}

function activateStackAction(bundle: TriageBundle) {
  if (inlineKey.value === bundleKey(bundle)) emit('open-bundle', bundle, null);
  else toggleBundle(bundle);
}

function dateTime(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function snoozeLabel(until: number | undefined): string {
  if (until === UNTIL_NEW_ACTIVITY) return 'Snoozed until new mail needs attention';
  if (!until || !dateTime(until)) return 'Snoozed';
  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(until);
  return `Snoozed until ${formatted}`;
}

async function keepFilterFocus(source: EventTarget | null): Promise<void> {
  if (!(source instanceof HTMLElement)) return;
  await nextTick();
  if (!source.isConnected || source.closest('details:not([open])')) {
    filterBar.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }
}

function complete(bundle: TriageBundle, event: MouseEvent): void {
  closeContainingDropdown(event);
  emit('done', bundle);
  void keepFilterFocus(event.currentTarget);
}

function restore(bundle: TriageBundle, event: MouseEvent): void {
  closeContainingDropdown(event);
  emit('restore', bundle);
  void keepFilterFocus(event.currentTarget);
}

function snooze(bundle: TriageBundle, until: number, trigger: HTMLElement): void {
  emit('snooze', bundle, until);
  void keepFilterFocus(trigger);
}

function applyMessageAction(message: TriageMessage, action: ImapAttentionAction, event: MouseEvent): void {
  emit('message-action', message, action);
  if (action.type === 'trash') void keepFilterFocus(event.currentTarget);
}

function applyBundleAction(bundle: TriageBundle, action: ImapAttentionAction, event: MouseEvent): void {
  emit('bundle-action', bundle, action);
  if (action.type === 'trash') void keepFilterFocus(event.currentTarget);
}
</script>

<template>
  <section ref="listEl" class="attention-inbox" :class="{ 'msg-list--card': cardLayout }"
    :aria-labelledby="headingId" @keydown="selectionKeydown">
    <h2 :id="headingId" class="attention-inbox__heading">Smart Inbox</h2>
    <SelectableListHeader
      class="attention-inbox__header"
      :selectable="hasSelection"
      :all-selected="allSelected"
      :selected-count="selectionCount"
      :total-count="visibleMessages.length"
      :show-total-count="false"
      item-label="messages"
      @toggle-all="toggleAll"
      @clear-selection="selection.selectNone"
    >
      <template #normal-actions>
        <div ref="filterBar" class="attention-inbox__filters" role="group" aria-label="Smart Inbox filters">
          <button
            v-for="filter in filters"
            :key="filter.key"
            class="msg-list__filter attention-inbox__filter"
            :class="{ 'is-active': selectedFilter === filter.key }"
            type="button"
            :aria-label="filterName(filter)"
            :title="filterName(filter)"
            :aria-pressed="selectedFilter === filter.key"
            @click="selectedFilter = filter.key"
          >
            <component :is="filter.icon" class="attention-inbox__filter-icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
            <span class="attention-inbox__filter-label">{{ filter.label }}</span>
            <span class="attention-inbox__count">{{ bundlesByFilter[filter.key].length }}</span>
          </button>
        </div>
      </template>
      <template #selection-actions>
        <AppIconButton :title="selectionStarred ? 'Unstar' : 'Star'" :aria-label="selectionStarred ? 'Unstar' : 'Star'"
          :disabled="selectionDisabled" @click="applySelectionAction({ type: 'star', value: !selectionStarred }, $event)">
          <Star :size="16" :fill="selectionStarred ? 'currentColor' : 'none'" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton :title="selectionUnread ? 'Mark as read' : 'Mark as unread'"
          :aria-label="selectionUnread ? 'Mark as read' : 'Mark as unread'" :disabled="selectionDisabled"
          @click="applySelectionAction({ type: 'seen', value: selectionUnread }, $event)">
          <component :is="selectionUnread ? MailOpen : Mail" :size="16" aria-hidden="true" />
        </AppIconButton>
        <AppIconButton title="Move to Trash" aria-label="Move to Trash" danger :disabled="selectionDisabled"
          @click="applySelectionAction({ type: 'trash' }, $event)">
          <Trash2 :size="16" aria-hidden="true" />
        </AppIconButton>
      </template>
      <template #trailing>
        <div v-if="!hasSelection" class="attention-inbox__tools">
          <p class="attention-inbox__sync-status" :class="{ 'attention-inbox__sync-status--error': error }"
            role="status" :title="statusText || undefined">{{ statusText }}</p>
          <slot name="actions" />
        </div>
      </template>
    </SelectableListHeader>
    <div class="attention-inbox__scroll" :aria-busy="loading" @scroll="closeSwipe">
      <p v-if="!loading && visibleBundles.length === 0" class="attention-inbox__status">
        {{ emptyMessage }}
      </p>
      <ul v-if="visibleBundles.length > 0" class="attention-inbox__bundles msg-list__items"
        v-on="swipeHandlers" @click.capture="onSwipeClick">
        <MessageListRow
          v-for="bundle in visibleBundles"
          :key="bundle.id"
          class="attention-inbox__bundle"
          :class="{ 'attention-inbox__bundle--swiping': swipeKey === bundle.id,
            'attention-inbox__bundle--dragging': swipeKey === bundle.id && swipeDragging }"
          :data-attention-swipe="canSwipe(bundle) ? bundle.id : undefined"
          :style="swipeKey === bundle.id ? { '--attention-swipe-offset': `${swipeOffset}px` } : undefined"
          :message="bundleRow(bundle)"
          :conversation-count="bundle.messages.length"
          :stack-expanded="expandedBundles.has(bundle.id)"
          :stack-subject="stackSubjects.get(bundle.id)"
          :stack-controls="detailId(bundle)"
          :size="rowHeight"
          :dom-id-prefix="`${detailId(bundle)}-leader-`"
          :focused="openBundleId === bundle.id"
          :expanded="inlineReading ? inlineKey === bundleKey(bundle) : undefined"
          :reader-controls="inlineKey === bundleKey(bundle) ? inlinePanelId(bundleKey(bundle)) : undefined"
          :selected="bundleChecked(bundle)"
          :selection-mixed="bundleMixed(bundle)"
          :draggable="false"
          :context="bundleContext(bundle)"
          :tag-definitions="tagDefinitions"
          :additional-tags="bundleAdditionalTags(bundle)"
          @row-click="(_event, trigger) => emit('open-bundle', bundle, trigger)"
          @checkbox-click="toggleSelection(bundle, $event)"
          @toggle-stack="toggleBundle(bundle)"
        >
          <template #controls>
            <AttentionRowMenu
              :ref="(menu) => setSwipeMenu(bundle.id, menu)"
              :row="bundleRow(bundle)"
              :bundle="bundle"
              quick
              :stack-action="stackAction(bundle)"
              :label="bundle.messages.length > 1 ? 'Conversation actions' : undefined"
              :disabled="bundle.messages.some(({ message }) => actionDisabled(message))"
              @action="(action, event) => applyBundleAction(bundle, action, event)"
              @done="complete"
              @restore="restore"
              @snooze="snooze"
              @toggle-stack="activateStackAction(bundle)"
            />
          </template>
          <template #after-row>
            <AttentionSwipeActions v-if="swipeKey === bundle.id" :armed="swipeArmed" :dragging="swipeDragging"
              @delete="closeSwipe(); applyBundleAction(bundle, { type: 'trash' }, $event)"
              @snooze="swipeSnooze(bundle, $event)" />
            <InlineMailReader v-if="inlineKey === bundleKey(bundle)" :id="inlinePanelId(bundleKey(bundle))">
              <div
                :ref="(element) => setInlineTarget(bundleKey(bundle), element)"
                class="attention-inbox__reader-host"
                tabindex="-1"
              />
            </InlineMailReader>
            <ul
              v-if="bundle.messages.length > 1"
              v-show="showMembers(bundle)"
              :id="detailId(bundle)"
              class="attention-inbox__messages msg-list__items"
              aria-label="Messages in bundle"
            >
              <MessageListRow
                v-for="item in chronologicalItems(bundle)"
                :key="item.message.id"
                :message="rowFor(item.message)"
                :stack-subject="stackSubjects.get(bundle.id)"
                :size="rowHeight"
                :dom-id-prefix="`${detailId(bundle)}-member-`"
                :focused="!openBundleId && isOpen(item.message)"
                :expanded="inlineReading ? inlineKey === messageKey(item.message) : undefined"
                :reader-controls="inlineKey === messageKey(item.message) && expandedBundles.has(bundle.id)
                  ? inlinePanelId(messageKey(item.message)) : undefined"
                :selected="messageChecked(item.message)"
                nested
                :draggable="false"
                :context="[recipientLabel(rowFor(item.message)), item.classification.reason].filter(Boolean).join(' · ')"
                :tag-definitions="tagDefinitions"
                :additional-tags="additionalTags?.get(browserTriageMessageKey(item.message))"
                @row-click="(_event, trigger) => emit('open', item.message, trigger)"
                @checkbox-click="toggleSelection(item.message, $event)"
              >
                <template #controls>
                  <AttentionRowMenu
                    :row="rowFor(item.message)"
                    :disabled="actionDisabled(item.message)"
                    @action="(action, event) => applyMessageAction(item.message, action, event)"
                  />
                </template>
                <template #after-row>
                  <InlineMailReader v-if="expandedBundles.has(bundle.id) && inlineKey === messageKey(item.message)"
                    :id="inlinePanelId(messageKey(item.message))">
                    <div
                      :ref="(element) => setInlineTarget(messageKey(item.message), element)"
                      class="attention-inbox__reader-host"
                      tabindex="-1"
                    />
                  </InlineMailReader>
                </template>
              </MessageListRow>
            </ul>
          </template>
        </MessageListRow>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.attention-inbox {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  color: var(--text);
  background: var(--panel);
  container-type: inline-size;
}

.attention-inbox__heading {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.attention-inbox__bundle[data-attention-swipe] > :deep(.msg-list__item) {
  touch-action: pan-y pinch-zoom;
  transition: background .06s ease, translate 150ms ease-out;
}

.attention-inbox__bundle--swiping {
  position: relative;
  overflow-x: clip;
}

.attention-inbox__bundle--swiping.msg-list__row--stack { --attention-swipe-card-inset: 10px; }
.attention-inbox__bundle--swiping > :deep(.msg-list__item) {
  z-index: 1;
  translate: calc(-1 * var(--attention-swipe-offset));
  background: var(--panel);
}
.attention-inbox__bundle--swiping.is-focused > :deep(.msg-list__item) { background: var(--rowActive); }
.attention-inbox__bundle--swiping > :deep(.msg-list__item .msg-list__row-controls) { visibility: hidden; }
.attention-inbox__bundle--dragging > :deep(.msg-list__item) { transition: none; }

@media (prefers-reduced-motion: reduce) {
  .attention-inbox__bundle[data-attention-swipe] > :deep(.msg-list__item) { transition: none; }
}

.attention-inbox__header {
  flex: 0 0 auto;
  min-width: 0;
}

.attention-inbox__header :deep(.selectable-list-header__count--total) {
  display: none;
}
.attention-inbox__header :deep(.selectable-list-header__normal-actions) { flex: 1 0 auto; }

.attention-inbox__filters {
  display: flex;
  align-items: center;
  gap: 4px;
}

.attention-inbox__filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-inline: 8px;
}

.attention-inbox__filter-icon {
  display: none;
}

.attention-inbox__count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

@container (width < 410px) {
  .attention-inbox__count { display: none; }
}

@container (width < 340px) {
  .attention-inbox__filter { justify-content: center; width: 34px; padding: 0; }
  .attention-inbox__filter-label { display: none; }
  .attention-inbox__filter-icon { display: block; }
}

.attention-inbox__scroll {
  container-type: size;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.attention-inbox__status {
  margin: 0;
  padding: 16px 18px;
  color: var(--muted);
}

.attention-inbox__tools { display: flex; min-width: 0; max-width: 55%; align-items: center; gap: 4px; }
.attention-inbox__sync-status {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
}
.attention-inbox__sync-status--error { color: var(--error-fg); }

.attention-inbox__bundles,
.attention-inbox__messages {
  margin: 0;
  padding: 0;
  list-style: none;
}

.attention-inbox__reader-host {
  height: 100%;
  min-height: 0;
}

@media (pointer: coarse) {
  .attention-inbox__filter {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>

<script setup lang="ts">
import { Bell, Check, ChevronDown, CircleAlert, Mail, MailOpen, Star, Trash2 } from '@lucide/vue';
import { useElementSize } from '@vueuse/core';
import { computed, nextTick, ref, useId, watch } from 'vue';

import { useListSelection } from '../composables/useListSelection';
import { provideSenderAvatars } from '../composables/useSenderAvatars';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import { browserTriageMessageKey } from '../triage/browser-model';
import type { TriageBundle, TriageMessage } from '../triage/smart-sort';
import { closeContainingDropdown } from '../utils/dropdown';
import { CARD_LAYOUT_WIDTH, CARD_ROW_HEIGHT, ROW_HEIGHT, conversationRow, type MessageRowLike } from '../utils/message-row-presentation';
import type { MessageTagDefinition } from '../utils/message-tags';
import AppIconButton from './AppIconButton.vue';
import AttentionRowMenu from './AttentionRowMenu.vue';
import MessageListRow from './MessageListRow.vue';
import SelectableListHeader from './SelectableListHeader.vue';

const props = withDefaults(defineProps<{
  bundles: readonly TriageBundle[];
  accountLabels?: Readonly<Record<string, string>>;
  loading?: boolean;
  error?: string | null;
  openBundleId?: string;
  openMessage?: TriageMessage;
  rows?: ReadonlyMap<string, MessageRowLike & { id: number | string }>;
  disabledActions?: ReadonlySet<string>;
  tagDefinitions?: ReadonlyArray<MessageTagDefinition>;
}>(), {
  accountLabels: () => ({}),
  loading: false,
  error: null,
});

const emit = defineEmits<{
  'open-bundle': [bundle: TriageBundle, trigger: EventTarget | null];
  open: [message: TriageMessage, trigger: EventTarget | null];
  'bundle-action': [bundle: TriageBundle, action: ImapAttentionAction];
  'message-action': [message: TriageMessage, action: ImapAttentionAction];
  'selection-action': [messages: TriageMessage[], action: ImapAttentionAction];
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
provideSenderAvatars();

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
const visibleMessages = computed(() => visibleBundles.value.flatMap(({ messages }) => messages.map(({ message }) => message)));
const selectionRows = computed(() => visibleBundles.value.flatMap((bundle) => [
  { key: `bundle:${bundle.id}`, row: bundle, messages: bundle.messages.map(({ message }) => message) },
  ...(expandedBundles.value.has(bundle.id) && bundle.messages.length > 1
    ? bundle.messages.map(({ message }) => ({ key: `message:${browserTriageMessageKey(message)}`, row: message, messages: [message] })) : []),
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
  return conversationRow(rowFor(bundle.leading.message), bundle.messages.map(({ message }) => rowFor(message)));
}

function isOpen(message: TriageMessage): boolean {
  return props.openMessage?.id === message.id && props.openMessage?.accountId === message.accountId;
}

function actionDisabled(message: TriageMessage): boolean {
  return props.disabledActions?.has(browserTriageMessageKey(message)) ?? false;
}

function bundleContext(bundle: TriageBundle): string {
  const status = bundle.status === 'snoozed' ? snoozeLabel(bundle.snoozedUntil)
    : bundle.status === 'done' ? 'Done' : bundle.reason;
  return [
    props.accountLabels[String(bundle.accountId)],
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

function dateTime(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function snoozeLabel(until: number | undefined): string {
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

function snooze(bundle: TriageBundle, until: number, event: MouseEvent): void {
  closeContainingDropdown(event);
  emit('snooze', bundle, until);
  void keepFilterFocus(event.currentTarget);
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
      <template #trailing><slot v-if="!hasSelection" name="actions" /></template>
    </SelectableListHeader>
    <slot name="progress" />
    <div class="attention-inbox__scroll" :aria-busy="loading">
      <p v-if="error" class="attention-inbox__status attention-inbox__status--error" role="status">
        {{ error }}
      </p>
      <p v-if="loading && visibleBundles.length === 0" class="attention-inbox__status" role="status">
        Loading mail…
      </p>
      <p v-else-if="visibleBundles.length === 0" class="attention-inbox__status">
        {{ emptyMessage }}
      </p>
      <ul v-else class="attention-inbox__bundles msg-list__items">
        <MessageListRow
          v-for="bundle in visibleBundles"
          :key="bundle.id"
          class="attention-inbox__bundle"
          :message="bundleRow(bundle)"
          :conversation-count="bundle.messages.length"
          :size="rowHeight"
          :dom-id-prefix="`${detailId(bundle)}-leader-`"
          :focused="openBundleId === bundle.id"
          :selected="bundleChecked(bundle)"
          :selection-mixed="bundleMixed(bundle)"
          unread-on-avatar
          :draggable="false"
          :context="bundleContext(bundle)"
          :tag-definitions="tagDefinitions"
          @row-click="(_event, trigger) => emit('open-bundle', bundle, trigger)"
          @checkbox-click="toggleSelection(bundle, $event)"
        >
          <template #controls>
            <div class="msg-list__row-controls" draggable="false" @click.stop>
              <button
                v-if="bundle.messages.length > 1"
                class="attention-inbox__expand"
                type="button"
                :aria-expanded="expandedBundles.has(bundle.id)"
                :aria-controls="detailId(bundle)"
                :aria-label="`${expandedBundles.has(bundle.id) ? 'Hide' : 'Show'} ${bundle.messages.length} messages`"
                @click="toggleBundle(bundle)"
              >
                {{ bundle.messages.length }}
                <ChevronDown :size="14" aria-hidden="true" />
              </button>
              <AttentionRowMenu
                :row="bundleRow(bundle)"
                :bundle="bundle"
                :label="bundle.messages.length > 1 ? 'Conversation actions' : undefined"
                :disabled="bundle.messages.some(({ message }) => actionDisabled(message))"
                @action="(action, event) => applyBundleAction(bundle, action, event)"
                @done="complete"
                @restore="restore"
                @snooze="snooze"
              />
            </div>
          </template>
          <template #after-row>
            <ul
              v-if="bundle.messages.length > 1"
              v-show="expandedBundles.has(bundle.id)"
              :id="detailId(bundle)"
              class="attention-inbox__messages msg-list__items"
              aria-label="Messages in bundle"
            >
              <MessageListRow
                v-for="item in bundle.messages"
                :key="item.message.id"
                :message="rowFor(item.message)"
                :size="rowHeight"
                :dom-id-prefix="`${detailId(bundle)}-member-`"
                :focused="!openBundleId && isOpen(item.message)"
                :selected="messageChecked(item.message)"
                unread-on-avatar
                :draggable="false"
                :context="item.classification.reason"
                :tag-definitions="tagDefinitions"
                @row-click="(_event, trigger) => emit('open', item.message, trigger)"
                @checkbox-click="toggleSelection(item.message, $event)"
              >
                <template #controls>
                  <div class="msg-list__row-controls" draggable="false" @click.stop>
                    <AttentionRowMenu
                      :row="rowFor(item.message)"
                      :disabled="actionDisabled(item.message)"
                      @action="(action, event) => applyMessageAction(item.message, action, event)"
                    />
                  </div>
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

.attention-inbox__header {
  flex: 0 0 auto;
  min-width: 0;
}

.attention-inbox__header :deep(.selectable-list-header__count--total) {
  display: none;
}

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
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.attention-inbox__status {
  margin: 0;
  padding: 16px 18px;
  color: var(--muted);
}

.attention-inbox__status--error {
  color: var(--error-fg);
}

.attention-inbox__bundles,
.attention-inbox__messages {
  margin: 0;
  padding: 0;
  list-style: none;
}

.attention-inbox__expand {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 34px;
  padding: 0 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.attention-inbox__expand:hover {
  background: var(--control-hover-bg);
  color: var(--text);
}

.attention-inbox__expand:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.attention-inbox__expand[aria-expanded='true'] svg {
  transform: rotate(180deg);
}

.attention-inbox__messages {
  margin-inline-start: 27px;
  border-inline-start: 1px solid var(--control-border);
}

@media (pointer: coarse) {
  .attention-inbox__expand {
    min-width: 44px;
    min-height: 44px;
    justify-content: center;
  }
  .attention-inbox__filter {
    min-width: 44px;
    min-height: 44px;
  }
}
</style>

<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { useElementSize } from '@vueuse/core';
import { computed, nextTick, ref, useId } from 'vue';

import { provideSenderAvatars } from '../composables/useSenderAvatars';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import { browserTriageMessageKey } from '../triage/browser-model';
import type { TriageBundle, TriageMessage } from '../triage/smart-sort';
import { closeContainingDropdown } from '../utils/dropdown';
import { CARD_LAYOUT_WIDTH, CARD_ROW_HEIGHT, ROW_HEIGHT, type MessageRowLike } from '../utils/message-row-presentation';
import type { MessageTagDefinition } from '../utils/message-tags';
import AttentionRowMenu from './AttentionRowMenu.vue';
import MessageListRow from './MessageListRow.vue';

const props = withDefaults(defineProps<{
  bundles: readonly TriageBundle[];
  accountLabels?: Readonly<Record<string, string>>;
  loading?: boolean;
  error?: string | null;
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
  open: [message: TriageMessage, trigger: EventTarget | null];
  'message-action': [message: TriageMessage, action: ImapAttentionAction];
  done: [bundle: TriageBundle];
  snooze: [bundle: TriageBundle, until: number];
  restore: [bundle: TriageBundle];
}>();

const filters = [
  { key: 'attention', label: 'Needs attention', empty: 'Nothing needs your attention.' },
  { key: 'updates', label: 'Updates', empty: 'No updates.' },
  { key: 'handled', label: 'Done & snoozed', empty: 'No done or snoozed mail.' },
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
const emptyMessage = computed(() => filters.find(({ key }) => key === selectedFilter.value)?.empty);

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
</script>

<template>
  <section ref="listEl" class="attention-inbox" :class="{ 'msg-list--card': cardLayout }" :aria-labelledby="headingId">
    <header class="attention-inbox__header">
      <h2 :id="headingId">Smart Inbox</h2>
      <slot name="actions" />
    </header>
    <div
      ref="filterBar"
      class="attention-inbox__filters"
      role="group"
      aria-label="Smart Inbox filters"
    >
      <button
        v-for="filter in filters"
        :key="filter.key"
        class="attention-inbox__filter"
        type="button"
        :aria-pressed="selectedFilter === filter.key"
        @click="selectedFilter = filter.key"
      >
        {{ filter.label }}
        <span class="attention-inbox__count">{{ bundlesByFilter[filter.key].length }}</span>
      </button>
    </div>
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
          :message="rowFor(bundle.leading.message)"
          :size="rowHeight"
          :dom-id-prefix="`${detailId(bundle)}-leader-`"
          :focused="isOpen(bundle.leading.message)"
          :selectable="false"
          :draggable="false"
          :context="bundleContext(bundle)"
          :tag-definitions="tagDefinitions"
          @row-click="(_event, trigger) => emit('open', bundle.leading.message, trigger)"
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
                :row="rowFor(bundle.leading.message)"
                :bundle="bundle"
                :disabled="actionDisabled(bundle.leading.message)"
                @action="(action, event) => applyMessageAction(bundle.leading.message, action, event)"
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
                :focused="isOpen(item.message)"
                :selectable="false"
                :draggable="false"
                :context="item.classification.reason"
                :tag-definitions="tagDefinitions"
                @row-click="(_event, trigger) => emit('open', item.message, trigger)"
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

.attention-inbox__header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 56px;
  padding: 8px 18px;
}

.attention-inbox__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}

.attention-inbox__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 14px 10px;
  border-bottom: 1px solid var(--border);
}

.attention-inbox__filter {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.attention-inbox__filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 4px 7px;
  border-radius: 6px;
  font-size: 13px;
}

.attention-inbox__filter[aria-pressed='true'] {
  background: var(--rowActive);
  font-weight: 650;
}

.attention-inbox__count {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
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

.attention-inbox__filter:hover {
  background: var(--rowHover);
}

.attention-inbox__filter:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
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

@media (hover: hover) and (pointer: fine) {
  .attention-inbox__bundles :deep(.msg-list__item:not(:hover, :focus-within) .attention-row-menu:not([open])) {
    opacity: 0;
    pointer-events: none;
  }
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
    min-height: 40px;
  }
}
</style>

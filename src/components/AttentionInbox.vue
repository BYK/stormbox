<script setup lang="ts">
import { Check, ChevronDown, Clock, RotateCcw } from '@lucide/vue';
import { computed, nextTick, ref, useId } from 'vue';

import type { TriageBundle, TriageMessage } from '../triage/smart-sort';
import { closeContainingDropdown } from '../utils/dropdown';
import { fmtDate } from '../utils/message-row-presentation';
import { shortFrom } from '../utils/sender-avatar';
import AppDropdown from './AppDropdown.vue';
import AppIconButton from './AppIconButton.vue';

const props = withDefaults(defineProps<{
  bundles: readonly TriageBundle[];
  accountLabels?: Readonly<Record<string, string>>;
  loading?: boolean;
  error?: string | null;
  openMessage?: TriageMessage;
}>(), {
  accountLabels: () => ({}),
  loading: false,
  error: null,
});

const emit = defineEmits<{
  open: [message: TriageMessage, trigger: EventTarget | null];
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
const expandedBundles = ref(new Set<string>());

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

function subjectOf(message: TriageMessage): string {
  return message.subject?.trim() || '(no subject)';
}

function isOpen(message: TriageMessage): boolean {
  return props.openMessage?.id === message.id && props.openMessage?.accountId === message.accountId;
}

function accountLabel(bundle: TriageBundle): string {
  return props.accountLabels[String(bundle.accountId)] || '';
}

function senderOf(message: TriageMessage): string {
  return message.sender ? shortFrom(message.sender) : '';
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

function tomorrowMorning(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

async function keepFilterFocus(source: EventTarget | null): Promise<void> {
  if (!(source instanceof HTMLElement)) return;
  await nextTick();
  if (!source.isConnected || source.closest('details:not([open])')) {
    filterBar.value?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }
}

function complete(bundle: TriageBundle, event: MouseEvent): void {
  emit('done', bundle);
  void keepFilterFocus(event.currentTarget);
}

function restore(bundle: TriageBundle, event: MouseEvent): void {
  emit('restore', bundle);
  void keepFilterFocus(event.currentTarget);
}

function snooze(bundle: TriageBundle, until: number, event: MouseEvent): void {
  closeContainingDropdown(event);
  emit('snooze', bundle, until);
  void keepFilterFocus(event.currentTarget);
}
</script>

<template>
  <section class="attention-inbox" :aria-labelledby="headingId">
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
      <ul v-else class="attention-inbox__bundles">
        <li
          v-for="bundle in visibleBundles"
          :key="bundle.id"
          class="attention-inbox__bundle"
        >
          <div class="attention-inbox__row">
            <button
              class="attention-inbox__preview"
              type="button"
              :aria-current="isOpen(bundle.leading.message) || undefined"
              @click="emit('open', bundle.leading.message, $event.currentTarget)"
            >
              <span class="attention-inbox__subject">{{ subjectOf(bundle.leading.message) }}</span>
              <span class="attention-inbox__details">
                <span v-if="bundle.status === 'action'" class="attention-inbox__priority">
                  {{ bundle.priority }}
                </span>
                <span v-if="bundle.status === 'snoozed'">{{ snoozeLabel(bundle.snoozedUntil) }}</span>
                <span v-else-if="bundle.status === 'done'">Done</span>
                <span v-else class="attention-inbox__reason">{{ bundle.reason }}</span>
                <span v-if="senderOf(bundle.leading.message)" class="attention-inbox__address">
                  {{ senderOf(bundle.leading.message) }}
                </span>
                <span v-if="accountLabel(bundle)" class="attention-inbox__address">
                  {{ accountLabel(bundle) }}
                </span>
                <time v-if="dateTime(bundle.latestAt)" :datetime="dateTime(bundle.latestAt)">
                  {{ fmtDate(bundle.latestAt) }}
                </time>
              </span>
            </button>

            <div class="attention-inbox__actions">
              <slot name="message-actions" :message="bundle.leading.message" />
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
              <template v-if="bundle.status === 'done' || bundle.status === 'snoozed'">
                <AppIconButton
                  :aria-label="bundle.status === 'snoozed' ? 'Cancel snooze' : 'Restore bundle'"
                  :title="bundle.status === 'snoozed' ? 'Cancel snooze' : 'Restore bundle'"
                  @click="restore(bundle, $event)"
                >
                  <RotateCcw :size="16" aria-hidden="true" />
                </AppIconButton>
              </template>
              <template v-else>
                <AppDropdown class="attention-inbox__snooze">
                  <summary
                    class="app-dropdown__summary attention-inbox__snooze-trigger"
                    aria-label="Snooze bundle"
                    title="Snooze"
                  >
                    <Clock :size="16" aria-hidden="true" />
                  </summary>
                  <div class="app-dropdown__menu attention-inbox__snooze-menu" role="group" aria-label="Snooze until">
                    <button
                      class="app-dropdown__item"
                      type="button"
                      @click="snooze(bundle, Date.now() + 60 * 60 * 1000, $event)"
                    >
                      <Clock :size="15" aria-hidden="true" />
                      In one hour
                    </button>
                    <button
                      class="app-dropdown__item"
                      type="button"
                      @click="snooze(bundle, tomorrowMorning(), $event)"
                    >
                      <Clock :size="15" aria-hidden="true" />
                      Tomorrow at 9 AM
                    </button>
                  </div>
                </AppDropdown>
                <AppIconButton aria-label="Mark bundle done" title="Done" @click="complete(bundle, $event)">
                  <Check :size="17" aria-hidden="true" />
                </AppIconButton>
              </template>
            </div>
          </div>

          <ul
            v-if="bundle.messages.length > 1"
            v-show="expandedBundles.has(bundle.id)"
            :id="detailId(bundle)"
            class="attention-inbox__messages"
            aria-label="Messages in bundle"
          >
            <li v-for="item in bundle.messages" :key="item.message.id" class="attention-inbox__row">
              <button
                class="attention-inbox__preview attention-inbox__message"
                type="button"
                :aria-current="isOpen(item.message) || undefined"
                @click="emit('open', item.message, $event.currentTarget)"
              >
                <span class="attention-inbox__subject">{{ subjectOf(item.message) }}</span>
                <span class="attention-inbox__details">
                  <span v-if="senderOf(item.message)" class="attention-inbox__address">{{ senderOf(item.message) }}</span>
                  <span class="attention-inbox__reason">{{ item.classification.reason }}</span>
                  <time v-if="dateTime(item.message.receivedAt)" :datetime="dateTime(item.message.receivedAt)">
                    {{ fmtDate(item.message.receivedAt) }}
                  </time>
                </span>
              </button>
              <div v-if="$slots['message-actions']" class="attention-inbox__actions">
                <slot name="message-actions" :message="item.message" />
              </div>
            </li>
          </ul>
        </li>
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
  flex-wrap: wrap;
  gap: 12px;
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

.attention-inbox__filter,
.attention-inbox__expand,
.attention-inbox__snooze-trigger,
.attention-inbox__preview {
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

.attention-inbox__bundle {
  border-bottom: 1px solid var(--border);
}

.attention-inbox__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-height: 61px;
  padding: 4px 10px;
}

.attention-inbox__preview {
  display: grid;
  gap: 4px;
  min-width: 0;
  width: 100%;
  padding: 8px;
  border-radius: 6px;
  text-align: left;
}

.attention-inbox__filter:hover,
.attention-inbox__expand:hover,
.attention-inbox__snooze-trigger:hover,
.attention-inbox__preview:hover {
  background: var(--rowHover);
}

.attention-inbox__preview[aria-current='true'] {
  background: var(--rowActive);
}

.attention-inbox__filter:focus-visible,
.attention-inbox__expand:focus-visible,
.attention-inbox__snooze-trigger:focus-visible,
.attention-inbox__preview:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.attention-inbox__subject {
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attention-inbox__details {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 9px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}

.attention-inbox__reason,
.attention-inbox__address {
  min-width: 0;
  overflow-wrap: anywhere;
}

.attention-inbox__reason {
  color: var(--text);
}

.attention-inbox__priority {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.attention-inbox__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.attention-inbox__expand,
.attention-inbox__snooze-trigger {
  display: inline-flex;
  min-height: 34px;
  min-width: 34px;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 0 5px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.attention-inbox__expand[aria-expanded='true'] svg {
  transform: rotate(180deg);
}

.attention-inbox__snooze-trigger::after {
  display: none;
}

.attention-inbox__snooze-menu {
  right: 0;
  left: auto;
  background: var(--panel);
}

.attention-inbox__messages {
  margin: 0 18px 9px 27px;
  padding-left: 8px;
  border-left: 1px solid var(--control-border);
}

.attention-inbox__message .attention-inbox__subject {
  font-size: 13px;
  font-weight: 500;
}

@container (max-width: 460px) {
  .attention-inbox__row {
    align-items: start;
    gap: 2px;
    padding-inline: 6px;
  }

  .attention-inbox__actions {
    padding-top: 4px;
  }

  .attention-inbox__row:has(.attention-message-actions) {
    grid-template-columns: minmax(0, 1fr);
  }

  .attention-inbox__row:has(.attention-message-actions) > .attention-inbox__actions {
    justify-content: end;
    padding-top: 0;
  }

  .attention-inbox__details {
    gap: 2px 6px;
  }
}

@media (pointer: coarse) {
  .attention-inbox__filter,
  .attention-inbox__expand,
  .attention-inbox__snooze-trigger {
    min-height: 40px;
  }

  .attention-inbox__actions :deep(.app-icon-button) {
    width: 40px;
    height: 40px;
    flex-basis: 40px;
  }
}
</style>

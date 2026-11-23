<script setup lang="ts">
import { Circle, CircleAlert, Info, Plus, RefreshCw, Star, X } from '@lucide/vue';
import { computed, nextTick, ref, toRef, watch } from 'vue';
import type { BulkActionItem } from '../composables/useBulkActionItems';
import { useMessageListHeader } from '../composables/useMessageListHeader';
import AppDropdown from './AppDropdown.vue';
import MessageBulkActions from './MessageBulkActions.vue';
import MessageListMoreMenu, { type MoreMenuItem } from './MessageListMoreMenu.vue';
import SelectableListHeader from './SelectableListHeader.vue';

const props = withDefaults(defineProps<{
  listWidth: number;
  folderId: number | string | null;
  folderName: string;
  totalCount: number;
  allSelected: boolean;
  selectedCount: number;
  unreadOnly: boolean;
  starredOnly: boolean;
  isLoading: boolean;
  refreshDisabled?: boolean;
  status?: string[];
  statusError?: boolean;
  columnIndex?: number;
  primary?: boolean;
  canAddColumn?: boolean;
  columnControls?: boolean;
  bulkActionItems?: BulkActionItem[];
  viewActions?: MoreMenuItem[];
}>(), {
  refreshDisabled: false,
  status: () => [],
  statusError: false,
  columnIndex: 1,
  primary: true,
  canAddColumn: true,
  columnControls: false,
  bulkActionItems: () => [],
  viewActions: () => [],
});

const emit = defineEmits<{
  'refresh': [];
  'add-column': [];
  'remove-column': [];
  'toggle-all': [];
  'clear-selection': [];
  'toggle-unread': [];
  'toggle-starred': [];
}>();

const header = ref<InstanceType<typeof SelectableListHeader> | null>(null);
const moreMenu = ref<InstanceType<typeof MessageListMoreMenu> | null>(null);
const columnControl = ref<HTMLButtonElement | null>(null);
const hasStatus = computed(() => props.status.length > 0);
const showStatusText = computed(() => props.selectedCount === 0
  && (props.listWidth === 0 || props.listWidth >= 720));
const statusText = computed(() => props.status.join(' · '));
const headerElement = computed(() => header.value?.$el as HTMLElement | undefined);

const {
  tier,
  showsCount,
  filterLabels,
  showsInlineControls,
  showsMoreMenu,
  moreMenuGroups,
  bulkActions,
  addColumnTitle,
  removeColumnTitle,
} = useMessageListHeader({
  listWidth: toRef(props, 'listWidth'),
  hasSelection: computed(() => props.selectedCount > 0),
  folderId: toRef(props, 'folderId'),
  folderName: toRef(props, 'folderName'),
  isLoading: toRef(props, 'isLoading'),
  primary: toRef(props, 'primary'),
  canAddColumn: toRef(props, 'canAddColumn'),
  columnIndex: toRef(props, 'columnIndex'),
  columnControls: toRef(props, 'columnControls'),
  bulkActionItems: toRef(props, 'bulkActionItems'),
  refreshDisabled: toRef(props, 'refreshDisabled'),
  viewActions: toRef(props, 'viewActions'),
  hasStatus,
  refresh: () => emit('refresh'),
  addColumn: () => emit('add-column'),
  removeColumn: () => emit('remove-column'),
});

function focusColumnControl() {
  if (columnControl.value) columnControl.value.focus();
  else if (moreMenu.value) moreMenu.value.focusTrigger();
  else headerElement.value?.querySelector<HTMLElement>('.msg-list__refresh')?.focus();
}

// Keep focus in the toolbar when a menu disappears.
watch([showsMoreMenu, hasStatus], ([more, status], [hadMore, hadStatus]) => {
  const active = document.activeElement;
  if ((hadMore && !more && headerElement.value?.querySelector('.msg-list__more')?.contains(active))
      || (hadStatus && !status && headerElement.value?.querySelector('.msg-list__status')?.contains(active))) {
    void nextTick(focusColumnControl);
  }
});

defineExpose({ focusColumnControl });
</script>

<template>
  <SelectableListHeader
    ref="header"
    class="msg-list__header"
    :data-header-tier="tier"
    :all-selected="allSelected"
    clear-class="msg-list__bulk-action msg-list__bulk-action--ghost"
    count-class="msg-list__count"
    :disabled="folderId == null"
    item-label="messages"
    select-all-class="msg-list__select-all"
    selection-actions-class="msg-list__bulk-actions"
    singular-item-label="message"
    :selected-count="selectedCount"
    :show-total-count="showsCount"
    :total-count="totalCount"
    @clear-selection="emit('clear-selection')"
    @toggle-all="emit('toggle-all')"
  >
    <template #selection-actions>
      <MessageBulkActions :items="bulkActions.inline">
        <template v-if="$slots.tag" #tag="{ item }">
          <slot name="tag" :item="item" />
        </template>
      </MessageBulkActions>
    </template>
    <template #normal-actions>
      <slot name="title" :compact="!filterLabels" />
      <div
        v-if="folderId != null"
        class="msg-list__filters"
        :class="{
          'msg-list__filters--icons': !filterLabels,
          'msg-list__filters--lead': !$slots.title,
        }"
        role="group"
        aria-label="Message filters"
      >
        <button
          class="msg-list__filter"
          :class="{ 'is-active': unreadOnly }"
          type="button"
          :aria-pressed="unreadOnly"
          aria-label="Unread"
          title="Unread"
          @click="emit('toggle-unread')"
        >
          <Circle v-if="!filterLabels" :size="10" :stroke-width="2" fill="currentColor" aria-hidden="true" />
          <template v-else>Unread</template>
        </button>
        <button
          class="msg-list__filter msg-list__filter--starred"
          :class="{ 'is-active': starredOnly }"
          type="button"
          :aria-pressed="starredOnly"
          aria-label="Starred"
          title="Starred"
          @click="emit('toggle-starred')"
        >
          <Star v-if="!filterLabels" :size="16" :stroke-width="1.75" aria-hidden="true" />
          <template v-else>Starred</template>
        </button>
      </div>
    </template>
    <template #trailing>
      <span class="msg-list__status-announcement" role="status">{{ statusText }}</span>
      <AppDropdown v-if="hasStatus" class="msg-list__status">
        <summary
          class="app-dropdown__summary msg-list__status-trigger"
          :class="{ 'is-error': statusError }"
          :aria-label="statusError ? 'Mail status, attention required' : 'Mail status'"
          :title="statusText"
        >
          <CircleAlert v-if="statusError" :size="16" :stroke-width="1.75" aria-hidden="true" />
          <Info v-else :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span v-if="showStatusText" aria-hidden="true" class="msg-list__status-label">{{ statusText }}</span>
        </summary>
        <div class="app-dropdown__menu msg-list__status-panel">
          <p v-for="(line, index) in status" :key="index">{{ line }}</p>
          <slot name="status-actions" />
        </div>
      </AppDropdown>
      <template v-if="showsInlineControls">
        <button
          v-if="folderId != null"
          class="msg-list__refresh"
          type="button"
          :disabled="refreshDisabled"
          :aria-label="isLoading ? 'Refreshing' : 'Refresh'"
          :title="isLoading ? 'Refreshing…' : 'Refresh'"
          @click="emit('refresh')"
        >
          <RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" :class="{ 'is-spinning': isLoading }" />
        </button>
        <button
          v-if="columnControls && primary"
          ref="columnControl"
          class="msg-list__column-control msg-list__add-column"
          type="button"
          :disabled="!canAddColumn"
          :title="addColumnTitle"
          :aria-label="addColumnTitle"
          @click="emit('add-column')"
        >
          <Plus :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <button
          v-else-if="columnControls"
          ref="columnControl"
          class="msg-list__column-control msg-list__remove-column"
          type="button"
          title="Remove column"
          :aria-label="removeColumnTitle"
          @click="emit('remove-column')"
        >
          <X :size="18" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </template>
      <MessageListMoreMenu
        v-if="showsMoreMenu"
        ref="moreMenu"
        :groups="moreMenuGroups"
        :label="columnControls ? `More actions for column ${columnIndex}` : 'More actions'"
      />
    </template>
  </SelectableListHeader>
</template>

<style scoped>
.msg-list__header {
  min-width: 0;
  flex-wrap: nowrap;
}
.msg-list__header :deep(.selectable-list-header__normal-actions) {
  gap: 10px;
}
.msg-list__column-control {
  display: inline-grid;
  flex: 0 0 auto;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.msg-list__column-control:hover,
.msg-list__column-control:focus-visible {
  background: var(--control-hover-bg);
  color: var(--text);
}
.msg-list__column-control:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.msg-list__column-control:disabled {
  cursor: default;
  opacity: 0.45;
}
.msg-list__column-control:disabled:hover {
  background: transparent;
  color: var(--muted);
}
.msg-list__filters {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
}
.msg-list__filters--lead {
  flex: 1 1 0;
  min-width: 0;
}
.msg-list__filters--icons .msg-list__filter {
  display: inline-grid;
  place-items: center;
  width: 34px;
  padding: 0;
}
.msg-list__refresh:disabled {
  cursor: default;
  opacity: 0.5;
}
.msg-list__refresh {
  background: transparent;
  border: 0;
  color: var(--muted);
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  cursor: pointer;
  flex-shrink: 0;
}
.msg-list__refresh:hover:where(:not(:disabled)),
.msg-list__status-trigger:hover,
.msg-list__status[open] .msg-list__status-trigger {
  background: var(--control-hover-bg);
  color: var(--text);
}
.msg-list__refresh:focus-visible,
.msg-list__status-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.msg-list__status {
  flex: 0 0 auto;
}
.msg-list__status-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 34px;
  height: 34px;
  box-sizing: border-box;
  padding: 0 6px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 12px;
}
.msg-list__status-trigger::after { content: none; }
.msg-list__status-trigger.is-error { color: var(--error-fg, #bc3939); }
.msg-list__status-label {
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__status-panel {
  inset-inline: auto 0;
  min-width: min(220px, 66vw);
  width: max-content;
  max-width: min(360px, 66vw);
  padding: 9px 12px;
  color: var(--text);
  font-size: 12px;
}
.msg-list__status-panel p { margin: 0; overflow-wrap: anywhere; }
.msg-list__status-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.is-spinning { animation: msg-spin 1.2s linear infinite; }
@keyframes msg-spin { to { transform: rotate(360deg); } }
</style>

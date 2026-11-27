<script setup lang="ts">
import { Archive, Check, Clock, Flame, Layers, Mail, MailOpen, RotateCcw, Star, Tags, Trash2 } from '@lucide/vue';
import { computed, shallowRef } from 'vue';

import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import type { TriageBundle } from '../triage/smart-sort';
import { closeContainingDropdown } from '../utils/dropdown';
import type { MessageRowLike } from '../utils/message-row-presentation';
import AppIconButton from './AppIconButton.vue';
import AttentionActionMenu from './AttentionActionMenu.vue';
import AttentionSnoozeDialog from './AttentionSnoozeDialog.vue';

const props = withDefaults(defineProps<{
  row: MessageRowLike;
  label?: string;
  bundle?: TriageBundle;
  disabled?: boolean;
  canTrash?: boolean;
  canArchive?: boolean;
  canJunk?: boolean;
  canTag?: boolean;
  quick?: boolean;
  stackAction?: string;
}>(), { canTrash: true });
const emit = defineEmits<{
  action: [action: ImapAttentionAction, event: MouseEvent];
  tag: [trigger: HTMLElement];
  done: [bundle: TriageBundle, event: MouseEvent];
  restore: [bundle: TriageBundle, event: MouseEvent];
  snooze: [bundle: TriageBundle, until: number, trigger: HTMLElement];
  'toggle-stack': [];
}>();
const flagged = computed(() => Number(props.row.is_flagged) === 1);
const unread = computed(() => Number(props.row.is_seen) === 0);
const handled = computed(() => props.bundle?.status === 'done' || props.bundle?.status === 'snoozed');
const canSnooze = computed(() => props.bundle != null && props.bundle.status !== 'done');
const restoreLabel = computed(() => props.bundle?.status === 'snoozed' ? 'Cancel snooze' : 'Restore bundle');
const snoozeTrigger = shallowRef<HTMLElement | null>(null);

function chooseAction(event: MouseEvent, action: ImapAttentionAction): void {
  closeContainingDropdown(event, true);
  emit('action', action, event);
}

function chooseTag(event: MouseEvent): void {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  const trigger = event.currentTarget.closest('details')?.querySelector('summary');
  closeContainingDropdown(event, true);
  if (trigger) emit('tag', trigger);
}

function openSnooze(event: MouseEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  showSnooze(target.closest('details')?.querySelector('summary') ?? target);
  closeContainingDropdown(event, true);
}

function showSnooze(trigger: HTMLElement) {
  if (canSnooze.value) snoozeTrigger.value = trigger;
}
defineExpose({ showSnooze });

function snooze(until: number) {
  const trigger = snoozeTrigger.value;
  snoozeTrigger.value = null;
  if (props.bundle && canSnooze.value && trigger) emit('snooze', props.bundle, until, trigger);
}
</script>

<template>
  <div class="attention-row-actions" :class="{ 'attention-row-actions--quick': quick }">
    <template v-if="bundle && quick">
      <AppIconButton v-if="canTrash" class="attention-row-actions__secondary" danger :disabled="disabled"
        aria-label="Delete" title="Move to Trash" @click="chooseAction($event, { type: 'trash' })">
        <Trash2 :size="17" aria-hidden="true" />
      </AppIconButton>
      <AppIconButton v-if="canSnooze" class="attention-row-actions__secondary" aria-label="Snooze" title="Snooze" aria-haspopup="dialog" @click="openSnooze">
        <Clock :size="17" aria-hidden="true" />
      </AppIconButton>
      <AppIconButton v-if="handled" :aria-label="restoreLabel" :title="restoreLabel" @click="emit('restore', bundle, $event)">
        <RotateCcw :size="17" aria-hidden="true" />
      </AppIconButton>
      <AppIconButton v-else aria-label="Mark done" title="Mark done" @click="emit('done', bundle, $event)">
        <Check :size="17" aria-hidden="true" />
      </AppIconButton>
    </template>
    <AttentionActionMenu class="attention-row-menu" :label="label ?? 'Message actions'">
      <button v-if="stackAction" class="app-dropdown__item" type="button"
        @click="closeContainingDropdown($event, true); emit('toggle-stack')">
        <Layers :size="16" aria-hidden="true" />
        {{ stackAction }}
      </button>
      <button
        v-if="canTag"
        class="app-dropdown__item"
        type="button"
        aria-haspopup="dialog"
        :disabled="disabled"
        @click="chooseTag"
      >
        <Tags :size="16" aria-hidden="true" />
        Tags
      </button>
      <button
        class="app-dropdown__item"
        type="button"
        aria-label="Star"
        :aria-pressed="flagged"
        :disabled="disabled"
        @click="chooseAction($event, { type: 'star', value: !flagged })"
      >
        <Star :size="16" :fill="flagged ? 'currentColor' : 'none'" aria-hidden="true" />
        {{ flagged ? 'Unstar' : 'Star' }}
      </button>
      <button
        class="app-dropdown__item"
        type="button"
        :disabled="disabled"
        @click="chooseAction($event, { type: 'seen', value: unread })"
      >
        <component :is="unread ? MailOpen : Mail" :size="16" aria-hidden="true" />
        {{ unread ? 'Mark as read' : 'Mark as unread' }}
      </button>
      <button
        v-if="canArchive"
        class="app-dropdown__item"
        type="button"
        :disabled="disabled"
        @click="chooseAction($event, { type: 'archive' })"
      >
        <Archive :size="16" aria-hidden="true" />
        Archive
      </button>
      <button
        v-if="canJunk"
        class="app-dropdown__item"
        type="button"
        :disabled="disabled"
        @click="chooseAction($event, { type: 'junk' })"
      >
        <Flame :size="16" aria-hidden="true" />
        Move to Junk
      </button>
      <button
        v-if="canTrash"
        class="app-dropdown__item"
        :class="{ 'attention-row-actions__overflow-fallback': quick }"
        type="button"
        :disabled="disabled"
        @click="chooseAction($event, { type: 'trash' })"
      >
        <Trash2 :size="16" aria-hidden="true" />
        Move to Trash
      </button>
      <template v-if="bundle">
        <button v-if="canSnooze" class="app-dropdown__item" :class="{ 'attention-row-actions__overflow-fallback': quick }"
          type="button" aria-haspopup="dialog" @click="openSnooze">
          <Clock :size="16" aria-hidden="true" />
          Snooze
        </button>
        <template v-if="!quick">
          <button v-if="handled" class="app-dropdown__item" type="button" @click="emit('restore', bundle, $event)">
            <RotateCcw :size="16" aria-hidden="true" />
            {{ restoreLabel }}
          </button>
          <button v-else class="app-dropdown__item" type="button" @click="emit('done', bundle, $event)">
            <Check :size="16" aria-hidden="true" />
            Mark bundle done
          </button>
        </template>
      </template>
    </AttentionActionMenu>
    <AttentionSnoozeDialog v-if="snoozeTrigger" :return-focus="snoozeTrigger" @close="snoozeTrigger = null" @select="snooze" />
  </div>
</template>

<style scoped>
.attention-row-actions { display: flex; align-items: center; }
.app-dropdown__item.attention-row-actions__overflow-fallback { display: none; }
@media (max-width: 639px) and (pointer: coarse) {
  .attention-row-actions--quick > :deep(.app-icon-button) {
    width: 44px;
    height: var(--row-touch-action-height, 44px);
    flex-basis: 44px;
  }
  .attention-row-actions--quick > .attention-row-actions__secondary { display: none; }
  .app-dropdown__item.attention-row-actions__overflow-fallback { display: grid; }
}
</style>

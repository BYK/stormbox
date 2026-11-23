<script setup lang="ts">
import { Check, Clock, Mail, MailOpen, RotateCcw, Star, Trash2 } from '@lucide/vue';
import { computed } from 'vue';

import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import type { TriageBundle } from '../triage/smart-sort';
import { closeContainingDropdown } from '../utils/dropdown';
import type { MessageRowLike } from '../utils/message-row-presentation';
import AttentionActionMenu from './AttentionActionMenu.vue';

const props = defineProps<{
  row: MessageRowLike;
  bundle?: TriageBundle;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  action: [action: ImapAttentionAction, event: MouseEvent];
  done: [bundle: TriageBundle, event: MouseEvent];
  restore: [bundle: TriageBundle, event: MouseEvent];
  snooze: [bundle: TriageBundle, until: number, event: MouseEvent];
}>();
const flagged = computed(() => Number(props.row.is_flagged) === 1);
const unread = computed(() => Number(props.row.is_seen) === 0);
const handled = computed(() => props.bundle?.status === 'done' || props.bundle?.status === 'snoozed');

function chooseAction(event: MouseEvent, action: ImapAttentionAction): void {
  closeContainingDropdown(event, true);
  emit('action', action, event);
}

function snoozeUntilTomorrow(): number {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}
</script>

<template>
  <AttentionActionMenu class="attention-row-menu" label="Message actions">
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
    <template v-if="bundle">
      <button
        v-if="handled"
        class="app-dropdown__item"
        type="button"
        @click="emit('restore', bundle, $event)"
      >
        <RotateCcw :size="16" aria-hidden="true" />
        {{ bundle.status === 'snoozed' ? 'Cancel snooze' : 'Restore bundle' }}
      </button>
      <template v-else>
        <button class="app-dropdown__item" type="button" @click="emit('done', bundle, $event)">
          <Check :size="16" aria-hidden="true" />
          Mark bundle done
        </button>
        <button
          class="app-dropdown__item"
          type="button"
          @click="emit('snooze', bundle, Date.now() + 60 * 60 * 1000, $event)"
        >
          <Clock :size="16" aria-hidden="true" />
          Snooze for one hour
        </button>
        <button
          class="app-dropdown__item"
          type="button"
          @click="emit('snooze', bundle, snoozeUntilTomorrow(), $event)"
        >
          <Clock :size="16" aria-hidden="true" />
          Snooze until tomorrow at 9 AM
        </button>
      </template>
    </template>
    <button
      class="app-dropdown__item"
      type="button"
      :disabled="disabled"
      @click="chooseAction($event, { type: 'trash' })"
    >
      <Trash2 :size="16" aria-hidden="true" />
      Move to Trash
    </button>
  </AttentionActionMenu>
</template>

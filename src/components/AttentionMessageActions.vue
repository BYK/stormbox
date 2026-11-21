<script setup lang="ts">
import { Mail, MailOpen, Star, Trash2 } from '@lucide/vue';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import AppIconButton from './AppIconButton.vue';

defineProps<{
  state?: { flagged: boolean; seen: boolean };
  disabled: boolean;
}>();

const emit = defineEmits<{ action: [action: ImapAttentionAction] }>();
</script>

<template>
  <div v-if="state" class="attention-message-actions" role="group" aria-label="Message actions">
    <AppIconButton
      aria-label="Star"
      :title="state.flagged ? 'Unstar' : 'Star'"
      :aria-pressed="state.flagged"
      :disabled="disabled"
      @click="emit('action', { type: 'star', value: !state.flagged })"
    >
      <Star :size="16" :fill="state.flagged ? 'currentColor' : 'none'" aria-hidden="true" />
    </AppIconButton>
    <AppIconButton
      :aria-label="state.seen ? 'Mark as unread' : 'Mark as read'"
      :title="state.seen ? 'Mark as unread' : 'Mark as read'"
      :disabled="disabled"
      @click="emit('action', { type: 'seen', value: !state.seen })"
    >
      <Mail v-if="state.seen" :size="16" aria-hidden="true" />
      <MailOpen v-else :size="16" aria-hidden="true" />
    </AppIconButton>
    <AppIconButton
      aria-label="Delete"
      title="Move to Trash"
      danger
      :disabled="disabled"
      @click="emit('action', { type: 'trash' })"
    >
      <Trash2 :size="16" aria-hidden="true" />
    </AppIconButton>
  </div>
</template>

<style scoped>
.attention-message-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.attention-message-actions [aria-pressed='true'] {
  color: var(--text);
}
</style>

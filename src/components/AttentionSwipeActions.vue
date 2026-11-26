<script setup lang="ts">
import { Check, Clock, Trash2 } from '@lucide/vue';
import { ATTENTION_SWIPE_REVEAL_WIDTH } from '../composables/useAttentionRowSwipe';

defineProps<{ armed: boolean; dragging: boolean }>();
const emit = defineEmits<{ delete: [event: MouseEvent]; snooze: [event: MouseEvent] }>();
</script>

<template>
  <div
    class="attention-swipe-actions"
    :class="{ 'attention-swipe-actions--armed': armed }"
    :style="{ '--attention-swipe-button-width': `${ATTENTION_SWIPE_REVEAL_WIDTH / 2}px` }"
    :aria-hidden="dragging ? true : undefined"
  >
    <span v-if="armed" class="attention-swipe-actions__done">
      <Check :size="19" aria-hidden="true" /> Done
    </span>
    <template v-else>
      <button type="button" data-attention-swipe-action :disabled="dragging"
        class="attention-swipe-actions__trash" @click="emit('delete', $event)">
        <Trash2 :size="18" aria-hidden="true" /> Delete
      </button>
      <button type="button" data-attention-swipe-action :disabled="dragging" @click="emit('snooze', $event)">
        <Clock :size="18" aria-hidden="true" /> Snooze
      </button>
    </template>
  </div>
</template>

<style scoped>
.attention-swipe-actions {
  position: absolute;
  inset: var(--attention-swipe-card-inset, 0) 0 0;
  display: flex;
  justify-content: flex-end;
  background: var(--panel2);
  pointer-events: none;
}
.attention-swipe-actions button {
  display: grid;
  width: var(--attention-swipe-button-width);
  align-content: center;
  justify-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: var(--control-hover-bg);
  color: var(--text);
  font: inherit;
  font-size: 12px;
}
.attention-swipe-actions button:not(:disabled) {
  pointer-events: auto;
  cursor: pointer;
}
.attention-swipe-actions button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.attention-swipe-actions button:disabled { color: var(--muted); }
.attention-swipe-actions .attention-swipe-actions__trash { background: var(--error-bg); }
.attention-swipe-actions__trash:not(:disabled) { color: var(--error-fg); }
.attention-swipe-actions--armed { background: color-mix(in srgb, var(--accent) 24%, var(--panel)); }
.attention-swipe-actions__done { display: flex; align-items: center; gap: 6px; padding: 0 14px; }
</style>

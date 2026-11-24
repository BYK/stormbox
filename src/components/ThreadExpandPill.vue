<script setup lang="ts">
import { ChevronDown, ChevronUp } from '@lucide/vue';

defineProps<{ count: number; expanded: boolean; controls?: string }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="thread-expand">
    <button type="button" class="thread-expand__pill" data-message-control
      :aria-expanded="expanded" :aria-controls="controls" @click.stop="emit('toggle')">
      {{ expanded ? 'Hide' : 'Show' }} {{ count }} {{ count === 1 ? 'message' : 'messages' }}
      <component :is="expanded ? ChevronUp : ChevronDown" :size="13" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.thread-expand {
  position: relative;
  z-index: 1;
  block-size: 0;
}
.thread-expand__pill {
  position: absolute;
  inset-block-start: -0.5px;
  inset-inline: 0;
  inline-size: max-content;
  max-inline-size: calc(100% - 16px);
  margin-inline: auto;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-block-size: 24px;
  padding: 1px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font: inherit;
  font-size: .75rem;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.thread-expand__pill:hover,
.thread-expand__pill[aria-expanded='true'] { background: var(--control-hover-bg); color: var(--text); }
.thread-expand__pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

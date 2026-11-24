<script setup lang="ts">
import { ChevronDown, ChevronUp } from '@lucide/vue';
import LetterStackIcon from './LetterStackIcon.vue';

defineProps<{ count: number; expanded: boolean; controls?: string }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="thread-expand">
    <button type="button" class="thread-expand__pill" data-message-control
      :aria-label="`${expanded ? 'Hide' : 'Show'} ${count} ${count === 1 ? 'message' : 'messages'}`"
      :aria-expanded="expanded" :aria-controls="controls" @click.stop="emit('toggle')">
      <LetterStackIcon />
      <span aria-hidden="true">{{ count }}</span>
      <component :is="expanded ? ChevronUp : ChevronDown" :size="11" aria-hidden="true" />
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
  inset-block-start: 0;
  inset-inline: 0;
  inline-size: max-content;
  max-inline-size: calc(100% - 16px);
  margin-inline: auto;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  block-size: 18px;
  padding-inline: 5px;
  border: 0;
  border-radius: 5px;
  background: var(--panel);
  color: var(--muted);
  font: inherit;
  font-size: .6875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.thread-expand__pill::before { content: ''; position: absolute; inset: -3px -5px; }
.thread-expand__pill:hover,
.thread-expand__pill[aria-expanded='true'] { background: var(--control-hover-bg); color: var(--text); }
.thread-expand__pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

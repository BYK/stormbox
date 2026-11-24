<script setup lang="ts">
defineProps<{ count: number; expanded: boolean; controls?: string }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="thread-expand">
    <button type="button" class="thread-expand__pill" data-message-control
      :aria-expanded="expanded" :aria-controls="controls" @click.stop="emit('toggle')">
      {{ expanded ? 'Hide' : 'Show' }} {{ count }} {{ count === 1 ? 'message' : 'messages' }}
    </button>
  </div>
</template>

<style scoped>
.thread-expand {
  padding: 4px 12px 7px;
  padding-inline-start: var(--thread-pill-indent, 14px);
}
.thread-expand__pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font: inherit;
  font-size: .75rem;
  font-weight: 600;
  cursor: pointer;
}
.thread-expand__pill:hover,
.thread-expand__pill[aria-expanded='true'] { background: var(--control-hover-bg); color: var(--text); }
.thread-expand__pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (pointer: coarse) {
  .thread-expand__pill { min-height: 36px; }
}
</style>

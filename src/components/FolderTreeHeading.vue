<script setup lang="ts">
import { Settings2 } from '@lucide/vue';

defineProps<{ label: string; actionLabel: string; actionAttrs?: Record<string, string> }>();
defineEmits<{ manage: [] }>();
</script>

<template>
  <div class="folder-tree__heading-row">
    <h3 class="folder-tree__heading">{{ label }}</h3>
    <span class="folder-tree__heading-actions">
      <button
        v-bind="actionAttrs"
        type="button"
        class="folder-tree__manage"
        :title="actionLabel"
        :aria-label="actionLabel"
        @click="$emit('manage')"
      >
        <Settings2 :size="16" :stroke-width="1.75" aria-hidden="true" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.folder-tree__heading-row { display: flex; align-items: center; justify-content: space-between; margin: 14px 10px 4px; }
.folder-tree__heading { margin: 0; font-size: 12px; font-weight: 600; color: var(--muted); }
.folder-tree__heading-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  /* Align the buttons with the right rail without inflating the heading row. */
  margin: -4px -6px -4px 0;
}
.folder-tree__manage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-tree__manage:hover, .folder-tree__manage:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
</style>

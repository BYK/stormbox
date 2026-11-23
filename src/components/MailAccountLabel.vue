<script setup lang="ts">
import { ChevronDown, ChevronRight } from '@lucide/vue';

withDefaults(defineProps<{ address: string; expanded?: boolean; controls?: string }>(), { expanded: undefined });
defineEmits<{ toggle: [] }>();
</script>

<template>
  <component
    :is="expanded === undefined ? 'div' : 'button'"
    class="mail-account-label"
    :type="expanded === undefined ? undefined : 'button'"
    :aria-expanded="expanded"
    :aria-controls="controls"
    :title="address"
    @click="expanded !== undefined && $emit('toggle')"
  >
    <component v-if="expanded !== undefined" :is="expanded ? ChevronDown : ChevronRight"
      :size="14" class="mail-account-label__chevron" aria-hidden="true" />
    <span class="mail-account-label__address">{{ address }}</span>
    <slot />
  </component>
</template>

<style scoped>
.mail-account-label {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
}
button.mail-account-label { cursor: pointer; }
button.mail-account-label:hover { background: var(--rowHover); }
button.mail-account-label:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.mail-account-label__address { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mail-account-label__chevron { color: var(--muted); flex-shrink: 0; }
</style>

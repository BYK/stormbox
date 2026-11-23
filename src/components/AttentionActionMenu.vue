<script setup lang="ts">
import { Ellipsis } from '@lucide/vue';
import { onBeforeUnmount, ref } from 'vue';

import AppDropdown from './AppDropdown.vue';

defineProps<{ label: string }>();
const panel = ref<HTMLElement | null>(null);
const topLayer = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
let dropdown: HTMLDetailsElement | null = null;

function closeOnViewportChange(event: Event): void {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return;
  if (!dropdown?.open) return;
  dropdown.open = false;
  if (panel.value?.contains(document.activeElement)) {
    dropdown.querySelector('summary')?.focus({ preventScroll: true });
  }
}

function removeViewportListeners(): void {
  window.removeEventListener('scroll', closeOnViewportChange, true);
  window.removeEventListener('resize', closeOnViewportChange);
}

function onToggle(event: Event): void {
  if (!topLayer || !(event.target instanceof HTMLDetailsElement) || !panel.value) return;
  dropdown = event.target;
  const menu = panel.value;
  if (!dropdown.open) {
    if (menu.matches(':popover-open')) menu.hidePopover();
    removeViewportListeners();
    return;
  }

  const anchor = dropdown.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const below = window.innerHeight - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  menu.style.maxWidth = `${window.innerWidth - margin * 2}px`;
  menu.style.maxHeight = '';
  menu.showPopover();
  const bounds = menu.getBoundingClientRect();
  const opensAbove = bounds.height > below && above > below;
  const height = Math.max(0, Math.min(bounds.height, opensAbove ? above : below));
  menu.style.maxHeight = `${height}px`;
  menu.style.left = `${Math.max(margin, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - margin))}px`;
  menu.style.top = `${Math.max(margin, opensAbove ? anchor.top - height - gap : anchor.bottom + gap)}px`;
  window.addEventListener('scroll', closeOnViewportChange, true);
  window.addEventListener('resize', closeOnViewportChange);
}

onBeforeUnmount(removeViewportListeners);
</script>

<template>
  <AppDropdown class="attention-action-menu" @toggle="onToggle">
    <summary class="app-dropdown__summary attention-action-menu__trigger" :aria-label="label" :title="label">
      <Ellipsis :size="18" aria-hidden="true" />
    </summary>
    <div
      ref="panel"
      class="app-dropdown__menu attention-action-menu__panel"
      :popover="topLayer ? 'manual' : undefined"
      role="group"
      :aria-label="label"
    >
      <slot />
    </div>
  </AppDropdown>
</template>

<style scoped>
.attention-action-menu__trigger {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 8px;
  color: var(--muted);
}
.attention-action-menu__trigger::after {
  display: none;
}
.attention-action-menu__trigger:hover,
.attention-action-menu[open] > .attention-action-menu__trigger {
  background: var(--control-hover-bg);
  color: var(--text);
}
.attention-action-menu__trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.attention-action-menu__panel {
  inset-inline-start: auto;
  inset-inline-end: 0;
  color: var(--text);
}
.attention-action-menu__panel[popover] {
  position: fixed;
  inset: auto;
  margin: 0;
}
.attention-action-menu__panel[popover]:not(:popover-open) {
  display: none;
}
.attention-action-menu__panel :deep(button:disabled) {
  opacity: 0.55;
  cursor: default;
  background: transparent;
}
@media (pointer: coarse) {
  .attention-action-menu__trigger {
    width: 44px;
    height: 44px;
  }
}
</style>

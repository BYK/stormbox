import { useEventListener } from '@vueuse/core';
import { ref } from 'vue';

export const ATTENTION_SWIPE_REVEAL_WIDTH = 128;
const REVEAL_THRESHOLD = 44;
const AXIS_THRESHOLD = 12;
const EDGE_MARGIN = 24;

interface SwipePointer {
  id: number;
  key: string;
  row: HTMLElement;
  x: number;
  y: number;
  offset: number;
  width: number;
}

function targetRow(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>('[data-attention-swipe]') : null;
}

export function useAttentionRowSwipe(commit: (key: string, row: HTMLElement) => void) {
  const activeKey = ref<string>();
  const offset = ref(0);
  const dragging = ref(false);
  const armed = ref(false);
  let activeRow: HTMLElement | undefined;
  let pointer: SwipePointer | undefined;
  let suppressClickUntil = 0;

  function close() {
    activeKey.value = undefined;
    activeRow = undefined;
    pointer = undefined;
    offset.value = 0;
    dragging.value = false;
    armed.value = false;
  }

  useEventListener('pointerdown', (event: PointerEvent) => {
    suppressClickUntil = 0;
    if ((event.pointerType === 'touch' && !event.isPrimary)
      || (activeRow && targetRow(event.target) !== activeRow)) close();
  }, { capture: true });
  useEventListener('focusin', (event) => {
    if (activeRow && targetRow(event.target) !== activeRow) close();
  });
  useEventListener('blur', close);

  function pointerdown(event: PointerEvent) {
    if (event.pointerType !== 'touch' || !event.isPrimary
      || event.clientX < EDGE_MARGIN || event.clientX > window.innerWidth - EDGE_MARGIN) return;
    if (!(event.target instanceof Element)) return;

    const row = targetRow(event.target);
    const key = row?.dataset.attentionSwipe;
    if (!row || key === undefined || event.target.closest('.msg-list__item')?.parentElement !== row) return;
    const control = event.target.closest('button, input, select, textarea, a, summary, [contenteditable], [data-message-control]');
    if (control && !control.classList.contains('msg-list__open')) return;

    pointer = { id: event.pointerId, key, row, x: event.clientX, y: event.clientY, offset: offset.value, width: row.clientWidth };
  }

  function pointermove(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.row.dataset.attentionSwipe !== pointer.key) {
      close();
      return;
    }
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;

    if (!dragging.value) {
      if (Math.abs(dy) >= AXIS_THRESHOLD && Math.abs(dy) >= Math.abs(dx)) {
        pointer = undefined;
        return;
      }
      if (Math.abs(dx) < AXIS_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.25) return;
      activeRow = pointer.row;
      activeKey.value = pointer.key;
      dragging.value = true;
    }

    // Measure commitment from the start of this drag, even on an already-open rail.
    const commitDistance = Math.min(320, Math.max(160, pointer.width * 0.6));
    armed.value = -dx >= commitDistance;
    offset.value = Math.min(pointer.width, Math.max(0, pointer.offset - dx));
    if (event.cancelable) event.preventDefault();
  }

  function pointerup(event: PointerEvent) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (dragging.value) pointermove(event);
    const finished = pointer;
    pointer = undefined;
    if (!finished || !dragging.value) return;
    suppressClickUntil = Date.now() + 500;
    if (armed.value) {
      close();
      commit(finished.key, finished.row);
    } else if (offset.value >= REVEAL_THRESHOLD) {
      dragging.value = false;
      offset.value = ATTENTION_SWIPE_REVEAL_WIDTH;
    } else close();
  }

  function pointercancel(event: PointerEvent) {
    if (pointer?.id === event.pointerId) close();
  }

  function onClick(event: MouseEvent) {
    if (event.detail > 0 && suppressClickUntil > Date.now()) {
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const dismissesRail = activeRow && targetRow(event.target) === activeRow
      && event.target instanceof Element && !event.target.closest('[data-attention-swipe-action]');
    if (!dismissesRail) return;
    close();
    if (event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !activeRow) return;
    const open = activeRow.querySelector<HTMLButtonElement>('.msg-list__open');
    close();
    open?.focus({ preventScroll: true });
    event.preventDefault();
    event.stopPropagation();
  }

  return {
    activeKey, offset, dragging, armed, close, onClick,
    handlers: { pointerdown, pointermove, pointerup, pointercancel, keydown },
  };
}

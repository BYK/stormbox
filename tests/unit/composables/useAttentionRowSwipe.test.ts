// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { ATTENTION_SWIPE_REVEAL_WIDTH, useAttentionRowSwipe } from '../../../src/composables/useAttentionRowSwipe';

function setup() {
  const commit = vi.fn();
  const open = vi.fn();
  const action = vi.fn();
  let swipe!: ReturnType<typeof useAttentionRowSwipe>;
  const list = mount(defineComponent({
    setup() {
      swipe = useAttentionRowSwipe(commit);
      return () => h('ul', {
        onPointerdown: swipe.handlers.pointerdown,
        onPointermove: swipe.handlers.pointermove,
        onPointerup: swipe.handlers.pointerup,
        onPointercancel: swipe.handlers.pointercancel,
        onKeydown: swipe.handlers.keydown,
        onClickCapture: swipe.onClick,
      }, ['first', 'second'].map((key) => h('li', { 'data-attention-swipe': key }, [
        h('div', { class: 'msg-list__item' }, [
          h('button', { class: 'msg-list__open', onClick: open }, key),
          h('button', { class: 'ordinary-control' }, 'More'),
        ]),
        h('button', { 'data-attention-swipe-action': '', onClick: action }, 'Snooze'),
      ])));
    },
  }), { attachTo: document.body });
  const rows = list.findAll('li');
  for (const row of rows) Object.defineProperty(row.element, 'clientWidth', { value: 340 });
  const rowButton = (index = 0) => rows[index].get('.msg-list__open').element;

  function touch(target: Element, type: string, clientX: number, clientY: number, overrides: PointerEventInit = {}) {
    return target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 7,
      clientX, clientY, ...overrides,
    }));
  }
  function drag(distance: number, baseX = 272, index = 0) {
    const button = rowButton(index);
    touch(button, 'pointerdown', baseX, 100);
    touch(button, 'pointermove', baseX - distance, 100);
    touch(button, 'pointerup', baseX - distance, 100);
  }
  return { list, rows, swipe, touch, drag, rowButton, commit, open, action };
}

describe('Attention row swipe', () => {
  it('reveals actions on a partial drag, keeps only one rail, and consumes the swipe click', async () => {
    const { list, rows, swipe, touch, drag, rowButton, commit, open, action } = setup();
    try {
      await nextTick();
      drag(80);
      expect(swipe.activeKey.value).toBe('first');
      expect(swipe.offset.value).toBe(ATTENTION_SWIPE_REVEAL_WIDTH);
      rowButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      expect(open).not.toHaveBeenCalled();
      expect(swipe.activeKey.value).toBe('first');
      drag(80);
      drag(90, 272, 1);
      expect(swipe.activeKey.value).toBe('second');
      const snooze = rows[1].get<HTMLButtonElement>('[data-attention-swipe-action]').element;
      touch(snooze, 'pointerdown', 268, 100);
      snooze.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      expect(action).toHaveBeenCalledOnce();
      snooze.focus();
      snooze.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(swipe.activeKey.value).toBeUndefined();
      expect(document.activeElement).toBe(rowButton(1));
      expect(commit).not.toHaveBeenCalled();
    } finally {
      list.unmount();
    }
  });

  it('requires one full drag to commit and clears the rail before delivering the action', async () => {
    const { list, rows, swipe, touch, drag, rowButton, commit, open } = setup();
    try {
      await nextTick();
      drag(140);
      drag(94);
      expect(commit).not.toHaveBeenCalled();
      expect(swipe.activeKey.value).toBe('first');
      const button = rowButton();
      touch(button, 'pointerdown', 272, 100);
      touch(button, 'pointermove', 52, 100);
      expect(swipe.armed.value).toBe(true);
      expect(commit).not.toHaveBeenCalled();
      commit.mockImplementation(() => expect(swipe.activeKey.value).toBeUndefined());
      touch(button, 'pointerup', 45, 100);
      expect(commit).toHaveBeenCalledExactlyOnceWith('first', rows[0].element);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      expect(open).not.toHaveBeenCalled();
    } finally {
      list.unmount();
    }
  });

  it('ignores a vertical drag, edge start, secondary pointer, mouse, and ordinary controls', async () => {
    const { list, rows, swipe, touch, rowButton, commit } = setup();
    try {
      await nextTick();
      const button = rowButton();
      touch(button, 'pointerdown', 260, 90);
      expect(touch(button, 'pointermove', 240, 148)).toBe(true);
      touch(button, 'pointerup', 240, 180);
      for (const [target, x, overrides] of [
        [button, 15, {}],
        [button, 260, { pointerType: 'mouse' }],
        [button, 260, { isPrimary: false }],
        [rows[0].get('.ordinary-control').element, 260, {}],
      ] as const) {
        touch(target, 'pointerdown', x, 90, overrides);
        expect(touch(target, 'pointermove', x - 230, 90, overrides)).toBe(true);
        touch(target, 'pointerup', x - 230, 90, overrides);
      }
      expect(swipe.activeKey.value).toBeUndefined();
      expect(commit).not.toHaveBeenCalled();

      touch(button, 'pointerdown', 270, 100);
      touch(button, 'pointermove', 60, 100);
      expect(swipe.armed.value).toBe(true);
      touch(button, 'pointercancel', 60, 100);
      expect(swipe.activeKey.value).toBeUndefined();
      expect(swipe.armed.value).toBe(false);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      list.unmount();
    }
  });
});

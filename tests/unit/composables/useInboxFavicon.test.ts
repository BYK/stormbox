// @vitest-environment happy-dom

import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { useInboxFavicon } from '../../../src/composables/useInboxFavicon';

const badgeImage = 'data:image/png;base64,badge';
let scope: EffectScope;
let png: HTMLLinkElement;
let ico: HTMLLinkElement;
let installIcon: HTMLLinkElement;

const decode = vi.fn<() => Promise<void>>();
const drawText = vi.fn();

function appendIcon(rel: string, href: string, type?: string) {
  const icon = document.createElement('link');
  icon.rel = rel;
  icon.href = href;
  if (type) icon.type = type;
  document.head.append(icon);
  return icon;
}

beforeEach(() => {
  scope = effectScope();
  png = appendIcon('icon', '/favicon-32.png', 'image/png');
  png.setAttribute('sizes', '32x32');
  ico = appendIcon('icon', '/favicon.ico', 'image/x-icon');
  installIcon = appendIcon('apple-touch-icon', '/apple-touch-icon.png');
  decode.mockReset().mockResolvedValue(undefined);
  drawText.mockClear();
  vi.stubGlobal('Image', class { decode = decode; });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(),
    stroke: vi.fn(), fill: vi.fn(), fillText: drawText,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(badgeImage);
});

afterEach(() => {
  scope.stop();
  png.remove();
  ico.remove();
  installIcon.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Inbox favicon', () => {
  it('draws a count, caps the badge, and restores the original icons at zero', async () => {
    const unread = ref(2);
    scope.run(() => useInboxFavicon(() => unread.value));
    await flushPromises();

    expect(drawText).toHaveBeenLastCalledWith('2', expect.any(Number), expect.any(Number));
    expect(png.getAttribute('href')).toBe(badgeImage);
    expect(ico.getAttribute('href')).toBe(badgeImage);
    expect(installIcon.getAttribute('href')).toBe('/apple-touch-icon.png');

    unread.value = 11;
    await flushPromises();
    expect(drawText).toHaveBeenLastCalledWith('9+', expect.any(Number), expect.any(Number));
    expect(decode).toHaveBeenCalledOnce();

    unread.value = 0;
    await nextTick();
    expect(png.getAttribute('href')).toBe('/favicon-32.png');
    expect(ico.getAttribute('href')).toBe('/favicon.ico');
    expect(ico.type).toBe('image/x-icon');
    expect(ico.hasAttribute('sizes')).toBe(false);
  });

  it('ignores a favicon load that finishes after the unread count clears', async () => {
    let finish: () => void;
    decode.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const unread = ref(1);
    scope.run(() => useInboxFavicon(() => unread.value));
    unread.value = 0;
    await nextTick();

    finish();
    await flushPromises();
    expect(drawText).not.toHaveBeenCalled();
    expect(png.getAttribute('href')).toBe('/favicon-32.png');
  });
});

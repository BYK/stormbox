import { computed, onScopeDispose, watch } from 'vue';

/** Add an unread badge to the app icon without touching the PWA icon. */
export function useInboxFavicon(unread: () => number) {
  const icons = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
  const source = icons.find((icon) => icon.type === 'image/png');
  if (!source) return;

  const originalHref = source.href;
  const originalIcons = icons.map((icon) => ({
    icon,
    attributes: ['type', 'sizes', 'href'].map((name) => [name, icon.getAttribute(name)]),
  }));
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  let artwork: Promise<HTMLImageElement> | undefined;
  let hasBadge = false;

  function restore() {
    if (!hasBadge) return;
    hasBadge = false;
    for (const { icon, attributes } of originalIcons) {
      for (const [name, value] of attributes) {
        if (value == null) icon.removeAttribute(name);
        else icon.setAttribute(name, value);
      }
    }
  }

  function loadArtwork() {
    const image = new Image();
    image.src = originalHref;
    return image.decode().then(() => image).catch((error) => {
      artwork = undefined;
      throw error;
    });
  }

  const badge = computed(() => {
    const count = unread();
    if (count <= 0) return '';
    return count > 9 ? '9+' : String(count);
  });
  watch(badge, async (text, _, onCleanup) => {
    if (!text) {
      restore();
      return;
    }

    let active = true;
    onCleanup(() => { active = false; });
    try {
      const image = await (artwork ??= loadArtwork());
      if (!active) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(image, 0, 0, size, size);
      const width = text.length > 1 ? 23 : 17;
      const left = size - width - 1;
      ctx.beginPath();
      ctx.roundRect(left, 1, width, 17, 8.5);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#c93838';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + width / 2, 9.5);

      // Update every candidate so browsers choosing the ICO fallback show the badge too.
      const href = canvas.toDataURL();
      for (const icon of icons) {
        icon.type = 'image/png';
        icon.setAttribute('sizes', '32x32');
        icon.href = href;
      }
      hasBadge = true;
    } catch {
      if (active) restore();
    }
  }, { immediate: true });

  onScopeDispose(restore);
}

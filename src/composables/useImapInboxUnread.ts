import { ref, watch } from 'vue';
import { TABLE_FAMILIES } from '../db/protocol';
import { getRepositoryAsync } from './useRepository';

/** Observe locally cached Inbox windows without invoking the IMAP relay. */
export function useImapInboxUnread(ownerId: () => number | null) {
  const count = ref(0);

  watch(ownerId, async (id, _, onCleanup) => {
    count.value = 0;
    if (id == null) return;

    let active = true;
    let unsubscribe: (() => void) | undefined;
    onCleanup(() => {
      active = false;
      unsubscribe?.();
    });

    try {
      const repo = await getRepositoryAsync();
      if (!active) return;

      let refreshVersion = 0;
      async function refresh() {
        const version = ++refreshVersion;
        const unread = await repo.getAttentionImapUnreadCount(id);
        if (active && version === refreshVersion) count.value = unread;
      }

      unsubscribe = repo.subscribe((tables) => {
        if (tables.includes(TABLE_FAMILIES.ATTENTION)) void refresh().catch(() => {});
      });
      await refresh();
    } catch {
      // The primary Inbox can still supply an unread count if the cache is unavailable.
    }
  }, { immediate: true });

  return count;
}

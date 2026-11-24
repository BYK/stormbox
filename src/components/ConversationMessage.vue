<script lang="ts">
import type { imapEntry } from '../composables/useImapReader';
import type { MessageBody, MessageRow } from '../types/db';

export type ConversationMessageSource =
  | { kind: 'jmap'; row: MessageRow; folderId: number }
  | { kind: 'imap'; entry: ReturnType<typeof imapEntry>; canArchive?: boolean; canJunk?: boolean; canTrash?: boolean };
</script>

<script setup lang="ts">
import { useOnline } from '@vueuse/core';
import { computed, shallowRef, watch } from 'vue';
import { useImapReader } from '../composables/useImapReader';
import type { Repository } from '../db/repository';
import { useAuthStore } from '../stores/auth-store';
import { useMailStore } from '../stores/mail-store';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import type { MessageAddress } from '../utils/reply';
import MessageView from './MessageView.vue';

const props = defineProps<{
  source: ConversationMessageSource;
  ownerId: number;
  repository: Repository;
  refreshImap: () => void | Promise<void>;
  maximized: boolean;
}>();
const emit = defineEmits<{ toggleMaximized: [] }>();
const mailStore = useMailStore();
const authStore = useAuthStore();
const online = useOnline();
const imapSource = computed(() => props.source.kind === 'imap' ? props.source : null);
const imap = useImapReader(() => props.ownerId, () => props.repository,
  (id) => imapSource.value?.entry.id === id ? imapSource.value.entry : undefined,
  props.refreshImap);
const imapView = computed(() => {
  const source = imapSource.value;
  const view = imap.view.value;
  return source && view ? { ...view,
    canArchive: source.canArchive, canJunk: source.canJunk, canTrash: source.canTrash,
  } : undefined;
});

watch(() => imapSource.value?.entry.id, (id) => {
  const entry = imapSource.value?.entry;
  if (!id || !entry) return imap.close();
  void imap.open(entry);
  if (!entry.row.seen) void imap.runAction(entry, { type: 'seen', value: true }, { undo: false });
}, { immediate: true });

function runImapAction(action: ImapAttentionAction) {
  if (imap.current.value) void imap.runAction(imap.current.value, action);
}

const jmapSource = computed(() => props.source.kind === 'jmap' ? props.source : null);
const jmapId = computed(() => jmapSource.value?.row.id);
const body = shallowRef<MessageBody | null>(null);
const addresses = shallowRef<MessageAddress[]>([]);
const error = shallowRef<string>();
const jmapView = computed(() => jmapSource.value ? {
  ...jmapSource.value, body: body.value, addresses: addresses.value, error: error.value,
} : undefined);

watch([jmapId, () => jmapSource.value?.row.body_fetched_at, online, () => authStore.isOfflineSession], ([id], [previousId], onCleanup) => {
  if (id !== previousId) body.value = null;
  const source = jmapSource.value;
  if (id == null || !source || body.value) return;
  error.value = undefined;
  let current = true;
  onCleanup(() => { current = false; });
  const cachedBody = mailStore.selectedMessageId === id ? mailStore.messageBody : null;
  if (cachedBody) body.value = cachedBody;
  else void props.repository.getMessageBodyForDisplay(source.row.account_id, id).then((loaded) => {
    if (!current) return;
    if (!loaded && (authStore.isOfflineSession || !online.value)) {
      error.value = 'Reconnect to download this message.';
    } else body.value = loaded ?? { text: '', html: '', attachments: [] };
  }).catch(() => {
    if (current) error.value = authStore.isOfflineSession || !online.value
      ? 'Reconnect to download this message.' : 'Could not open this message.';
  });
}, { immediate: true });

watch(() => mailStore.messageBody, (loaded) => {
  if (loaded && jmapId.value != null && mailStore.selectedMessageId === jmapId.value) {
    body.value = loaded;
    error.value = undefined;
  }
});

watch(jmapId, (id, _old, onCleanup) => {
  addresses.value = [];
  const source = jmapSource.value;
  if (id == null || !source) return;
  let current = true;
  onCleanup(() => { current = false; });
  void props.repository.listMessageAddresses(id).then((loaded) => {
    if (current) addresses.value = Array.isArray(loaded) ? loaded : [];
  }).catch(() => {});
  if (mailStore.selectedMessageId !== id && !source.row.is_seen) {
    void mailStore.markManySeen([id], true, { sourceFolderId: source.folderId, rows: [source.row], undoable: false })
      .catch(() => {});
  }
}, { immediate: true });
</script>

<template>
  <MessageView v-if="jmapView || imapView" :jmap="jmapView" :imap="imapView"
    in-conversation :show-back="false" :maximized="maximized"
    @toggle-maximized="emit('toggleMaximized')" @imap-action="runImapAction" @imap-compose="imap.composeResponse" />
</template>

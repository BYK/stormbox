<script setup lang="ts">
import { AtSign, RefreshCw } from '@lucide/vue';
import { useOnline } from '@vueuse/core';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { MailboxRole } from '../constants/states';
import { imapEntry, useImapReader } from '../composables/useImapReader';
import { useMessageTags } from '../composables/useMessageTags';
import { getRepositoryAsync } from '../composables/useRepository';
import type { AttentionCache, CachedImapAccount, CachedImapFolder } from '../db/attention';
import { TABLE_FAMILIES } from '../db/protocol';
import type { Repository } from '../db/repository';
import { JMAP_SERVER_URL } from '../defines';
import { disableWebPush, onWebPushRefresh } from '../push/client';
import { browserSessionEnabled } from '../services/browser-session';
import { useComposeStore } from '../stores/compose-store';
import { GOOGLE_IMAP_RESULTS, GOOGLE_IMAP_RETURN_SPACE, type GoogleImapResult, type RelayFolder } from '../sync/backends/imap/attention-relay';
import { folderPresentation } from '../utils/folder-presentation';
import AppIconButton from './AppIconButton.vue';
import AttentionRowMenu from './AttentionRowMenu.vue';
import FolderNode from './FolderNode.vue';
import ImapAccountsDialog from './ImapAccountsDialog.vue';
import MessageListRow from './MessageListRow.vue';
import MessageView from './MessageView.vue';

const props = defineProps<{ ownerId: number; search: string; folderTarget: HTMLElement }>();
const emit = defineEmits<{
  'folder-selected': [selected: boolean];
  'detail-visible': [visible: boolean];
  maximized: [maximized: boolean];
}>();
const online = useOnline();
const composeStore = useComposeStore();
const { definitions } = useMessageTags();
const cache = shallowRef<AttentionCache>({ paired: false, accounts: [], states: {} });
const managing = ref(false);
const googleResult = ref<GoogleImapResult>();
const selected = shallowRef<{ accountId: string; path: string }>();
const folderWindow = shallowRef<CachedImapFolder | null>(null);
const folderLoading = ref(false);
const inboxLoading = ref(false);
const accountError = ref('');
const folderError = ref('');
const actionError = ref('');
const listHeading = ref<HTMLElement>();
const readerPane = ref<HTMLElement>();
const maximized = ref(false);
const listingByAccount = new Set<string>();
const expandedAccounts = new Set<string>();
const listErrors = ref(new Map<string, string>());
let repo: Repository;
let unsubscribe: (() => void) | undefined;
let unsubscribePush: (() => void) | undefined;
let heartbeat: number;
let mounted = false;
let cacheSequence = 0;
let folderSequence = 0;
let openingButton: HTMLElement | null = null;

const roles: Record<string, MailboxRole> = {
  '\\archive': 'archive', '\\all': 'all', '\\drafts': 'drafts', '\\sent': 'sent',
  '\\junk': 'junk', '\\trash': 'trash', '\\flagged': 'flagged', '\\important': 'important',
};
const inbox: RelayFolder = { path: 'INBOX', name: 'Inbox', specialUse: '\\Inbox', delimiter: null };

function folders(account: CachedImapAccount) {
  return [inbox, ...(account.folders ?? []).filter(({ path }) => path.toUpperCase() !== 'INBOX')];
}

function folderRole(folder: RelayFolder) {
  return folder.path === 'INBOX' ? 'inbox' : roles[folder.specialUse?.toLowerCase() ?? ''];
}

function folderNode(folder: RelayFolder) {
  const role = folderRole(folder);
  const name = !role && folder.delimiter ? folder.path.split(folder.delimiter).join(' / ') : folder.name;
  const { icon, color: tone } = folderPresentation({ name, role });
  return { id: folder.path, name, icon, tone };
}

const account = computed(() => cache.value.accounts.find(({ relay_id }) => relay_id === selected.value?.accountId));
const isInbox = computed(() => selected.value?.path === 'INBOX');
const folder = computed(() => account.value && folders(account.value).find(({ path }) => path === selected.value?.path));
const role = computed(() => folder.value && folderRole(folder.value));
const loading = computed(() => isInbox.value ? inboxLoading.value : folderLoading.value);
const syncedAt = computed(() => isInbox.value ? account.value?.last_synced_at : folderWindow.value?.syncedAt);
const total = computed(() => isInbox.value ? account.value?.total_messages : folderWindow.value?.total);
const syncError = computed(() => isInbox.value ? account.value?.sync_error : folderError.value);
const entries = computed(() => {
  const source = account.value;
  const path = selected.value?.path;
  if (!source || !path) return [];
  const uidValidity = isInbox.value ? source.uid_validity : folderWindow.value?.uidValidity;
  const rows = isInbox.value ? source.messages : folderWindow.value?.messages;
  return uidValidity && rows ? rows.map((row) => imapEntry(source, path, uidValidity, row)) : [];
});
const filteredEntries = computed(() => {
  const terms = props.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries.value;
  return entries.value.filter(({ presentation }) => {
    const text = [presentation.from_text, presentation.to_text, presentation.subject, presentation.preview]
      .join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  });
});
const byId = computed(() => new Map(entries.value.map((entry) => [entry.id, entry])));
const reader = useImapReader(() => props.ownerId, () => repo, (id) => byId.value.get(id), (cause) => {
  actionError.value = errorMessage(cause);
});
const readerProps = computed(() => reader.view.value && {
  ...reader.view.value,
  canArchive: role.value !== 'archive' && (!reader.view.value.gmailLabels || isInbox.value),
  canJunk: role.value !== 'junk',
  canTrash: role.value !== 'trash',
});
const canCompose = computed(() => account.value?.can_send === true);

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Could not sync this mail account.';
}

async function loadCache() {
  const sequence = ++cacheSequence;
  const next = await repo.getAttentionCache(props.ownerId);
  if (!mounted || sequence !== cacheSequence) return;
  cache.value = next;
  if (selected.value && !account.value) clearFolder();
}

async function loadSelectedFolder() {
  const current = selected.value;
  if (!current || current.path === 'INBOX') return;
  const sequence = ++folderSequence;
  const snapshot = await repo.getImapFolder(props.ownerId, current.accountId, current.path);
  if (mounted && selected.value === current && sequence === folderSequence) folderWindow.value = snapshot;
}

async function refreshInboxes() {
  if (!repo || !cache.value.paired || inboxLoading.value || !online.value) return;
  inboxLoading.value = true;
  accountError.value = '';
  try {
    await repo.refreshAttentionRelay(props.ownerId);
    await loadCache();
  } catch (cause) {
    accountError.value = errorMessage(cause);
  } finally {
    inboxLoading.value = false;
  }
}

async function refreshFolder() {
  const current = selected.value;
  if (!current || folderLoading.value || !online.value) return;
  if (current.path === 'INBOX') return refreshInboxes();
  folderLoading.value = true;
  folderError.value = '';
  try {
    await repo.getImapFolder(props.ownerId, current.accountId, current.path, true);
    if (selected.value === current) await loadSelectedFolder();
  } catch (cause) {
    if (selected.value === current) folderError.value = errorMessage(cause);
  } finally {
    if (selected.value === current) folderLoading.value = false;
  }
}

async function refreshFolderList(accountId: string) {
  if (!online.value || listingByAccount.has(accountId)) return;
  listingByAccount.add(accountId);
  listErrors.value.delete(accountId);
  try {
    await repo.refreshImapFolders(props.ownerId, accountId);
    await loadCache();
  } catch (cause) {
    listErrors.value.set(accountId, errorMessage(cause));
  } finally {
    listingByAccount.delete(accountId);
  }
}

function onAccountToggle(accountId: string, event: Event) {
  if (!(event.target as HTMLDetailsElement).open) {
    expandedAccounts.delete(accountId);
    return;
  }
  expandedAccounts.add(accountId);
  void refreshFolderList(accountId);
}

function refreshCurrent() {
  if (!selected.value) return;
  void refreshFolder();
  void refreshFolderList(selected.value.accountId);
}

function clearFolder() {
  selected.value = undefined;
  folderWindow.value = null;
  reader.close();
  maximized.value = false;
  emit('folder-selected', false);
}

async function pickFolder(accountId: string, path: string) {
  if (selected.value?.accountId === accountId && selected.value.path === path) return;
  selected.value = { accountId, path };
  folderWindow.value = null;
  folderLoading.value = false;
  folderError.value = '';
  actionError.value = '';
  reader.close();
  openingButton = null;
  emit('folder-selected', true);
  await nextTick();
  listHeading.value?.focus({ preventScroll: true });
  const current = selected.value;
  await loadSelectedFolder().catch((cause) => {
    if (selected.value === current) folderError.value = errorMessage(cause);
  });
  if (selected.value === current) void refreshFolder();
}

function openMessage(entry: ReturnType<typeof imapEntry>, button: HTMLElement | null) {
  openingButton = button;
  void reader.open(entry);
  void nextTick(() => readerPane.value?.focus({ preventScroll: true }));
}

watch(reader.current, (next, previous) => {
  if (Boolean(next) !== Boolean(previous)) emit('detail-visible', Boolean(next));
  if (next || !previous) return;
  maximized.value = false;
  void nextTick(() => {
    if (reader.current.value || !selected.value) return;
    if (openingButton?.isConnected) openingButton.focus({ preventScroll: true });
    else listHeading.value?.focus({ preventScroll: true });
    openingButton = null;
  });
});
watch(maximized, (value) => emit('maximized', value));

function startCompose() {
  const sender = account.value;
  if (!sender?.can_send) return;
  composeStore.open({}, { origin: 'new', imapAccount: {
    id: sender.relay_id, email: sender.address, name: sender.name, ownerId: props.ownerId,
  } });
}

async function disconnect() {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration && 'pushManager' in registration) await disableWebPush(registration).catch(() => {});
  await repo.disconnectAttentionRelay(props.ownerId);
  await loadCache();
}

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  void refreshInboxes();
  if (!isInbox.value) void refreshFolder();
}

onMounted(async () => {
  mounted = true;
  try {
    repo = await getRepositoryAsync();
    if (!mounted) return;
    unsubscribe = repo.subscribe((tables) => {
      if (tables.includes(TABLE_FAMILIES.IMAP_MUTATIONS)) onVisible();
      if (!tables.includes(TABLE_FAMILIES.ATTENTION)) return;
      void Promise.all([loadCache(), loadSelectedFolder()]).catch((cause) => { accountError.value = errorMessage(cause); });
    });
    unsubscribePush = onWebPushRefresh(onVisible);
    await loadCache();
    if (!mounted) return;
    const url = new URL(window.location.href);
    const result = GOOGLE_IMAP_RESULTS.find((value) => value === url.searchParams.get('google_imap'));
    if (result) {
      googleResult.value = result;
      managing.value = true;
      window.sessionStorage.removeItem(GOOGLE_IMAP_RETURN_SPACE);
      url.searchParams.delete('google_imap');
      url.searchParams.delete('view');
      window.history.replaceState(window.history.state, '', url);
    }
    onVisible();
    document.addEventListener('visibilitychange', onVisible);
    heartbeat = window.setInterval(onVisible, 60_000);
  } catch (cause) {
    accountError.value = errorMessage(cause);
  }
});

watch(online, (value) => {
  if (!value || !repo) return;
  onVisible();
  for (const accountId of expandedAccounts) void refreshFolderList(accountId);
});
onBeforeUnmount(() => {
  mounted = false;
  clearFolder();
  emit('detail-visible', false);
  emit('maximized', false);
  unsubscribe?.();
  unsubscribePush?.();
  document.removeEventListener('visibilitychange', onVisible);
  window.clearInterval(heartbeat);
});

defineExpose({ canCompose, clearFolder, startCompose });
</script>

<template>
  <Teleport :to="folderTarget">
    <div class="imap-nav__heading">
      <h3>IMAP accounts</h3>
      <AppIconButton title="Manage IMAP accounts" aria-label="Manage IMAP accounts" @click="managing = true">
        <AtSign :size="16" aria-hidden="true" />
      </AppIconButton>
    </div>
    <p v-if="accountError && !selected" class="imap-nav__status" role="alert">{{ accountError }}</p>
    <details v-for="entry in cache.accounts" :key="entry.relay_id" class="imap-nav__account"
      @toggle="onAccountToggle(entry.relay_id, $event)">
      <summary :title="entry.address">
        <span>{{ entry.address }}</span>
        <span v-if="entry.sync_error" class="imap-nav__error" aria-label="Inbox sync failed">!</span>
      </summary>
      <FolderNode v-for="option in folders(entry)" :key="option.path" :folder="folderNode(option)"
        :current-folder-id="selected?.accountId === entry.relay_id ? selected.path : null"
        :is-collapsed="() => false" :on-toggle="() => {}" :on-pick="() => pickFolder(entry.relay_id, option.path)" />
      <p v-if="listErrors.has(entry.relay_id)" class="imap-nav__status" role="status">{{ listErrors.get(entry.relay_id) }}</p>
    </details>
  </Teleport>

  <section v-if="selected && account" class="imap-mail" aria-label="IMAP mail"
    :class="{ 'imap-mail--reading': readerProps, 'imap-mail--maximized': maximized }">
    <div v-show="!maximized" class="imap-mail__list msg-list">
      <header class="imap-mail__header">
        <div>
          <h2 ref="listHeading" tabindex="-1">{{ folder?.name ?? selected.path }}</h2>
          <p>{{ account.address }}</p>
        </div>
        <AppIconButton title="Refresh folder" aria-label="Refresh folder" :disabled="loading || !online" @click="refreshCurrent">
          <RefreshCw :size="17" aria-hidden="true" />
        </AppIconButton>
      </header>
      <div class="imap-mail__status" role="status">
        <p v-if="syncError || accountError" class="imap-nav__error">{{ syncError || accountError }}</p>
        <p v-if="loading">Syncing…</p>
        <p v-if="syncedAt">Last synced {{ new Date(syncedAt).toLocaleString() }}</p>
        <p v-else-if="!loading && !entries.length && !syncError && !accountError">{{ online ? 'Waiting for first sync' : 'No downloaded mail' }}</p>
        <p v-if="total != null && total > entries.length">{{ entries.length }} most recent of {{ total.toLocaleString() }} messages</p>
        <p v-if="actionError" class="imap-nav__error">{{ actionError }}</p>
      </div>
      <ul v-if="filteredEntries.length" class="imap-mail__rows" aria-label="Messages">
        <MessageListRow v-for="entry in filteredEntries" :key="entry.id" :message="entry.presentation" :size="58"
          dom-id-prefix="imap-mail-row-" :focused="readerProps?.id === entry.id" :selectable="false" :draggable="false"
          :shows-recipients="role === 'sent' || role === 'drafts'" :tag-definitions="definitions"
          @row-click="(_event, button) => openMessage(entry, button)">
          <template #controls>
            <div class="msg-list__row-controls" draggable="false" @click.stop>
              <AttentionRowMenu :row="entry.presentation" :disabled="reader.disabled(entry.id)" :can-trash="role !== 'trash'"
                @action="actionError = ''; reader.runAction(entry, $event)" />
            </div>
          </template>
        </MessageListRow>
      </ul>
      <p v-else-if="!loading && (syncedAt || entries.length)" class="imap-mail__empty">
        {{ search.trim() ? 'No matches in downloaded messages.' : 'This folder is empty.' }}
      </p>
    </div>
    <div v-if="readerProps" ref="readerPane" class="imap-mail__reader" tabindex="-1">
      <MessageView :imap="readerProps" :maximized="maximized" back-label="Back to folder"
        @back="reader.close" @toggle-maximized="maximized = !maximized"
        @imap-action="reader.current.value && reader.runAction(reader.current.value, $event)"
        @imap-compose="reader.composeResponse" />
    </div>
  </section>

  <ImapAccountsDialog v-if="managing" :owner-id="ownerId" :paired="cache.paired"
    :automatic="browserSessionEnabled(JMAP_SERVER_URL)" :google-result="googleResult" :disconnect="disconnect" return-to-mail
    @paired="loadCache" @account-change="refreshInboxes" @close="managing = false; googleResult = undefined" />
</template>

<style scoped>
.imap-nav__heading { display: flex; align-items: center; justify-content: space-between; margin: 8px 4px 0 10px; }
.imap-nav__heading h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--muted); }
.imap-nav__account summary { padding: 7px 10px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imap-nav__account summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 6px; }
.imap-nav__account summary span + span { margin-inline-start: 5px; font-weight: 700; }
.imap-nav__status { margin: 4px 10px; color: var(--muted); font-size: .8rem; overflow-wrap: anywhere; }
.imap-nav__error { color: var(--error-fg); }
.imap-mail { grid-column: 4 / -1; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; min-height: 0; }
.imap-mail--reading:not(.imap-mail--maximized) { grid-template-columns: minmax(280px, var(--message-columns-width)) minmax(0, 1fr); }
.imap-mail__list { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.imap-mail__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.imap-mail__header > div { min-width: 0; }
.imap-mail__header h2 { margin: 0; font-size: 1rem; }
.imap-mail__header p, .imap-mail__status p { margin: 0; overflow-wrap: anywhere; }
.imap-mail__header p, .imap-mail__status, .imap-mail__empty { color: var(--muted); font-size: .82rem; }
.imap-mail__status:not(:empty), .imap-mail__empty { margin: 0; padding: 8px 14px; }
.imap-mail__rows { flex: 1; min-height: 0; overflow: auto; padding: 0; margin: 0; list-style: none; }
.imap-mail__reader { min-height: 0; min-width: 0; border-inline-start: 1px solid var(--border); outline: none; }
.imap-mail__reader :deep(.message-view) { height: 100%; }
.imap-mail--maximized .imap-mail__reader { position: fixed; inset: 0; z-index: 45; }
@media (max-width: 839px) {
  .imap-mail--reading:not(.imap-mail--maximized) { grid-template-columns: minmax(0, 1fr); }
  .imap-mail--reading .imap-mail__list { display: none; }
}
</style>

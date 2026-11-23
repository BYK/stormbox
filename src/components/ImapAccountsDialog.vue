<script setup lang="ts">
import { X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useOnline } from '@vueuse/core';

import { useModalFocus } from '../composables/useModalFocus';
import { getRepositoryAsync } from '../composables/useRepository';
import { replaceLocation } from '../services/navigation';
import { GOOGLE_IMAP_RETURN_SPACE, type GoogleImapResult, type RelayAccount, type RelayAccountInput, type RelayAccountSettings } from '../sync/backends/imap/attention-relay';
import AppButton from './AppButton.vue';
import AppIconButton from './AppIconButton.vue';

const props = defineProps<{
  ownerId: number;
  paired: boolean;
  automatic: boolean;
  googleResult?: GoogleImapResult;
  returnToMail?: boolean;
  disconnect: () => Promise<void>;
}>();
const emit = defineEmits<{
  close: [];
  paired: [failedAccounts: string[]];
  'account-change': [];
}>();

const online = useOnline();
const heading = useId();
const dialog = ref<HTMLElement | null>(null);
const tokenInput = ref<HTMLInputElement | null>(null);
const emailInput = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const screen = ref<'pair' | 'list' | 'form' | 'remove'>(props.paired ? 'list' : 'pair');
const busy = ref(false);
const refreshing = ref(false);
const error = ref('');
const notice = ref('');
const accounts = ref<RelayAccount[]>([]);
const editing = ref<RelayAccount>();
const removing = ref<RelayAccount>();
const token = ref('');
const provider = ref<'gmail' | 'imap'>('gmail');
const googleOAuth = ref<boolean>();
const useAppPassword = ref(false);
const googleSignIn = computed(() => provider.value === 'gmail' && googleOAuth.value && !useAppPassword.value && !editing.value);
const email = ref('');
const password = ref('');
const host = ref('');
const user = ref('');
const mode = ref<'tls' | 'starttls'>('tls');
let active = true;
let pendingGoogleResult = props.googleResult;

useModalFocus(dialog, { containTab: true, initialFocus: tokenInput });

function close() {
  if (!active) return;
  active = false;
  emit('close');
}

function showError(cause: unknown) {
  if (screen.value !== 'pair' && (cause as { code?: string } | null)?.code === 'unauthorized') {
    screen.value = 'pair';
    error.value = 'Pair this browser again to manage your IMAP accounts.';
  } else {
    error.value = cause instanceof Error ? cause.message : 'Could not update IMAP accounts.';
  }
}

async function run(operation: () => Promise<void>) {
  if (!active || busy.value || !online.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await operation();
  } catch (cause) {
    if (active) showError(cause);
  } finally {
    busy.value = false;
  }
}

function showSettings(settings: RelayAccountSettings) {
  accounts.value = settings.accounts;
  googleOAuth.value = settings.googleOAuth;
}

async function loadAccounts(justPaired = false) {
  if (!active || refreshing.value) return;
  refreshing.value = true;
  try {
    const repo = await getRepositoryAsync();
    if (!active) return;
    const cached = await repo.listAttentionRelayAccounts(props.ownerId, true).catch(() => undefined);
    if (!active) return;
    if (!props.paired && !cached?.paired && !justPaired) {
      if (props.automatic) void pair();
      return;
    }
    if (cached) showSettings(cached);
    if (screen.value === 'pair') screen.value = 'list';
    showGoogleResult();
    if (!online.value) return;
    const settings = await repo.listAttentionRelayAccounts(props.ownerId);
    if (!active) return;
    showSettings(settings);
    if (!accounts.value.length && screen.value === 'list') openForm(undefined, false);
  } catch (cause) {
    if (active) showError(cause);
  } finally {
    refreshing.value = false;
  }
}

function showGoogleResult() {
  const result = pendingGoogleResult;
  pendingGoogleResult = undefined;
  if (result === 'connected') {
    notice.value = 'Google account connected.';
    emit('account-change');
  } else if (result === 'cancelled') {
    notice.value = 'Google sign-in was cancelled.';
  } else if (result === 'blocked') {
    error.value = 'Your organization blocked this Google connection. Ask your Google Workspace administrator to approve Stormbox.';
  } else if (result === 'account_mismatch') {
    error.value = 'You selected a different Google account. Try again with the account you want to reconnect.';
  } else if (result === 'failed') {
    error.value = 'Google did not connect the account. Try signing in again.';
  }
}

onMounted(() => void loadAccounts());
onBeforeUnmount(() => { active = false; });
watch(online, (connected) => {
  if (connected && screen.value === 'list') void loadAccounts();
});

function openForm(account?: RelayAccount, clearFeedback = true) {
  editing.value = account;
  provider.value = !account || account.host === 'imap.gmail.com' ? 'gmail' : 'imap';
  useAppPassword.value = false;
  email.value = account?.email ?? '';
  password.value = '';
  host.value = account?.host ?? '';
  user.value = account?.user ?? '';
  mode.value = account?.mode ?? 'tls';
  if (clearFeedback) {
    error.value = '';
    notice.value = '';
  }
  screen.value = 'form';
  void nextTick(() => (account ? passwordInput : emailInput).value?.focus());
}

function toggleAppPassword() {
  useAppPassword.value = !useAppPassword.value;
  error.value = '';
  password.value = '';
  if (useAppPassword.value) void nextTick(() => emailInput.value?.focus());
}

async function connectGoogle(account?: RelayAccount) {
  if (!googleOAuth.value) return;
  await run(async () => {
    const repo = await getRepositoryAsync();
    if (!active) return;
    const url = await repo.startAttentionGoogleOAuth(props.ownerId, account?.id);
    if (!active) return;
    if (props.returnToMail) window.sessionStorage.setItem(GOOGLE_IMAP_RETURN_SPACE, 'mail');
    else window.sessionStorage.removeItem(GOOGLE_IMAP_RETURN_SPACE);
    replaceLocation(url);
  });
}

function showList() {
  password.value = '';
  error.value = '';
  notice.value = '';
  screen.value = 'list';
}

async function pair() {
  const accessToken = props.automatic ? undefined : token.value.trim();
  if (accessToken === '') return;
  await run(async () => {
    token.value = '';
    const repo = await getRepositoryAsync();
    if (!active) return;
    const failed = await repo.pairAttentionRelay(props.ownerId, accessToken, false);
    if (!active) return;
    screen.value = 'list';
    emit('paired', failed);
    void loadAccounts(true);
  });
}

async function save() {
  const address = email.value.trim();
  const credential = provider.value === 'gmail' ? password.value.replace(/\s/g, '') : password.value;
  if (!address || !credential) return;
  const account: RelayAccountInput = {
    email: address,
    password: credential,
    name: editing.value?.name ?? (provider.value === 'gmail' ? 'Gmail' : address),
  };
  if (provider.value === 'imap') {
    account.host = host.value.trim();
    account.user = user.value.trim() || address;
    account.mode = mode.value;
  }
  await run(async () => {
    password.value = '';
    const repo = await getRepositoryAsync();
    const saved = await repo.saveAttentionRelayAccount(props.ownerId, account);
    if (!active) return;
    accounts.value = [...accounts.value.filter(({ id }) => id !== saved.id), saved];
    showList();
    notice.value = `${saved.email} is connected.`;
    emit('account-change');
  });
}

function confirmRemove(account: RelayAccount) {
  removing.value = account;
  error.value = '';
  notice.value = '';
  screen.value = 'remove';
}

async function remove() {
  const account = removing.value;
  if (!account) return;
  await run(async () => {
    const repo = await getRepositoryAsync();
    await repo.removeAttentionRelayAccount(props.ownerId, account.id);
    if (!active) return;
    accounts.value = accounts.value.filter(({ id }) => id !== account.id);
    showList();
    notice.value = `${account.email} was disconnected.`;
    emit('account-change');
  });
}

async function disconnectBrowser() {
  await run(async () => {
    await props.disconnect();
    close();
  });
}
</script>

<template>
  <Teleport to="body">
    <div class="imap-accounts" @click.self="close">
      <section
        ref="dialog"
        class="imap-accounts__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="heading"
        tabindex="-1"
        @keydown.esc.stop="close"
      >
        <header class="imap-accounts__header">
          <h2 :id="heading">IMAP accounts</h2>
          <AppIconButton aria-label="Close IMAP accounts" @click="close">
            <X :size="18" aria-hidden="true" />
          </AppIconButton>
        </header>
        <p v-if="!online" role="status" class="imap-accounts__message">Go online to manage your accounts.</p>
        <p v-if="error" class="imap-accounts__error" role="alert">{{ error }}</p>
        <p v-if="notice" class="imap-accounts__message" role="status">{{ notice }}</p>

        <form v-if="screen === 'pair'" class="imap-accounts__form" @submit.prevent="pair">
          <p v-if="automatic">{{ busy ? 'Connecting to your mail relay…' : 'Connect using your Thundermail session.' }}</p>
          <p v-else>Pair this browser with your mail relay to connect accounts.</p>
          <label v-if="!automatic">
            Mail relay pairing token
            <input ref="tokenInput" v-model="token" type="password" autocomplete="off" required :disabled="busy" />
          </label>
          <footer class="imap-accounts__footer">
            <AppButton variant="outline" @click="close">Cancel</AppButton>
            <AppButton form-action="submit" :disabled="busy || refreshing || !online || (!automatic && !token.trim())">Connect</AppButton>
          </footer>
        </form>

        <form v-else-if="screen === 'form'" class="imap-accounts__form" @submit.prevent="googleSignIn ? connectGoogle() : save()">
          <fieldset v-if="!editing" :disabled="busy">
            <legend>Email provider</legend>
            <label class="imap-accounts__choice"><input v-model="provider" type="radio" value="gmail" /> Gmail</label>
            <label class="imap-accounts__choice"><input v-model="provider" type="radio" value="imap" /> Other IMAP</label>
          </fieldset>
          <template v-if="googleSignIn">
            <p>Choose the Google account you want to connect.</p>
            <footer class="imap-accounts__footer">
              <AppButton variant="outline" :disabled="busy" @click="showList">Back</AppButton>
              <AppButton variant="outline" :disabled="busy" @click="toggleAppPassword">Use an app password</AppButton>
              <AppButton form-action="submit" :disabled="busy || !online">Connect with Google</AppButton>
            </footer>
          </template>
          <template v-else>
            <label>
              Email address
              <input ref="emailInput" v-model="email" type="email" autocomplete="email" required :readonly="Boolean(editing)" :disabled="busy" />
            </label>
            <template v-if="provider === 'imap'">
              <label>
                IMAP hostname
                <input v-model="host" placeholder="imap.example.com" spellcheck="false" required :readonly="Boolean(editing)" :disabled="busy" />
              </label>
              <label>
                IMAP username
                <input v-model="user" autocomplete="username" :placeholder="email || 'Same as email address'" :readonly="Boolean(editing)" :disabled="busy" />
              </label>
              <fieldset :disabled="busy || Boolean(editing)">
                <legend>Connection security</legend>
                <label class="imap-accounts__choice"><input v-model="mode" type="radio" value="tls" /> TLS (993)</label>
                <label class="imap-accounts__choice"><input v-model="mode" type="radio" value="starttls" /> STARTTLS (143)</label>
              </fieldset>
            </template>
            <label>
              {{ provider === 'gmail' ? 'Google app password' : 'IMAP password' }}
              <input ref="passwordInput" v-model="password" type="password" autocomplete="new-password" required :disabled="busy" />
            </label>
            <p v-if="provider === 'gmail'">
              Create an app password for Stormbox in <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">Google App Passwords</a>.
            </p>
            <footer class="imap-accounts__footer">
              <AppButton variant="outline" :disabled="busy" @click="showList">Back</AppButton>
              <AppButton v-if="googleOAuth && provider === 'gmail' && !editing" variant="outline" :disabled="busy" @click="toggleAppPassword">
                Use Google sign-in
              </AppButton>
              <AppButton form-action="submit" :disabled="busy || !online || !email.trim() || !password || (provider === 'imap' && !host.trim())">
                {{ busy ? 'Connecting…' : editing ? 'Update password' : 'Connect account' }}
              </AppButton>
            </footer>
          </template>
        </form>

        <template v-else-if="screen === 'remove' && removing">
          <p>Disconnect {{ removing.email }}? You can reconnect it later.</p>
          <footer class="imap-accounts__footer">
            <AppButton variant="outline" :disabled="busy" @click="showList">Cancel</AppButton>
            <AppButton :disabled="busy || !online" @click="remove">Remove account</AppButton>
          </footer>
        </template>

        <template v-else>
          <ul v-if="accounts.length" class="imap-accounts__list">
            <li v-for="account in accounts" :key="account.id">
              <div class="imap-accounts__identity">
                <strong>{{ account.name }}</strong>
                <span v-if="account.name !== account.email">{{ account.email }}</span>
              </div>
              <div v-if="account.managed" class="imap-accounts__row-actions">
                <AppButton
                  v-if="account.auth === 'google-oauth'"
                  variant="outline"
                  :disabled="busy || !online || !googleOAuth"
                  @click="connectGoogle(account)"
                >Reconnect Google</AppButton>
                <AppButton v-else variant="outline" :disabled="busy || !online" @click="openForm(account)">Update password</AppButton>
                <AppIconButton danger :aria-label="`Remove ${account.email}`" :disabled="busy || !online" @click="confirmRemove(account)">
                  <X :size="16" aria-hidden="true" />
                </AppIconButton>
              </div>
            </li>
          </ul>
          <p v-else-if="!refreshing && !error" class="imap-accounts__message">No IMAP accounts connected.</p>
          <p v-if="refreshing && online" class="imap-accounts__message" role="status">Refreshing accounts…</p>
          <footer class="imap-accounts__footer imap-accounts__footer--list">
            <AppButton variant="outline" :disabled="busy || !online" @click="disconnectBrowser">Disconnect this browser</AppButton>
            <AppButton :disabled="busy || !online || (refreshing && googleOAuth === undefined)" @click="openForm()">Add account</AppButton>
          </footer>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.imap-accounts {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: 16px;
  background: var(--modal-scrim);
  backdrop-filter: var(--modal-scrim-blur);
}
.imap-accounts__panel {
  width: min(100%, 510px);
  max-height: 100%;
  box-sizing: border-box;
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
}
.imap-accounts__panel:focus { outline: none; }
.imap-accounts__header,
.imap-accounts__footer,
.imap-accounts__row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.imap-accounts__header { justify-content: space-between; }
.imap-accounts__header h2 { margin: 0; font-size: 18px; }
.imap-accounts__footer { justify-content: end; margin-top: 6px; }
.imap-accounts__footer--list { justify-content: space-between; }
.imap-accounts__form { display: grid; gap: 12px; margin-top: 12px; }
.imap-accounts__form p,
.imap-accounts__message { margin: 6px 0; color: var(--muted); font-size: 13px; }
.imap-accounts__error {
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--error-bg);
  color: var(--error-fg);
}
.imap-accounts__form label {
  display: grid;
  gap: 4px;
  font-size: 13px;
}
.imap-accounts__form input:not([type='radio']) {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--control-border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
}
.imap-accounts__form fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 5px 0;
  border: 0;
}
.imap-accounts__form legend { font-size: 13px; }
.imap-accounts__form .imap-accounts__choice { display: flex; align-items: center; }
.imap-accounts__choice input { accent-color: var(--accent); }
.imap-accounts__list { list-style: none; margin: 8px 0 14px; padding: 0; }
.imap-accounts__list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.imap-accounts__identity { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.imap-accounts__identity span { font-size: 13px; color: var(--muted); }
</style>

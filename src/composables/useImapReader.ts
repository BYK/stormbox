import { useOnline } from '@vueuse/core';
import { computed, onScopeDispose, shallowReactive, shallowRef, watch } from 'vue';
import type { CachedImapAccount } from '../db/attention';
import type { Repository } from '../db/repository';
import { useComposeStore } from '../stores/compose-store';
import { useImapOptimisticActions } from '../stores/imap-optimistic-actions-store';
import { isTransientImapError, type ImapAttentionAction, type ImapMessageLocation, type RelayMessage, type RelayMessageBody } from '../sync/backends/imap/attention-relay';
import { formatAddressList } from '../utils/address-parse';

function formatAddresses(list: RelayMessage['from'] = []) {
  return formatAddressList(list.map(({ name, address }) => ({ name, email: address })));
}

export function imapEntry(account: CachedImapAccount, mailbox: string, uidValidity: string, row: RelayMessage) {
  const id = JSON.stringify([account.relay_id, mailbox, uidValidity, row.uid]);
  const location: ImapMessageLocation = { accountId: account.relay_id, mailbox, uidValidity, uid: row.uid };
  const presentation = {
    id,
    subject: row.subject,
    preview: row.preview,
    from_text: formatAddresses(row.from),
    to_text: formatAddresses(row.to),
    keywords_json: JSON.stringify(Object.fromEntries((row.keywords ?? []).map((keyword) => [keyword, true]))),
    received_at: Date.parse(row.receivedAt) || 0,
    is_seen: Number(row.seen),
    is_flagged: Number(row.flagged),
    has_attachment: Number(row.hasAttachments === true),
  };
  return { id, location, presentation, row, account };
}

type ImapEntry = ReturnType<typeof imapEntry>;
type Reading = { id: string; body?: RelayMessageBody; bodyError?: string; retrying: boolean; failures: number };

export function useImapReader(
  ownerId: () => number,
  repository: () => Repository,
  find: (id: string) => ImapEntry | undefined,
  refresh: () => void | Promise<void>,
) {
  const online = useOnline();
  const composeStore = useComposeStore();
  const optimistic = useImapOptimisticActions();
  const reading = shallowRef<Reading>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  const current = computed(() => reading.value && find(reading.value.id));
  const view = computed(() => {
    const entry = current.value;
    if (!entry || !reading.value) return undefined;
    const { account, row, presentation } = entry;
    const labels = row.labels ?? [];
    return {
      ...presentation,
      ccText: formatAddresses(row.cc), labels,
      knownLabels: [...new Set([...labels, ...account.messages.flatMap((message) => message.labels ?? [])])],
      gmailLabels: row.gmailLabels ?? labels.length > 0,
      canSend: account.can_send === true,
      seen: row.seen, flagged: row.flagged, disabled: false,
      body: reading.value.body, bodyError: reading.value.bodyError, retrying: reading.value.retrying,
    };
  });

  function close() {
    clearTimeout(retryTimer);
    reading.value = undefined;
  }
  onScopeDispose(close);

  watch(current, (entry) => {
    if (!entry) close();
  });

  async function load(entry: ImapEntry, next: Reading) {
    const attempt = ++request;
    const isCurrent = () => reading.value === next && attempt === request;
    const owner = ownerId();
    try {
      const repo = repository();
      const cached = await repo.readAttentionImapMessage(owner, entry.location, true);
      if (!isCurrent()) return;
      next.body = cached ?? next.body;
      if (next.body?.html != null || !online.value) {
        next.retrying = false;
        next.bodyError = !online.value && !next.body ? 'Reconnect to download this message.' : undefined;
        return;
      }
      next.bodyError = undefined;
      const body = await repo.readAttentionImapMessage(owner, entry.location);
      if (!isCurrent()) return;
      next.body = body ?? next.body;
      next.retrying = false;
      next.bodyError = undefined;
    } catch (cause) {
      if (!isCurrent()) return;
      if (!online.value) {
        next.retrying = false;
        if (!next.body) next.bodyError = 'Reconnect to download this message.';
      } else if (isTransientImapError(cause)) {
        next.retrying = true;
        const delay = Math.min(1_000 * 2 ** Math.min(next.failures++, 6), 60_000);
        retryTimer = setTimeout(() => { if (isCurrent()) void load(entry, next); }, delay);
      } else {
        next.retrying = false;
        next.bodyError = cause instanceof Error ? cause.message : 'Could not open this message.';
      }
    }
  }

  function open(entry: ImapEntry) {
    clearTimeout(retryTimer);
    const next = shallowReactive<Reading>({ id: entry.id, retrying: false, failures: 0 });
    reading.value = next;
    return load(entry, next);
  }

  watch(online, (connected) => {
    clearTimeout(retryTimer);
    const next = reading.value;
    const entry = current.value;
    if (!entry || !next || next.body?.html != null) return;
    if (connected) {
      next.failures = 0;
      void load(entry, next);
    } else {
      next.retrying = false;
      if (!next.body) next.bodyError = 'Reconnect to download this message.';
    }
  });

  function runAction(entry: ImapEntry, action: ImapAttentionAction, { undo }: { undo?: boolean } = {}) {
    return optimistic.run(ownerId(), repository(), [{ entry, action }], { undo, refresh });
  }

  function composeResponse(kind: 'reply' | 'reply-all' | 'forward', inlineTarget?: HTMLElement) {
    const entry = current.value;
    const body = reading.value?.body;
    if (!entry?.account.can_send || !body) return;
    const { account, row, presentation } = entry;
    const addressLists = { from: row.from, replyTo: row.replyTo, to: row.to, cc: row.cc };
    const addresses = Object.entries(addressLists).flatMap(([kind, list]) => (list ?? [])
      .map(({ name, address }, position) => ({ kind, position, name, email: address })));
    composeStore.prepareImapResponse(kind, { id: account.relay_id, email: account.address, name: account.name }, {
      ...presentation, addresses,
      rfc822_message_id: row.messageId,
      references_json: JSON.stringify(row.references ?? []),
      in_reply_to_json: JSON.stringify(row.inReplyTo ? [row.inReplyTo] : []),
    }, body, inlineTarget);
  }

  return { current, view, open, close, runAction, composeResponse };
}

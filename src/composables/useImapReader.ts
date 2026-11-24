import { useOnline } from '@vueuse/core';
import { computed, shallowReactive, shallowRef, watch } from 'vue';
import type { CachedImapAccount } from '../db/attention';
import type { Repository } from '../db/repository';
import { useComposeStore } from '../stores/compose-store';
import { useImapOptimisticActions } from '../stores/imap-optimistic-actions-store';
import type { ImapAttentionAction, ImapMessageLocation, RelayMessage, RelayMessageBody } from '../sync/backends/imap/attention-relay';
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
type Reading = { id: string; body?: RelayMessageBody; bodyError?: string };

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
      ...reading.value,
    };
  });

  function close() { reading.value = undefined; }

  watch(current, (entry) => {
    if (!entry) close();
  });

  async function open(entry: ImapEntry) {
    const next = shallowReactive<Reading>({ id: entry.id });
    reading.value = next;
    try {
      const repo = repository();
      const cached = await repo.readAttentionImapMessage(ownerId(), entry.location, true);
      if (reading.value !== next) return;
      next.body = cached ?? undefined;
      if (cached?.html != null || (cached && !online.value)) return;
      if (!online.value) throw new Error('This message body has not been downloaded for offline reading.');
      next.body = await repo.readAttentionImapMessage(ownerId(), entry.location) ?? undefined;
    } catch (cause) {
      if (reading.value === next) next.bodyError = cause instanceof Error
        ? cause.message : 'Could not open this message.';
    }
  }

  function runAction(entry: ImapEntry, action: ImapAttentionAction, { undo }: { undo?: boolean } = {}) {
    return optimistic.run(ownerId(), repository(), [{ entry, action }], { undo, refresh });
  }

  function composeResponse(kind: 'reply' | 'reply-all' | 'forward') {
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
    }, body);
  }

  return { current, view, open, close, runAction, composeResponse };
}

import { buildTriageBundles, triageExcerpt, type BundleState, type TriageBundle, type TriageMessage } from '../../../src/triage/smart-sort';
import type { StoredMessage } from './account';
import type { MailAccount } from './mail-transport';

export interface AttentionNotification {
  confirmed: boolean;
  messageKey: string;
  sender: string;
  subject: string;
  preview: string;
}

interface AttentionDeliveryPlan {
  notifications: { uid: number; bundleUid: number; notification: AttentionNotification }[];
  missingPreviews: StoredMessage[];
}

function visibleText(text: string, size: number): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  const characters = Array.from(clean);
  return characters.length > size ? `${characters.slice(0, size - 1).join('')}…` : clean;
}

function isActive(bundle: TriageBundle): boolean {
  return bundle.status === 'action' || bundle.status === 'uncertain';
}

function localKey(message: TriageMessage): string {
  return JSON.stringify([String(message.accountId), '3-local', String(message.id)]);
}

export function notificationHandled(notification: AttentionNotification, states: Record<string, BundleState>, now: number): boolean {
  const allStates = Object.values(states);
  if (allStates.some((state) => state.resolved.includes(notification.messageKey))) return true;
  const matching = allStates.filter((state) => state.observed.includes(notification.messageKey));
  const latest = matching.sort((left, right) => right.changedAt - left.changedAt)[0];
  return latest?.disposition === 'snoozed' && (latest.snoozedUntil ?? 0) > now;
}

export function newAttentionNotifications(
  account: Pick<MailAccount, 'id' | 'email'>,
  messages: StoredMessage[],
  firstUid: number,
  states: Record<string, BundleState>,
  now = Date.now(),
): AttentionDeliveryPlan {
  const byId = new Map<string, StoredMessage>();
  const candidates = new Set<string>();
  const triageMessages = messages.map((message) => {
    // Smart Inbox requests the reserved inbox path as INBOX, regardless of server casing.
    const id = JSON.stringify(['INBOX', message.uidValidity, message.uid]);
    byId.set(id, message);
    if (message.uid >= firstUid) candidates.add(id);
    return {
      id,
      accountId: `imap:${account.id}`,
      receivedAt: Date.parse(message.receivedAt),
      subject: message.subject,
      preview: message.preview,
      messageId: message.messageId[0],
      references: message.references,
      inReplyTo: message.inReplyTo,
      sender: message.from[0]?.email,
      directRecipient: message.to.some(({ email }) => email.toLowerCase() === account.email.toLowerCase()),
      isFlagged: message.keywords.$flagged === true,
    } satisfies TriageMessage;
  });
  const activeAliases = new Set(buildTriageBundles(triageMessages.filter(({ id }) => !candidates.has(id)), states, now)
    .filter(isActive).flatMap(({ aliases }) => aliases));
  const notifications: AttentionDeliveryPlan['notifications'] = [];
  const missingPreviews: StoredMessage[] = [];
  for (const bundle of buildTriageBundles(triageMessages, states, now)) {
    const arrivals = bundle.messages.filter(({ message }) => candidates.has(String(message.id)));
    if (!arrivals.length) continue;
    const missing = bundle.messages.map(({ message }) => byId.get(String(message.id))!)
      .filter(({ preview }) => preview === undefined);
    if (missing.length) {
      missingPreviews.push(...missing);
      continue;
    }
    if (!isActive(bundle) || bundle.aliases.some((alias) => activeAliases.has(alias))) continue;
    const resolved = new Set(bundle.resolved);
    const items = [bundle.leading, ...arrivals];
    const fresh = items.find(({ message, classification }) => candidates.has(String(message.id))
      && classification.disposition !== 'update' && !resolved.has(localKey(message)));
    if (!fresh) continue;
    const envelope = byId.get(String(fresh.message.id))!;
    const bundleUid = Math.min(...arrivals.map(({ message }) => byId.get(String(message.id))!.uid));
    const from = envelope.from[0];
    const sender = visibleText(from?.name || from?.email || '', 100) || 'Unknown sender';
    const subject = visibleText(envelope.subject ?? '', 150) || '(No subject)';
    const preview = visibleText(triageExcerpt(fresh.message), 200);
    notifications.push({ uid: envelope.uid, bundleUid, notification: {
      confirmed: fresh.classification.disposition === 'action', messageKey: localKey(fresh.message), sender, subject, preview,
    } });
  }
  return { notifications, missingPreviews };
}

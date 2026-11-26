import { describe, expect, it } from 'vitest';
import { UNTIL_NEW_ACTIVITY } from '../../../src/triage/snooze-time';
import {
  buildTriageBundles,
  classifyTriageMessage,
  markBundleDone,
  priorityForScore,
  snoozeBundle,
  timeAdjustedScore,
  type TriageMessage,
} from '../../../src/triage/smart-sort';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 21, 12);

function mail(id: number, input: Partial<TriageMessage> = {}): TriageMessage {
  return { id, accountId: 1, receivedAt: NOW - 2 * HOUR, ...input };
}

describe('action classification', () => {
  it('surfaces explicit action and exceptions regardless of automated sender', () => {
    expect(classifyTriageMessage(mail(1, {
      subject: 'Order confirmed', preview: 'Please confirm your delivery address', sender: 'automation@example.com',
    }))).toMatchObject({ disposition: 'action', reason: 'Action requested' });
    expect(classifyTriageMessage(mail(2, { subject: 'ACİL: ÖDEME BAŞARISIZ' })))
      .toMatchObject({ disposition: 'action', baseScore: 84 });
    expect(classifyTriageMessage(mail(3, { subject: 'Lütfen yanıt veriniz' })).disposition).toBe('action');
  });

  it('collapses identified routine notices while keeping ambiguous messages visible', () => {
    expect(classifyTriageMessage(mail(1, {
      subject: 'Daily digest', body: 'Today’s news\n> Please approve the earlier request',
    })).disposition).toBe('update');
    expect(classifyTriageMessage(mail(2, { subject: 'İşlem gerekmiyor.' })).disposition).toBe('update');
    expect(classifyTriageMessage(mail(3, { subject: 'No action required unless rates have changed' })).disposition)
      .toBe('uncertain');
    expect(classifyTriageMessage(mail(4, { subject: 'A thought for Monday' })).disposition).toBe('uncertain');
  });

  it('keeps a real request visible when another classifier calls it routine', () => {
    const classification = { disposition: 'update' as const, baseScore: 12, reason: 'Update' };
    expect(classifyTriageMessage(mail(1, { subject: 'Review requested', classification })).disposition).toBe('action');
    expect(classifyTriageMessage(mail(2, { subject: 'Unclear', classification })).disposition).toBe('update');
  });
});

describe('bundling and ranking', () => {
  it('threads replies by identifiers and keeps different accounts distinct', () => {
    const messages = [
      mail(1, { messageId: '<proposal@example.com>', subject: 'Please review the proposal' }),
      mail(2, { references: ['proposal@example.com'], messageId: '<reply@example.com>', receivedAt: NOW }),
      mail(3, { inReplyTo: '<reply@example.com>', receivedAt: NOW }),
      mail(4, { accountId: 2, references: '<proposal@example.com>' }),
    ];
    const bundles = buildTriageBundles(messages, {}, NOW);
    expect(bundles).toHaveLength(2);
    expect(bundles[0].messages.map((item) => item.message.id).sort()).toEqual([1, 2, 3]);
    expect(bundles[0].leading.message.id).toBe(1);
    expect(bundles[1].accountId).toBe(2);
  });

  it('groups scoped order or ticket references without guessing by subject alone', () => {
    const messages = [
      mail(1, { sender: 'Shop <shop@example.com>', subject: 'Order #AB1234 confirmed' }),
      mail(2, { sender: 'shop@example.com', subject: 'We shipped your order AB1234' }),
      mail(3, { sender: 'other-shop@example.com', subject: 'Order #AB1234 confirmed' }),
      mail(4, { sender: 'shop@example.com', subject: 'Your order is ready' }),
      mail(5, { sender: 'shop@example.com', subject: 'Your order is ready' }),
    ];
    const bundledIds = buildTriageBundles(messages, {}, NOW)
      .map((bundle) => bundle.messages.map((item) => item.message.id).sort());
    expect(bundledIds).toHaveLength(4);
    expect(bundledIds).toContainEqual([1, 2]);
  });

  it('ranks by age-adjusted score while keeping the outstanding request as the thread lead', () => {
    expect([80, 60, 35, 34].map(priorityForScore)).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(timeAdjustedScore(84, NOW - 72 * HOUR, NOW)).toBe(42);
    const messages = [
      mail(1, { threadId: 'a', subject: 'Urgent: please reply', receivedAt: NOW - 144 * HOUR }),
      mail(2, { threadId: 'a', subject: 'Workflow succeeded', receivedAt: NOW }),
      mail(3, { threadId: 'b', subject: 'Please reply', receivedAt: NOW }),
    ];
    const [first, second] = buildTriageBundles(messages, {}, NOW);
    expect([first.priority, second.priority]).toEqual(['P1', 'P0']);
    expect(second.leading.message.id).toBe(1);
    expect(second.latestAt).toBe(NOW);
  });

  it('lets recent incoming mail outrank an old star without losing the star as a signal', () => {
    const messages = [
      mail(1, { subject: 'Weekly newsletter', receivedAt: NOW - 7 * 24 * HOUR, isFlagged: true }),
      mail(2, { subject: 'Documents for completion', receivedAt: NOW, directRecipient: true }),
      mail(3, { subject: 'Important update', receivedAt: NOW - 6 * HOUR, isFlagged: true }),
      mail(4, { subject: 'Other update', receivedAt: NOW - 6 * HOUR }),
    ];
    const bundles = buildTriageBundles(messages, {}, NOW);
    expect(bundles.map(({ leading }) => leading.message.id)).toEqual([2, 3, 4, 1]);
    expect(bundles.at(-1)).toMatchObject({ status: 'uncertain', priority: 'P2', reason: 'Flagged by you' });
  });
});

describe('bundle actions', () => {
  const request = mail(1, { messageId: '<order@example.com>', subject: 'Please confirm your address' });
  const newestRoutine = mail(2, {
    threadId: 'new-thread-id', references: '<order@example.com>', receivedAt: NOW,
    subject: 'Order confirmed',
  });
  const delayedRequest = mail(3, {
    references: '<order@example.com>', receivedAt: NOW - 4 * HOUR,
    subject: 'Please reply with a delivery time',
  });

  it('keeps Done through alias changes and routine replies, then reopens for a newly synced request', () => {
    const [original] = buildTriageBundles([request], {}, NOW);
    const states = { [original.id]: markBundleDone(original, NOW) };
    const [settled] = buildTriageBundles([request, newestRoutine], states, NOW);
    expect(settled.id).not.toBe(original.id);
    expect(settled.status).toBe('done');
    const [reopened] = buildTriageBundles([request, newestRoutine, delayedRequest], states, NOW);
    expect(reopened.status).toBe('action');
    expect(reopened.leading.message.id).toBe(3);
  });

  it('shows an outstanding request after snooze expires and gives new requests immediate visibility', () => {
    const [original] = buildTriageBundles([request], {}, NOW);
    const states = { [original.id]: snoozeBundle(original, NOW + HOUR, NOW) };
    const [sleeping] = buildTriageBundles([request, newestRoutine], states, NOW);
    expect(sleeping).toMatchObject({ status: 'snoozed', snoozedUntil: NOW + HOUR });
    expect(buildTriageBundles([request, newestRoutine], states, NOW + HOUR)[0].status).toBe('action');
    expect(buildTriageBundles([request, delayedRequest], states, NOW)[0].status).toBe('action');

    const indefinite = { [original.id]: snoozeBundle(original, UNTIL_NEW_ACTIVITY, NOW) };
    const farFuture = NOW + 365 * 24 * HOUR;
    expect(buildTriageBundles([request, newestRoutine], indefinite, farFuture)[0].status).toBe('snoozed');
    expect(buildTriageBundles([request, delayedRequest], indefinite, farFuture)[0].status).toBe('action');
  });
});

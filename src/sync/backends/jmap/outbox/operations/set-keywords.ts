import { maxObjectsInSet } from '../../limits';
import { chunks, submitEmailSet } from '../jmap';
import { collectMessageIds } from '../messages-shared';
import { resolveRemoteMessageIdsByAccount } from '../resolve';
import { DB_RPC } from '../../../../../db/protocol';
import { mailActionPatch } from '../../../../../types/mail-action';
import { finishMessageBatch } from '../batch';

async function runSetKeywords({ transport, handlers, row, request, useWebSocket }) {
  const messageIds = collectMessageIds(row, request).map(Number);
  if (messageIds.length === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  // Keyword flips (e.g. $seen on open) can target messages living in a
  // shared account's folders, so resolve each message's own account and
  // issue one Email/set per remote account.
  const resolvedByAccount = await resolveRemoteMessageIdsByAccount(handlers, messageIds) as Map<string, Array<{ localId: number; remoteId: string }>>;
  if (resolvedByAccount.size === 0) {
    return { ok: false, error: { type: 'unknownMessage' } };
  }
  // Keywords go out lowercase (MK-1.5). A removal also keeps any other
  // spelling the store saw in the cache, since Stalwart matches custom
  // keywords case-sensitively.
  const update = {};
  for (const k of request.remove ?? []) {
    update[`keywords/${k}`] = null;
    update[`keywords/${k.toLowerCase()}`] = null;
  }
  for (const k of request.add ?? []) {
    update[`keywords/${k.toLowerCase()}`] = true;
  }
  const staged = mailActionPatch(row.optimistic_patch_json) != null;
  const succeededIds: number[] = [];
  const errors: Record<string, any> = {};
  for (const [remoteAccountId, resolved] of resolvedByAccount) {
    for (const chunk of chunks(resolved, maxObjectsInSet(transport))) {
      const result = await submitEmailSet({
        transport,
        account: { remote_account_id: remoteAccountId },
        useWebSocket,
        update: Object.fromEntries(
          chunk.map(({ remoteId }) => [remoteId, update]),
        ),
      });
      if (!staged) {
        if (!result.ok) return result;
        continue;
      }
      const confirmed: number[] = [];
      for (const { remoteId, localId } of chunk) {
        const error = result.error;
        const rejected = error?.type === 'notUpdated' && 'detail' in error ? error.detail?.[remoteId] : error;
        if (rejected) errors[String(localId)] = rejected;
        else confirmed.push(localId);
      }
      await handlers[DB_RPC.MAIL_ACTION_APPLY_KEYWORDS]({ messageIds: confirmed, add: request.add, remove: request.remove });
      succeededIds.push(...confirmed);
    }
  }
  if (!staged) return { ok: true };
  const resolvedIds = new Set([...succeededIds, ...Object.keys(errors).map(Number)]);
  for (const id of messageIds) {
    if (!resolvedIds.has(id)) errors[String(id)] = { type: 'notFound' };
  }
  return finishMessageBatch(succeededIds, errors);
}

export { runSetKeywords };

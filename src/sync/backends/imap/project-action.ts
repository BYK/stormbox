import type { ImapAttentionAction, RelayMessage } from './attention-relay';

export function isImapMove(action: ImapAttentionAction) {
  return action.type === 'archive' || action.type === 'trash' || action.type === 'junk';
}

export function describeImapAction(action: ImapAttentionAction, target: string) {
  switch (action.type) {
    case 'archive': return { attempt: `archive ${target}`, success: `Archived ${target}` };
    case 'trash': return { attempt: `move ${target} to Trash`, success: `Moved ${target} to Trash` };
    case 'junk': return { attempt: `move ${target} to Junk`, success: `Moved ${target} to Junk` };
    case 'star': return action.value
      ? { attempt: `star ${target}`, success: `Starred ${target}` }
      : { attempt: `unstar ${target}`, success: `Unstarred ${target}` };
    case 'seen': return action.value
      ? { attempt: `mark ${target} as read`, success: `Marked ${target} as read` }
      : { attempt: `mark ${target} as unread`, success: `Marked ${target} as unread` };
    case 'tags': return { attempt: `update tags on ${target}`, success: `Updated tags on ${target}` };
  }
}

function keywordField(keyword: string) { return `keyword:${keyword.toLowerCase()}`; }
function labelField(label: string) { return `label:${label}`; }

export function imapActionFields(action: ImapAttentionAction): string[] {
  if (action.type === 'tags') {
    const { add = [], remove = [], addLabels = [], removeLabels = [] } = action.tags;
    return [...add.map(keywordField), ...remove.map(keywordField), ...addLabels.map(labelField), ...removeLabels.map(labelField)];
  }
  if (isImapMove(action)) return ['mailbox'];
  return [action.type];
}

function patchTags(
  tags: string[] = [], added: string[] = [], removed: string[] = [], caseInsensitive = false,
) {
  const key = (tag: string) => caseInsensitive ? tag.toLowerCase() : tag;
  const byName = new Map(tags.map((tag) => [key(tag), tag]));
  for (const tag of removed) byName.delete(key(tag));
  for (const tag of added) if (!byName.has(key(tag))) byName.set(key(tag), tag);
  return [...byName.values()];
}

export function projectImapAction(message: RelayMessage, action: ImapAttentionAction): RelayMessage | null {
  if (isImapMove(action)) return null;
  if (action.type === 'star') return { ...message, flagged: action.value };
  if (action.type === 'seen') return { ...message, seen: action.value };
  if (action.type === 'tags') {
    const { add, remove, addLabels, removeLabels } = action.tags;
    return { ...message,
      keywords: patchTags(message.keywords, add, remove, true),
      labels: patchTags(message.labels, addLabels, removeLabels),
    };
  }
  return message;
}

function restoreTags(before: string[] = [], added: string[] = [], removed: string[] = [], caseInsensitive = false) {
  const key = (tag: string) => caseInsensitive ? tag.toLowerCase() : tag;
  const original = new Map(before.map((tag) => [key(tag), tag]));
  const changed = new Map([...removed, ...added].map((tag) => [key(tag), tag]));
  const restore: string[] = [];
  const discard: string[] = [];
  for (const [name, spelling] of changed) {
    const tag = original.get(name);
    if (tag === undefined) discard.push(spelling);
    else restore.push(tag);
  }
  return { restore, discard };
}

export function revertImapProjection(message: RelayMessage | undefined, before: RelayMessage,
  action: ImapAttentionAction, earlier?: ReadonlySet<string>): RelayMessage | undefined {
  if (isImapMove(action)) return message ?? before;
  if (!message) return undefined;
  if (action.type === 'star') return earlier?.has('star') ? message : { ...message, flagged: before.flagged };
  if (action.type === 'seen') return earlier?.has('seen') ? message : { ...message, seen: before.seen };
  if (action.type === 'tags') {
    const { add, remove, addLabels, removeLabels } = action.tags;
    const unaffectedKeywords = (items?: string[]) => items?.filter((keyword) => !earlier?.has(keywordField(keyword)));
    const unaffectedLabels = (items?: string[]) => items?.filter((label) => !earlier?.has(labelField(label)));
    const keywords = restoreTags(before.keywords, unaffectedKeywords(add), unaffectedKeywords(remove), true);
    const labels = restoreTags(before.labels, unaffectedLabels(addLabels), unaffectedLabels(removeLabels));
    return { ...message,
      keywords: patchTags(message.keywords, keywords.restore, keywords.discard, true),
      labels: patchTags(message.labels, labels.restore, labels.discard),
    };
  }
  return message;
}

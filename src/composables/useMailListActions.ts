import type { Repository } from '../db/repository';
import { useImapOptimisticActions } from '../stores/imap-optimistic-actions-store';
import { useMailActionFeedbackStore, type MailUndoGroup } from '../stores/mail-action-feedback-store';
import { useMailStore } from '../stores/mail-store';
import type { ImapAttentionAction } from '../sync/backends/imap/attention-relay';
import type { FolderRow, MessageRow } from '../types/db';
import { gmailLabelTags, imapTagPatch } from '../utils/imap-message-tags';
import { resolveMessageTags, type MessageTagDefinition } from '../utils/message-tags';
import type { imapEntry } from './useImapReader';

export type MailListSource =
  | { kind: 'imap'; entry: ReturnType<typeof imapEntry> }
  | { kind: 'jmap'; folder: Pick<FolderRow, 'id'>; row: MessageRow };
export type MailListAction = Exclude<ImapAttentionAction, { type: 'tags' | 'trash' }>
  | { type: 'tag'; keyword: string; value: boolean }
  | { type: 'delete' }
  | { type: 'clear-tags' }
  | { type: 'read-and-archive' };

type ImapSource = Extract<MailListSource, { kind: 'imap' }>;

export function usesGmailLabels(source: MailListSource): source is ImapSource {
  return source.kind === 'imap' && (source.entry.row.gmailLabels ?? Boolean(source.entry.row.labels?.length));
}

function imapAction(source: ImapSource, action: Exclude<MailListAction, { type: 'read-and-archive' }>,
  definitions: ReadonlyArray<MessageTagDefinition>): ImapAttentionAction {
  const { entry } = source;
  const labels = entry.row.labels ?? [];
  switch (action.type) {
    case 'delete': return { type: 'trash' };
    case 'clear-tags': return {
      type: 'tags',
      tags: { remove: resolveMessageTags(entry.presentation.keywords_json, definitions).map(({ keyword }) => keyword), removeLabels: labels },
    };
    case 'tag': {
      const definedTag = usesGmailLabels(source) && definitions.find(({ keyword }) => keyword === action.keyword);
      if (definedTag) {
        return { type: 'tags', tags: action.value ? { addLabels: [definedTag.name] } : {
          removeLabels: [definedTag.name],
          remove: resolveMessageTags(entry.presentation.keywords_json, definitions)
            .filter(({ keyword }) => keyword === action.keyword).map(({ keyword }) => keyword),
        } };
      }
      const label = usesGmailLabels(source) && action.keyword.startsWith('gmail label:')
        ? action.keyword.slice('gmail label:'.length) : undefined;
      const gmailTags = usesGmailLabels(source) ? gmailLabelTags(labels, definitions, label ? [label] : undefined) : [];
      return { type: 'tags', tags: imapTagPatch(action.keyword, action.value, gmailTags) };
    }
    default: return action;
  }
}

/** Run the same list action against its owning local outbox. */
export function useMailListActions(ownerId: () => number, repository: () => Repository, refreshImap: () => Promise<void>) {
  const mail = useMailStore();
  const optimistic = useImapOptimisticActions();
  const feedback = useMailActionFeedbackStore();

  async function runJmap(folderId: number, rows: MessageRow[], action: MailListAction, undoGroup?: MailUndoGroup) {
    const ids = rows.map(({ id }) => id);
    const source = { sourceFolderId: folderId, rows, ...(undoGroup && { undoGroup }) };
    switch (action.type) {
      case 'star': return mail.markManyFlagged(ids, action.value, source);
      case 'seen': return mail.markManySeen(ids, action.value, source);
      case 'archive': return mail.archiveMessages(ids, source);
      case 'read-and-archive': return mail.archiveMessages(ids, { ...source, markRead: true });
      case 'junk': return mail.junkMessages(ids, source);
      case 'delete': return mail.destroyMessages(ids, source);
      case 'tag': return mail.setTagsMany(ids, action.value ? { add: [action.keyword] } : { remove: [action.keyword] }, source);
      case 'clear-tags': return mail.clearTagsMany(ids, source);
    }
  }

  async function run(sources: readonly MailListSource[], action: MailListAction, definitions: ReadonlyArray<MessageTagDefinition>,
    { undoLabel }: { undoLabel?: string } = {}) {
    if (sources.length === 0) return;
    const folders = new Map<number, MessageRow[]>();
    const imap: Array<{ entry: ImapSource['entry']; action: ImapAttentionAction }> = [];
    for (const source of sources) {
      if (source.kind === 'imap') {
        if (action.type === 'read-and-archive') {
          const { entry } = source;
          if (!entry.row.seen) imap.push({ entry, action: { type: 'seen', value: true } });
          imap.push({ entry, action: { type: 'archive' } });
        } else imap.push({ entry: source.entry, action: imapAction(source, action, definitions) });
      } else {
        const rows = folders.get(source.folder.id) ?? [];
        rows.push(source.row);
        folders.set(source.folder.id, rows);
      }
    }
    const owner = ownerId();
    const repo = repository();
    const group = undoLabel ? feedback.createUndoGroup(undoLabel, () => ownerId() === owner && repository() === repo) : undefined;
    try {
      const tasks: Promise<unknown>[] = [...folders].map(([folderId, rows]) => runJmap(folderId, rows, action, group));
      if (imap.length) tasks.push(optimistic.run(owner, repo, imap, { ...(group && { group }), refresh: refreshImap }));
      const results = await Promise.allSettled(tasks);
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Some accounts could not save the change.');
    } finally {
      group?.finish();
    }
  }

  return run;
}

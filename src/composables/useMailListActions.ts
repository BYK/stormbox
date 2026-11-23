import type { Repository } from '../db/repository';
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
  | { type: 'clear-tags' };

type ImapSource = Extract<MailListSource, { kind: 'imap' }>;

export function usesGmailLabels(source: MailListSource): source is ImapSource {
  return source.kind === 'imap' && (source.entry.row.gmailLabels ?? Boolean(source.entry.row.labels?.length));
}

function imapAction(source: ImapSource, action: MailListAction, definitions: ReadonlyArray<MessageTagDefinition>): ImapAttentionAction {
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
export function useMailListActions(ownerId: () => number, repository: () => Repository) {
  const mail = useMailStore();

  async function runJmap(folderId: number, rows: MessageRow[], action: MailListAction) {
    const ids = rows.map(({ id }) => id);
    const source = { sourceFolderId: folderId, rows };
    switch (action.type) {
      case 'star': return mail.markManyFlagged(ids, action.value, source);
      case 'seen': return mail.markManySeen(ids, action.value, source);
      case 'archive': return mail.archiveMessages(ids, source);
      case 'junk': return mail.junkMessages(ids, source);
      case 'delete': return mail.destroyMessages(ids, source);
      case 'tag': return mail.setTagsMany(ids, action.value ? { add: [action.keyword] } : { remove: [action.keyword] }, source);
      case 'clear-tags': return mail.clearTagsMany(ids, source);
    }
  }

  async function run(sources: readonly MailListSource[], action: MailListAction, definitions: ReadonlyArray<MessageTagDefinition>) {
    const folders = new Map<number, MessageRow[]>();
    const imap = [];
    for (const source of sources) {
      if (source.kind === 'imap') {
        imap.push({ location: source.entry.location, action: imapAction(source, action, definitions) });
      } else {
        const rows = folders.get(source.folder.id) ?? [];
        rows.push(source.row);
        folders.set(source.folder.id, rows);
      }
    }
    const jobs: Promise<unknown>[] = [];
    const errors: unknown[] = [];
    if (imap.length === 1) {
      jobs.push(repository().mutateAttentionImapMessage(ownerId(), imap[0].location, imap[0].action));
    } else if (imap.length > 1) {
      jobs.push(repository().mutateAttentionImapMessages(ownerId(), imap));
    }
    const imapResults = Promise.allSettled(jobs);
    for (const [folderId, rows] of folders) {
      try { await runJmap(folderId, rows, action); } catch (cause) { errors.push(cause); }
    }
    for (const result of await imapResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Some accounts could not save the change.');
  }

  return run;
}

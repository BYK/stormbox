import type { ImapTagPatch } from '../sync/backends/imap/attention-relay';
import type { MessageTagDefinition, ResolvedTag } from './message-tags';

const GMAIL_SYSTEM_LABEL = /^(?:inbox|spam|trash|unread|starred|important|sent|drafts?|all mail|category_\w+|\[gmail\]|\[googlemail\])$/i;

type GmailLabelTag = ResolvedTag & { applied: boolean };

/** Include available labels in the picker when the caller supplies known labels. */
export function gmailLabelTags(
  labels: ReadonlyArray<string>,
  definitions: ReadonlyArray<MessageTagDefinition>,
  knownLabels?: ReadonlyArray<string>,
): GmailLabelTag[] {
  const colors = new Map(definitions.filter(({ name }) => !GMAIL_SYSTEM_LABEL.test(name))
    .map(({ name, color }) => [name, color]));
  const applied = new Set(labels);
  const names = knownLabels ? new Set([...colors.keys(), ...knownLabels, ...applied]) : applied;
  return [...names].map((label) => ({
    keyword: `gmail label:${label}`,
    name: label,
    color: colors.get(label) ?? null,
    defined: true,
    applied: applied.has(label),
  }));
}

export function imapTagPatch(
  keyword: string,
  on: boolean,
  gmailTags: ReadonlyArray<GmailLabelTag>,
): ImapTagPatch {
  const label = gmailTags.find((tag) => tag.keyword === keyword);
  return label ? { [on ? 'addLabels' : 'removeLabels']: [label.name] } : { [on ? 'add' : 'remove']: [keyword] };
}

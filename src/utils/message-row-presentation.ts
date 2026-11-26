/**
 * Pure presentation helpers for a message-list row. Shared by every
 * surface that renders MessageListRow so the row reads the same in the
 * folder list and in other list layouts.
 */

import type { JmapViewSort } from '../constants/states';
import { parseAddressList } from './address-list';
import { shortFrom } from './sender-avatar';

export const CARD_LAYOUT_WIDTH = 480;
export const ROW_HEIGHT = 64;
export const CARD_ROW_HEIGHT = 96;

export interface MessageRowLike {
  id?: number | string | null;
  from_text?: string | null;
  to_text?: string | null;
  subject?: string | null;
  preview?: string | null;
  received_at?: number | string | null;
  sent_at?: number | string | null;
  is_seen?: number | string | null;
  is_flagged?: number | string | null;
  has_attachment?: number | string | null;
  keywords_json?: string | null;
  scheduled_undo_status?: string | null;
}

export function recipientLabel(row: Pick<MessageRowLike, 'to_text'>): string {
  const to = row.to_text?.trim() ?? '';
  return parseAddressList(to).map(({ email }) => email).join(', ') || to;
}

/** Give a conversation row the unread and starred state of its members. */
export function conversationRow<T extends MessageRowLike>(leading: T, members: readonly MessageRowLike[]): T {
  return {
    ...leading,
    is_seen: Number(members.every((row) => Number(row.is_seen) !== 0)),
    is_flagged: Number(members.some((row) => Number(row.is_flagged) === 1)),
  };
}

/** Sent and Drafts list the people you wrote to, not yourself (Fixes #98). */
export function folderShowsRecipients(
  folder: { role?: string | null } | null | undefined,
): boolean {
  const role = folder?.role;
  return role === 'sent' || role === 'drafts';
}

export function rowCorrespondent(
  row: MessageRowLike | null | undefined,
  showsRecipients: boolean,
): string | null | undefined {
  return showsRecipients ? row?.to_text : row?.from_text;
}

export function correspondentLabel(
  row: MessageRowLike | null | undefined,
  showsRecipients: boolean,
): string {
  const text = rowCorrespondent(row, showsRecipients);
  if (!text) {
    return showsRecipients ? '(no recipient)' : '(no sender)';
  }
  return shortFrom(text);
}

/**
 * The timestamp the row shows: the active sort's column, so what the
 * user sees explains the order they see it in. Received-sorted folders
 * show received_at; Sent/Drafts/Scheduled (sentAt sorts) show sent_at.
 */
export function rowTimestamp(
  row: MessageRowLike,
  sort: JmapViewSort,
): number | string | null | undefined {
  return sort === 'received'
    ? row.received_at
    : (row.sent_at ?? row.received_at);
}

export function fmtDate(ms: number | string | null | undefined): string {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.valueOf())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}

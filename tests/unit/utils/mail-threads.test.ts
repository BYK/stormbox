import { expect, it } from 'vitest';

import { groupMailThreads, parseThreadHeaders, type ThreadMessage } from '../../../src/utils/mail-threads';

function mail(key: string, receivedAt: number, fields: Partial<ThreadMessage> = {}): ThreadMessage {
  return { key, receivedAt, accountKey: 'jmap:1', subject: 'Planning', ...fields };
}

it('joins native threads and RFC reply chains across accounts, sorting by newest message', () => {
  const first = mail('first', 10, { nativeThreadId: 'thread', messageId: 'first@example.org' });
  const local = mail('local', 30, { nativeThreadId: 'thread', subject: 'Different subject in native thread' });
  const imap = mail('imap', 40, { accountKey: 'imap:work', subject: 'Re: Planning', references: ['<first@example.org>'] });
  const other = mail('another-account', 50, { accountKey: 'jmap:2', nativeThreadId: 'thread' });
  const unrelated = mail('unrelated', 20);
  const threads = groupMailThreads([local, unrelated, imap, first, other]);
  expect(threads.map(({ newest }) => newest.key)).toEqual(['another-account', 'imap', 'unrelated']);
  expect(threads[1].previous.map(({ key }) => key)).toEqual(['first', 'local']);
});

it('falls back to In-Reply-To and keeps unrelated reply subjects separate', () => {
  const root = mail('root', 10, { messageId: 'root@example.org' });
  const inferred = mail('inferred', 20, {
    accountKey: 'imap:other', subject: 'Fwd: Re: Planning', inReplyTo: ['<root@example.org>', '<ignored@example.org>'],
  });
  const changed = mail('changed', 30, { subject: 'Other topic', references: ['<root@example.org>'] });
  const ignored = mail('ignored', 40, { messageId: 'ignored@example.org' });
  expect(groupMailThreads([root, inferred, changed, ignored]).map(({ newest, previous }) => [
    newest.key, previous.map(({ key }) => key),
  ])).toEqual([['ignored', []], ['changed', []], ['inferred', ['root']]]);
  expect(parseThreadHeaders('["known@example.org",false]')).toEqual(['known@example.org']);
  expect(parseThreadHeaders('malformed')).toEqual([]);
});

export interface ThreadMessage {
  key: string;
  accountKey: string;
  receivedAt: number;
  subject: string | null | undefined;
  nativeThreadId?: number | string | null;
  messageId?: string | null;
  references?: readonly string[];
  inReplyTo?: readonly string[];
}

export interface MailThread<T> {
  key: string;
  newest: T;
  /** Oldest first, excluding the newest message shown on the stack. */
  previous: T[];
}

function messageIds(values: readonly string[]) {
  return values.flatMap((value) => {
    const ids = [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1]);
    if (ids.length > 0) return ids;
    const bare = value.trim();
    return /^[^<>\s]+@[^<>\s]+$/.test(bare) ? [bare] : [];
  });
}

function baseSubject(subject: string | null | undefined) {
  return (subject ?? '').normalize('NFC').trim().toLowerCase()
    .replace(/^(?:(?:re|fw|fwd|aw|sv)(?:\[\d+\])?:\s*)+/i, '')
    .replace(/\s+/g, ' ');
}

export function parseThreadHeaders(json: string | null): string[] {
  if (!json) return [];
  try {
    const values: unknown = JSON.parse(json);
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** Link native threads within an account and RFC reply chains across accounts. */
export function groupMailThreads<T extends ThreadMessage>(messages: readonly T[]): MailThread<T>[] {
  const parents = messages.map((_, index) => index);
  const owners = new Map<string, number>();
  const rank = messages.map(() => 0);
  function root(index: number): number {
    if (parents[index] !== index) parents[index] = root(parents[index]);
    return parents[index];
  }
  function link(index: number, alias: string) {
    const owner = owners.get(alias);
    if (owner === undefined) {
      owners.set(alias, index);
      return;
    }
    const a = root(index);
    const b = root(owner);
    if (a === b) return;
    if (rank[a] < rank[b]) parents[a] = b;
    else {
      parents[b] = a;
      if (rank[a] === rank[b]) rank[a] += 1;
    }
  }

  const stableAliases = messages.map((message, index) => {
    const native = message.nativeThreadId == null ? undefined : JSON.stringify(['native', message.accountKey, message.nativeThreadId]);
    if (native) link(index, native);
    const ids = messageIds(message.messageId ? [message.messageId] : []);
    const references = messageIds(message.references ?? []);
    // RFC 5256 uses the first valid In-Reply-To ID only when References is absent.
    const ancestors = references.length ? references : messageIds(message.inReplyTo ?? []).slice(0, 1);
    const subject = baseSubject(message.subject);
    // Combine the ID with the base subject so a reply that starts a different topic
    // does not join an unrelated conversation across providers (RFC 8621 §3).
    const aliases = [...ancestors, ...ids.slice(0, 1)].map((id) => JSON.stringify(['rfc', subject, id]));
    for (const alias of aliases) link(index, alias);
    return aliases[0] ?? native ?? message.key;
  });

  const byRoot = new Map<number, Array<{ message: T; alias: string }>>();
  for (const [index, message] of messages.entries()) {
    const id = root(index);
    const group = byRoot.get(id) ?? [];
    group.push({ message, alias: stableAliases[index] });
    byRoot.set(id, group);
  }

  const compare = (a: T, b: T) => a.receivedAt - b.receivedAt || a.key.localeCompare(b.key);
  return [...byRoot.values()].map((group) => {
    group.sort((a, b) => compare(a.message, b.message));
    return {
      key: group[0].alias,
      newest: group[group.length - 1].message,
      previous: group.slice(0, -1).map(({ message }) => message),
    };
  }).sort((a, b) => compare(b.newest, a.newest));
}

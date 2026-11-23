export type TriageDisposition = 'action' | 'uncertain' | 'update';
export type TriagePriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TriageClassification {
  disposition: TriageDisposition;
  reason: string;
  baseScore: number;
}

export interface TriageMessage {
  id: number | string;
  accountId: number | string;
  receivedAt: number;
  subject?: string | null;
  preview?: string | null;
  body?: string | null;
  threadId?: number | string | null;
  messageId?: string | null;
  references?: readonly string[] | string | null;
  inReplyTo?: readonly string[] | string | null;
  sender?: string | null;
  groupReference?: string | null;
  directRecipient?: boolean;
  isFlagged?: boolean;
  isAnswered?: boolean;
  classification?: TriageClassification;
}

export interface TriageItem {
  message: TriageMessage;
  classification: TriageClassification;
}

export interface BundleState {
  disposition: 'done' | 'snoozed';
  changedAt: number;
  aliases: string[];
  observed: string[];
  resolved: string[];
  snoozedUntil?: number;
}

export interface TriageBundle {
  id: string;
  accountId: TriageMessage['accountId'];
  messages: TriageItem[];
  leading: TriageItem;
  status: TriageDisposition | 'done' | 'snoozed';
  reason: string;
  priority: TriagePriority;
  score: number;
  latestAt: number;
  snoozedUntil?: number;
  aliases: string[];
  resolved: string[];
}

const ENGLISH_REQUEST = /\b(?:(?:action|review|response|approval|signature|payment) (?:is )?(?:requested|required|overdue)|(?:you have been|you were) (?:assigned|mentioned)|(?:requested your|requested a) review|mentioned you|please (?:review|reply|respond|approve|confirm|send|submit|sign|pay|decide)|(?:could|can|would) you (?:review|reply|respond|approve|confirm|send|submit|sign|pay|decide|take a look))\b/;
const TURKISH_REQUEST = /\b(?:(?:lutfen )?(?:yanit|cevap) ver(?:in|iniz|ebilir misin)|lutfen (?:incele|onayla|imzala|gonder|ode|bildir)\w*|(?:yanit|cevap|onay|imza|odeme|islem) (?:gerekli|gerekiyor|bekleniyor)|incelemeniz (?:isteniyor|bekleniyor))\b/;
const EXCEPTION = /\b(?:payment (?:failed|declined|overdue)|(?:delivery|verification) (?:failed|attempt failed)|undeliverable|(?:your )?account (?:locked|suspended)|failed (?:to deliver|verification)|(?:failure|error) in (?:workflow|pipeline|run)|(?:workflow|pipeline|run|checks?) (?:has |have )?failed|(?:odeme|teslimat|dogrulama) (?:basarisiz|reddedildi)|hesabiniz (?:kilitlendi|askiya alindi))\b/;
const URGENT = /\b(?:urgent|asap|immediately|critical|overdue|due today|respond today|time[- ]sensitive|acil|hemen|bugun son gun|son gun bugun)\b/;
const NO_ACTION = /\b(?:no (?:further )?action (?:is )?(?:needed|required)|no (?:need|action) to (?:reply|respond)|islem (?:yapmaniz )?gerekmiyor|(?:yanit|cevap) (?:vermeniz )?gerekmiyor)\b/g;
const ROUTINE_SUBJECT = /^(?:(?:\[[^[\]\r\n]{1,80}\]|re:|fw:|fwd:)\s*)*(?:(?:weekly|daily|monthly) (?:digest|newsletter|summary|activity report)|(?:payment|order) (?:received|confirmed)|(?:your )?(?:parcel|package|order) (?:has shipped|has been shipped|was delivered)|(?:workflow|pipeline|run|checks?) (?:has |have )?(?:passed|succeeded|completed successfully|started|queued)|(?:gunluk|haftalik|aylik) (?:ozet|bulten|rapor)|(?:odeme|siparis) (?:alindi|onaylandi)|(?:kargonuz|siparisiniz) (?:yola cikti|teslim edildi))(?:\b|$)/;
const TICKET = /\b(ticket|case|incident|order|invoice|shipment|siparis|fatura|kargo)(?:\s+(?:no\.?|number|numarasi))?[\s#:]+([a-z0-9][a-z0-9-]{3,39})\b/g;

const HALF_LIFE_MS = 72 * 60 * 60 * 1000;
const DISPOSITION_ORDER: Record<TriageBundle['status'], number> = {
  action: 0, uncertain: 1, update: 2, snoozed: 3, done: 4,
};
const PRIORITIES: readonly TriagePriority[] = ['P0', 'P1', 'P2', 'P3'];

function foldText(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

function boundedScore(score: number): number {
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 48;
}

export function triageExcerpt(message: TriageMessage): string {
  return (message.body ?? message.preview ?? '').slice(0, 2400)
    .split(/\r?\nOn .{0,180}wrote:\s*\r?\n|\r?\n--\s*\r?\n/i, 1)[0]
    .replace(/^\s*>.*$/gm, '');
}

export function classifyTriageMessage(message: TriageMessage): TriageClassification {
  if (message.isFlagged) return { disposition: 'action', baseScore: 85, reason: 'Flagged by you' };
  if (message.isAnswered) return { disposition: 'update', baseScore: 30, reason: 'Already replied' };

  const subject = foldText(message.subject ?? '');
  const text = `${subject}\n${foldText(triageExcerpt(message))}`;
  const actionableText = text.replace(NO_ACTION, '');
  const urgent = URGENT.test(actionableText);
  if (EXCEPTION.test(actionableText)) {
    return { disposition: 'action', baseScore: urgent ? 84 : 68, reason: 'Exception reported' };
  }
  if (ENGLISH_REQUEST.test(actionableText) || TURKISH_REQUEST.test(actionableText)) {
    return { disposition: 'action', baseScore: urgent ? 82 : 65, reason: 'Action requested' };
  }
  const remainingSubject = subject.replace(NO_ACTION, '');
  const noActionSubject = remainingSubject !== subject && /^\W*$/.test(remainingSubject);
  if (ROUTINE_SUBJECT.test(subject) || noActionSubject) {
    return { disposition: 'update', baseScore: 25, reason: 'Routine update' };
  }
  if (message.classification) {
    return { ...message.classification, baseScore: boundedScore(message.classification.baseScore) };
  }
  return {
    disposition: 'uncertain',
    baseScore: 48 + (message.directRecipient ? 7 : 0) + (urgent ? 16 : 0),
    reason: urgent ? 'Time-sensitive wording' : 'May need your attention',
  };
}

export function priorityForScore(score: number): TriagePriority {
  return PRIORITIES[priorityIndex(score)];
}

function priorityIndex(score: number): number {
  if (score >= 80) return 0;
  if (score >= 60) return 1;
  if (score >= 35) return 2;
  return 3;
}

export function timeAdjustedScore(score: number, receivedAt: number, now = Date.now()): number {
  const age = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : Infinity;
  return boundedScore(score) * 2 ** (-age / HALF_LIFE_MS);
}

function messageIds(value: TriageMessage['references']): string[] {
  if (!value) return [];
  if (typeof value !== 'string') return value.flatMap(messageIds);
  const bracketed = [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1]);
  return bracketed.length ? bracketed : value.trim().split(/\s+/).filter(id => /^[^<>\s]+@[^<>\s]+$/.test(id));
}

function alias(message: TriageMessage, kind: string, value: number | string): string {
  return JSON.stringify([String(message.accountId), kind, String(value)]);
}

function localKey(message: TriageMessage): string {
  return alias(message, '3-local', message.id);
}

function sourceReference(message: TriageMessage): string | undefined {
  const sender = message.sender?.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? message.sender?.trim();
  if (!sender || !/^[^<>\s]+@[^<>\s]+$/.test(sender)) return;
  const explicit = message.groupReference?.trim();
  if (explicit) return JSON.stringify([sender.toLowerCase(), explicit]);
  const matches = new Set([...foldText(message.subject ?? '').matchAll(TICKET)]
    .filter((match) => /\d/.test(match[2]))
    .map((match) => `${match[1]} ${match[2]}`));
  if (matches.size === 1) return JSON.stringify([sender.toLowerCase(), matches.values().next().value]);
}

function messageAliases(message: TriageMessage): string[] {
  const aliases = [localKey(message)];
  if (message.threadId != null && message.threadId !== '') aliases.push(alias(message, '0-thread', message.threadId));
  const reference = sourceReference(message);
  if (reference) aliases.push(alias(message, '1-source', reference));
  const ancestry = messageIds(message.references);
  const ids = [...messageIds(message.messageId), ...ancestry.slice(0, 1), ...ancestry.slice(-30)];
  if (!ancestry.length) ids.push(...messageIds(message.inReplyTo).slice(0, 1));
  for (const id of new Set(ids)) aliases.push(alias(message, '2-message', id));
  return aliases;
}

interface BundleMembers { items: TriageItem[]; aliases: Set<string> }

function groupMessages(messages: readonly TriageMessage[]): BundleMembers[] {
  const parents = messages.map((_, index) => index);
  const aliasesByMessage = messages.map(messageAliases);
  const firstMessageByAlias = new Map<string, number>();
  const find = (index: number) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  for (const [index, aliases] of aliasesByMessage.entries()) {
    for (const key of aliases) {
      const previous = firstMessageByAlias.get(key);
      if (previous == null) firstMessageByAlias.set(key, index);
      else parents[find(index)] = find(previous);
    }
  }
  const groups = new Map<number, BundleMembers>();
  for (const [index, message] of messages.entries()) {
    const root = find(index);
    const group = groups.get(root) ?? { items: [], aliases: new Set<string>() };
    if (!groups.has(root)) groups.set(root, group);
    group.items.push({ message, classification: classifyTriageMessage(message) });
    for (const key of aliasesByMessage[index]) group.aliases.add(key);
  }
  return [...groups.values()];
}

function recency(left: TriageItem, right: TriageItem): number {
  return right.message.receivedAt - left.message.receivedAt
    || localKey(left.message).localeCompare(localKey(right.message));
}

export function buildTriageBundles(
  messages: readonly TriageMessage[],
  states: Readonly<Record<string, BundleState>> = {},
  now = Date.now(),
): TriageBundle[] {
  const statesByAlias = new Map<string, BundleState[]>();
  for (const [id, state] of Object.entries(states)) {
    for (const key of new Set([id, ...state.aliases])) {
      const existing = statesByAlias.get(key);
      if (existing) existing.push(state);
      else statesByAlias.set(key, [state]);
    }
  }

  const bundles = groupMessages(messages).map((group): TriageBundle => {
    const aliases = [...group.aliases].sort();
    const matched = [...new Set(aliases.flatMap((key) => statesByAlias.get(key) ?? []))];
    const latestState = matched.sort((left, right) => right.changedAt - left.changedAt)[0];
    const resolved = new Set(matched.flatMap((state) => state.resolved));
    const pending = group.items.filter((item) => item.classification.disposition !== 'update'
      && !resolved.has(localKey(item.message)));
    const actions = pending.filter((item) => item.classification.disposition === 'action');
    group.items.sort(recency);

    const nextItems = actions.length ? actions : pending;
    nextItems.sort((left, right) => priorityIndex(left.classification.baseScore) - priorityIndex(right.classification.baseScore)
      || timeAdjustedScore(right.classification.baseScore, right.message.receivedAt, now)
        - timeAdjustedScore(left.classification.baseScore, left.message.receivedAt, now)
      || recency(left, right));
    const leading = nextItems[0] ?? group.items[0];
    let status: TriageBundle['status'] = nextItems.at(0)?.classification.disposition
      ?? (resolved.size || latestState?.disposition === 'done' ? 'done' : 'update');
    const until = latestState?.snoozedUntil;
    if (latestState?.disposition === 'snoozed' && until != null && until > now) {
      const observed = new Set(latestState.observed);
      if (pending.every((item) => observed.has(localKey(item.message)))) status = 'snoozed';
    }

    const baseScore = status === 'done' || status === 'update' ? 25 : leading.classification.baseScore;
    const reason = status === 'done' ? 'Done' : status === 'snoozed' ? 'Snoozed'
      : status === 'update' ? 'Routine update' : leading.classification.reason;
    return {
      id: aliases[0], accountId: leading.message.accountId, messages: group.items, leading,
      status, reason, priority: priorityForScore(baseScore),
      score: timeAdjustedScore(baseScore, leading.message.receivedAt, now),
      latestAt: group.items[0].message.receivedAt, aliases, resolved: [...resolved],
      ...(status === 'snoozed' ? { snoozedUntil: until } : {}),
    };
  });

  return bundles.sort((left, right) => DISPOSITION_ORDER[left.status] - DISPOSITION_ORDER[right.status]
    || PRIORITIES.indexOf(left.priority) - PRIORITIES.indexOf(right.priority)
    || right.score - left.score || right.latestAt - left.latestAt || left.id.localeCompare(right.id));
}

export function markBundleDone(bundle: TriageBundle, now = Date.now()): BundleState {
  const observed = bundle.messages.map((item) => localKey(item.message));
  return {
    disposition: 'done', changedAt: now, aliases: bundle.aliases,
    observed, resolved: [...new Set([...bundle.resolved, ...observed])],
  };
}

export function snoozeBundle(bundle: TriageBundle, until: number, now = Date.now()): BundleState {
  return {
    disposition: 'snoozed', changedAt: now, aliases: bundle.aliases,
    observed: bundle.messages.map((item) => localKey(item.message)),
    resolved: bundle.resolved, snoozedUntil: until,
  };
}

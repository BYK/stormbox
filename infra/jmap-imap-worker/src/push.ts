import { DurableObject } from 'cloudflare:workers';
import webPush from 'web-push';
import type { BundleState } from '../../../src/triage/smart-sort';
import { notificationHandled, type AttentionNotification } from './attention-notifications';
import { HttpError, json, readJson } from './http';

export interface PushEnv {
  PUSH_SUBSCRIPTIONS?: DurableObjectNamespace<PushSubscriptions>;
  RELAY_SESSION_KEY?: string;
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  WEB_PUSH_VAPID_SUBJECT?: string;
}

interface Subscription {
  endpoint: string;
  keys: { auth: string; p256dh: string };
}

type PendingRecipient = SqlStorageValueRecord & {
  event_key: string;
  endpoint: string;
  tag: string;
  detail: string;
  auth: string;
  p256dh: string;
  attempts: number;
};

type SqlStorageValueRecord = Record<string, SqlStorageValue>;

const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const MAX_BODY = 16 * 1024;
const MAX_SUBSCRIPTIONS = 32;
const MAX_ATTEMPTS = 6;
const RETENTION = 24 * 60 * 60 * 1000;
const TTL = 60 * 60;

interface AttentionStateUpdate {
  id: string;
  state: BundleState | null;
  replacedIds: string[];
  changedAt: number;
}

function accountFromAlias(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const alias: unknown = JSON.parse(value);
    if (!Array.isArray(alias) || alias.length !== 3 || typeof alias[0] !== 'string'
      || typeof alias[2] !== 'string' || !['0-thread', '1-source', '2-message', '3-local'].includes(alias[1])) return;
    return /^imap:([A-Za-z0-9_-]{1,128})$/.exec(alias[0])?.[1];
  } catch {
    return undefined;
  }
}

function attentionStateUpdate(input: unknown): { account: string; update: AttentionStateUpdate } {
  const badInput = () => new HttpError(400, 'Invalid attention state.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badInput();
  const { id, state, replacedIds, changedAt } = input as AttentionStateUpdate;
  const account = accountFromAlias(id);
  const aliasesForAccount = (items: unknown): items is string[] => Array.isArray(items)
    && items.length <= 2048 && items.every((item) => accountFromAlias(item) === account);
  if (!account || !aliasesForAccount(replacedIds) || !Number.isSafeInteger(changedAt) || changedAt <= 0
    || changedAt > Date.now() + 5 * 60 * 1000) throw badInput();
  if (state === null) return { account, update: { id, state, replacedIds, changedAt } };
  if (!state || typeof state !== 'object' || !['done', 'snoozed'].includes(state.disposition)
    || !aliasesForAccount(state.aliases) || !aliasesForAccount(state.resolved) || !aliasesForAccount(state.observed)
    || (state.disposition === 'snoozed' && !Number.isSafeInteger(state.snoozedUntil))) throw badInput();
  return { account, update: { id, changedAt, replacedIds, state: {
    disposition: state.disposition, changedAt, aliases: state.aliases, observed: state.observed,
    resolved: state.resolved, ...(state.disposition === 'snoozed' ? { snoozedUntil: state.snoozedUntil } : {}),
  } } };
}

function base64Bytes(value: unknown, byteLength: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== Math.ceil(byteLength * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const sequence = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (btoa(sequence).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== value) return null;
  return Uint8Array.from(sequence, (character) => character.charCodeAt(0));
}

function vapid(env: PushEnv) {
  const { WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: privateKey, WEB_PUSH_VAPID_SUBJECT: subject } = env;
  if (!publicKey || !privateKey || !subject || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  if (base64Bytes(publicKey, 65)?.[0] !== 4 || !base64Bytes(privateKey, 32)) return null;
  return { publicKey, privateKey, subject };
}

function subscriptionRegistry(env: PushEnv) {
  return env.PUSH_SUBSCRIPTIONS?.getByName(env.RELAY_SESSION_KEY ? 'stormbox-owner' : 'stormbox');
}

function endpointFrom(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) throw new HttpError(400, 'Invalid push endpoint.');
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new HttpError(400, 'Invalid push endpoint.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || endpoint.href !== value) {
    throw new HttpError(400, 'Invalid push endpoint.');
  }
  if (!PUSH_HOSTS.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`))) {
    throw new HttpError(400, 'Unsupported push provider.');
  }
  return endpoint.href;
}

/** Browser writes are authorized by the gateway's paired session check. */
export async function handlePush(request: Request, env: PushEnv, paired: boolean): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    const keys = vapid(env);
    if (!keys || !env.PUSH_SUBSCRIPTIONS) return json({ error: 'Push notifications are unconfigured.' }, 503);
    if (path === '/api/push/config' && request.method === 'GET') return json({ publicKey: keys.publicKey });
    const status = path === '/api/push/subscriptions/status' && request.method === 'POST';
    const write = path === '/api/push/subscriptions' && ['POST', 'DELETE'].includes(request.method);
    const attention = path === '/api/push/attention' && request.method === 'PUT';
    if (!status && !write && !attention) return json({ error: 'Not found.' }, 404);
    if (!paired) return json({ error: 'Pair the browser first.' }, 401);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'Expected a JSON request.');
    }
    const subscriptions = subscriptionRegistry(env)!;
    if (attention) {
      const { account, update } = attentionStateUpdate(await readJson(request, 256 * 1024));
      await subscriptions.updateAttentionState(account, update);
      return json(null, 204);
    }
    const body: Partial<Subscription> & { confirmedOnly?: boolean } = await readJson(request, MAX_BODY);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON.');
    const endpoint = endpointFrom(body.endpoint);
    const { confirmedOnly } = body;
    if (confirmedOnly !== undefined && typeof confirmedOnly !== 'boolean') throw new HttpError(400, 'Invalid triage mode.');
    if (status) return json({ enabled: await subscriptions.checkSubscription(endpoint, confirmedOnly) });
    if (request.method === 'DELETE') {
      await subscriptions.remove(endpoint);
    } else {
      const auth = body.keys?.auth;
      const p256dh = body.keys?.p256dh;
      if (!auth || !p256dh || !base64Bytes(auth, 16) || base64Bytes(p256dh, 65)?.[0] !== 4) {
        throw new HttpError(400, 'Invalid subscription keys.');
      }
      if (!await subscriptions.add({ endpoint, keys: { auth, p256dh } }, confirmedOnly)) {
        throw new HttpError(409, 'The notification subscription limit was reached.');
      }
    }
    return json(null, 204);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    return json({ error: 'Push relay operation failed.' }, 502);
  }
}

export async function notifyArrival(
  env: PushEnv, account: string, event: string, detail: AttentionNotification, aliases?: string[],
): Promise<boolean> {
  if (!env.PUSH_SUBSCRIPTIONS || !vapid(env)) return true;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(account) || !/^[A-Za-z0-9_:-]{1,128}$/.test(event)) return false;
  try {
    await subscriptionRegistry(env)!.enqueue(account, event, detail, aliases);
    return true;
  } catch {
    return false;
  }
}

export async function observePushConversations(env: PushEnv, account: string, observations: string[][]): Promise<boolean> {
  if (!observations.length || !env.PUSH_SUBSCRIPTIONS || !vapid(env)) return true;
  try {
    await subscriptionRegistry(env)!.observeConversations(account, observations);
    return true;
  } catch {
    return false;
  }
}

export async function pushAttentionStates(env: PushEnv, account: string): Promise<Record<string, BundleState> | null> {
  if (!env.PUSH_SUBSCRIPTIONS || !vapid(env)) return null;
  return subscriptionRegistry(env)!.attentionStates(account);
}

export async function hasPushSubscribers(env: PushEnv): Promise<boolean> {
  if (!env.PUSH_SUBSCRIPTIONS || !vapid(env)) return false;
  return subscriptionRegistry(env)!.hasAny();
}

function subscriptionValue(recipient: PendingRecipient): Subscription {
  return { endpoint: recipient.endpoint, keys: { auth: recipient.auth, p256dh: recipient.p256dh } };
}

async function pushDigest(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function send(
  subscription: Subscription, tag: string, notification: AttentionNotification,
  vapidDetails: NonNullable<ReturnType<typeof vapid>>,
) {
  const { sender, subject, preview } = notification;
  const details = webPush.generateRequestDetails(subscription, JSON.stringify({ tag, sender, subject, preview }), {
    TTL, topic: tag, vapidDetails,
  });
  const result = await fetch(endpointFrom(details.endpoint), {
    method: 'POST',
    headers: details.headers,
    // Strip the Node Buffer wrapper to pass the encrypted bytes to workerd.
    body: Uint8Array.from(details.body!),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  await result.body?.cancel();
  return result.status;
}

export class PushSubscriptions extends DurableObject<PushEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: PushEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY, auth TEXT NOT NULL, p256dh TEXT NOT NULL, confirmed_only INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_events (
        event_key TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at INTEGER NOT NULL, detail TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS push_pending (
        event_key TEXT NOT NULL REFERENCES push_events(event_key) ON DELETE CASCADE,
        endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
        due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_key, endpoint)
      );
      CREATE INDEX IF NOT EXISTS push_pending_due ON push_pending(due_at);
      CREATE TABLE IF NOT EXISTS push_attention_states (
        account TEXT NOT NULL, id TEXT NOT NULL, changed_at INTEGER NOT NULL, state TEXT,
        PRIMARY KEY(account, id)
      );
      CREATE TABLE IF NOT EXISTS push_notified_aliases (
        account TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(account, digest)
      );
    `);
    const eventColumns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(push_events)').toArray().map(({ name }) => name));
    if (!eventColumns.has('detail')) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE push_events ADD COLUMN detail TEXT');
        this.sql.exec('DELETE FROM push_events');
      });
    }
    if (!eventColumns.has('confirmed')) this.sql.exec('ALTER TABLE push_events ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0');
    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(push_subscriptions)').toArray().some(({ name }) => name === 'confirmed_only')) {
      this.sql.exec('ALTER TABLE push_subscriptions ADD COLUMN confirmed_only INTEGER NOT NULL DEFAULT 0');
    }
  }

  has(endpoint: string): boolean {
    return this.sql.exec('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', endpoint).toArray().length > 0;
  }

  checkSubscription(endpoint: string, confirmedOnly?: boolean): boolean {
    return this.ctx.storage.transactionSync(() => {
      const enabled = this.has(endpoint);
      if (enabled && confirmedOnly !== undefined) this.setSubscriptionMode(endpoint, confirmedOnly);
      return enabled;
    });
  }

  private setSubscriptionMode(endpoint: string, confirmedOnly: boolean): void {
    this.sql.exec('UPDATE push_subscriptions SET confirmed_only = ? WHERE endpoint = ?', Number(confirmedOnly), endpoint);
    if (confirmedOnly) {
      this.sql.exec(`DELETE FROM push_pending WHERE endpoint = ? AND event_key IN (SELECT event_key FROM push_events WHERE confirmed = 0)`, endpoint);
      this.pruneDeliveredDetails();
    }
  }

  hasAny(): boolean {
    return this.sql.exec('SELECT 1 FROM push_subscriptions LIMIT 1').toArray().length > 0;
  }

  attentionStates(account: string): Record<string, BundleState> | null {
    if (!this.hasAny()) return null;
    const rows = this.sql.exec<{ id: string; state: string }>(`SELECT id, state FROM push_attention_states
      WHERE account = ? AND state IS NOT NULL`, account);
    return Object.fromEntries([...rows].map(({ id, state }) => [id, JSON.parse(state) as BundleState]));
  }

  updateAttentionState(account: string, update: AttentionStateUpdate): void {
    const { id, state, replacedIds, changedAt } = update;
    this.ctx.storage.transactionSync(() => {
      for (const key of new Set([id, ...replacedIds])) {
        const value = key === id && state ? JSON.stringify(state) : null;
        this.sql.exec(`INSERT INTO push_attention_states (account,id,changed_at,state) VALUES (?, ?, ?, ?)
          ON CONFLICT(account,id) DO UPDATE SET changed_at = excluded.changed_at, state = excluded.state
          WHERE push_attention_states.changed_at <= excluded.changed_at`, account, key, changedAt, value);
      }
      if (state) this.cancelHandledNotifications(account);
    });
  }

  private cancelHandledNotifications(account: string): void {
    const states = this.attentionStates(account);
    if (!states) return;
    const now = Date.now();
    const events = this.sql.exec<{ event_key: string; detail: string }>(`SELECT event_key,detail FROM push_events
      WHERE event_key GLOB ? AND detail IS NOT NULL`, `${account}:*`).toArray();
    for (const { event_key: key, detail } of events) {
      if (notificationHandled(JSON.parse(detail) as AttentionNotification, states, now)) {
        this.sql.exec('DELETE FROM push_pending WHERE event_key = ?', key);
      }
    }
    this.pruneDeliveredDetails();
  }

  add(subscription: Subscription, confirmedOnly?: boolean): boolean {
    return this.ctx.storage.transactionSync(() => {
      const count = this.sql.exec<{ total: number }>('SELECT count(*) AS total FROM push_subscriptions').one().total;
      if (count >= MAX_SUBSCRIPTIONS && !this.has(subscription.endpoint)) return false;
      this.sql.exec(`INSERT INTO push_subscriptions (endpoint,auth,p256dh) VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET auth = excluded.auth, p256dh = excluded.p256dh`,
      subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh);
      if (confirmedOnly !== undefined) this.setSubscriptionMode(subscription.endpoint, confirmedOnly);
      return true;
    });
  }

  remove(endpoint: string): void {
    this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }

  async enqueue(account: string, event: string, detail: AttentionNotification, aliases = [detail.messageKey]): Promise<void> {
    if (!detail.confirmed || !detail.messageKey) return;
    const key = `${account}:${event}`;
    const tag = `stormbox-${(await pushDigest(key)).slice(0, 20)}`;
    // No subject, message ID or preview needs to survive in the deduplication ledger.
    const digests = JSON.stringify(await Promise.all(aliases.map(pushDigest)));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM push_events WHERE created_at < ?', now - RETENTION);
      if (this.isNotifiedConversation(account, digests)) {
        this.rememberConversation(account, digests);
        return;
      }
      const states = this.attentionStates(account);
      if (!states || notificationHandled(detail, states, now)) return;
      const inserted = this.sql.exec(`INSERT OR IGNORE INTO push_events (event_key,tag,created_at,detail,confirmed) VALUES (?, ?, ?, ?, ?)`,
        key, tag, now, JSON.stringify(detail), Number(detail.confirmed)).rowsWritten;
      if (inserted) this.sql.exec(`INSERT INTO push_pending (event_key, endpoint, due_at)
        SELECT ?, endpoint, ? FROM push_subscriptions WHERE confirmed_only = 0 OR ? = 1`, key, now, Number(detail.confirmed));
      this.rememberConversation(account, digests);
      this.pruneDeliveredDetails();
    });
    await this.schedule();
  }

  async observeConversations(account: string, observations: string[][]): Promise<void> {
    const groups = await Promise.all(observations.map(async (aliases) => JSON.stringify(await Promise.all(aliases.map(pushDigest)))));
    this.ctx.storage.transactionSync(() => {
      for (const digests of groups) {
        if (this.isNotifiedConversation(account, digests)) this.rememberConversation(account, digests);
      }
    });
  }

  private isNotifiedConversation(account: string, digests: string): boolean {
    return this.sql.exec(`SELECT 1 FROM json_each(?) AS alias JOIN push_notified_aliases AS known
      ON known.account = ? AND known.digest = alias.value LIMIT 1`, digests, account).toArray().length > 0;
  }

  private rememberConversation(account: string, digests: string): void {
    this.sql.exec('INSERT OR IGNORE INTO push_notified_aliases SELECT ?, value FROM json_each(?)', account, digests);
  }

  private pruneDeliveredDetails() {
    this.sql.exec(`UPDATE push_events SET detail = NULL WHERE detail IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM push_pending WHERE event_key = push_events.event_key)`);
  }

  private async schedule() {
    const pending = this.sql.exec<{ next: number | null }>('SELECT min(due_at) AS next FROM push_pending').one().next;
    if (pending === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > pending) await this.ctx.storage.setAlarm(pending);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec('DELETE FROM push_events WHERE created_at < ?', now - RETENTION);
    const keys = vapid(this.env);
    if (!keys) {
      if (this.sql.exec('SELECT 1 FROM push_pending LIMIT 1').toArray().length) {
        await this.ctx.storage.setAlarm(now + 60 * 60 * 1000);
      }
      return;
    }
    const batch = this.sql.exec<PendingRecipient>(`SELECT pending.event_key, pending.endpoint, event.tag, event.detail,
      sub.auth, sub.p256dh, pending.attempts
      FROM push_pending pending JOIN push_events event USING(event_key) JOIN push_subscriptions sub USING(endpoint)
      WHERE pending.due_at <= ? ORDER BY pending.due_at LIMIT 4`, now).toArray();
    const statesByAccount = new Map<string, Record<string, BundleState>>();
    await Promise.all(batch.map(async (recipient) => {
      const notification = JSON.parse(recipient.detail) as AttentionNotification;
      const account = recipient.event_key.split(':', 1)[0];
      if (!statesByAccount.has(account)) statesByAccount.set(account, this.attentionStates(account) ?? {});
      if (!notification.confirmed || !notification.messageKey || notificationHandled(notification, statesByAccount.get(account)!, now)) {
        this.sql.exec('DELETE FROM push_pending WHERE event_key = ? AND endpoint = ?', recipient.event_key, recipient.endpoint);
        return;
      }
      let status: number;
      try {
        status = await send(subscriptionValue(recipient), recipient.tag, notification, keys);
      } catch {
        status = 503;
      }
      if (status === 404 || status === 410) {
        this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ? AND auth = ? AND p256dh = ?',
          recipient.endpoint, recipient.auth, recipient.p256dh);
      }
      const retryable = (status >= 500 || status === 429) && recipient.attempts + 1 < MAX_ATTEMPTS;
      if (retryable) {
        const due = Date.now() + 30_000 * 2 ** recipient.attempts;
        this.sql.exec('UPDATE push_pending SET attempts = attempts + 1, due_at = ? WHERE event_key = ? AND endpoint = ?',
          due, recipient.event_key, recipient.endpoint);
      } else {
        this.sql.exec('DELETE FROM push_pending WHERE event_key = ? AND endpoint = ?', recipient.event_key, recipient.endpoint);
      }
    }));
    this.pruneDeliveredDetails();
    await this.schedule();
  }
}

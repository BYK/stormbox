import { DurableObject } from 'cloudflare:workers';
import webPush from 'web-push';
import { HttpError, json, readJson } from './http';

export interface PushEnv {
  PUSH_SUBSCRIPTIONS?: DurableObjectNamespace<PushSubscriptions>;
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
    if (!status && !write) return json({ error: 'Not found.' }, 404);
    if (!paired) return json({ error: 'Pair the browser first.' }, 401);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'Expected a JSON request.');
    }
    const body: Partial<Subscription> = await readJson(request, MAX_BODY);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid JSON.');
    const endpoint = endpointFrom(body.endpoint);
    const subscriptions = env.PUSH_SUBSCRIPTIONS.getByName('stormbox');
    if (status) return json({ enabled: await subscriptions.has(endpoint) });
    if (request.method === 'DELETE') {
      await subscriptions.remove(endpoint);
    } else {
      const auth = body.keys?.auth;
      const p256dh = body.keys?.p256dh;
      if (!auth || !p256dh || !base64Bytes(auth, 16) || base64Bytes(p256dh, 65)?.[0] !== 4) {
        throw new HttpError(400, 'Invalid subscription keys.');
      }
      if (!await subscriptions.add({ endpoint, keys: { auth, p256dh } })) {
        throw new HttpError(409, 'The notification subscription limit was reached.');
      }
    }
    return json(null, 204);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    return json({ error: 'Push relay operation failed.' }, 502);
  }
}

export async function notifyArrival(env: PushEnv, account: string, event: string): Promise<boolean> {
  if (!env.PUSH_SUBSCRIPTIONS || !vapid(env)) return true;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(account) || !/^[A-Za-z0-9_:-]{1,128}$/.test(event)) return false;
  try {
    await env.PUSH_SUBSCRIPTIONS.getByName('stormbox').enqueue(account, event);
    return true;
  } catch {
    return false;
  }
}

function subscriptionValue(recipient: PendingRecipient): Subscription {
  return { endpoint: recipient.endpoint, keys: { auth: recipient.auth, p256dh: recipient.p256dh } };
}

async function send(subscription: Subscription, tag: string, vapidDetails: NonNullable<ReturnType<typeof vapid>>) {
  const details = webPush.generateRequestDetails(subscription, JSON.stringify({ tag }), {
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
        endpoint TEXT PRIMARY KEY, auth TEXT NOT NULL, p256dh TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_events (
        event_key TEXT PRIMARY KEY, tag TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_pending (
        event_key TEXT NOT NULL REFERENCES push_events(event_key) ON DELETE CASCADE,
        endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
        due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_key, endpoint)
      );
      CREATE INDEX IF NOT EXISTS push_pending_due ON push_pending(due_at);
    `);
  }

  has(endpoint: string): boolean {
    return this.sql.exec('SELECT 1 FROM push_subscriptions WHERE endpoint = ?', endpoint).toArray().length > 0;
  }

  add(subscription: Subscription): boolean {
    return this.ctx.storage.transactionSync(() => {
      const count = this.sql.exec<{ total: number }>('SELECT count(*) AS total FROM push_subscriptions').one().total;
      if (count >= MAX_SUBSCRIPTIONS && !this.has(subscription.endpoint)) return false;
      this.sql.exec(`INSERT INTO push_subscriptions VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET auth = excluded.auth, p256dh = excluded.p256dh`,
      subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh);
      return true;
    });
  }

  remove(endpoint: string): void {
    this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }

  async enqueue(account: string, event: string): Promise<void> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)));
    const tag = `stormbox-${Array.from(digest.subarray(0, 10), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const key = `${account}:${event}`;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM push_events WHERE created_at < ?', now - RETENTION);
      const inserted = this.sql.exec('INSERT OR IGNORE INTO push_events VALUES (?, ?, ?)', key, tag, now).rowsWritten;
      if (inserted) this.sql.exec(`INSERT INTO push_pending (event_key, endpoint, due_at)
        SELECT ?, endpoint, ? FROM push_subscriptions`, key, now);
    });
    await this.schedule();
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
    const batch = this.sql.exec<PendingRecipient>(`SELECT pending.event_key, pending.endpoint, event.tag,
      sub.auth, sub.p256dh, pending.attempts
      FROM push_pending pending JOIN push_events event USING(event_key) JOIN push_subscriptions sub USING(endpoint)
      WHERE pending.due_at <= ? ORDER BY pending.due_at LIMIT 4`, now).toArray();
    await Promise.all(batch.map(async (recipient) => {
      let status: number;
      try {
        status = await send(subscriptionValue(recipient), recipient.tag, keys);
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
    await this.schedule();
  }
}

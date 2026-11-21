import { DurableObject } from 'cloudflare:workers';
import { RELAY_REGISTRY_NAME, type Env } from './config';
import { HttpError } from './http';
import { verifyImapAccount, type MailAccount, type MailConnection } from './mail-transport';

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = new Set(['local', 'localhost', 'internal', 'home', 'lan', 'onion']);
const utf8 = new TextEncoder();

type PublicAccount = {
  id: string;
  email: string;
  name: string;
};

type RecordRow = PublicAccount & { email_key: string; revision: string; credential: string };
type RecordInput = Omit<MailAccount, 'id'> & { name: string };
type ManagedAccount = PublicAccount & Pick<MailConnection, 'host' | 'mode' | 'port' | 'user'> & { managed: true };

function accountMetadata(account: PublicAccount, { host, mode, port, user }: MailConnection): ManagedAccount {
  return { id: account.id, email: account.email, name: account.name, host, mode, port, user, managed: true };
}

function requiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new HttpError(400, 'invalid_account');
  }
  return value;
}

export function managedAccountInput(input: unknown): RecordInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_account');
  const fields = input as Record<string, unknown>;
  const email = requiredText(fields.email, 254).trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@.]+$/.test(email)) throw new HttpError(400, 'invalid_account');
  const name = fields.name === undefined || fields.name === '' ? email : requiredText(fields.name, 120).trim() || email;
  const user = fields.user === undefined || fields.user === '' ? email : requiredText(fields.user, 254).trim();
  if (!user) throw new HttpError(400, 'invalid_account');
  const host = fields.host === undefined || fields.host === '' ? 'imap.gmail.com' : requiredText(fields.host, 253).trim().toLowerCase();
  const labels = host.split('.');
  const suffix = labels.at(-1) ?? '';
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label)) || !/^[a-z]/.test(suffix) || LOCAL_SUFFIXES.has(suffix)) {
    throw new HttpError(400, 'invalid_imap_host');
  }
  const mode = fields.mode ?? 'tls';
  if (mode !== 'tls' && mode !== 'starttls') throw new HttpError(400, 'invalid_imap_port');
  const port = mode === 'tls' ? 993 : 143;
  if ((fields.port !== undefined && fields.port !== port) || (host === 'imap.gmail.com' && mode !== 'tls')) {
    throw new HttpError(400, 'invalid_imap_port');
  }
  const rawPassword = requiredText(fields.password, 512);
  if (!rawPassword.trim()) throw new HttpError(400, 'invalid_account');
  const appPassword = rawPassword.replace(/ /g, '');
  const password = host === 'imap.gmail.com' && /^[a-z0-9]{16}$/i.test(appPassword) ? appPassword : rawPassword;
  return { email, name, imap: { host, mode, port, user, password } };
}

function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base64FromBytes(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

async function credentialKey(env: Env): Promise<CryptoKey> {
  const encoded = env.IMAP_ACCOUNT_ENCRYPTION_KEY;
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new HttpError(503, 'account_management_unavailable');
  }
  return crypto.subtle.importKey('raw', bytesFromBase64(encoded), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptCredential(key: CryptoKey, id: string, endpoint: MailConnection): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(id) },
    key, utf8.encode(JSON.stringify(endpoint)));
  return `${base64FromBytes(iv.buffer)}.${base64FromBytes(ciphertext)}`;
}

export async function decryptCredential(key: CryptoKey, id: string, credential: string): Promise<MailConnection> {
  const [iv, ciphertext] = credential.split('.');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytesFromBase64(iv), additionalData: utf8.encode(id),
  }, key, bytesFromBase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function registry(env: Env) {
  return env.MANAGED_ACCOUNTS?.getByName(RELAY_REGISTRY_NAME);
}

export async function listManagedAccounts(env: Env): Promise<ManagedAccount[]> {
  const accounts = registry(env);
  if (!accounts) return [];
  const records = await accounts.list();
  if (!records.length) return [];
  const key = await credentialKey(env);
  return Promise.all(records.map(async (record) => accountMetadata(record,
    await decryptCredential(key, record.id, record.credential))));
}

export async function listManagedIds(env: Env): Promise<string[]> {
  return (await registry(env)?.ids()) ?? [];
}

export async function getManagedAccount(env: Env, id: string): Promise<MailAccount | undefined> {
  const record = await registry(env)?.byId(id);
  if (!record) return;
  const key = await credentialKey(env);
  return { id: record.id, email: record.email, name: record.name, imap: await decryptCredential(key, id, record.credential) };
}

function sameMailbox(first: MailConnection, second: MailConnection): boolean {
  return first.host === second.host && first.mode === second.mode && first.port === second.port && first.user === second.user;
}

export async function registerManagedAccount(env: Env, input: RecordInput, limit: number): Promise<ManagedAccount> {
  const accounts = registry(env);
  if (!accounts) throw new HttpError(503, 'account_management_unavailable');
  const key = await credentialKey(env);
  const emailKey = input.email.toLowerCase();
  const previous = await accounts.byEmail(emailKey);
  if (!previous && await accounts.count() >= limit) throw new HttpError(409, 'account_limit');
  if (previous && !sameMailbox(await decryptCredential(key, previous.id, previous.credential), input.imap)) {
    throw new HttpError(409, 'account_identity_changed');
  }
  const id = previous?.id ?? `managed_${crypto.randomUUID()}`;
  await verifyImapAccount({ ...input, id });
  const record = {
    id, email: input.email, email_key: emailKey, name: input.name, revision: crypto.randomUUID(),
    credential: await encryptCredential(key, id, input.imap),
  };
  const result = await accounts.save(record, previous?.revision ?? null, limit);
  if (result === 'limit') throw new HttpError(409, 'account_limit');
  if (result === 'stale') throw new HttpError(409, 'account_changed');
  return accountMetadata(record, input.imap);
}

export async function removeManagedAccount(env: Env, id: string): Promise<boolean> {
  return (await registry(env)?.remove(id)) ?? false;
}

export class ManagedAccounts extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS managed_imap_accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, revision TEXT NOT NULL, credential TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_session_nonces (
        nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
      );
    `);
  }

  list(): RecordRow[] {
    return this.sql.exec<RecordRow>('SELECT * FROM managed_imap_accounts ORDER BY email_key').toArray();
  }

  ids(): string[] {
    return this.sql.exec<{ id: string }>('SELECT id FROM managed_imap_accounts').toArray().map(({ id }) => id);
  }

  count(): number {
    return this.sql.exec<{ total: number }>('SELECT count(*) AS total FROM managed_imap_accounts').one().total;
  }

  byId(id: string): RecordRow | null {
    return this.sql.exec<RecordRow>('SELECT * FROM managed_imap_accounts WHERE id = ?', id).toArray()[0] ?? null;
  }

  byEmail(email: string): RecordRow | null {
    return this.sql.exec<RecordRow>('SELECT * FROM managed_imap_accounts WHERE email_key = ?', email).toArray()[0] ?? null;
  }

  save(record: RecordRow, previousRevision: string | null, limit: number): 'saved' | 'stale' | 'limit' {
    return this.ctx.storage.transactionSync(() => {
      const current = this.byEmail(record.email_key);
      if ((current?.revision ?? null) !== previousRevision) return 'stale';
      if (!current && this.count() >= limit) return 'limit';
      this.sql.exec(`
        INSERT INTO managed_imap_accounts (id, email, email_key, name, revision, credential)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (email_key) DO UPDATE SET email = excluded.email, name = excluded.name,
          revision = excluded.revision, credential = excluded.credential
      `, record.id, record.email, record.email_key, record.name, record.revision, record.credential);
      return 'saved';
    });
  }

  remove(id: string): boolean {
    return this.sql.exec('DELETE FROM managed_imap_accounts WHERE id = ?', id).rowsWritten > 0;
  }

  consumeSessionNonce(nonce: string, expiresAt: number): boolean {
    const now = Date.now();
    if (expiresAt <= now) return false;
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM relay_session_nonces WHERE expires_at <= ?', now);
      return this.sql.exec('INSERT OR IGNORE INTO relay_session_nonces VALUES (?, ?)', nonce, expiresAt).rowsWritten > 0;
    });
  }
}

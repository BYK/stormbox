import { DurableObject } from 'cloudflare:workers';
import { RELAY_REGISTRY_NAME, type Env } from './config';
import { googleOAuthConfiguration, GoogleOAuthError, refreshGoogleAccess, type GoogleIdentity } from './google-auth';
import { HttpError } from './http';
import { verifyImapAccount, type ImapConnection, type MailAccount, type MailConnection } from './mail-transport';

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = new Set(['local', 'localhost', 'internal', 'home', 'lan', 'onion']);
const utf8 = new TextEncoder();

type PublicAccount = {
  id: string;
  email: string;
  name: string;
};

type RecordRow = PublicAccount & { email_key: string; revision: string; credential: string };
type RecordInput = Omit<PublicAccount, 'id'> & { imap: MailConnection };
type GoogleConnection = Omit<MailConnection, 'password'> & {
  auth: 'google-oauth';
  refreshToken: string;
  subject: string;
  clientId: string;
};
type StoredConnection = MailConnection | GoogleConnection;
type ManagedAccount = PublicAccount & Pick<MailConnection, 'host' | 'mode' | 'port' | 'user'> & { managed: true; auth?: 'google-oauth' };
type ResolvedAccount = { account: MailAccount } | { error: 'google_reconnect_required' | 'mail_unavailable' };
type TokenResult = { token: string } | Extract<ResolvedAccount, { error: string }>;

export type GoogleOAuthFlow = {
  state: string;
  browser_hash: string;
  verifier: string;
  client_id: string;
  account_id: string | null;
  revision: string | null;
  expires_at: number;
};

const MAX_GOOGLE_FLOWS = 32;
const GOOGLE_TOKEN_CACHE_MS = 50 * 60_000;
const GOOGLE_TOKEN_MARGIN_MS = 30_000;

function accountMetadata(account: PublicAccount, endpoint: StoredConnection): ManagedAccount {
  const { host, mode, port, user } = endpoint;
  return { id: account.id, email: account.email, name: account.name, host, mode, port, user, managed: true,
    ...('auth' in endpoint ? { auth: endpoint.auth } : {}) };
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

export async function encryptCredential(key: CryptoKey, id: string, endpoint: StoredConnection): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(id) },
    key, utf8.encode(JSON.stringify(endpoint)));
  return `${base64FromBytes(iv.buffer)}.${base64FromBytes(ciphertext)}`;
}

export async function decryptCredential(key: CryptoKey, id: string, credential: string): Promise<StoredConnection> {
  const [iv, ciphertext] = credential.split('.');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytesFromBase64(iv), additionalData: utf8.encode(id),
  }, key, bytesFromBase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function managedRegistry(env: Env) {
  return env.MANAGED_ACCOUNTS?.getByName(RELAY_REGISTRY_NAME);
}

export async function listManagedAccounts(env: Env): Promise<ManagedAccount[]> {
  const accounts = managedRegistry(env);
  if (!accounts) return [];
  const records = await accounts.list();
  if (!records.length) return [];
  const key = await credentialKey(env);
  return Promise.all(records.map(async (record) => accountMetadata(record,
    await decryptCredential(key, record.id, record.credential))));
}

export async function listManagedIds(env: Env): Promise<string[]> {
  return (await managedRegistry(env)?.ids()) ?? [];
}

export async function getManagedAccount(env: Env, id: string): Promise<MailAccount | undefined> {
  const result = await managedRegistry(env)?.resolve(id);
  if (!result) return;
  if ('error' in result) throw new HttpError(result.error === 'google_reconnect_required' ? 422 : 502, result.error);
  return result.account;
}

function sameMailbox(first: StoredConnection, second: StoredConnection): boolean {
  return first.host === second.host && first.mode === second.mode && first.port === second.port && first.user === second.user;
}

type Registry = NonNullable<ReturnType<typeof managedRegistry>>;

async function saveManagedAccount(accounts: Registry, key: CryptoKey, input: PublicAccount, imap: StoredConnection,
  revision: string | null, limit: number, googleFlowState?: string): Promise<ManagedAccount> {
  const record = {
    ...input, email_key: input.email.toLowerCase(), revision: crypto.randomUUID(),
    credential: await encryptCredential(key, input.id, imap),
  };
  const result = await accounts.save(record, revision, limit, googleFlowState);
  if (result === 'limit') throw new HttpError(409, 'account_limit');
  if (result === 'stale') throw new HttpError(409, 'account_changed');
  return accountMetadata(record, imap);
}

export async function registerManagedAccount(env: Env, input: RecordInput, limit: number): Promise<ManagedAccount> {
  const accounts = managedRegistry(env);
  if (!accounts) throw new HttpError(503, 'account_management_unavailable');
  const key = await credentialKey(env);
  const emailKey = input.email.toLowerCase();
  const previous = await accounts.byEmail(emailKey);
  if (!previous && await accounts.count() >= limit) throw new HttpError(409, 'account_limit');
  if (previous) {
    const endpoint = await decryptCredential(key, previous.id, previous.credential);
    if ('auth' in endpoint || !sameMailbox(endpoint, input.imap)) throw new HttpError(409, 'account_identity_changed');
  }
  const id = previous?.id ?? `managed_${crypto.randomUUID()}`;
  await verifyImapAccount({ ...input, id });
  return saveManagedAccount(accounts, key, { id, email: input.email, name: input.name }, input.imap, previous?.revision ?? null, limit);
}

async function googleReconnectTarget(env: Env, accountId: string) {
  const record = await managedRegistry(env)?.byId(accountId);
  if (!record) throw new HttpError(404, 'account_not_found');
  const endpoint = await decryptCredential(await credentialKey(env), record.id, record.credential);
  if (endpoint.host !== 'imap.gmail.com' || endpoint.mode !== 'tls' || endpoint.port !== 993
    || endpoint.user.toLowerCase() !== record.email_key) throw new HttpError(409, 'account_identity_changed');
  return { record, endpoint };
}

export async function googleReconnectInfo(env: Env, accountId: string) {
  const { record } = await googleReconnectTarget(env, accountId);
  return { email: record.email, revision: record.revision };
}

export async function registerManagedGoogleAccount(
  env: Env, identity: GoogleIdentity, flow: GoogleOAuthFlow, refreshToken: string, accessToken: string, limit: number,
): Promise<ManagedAccount> {
  const accounts = managedRegistry(env);
  if (!accounts) throw new HttpError(503, 'account_management_unavailable');
  const { email, subject } = identity;
  const emailKey = email.toLowerCase();
  const key = await credentialKey(env);
  let account: PublicAccount = { id: `managed_${crypto.randomUUID()}`, email, name: email };
  if (flow.account_id) {
    const { endpoint, record } = await googleReconnectTarget(env, flow.account_id);
    if (record.revision !== flow.revision || record.email_key !== emailKey
      || ('auth' in endpoint && endpoint.subject !== subject)) throw new HttpError(409, 'google_account_mismatch');
    account = { id: record.id, name: record.name, email: record.email };
  } else {
    if (await accounts.byEmail(emailKey)) throw new HttpError(409, 'google_account_mismatch');
    if (await accounts.count() >= limit) throw new HttpError(409, 'account_limit');
  }
  const connection = { host: 'imap.gmail.com', mode: 'tls' as const, port: 993, user: email };
  await verifyImapAccount({ ...account, imap: { ...connection, accessToken } });
  return saveManagedAccount(accounts, key, account,
    { ...connection, auth: 'google-oauth', refreshToken, subject, clientId: flow.client_id }, flow.revision, limit, flow.state);
}

export async function removeManagedAccount(env: Env, id: string): Promise<boolean> {
  return (await managedRegistry(env)?.remove(id)) ?? false;
}

export class ManagedAccounts extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly accessTokens = new Map<string, { revision: string; until: number; result: TokenResult }>();
  private readonly refreshingTokens = new Map<string, Promise<TokenResult>>();

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
      CREATE TABLE IF NOT EXISTS google_oauth_flows (
        state TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL, client_id TEXT NOT NULL,
        account_id TEXT, revision TEXT, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
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

  save(record: RecordRow, previousRevision: string | null, limit: number, googleFlowState?: string): 'saved' | 'stale' | 'limit' {
    return this.ctx.storage.transactionSync(() => {
      const current = this.byEmail(record.email_key);
      if ((current?.revision ?? null) !== previousRevision) return 'stale';
      if (!current && this.count() >= limit) return 'limit';
      if (googleFlowState && !this.sql.exec(
        'DELETE FROM google_oauth_flows WHERE state = ? AND consumed = 1 AND expires_at > ?',
        googleFlowState, Date.now(),
      ).rowsWritten) return 'stale';
      this.sql.exec(`
        INSERT INTO managed_imap_accounts (id, email, email_key, name, revision, credential)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (email_key) DO UPDATE SET email = excluded.email, name = excluded.name,
          revision = excluded.revision, credential = excluded.credential
      `, record.id, record.email, record.email_key, record.name, record.revision, record.credential);
      this.accessTokens.delete(record.id);
      return 'saved';
    });
  }

  remove(id: string): boolean {
    this.accessTokens.delete(id);
    return this.sql.exec('DELETE FROM managed_imap_accounts WHERE id = ?', id).rowsWritten > 0;
  }

  async resolve(id: string): Promise<ResolvedAccount | null> {
    const record = this.byId(id);
    if (!record) return null;
    const endpoint = await decryptCredential(await credentialKey(this.env), id, record.credential);
    let imap: ImapConnection;
    if ('auth' in endpoint) {
      const result = await this.getGoogleToken(record, endpoint);
      if ('error' in result) return result;
      const { host, mode, port, user } = endpoint;
      imap = { host, mode, port, user, accessToken: result.token };
    } else {
      imap = endpoint;
    }
    // Credential replacement or removal can finish while Google is refreshing.
    const current = this.byId(id);
    if (!current) return null;
    if (current.revision !== record.revision) return { error: 'mail_unavailable' };
    return { account: { id, email: record.email, name: record.name, imap } };
  }

  private async getGoogleToken(record: RecordRow, endpoint: GoogleConnection): Promise<TokenResult> {
    const cached = this.accessTokens.get(record.id);
    if (cached && cached.revision === record.revision && cached.until > Date.now()) return cached.result;
    const config = googleOAuthConfiguration(this.env);
    if (!config || config.clientId !== endpoint.clientId) return { error: 'google_reconnect_required' };

    const key = `${record.id}:${record.revision}`;
    const pending = this.refreshingTokens.get(key);
    if (pending) return pending;
    const refreshing = this.refreshGoogleToken(record, endpoint, config);
    this.refreshingTokens.set(key, refreshing);
    try {
      return await refreshing;
    } finally {
      this.refreshingTokens.delete(key);
    }
  }

  private async refreshGoogleToken(record: RecordRow, endpoint: GoogleConnection,
    config: NonNullable<ReturnType<typeof googleOAuthConfiguration>>): Promise<TokenResult> {
    let result: TokenResult;
    let until: number;
    try {
      const grant = await refreshGoogleAccess(config, endpoint.refreshToken);
      if (grant.refreshToken && grant.refreshToken !== endpoint.refreshToken) {
        const credential = await encryptCredential(await credentialKey(this.env), record.id, { ...endpoint, refreshToken: grant.refreshToken });
        this.sql.exec('UPDATE managed_imap_accounts SET credential = ? WHERE id = ? AND revision = ?', credential, record.id, record.revision);
      }
      result = { token: grant.accessToken };
      until = Math.min(grant.expiresAt - GOOGLE_TOKEN_MARGIN_MS, Date.now() + GOOGLE_TOKEN_CACHE_MS);
    } catch (error) {
      const reconnect = error instanceof GoogleOAuthError && (error.code === 'blocked' || error.code === 'reconnect_required');
      result = { error: reconnect ? 'google_reconnect_required' : 'mail_unavailable' };
      until = Date.now() + (reconnect ? 60_000 : 15_000);
    }
    if (this.byId(record.id)?.revision === record.revision) this.accessTokens.set(record.id, { revision: record.revision, until, result });
    return result;
  }

  async storeGoogleFlow(flow: GoogleOAuthFlow, priorBrowserHash?: string): Promise<boolean> {
    const saved = this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM google_oauth_flows WHERE expires_at <= ?', Date.now());
      if (priorBrowserHash) this.sql.exec('DELETE FROM google_oauth_flows WHERE browser_hash = ?', priorBrowserHash);
      if (this.sql.exec<{ total: number }>('SELECT count(*) AS total FROM google_oauth_flows').one().total >= MAX_GOOGLE_FLOWS) return false;
      this.sql.exec(`
        INSERT INTO google_oauth_flows (state, browser_hash, verifier, client_id, account_id, revision, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, flow.state, flow.browser_hash, flow.verifier, flow.client_id, flow.account_id, flow.revision, flow.expires_at);
      return true;
    });
    if (saved) await this.scheduleGoogleCleanup();
    return saved;
  }

  consumeGoogleFlow(state: string, browserHash: string): GoogleOAuthFlow | null {
    return this.sql.exec<GoogleOAuthFlow>(`
      UPDATE google_oauth_flows SET consumed = 1
      WHERE state = ? AND browser_hash = ? AND expires_at > ? AND consumed = 0
      RETURNING state, browser_hash, verifier, client_id, account_id, revision, expires_at
    `, state, browserHash, Date.now()).toArray()[0] ?? null;
  }

  completeGoogleFlow(state: string): void {
    this.sql.exec('DELETE FROM google_oauth_flows WHERE state = ?', state);
  }

  async cancelGoogleFlow(browserHash: string): Promise<void> {
    this.sql.exec('DELETE FROM google_oauth_flows WHERE browser_hash = ?', browserHash);
    await this.scheduleGoogleCleanup();
  }

  async alarm(): Promise<void> {
    this.sql.exec('DELETE FROM google_oauth_flows WHERE expires_at <= ?', Date.now());
    await this.scheduleGoogleCleanup();
  }

  private async scheduleGoogleCleanup(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    const { next } = this.sql.exec<{ next: number | null }>('SELECT min(expires_at) AS next FROM google_oauth_flows').one();
    if (next === null) {
      if (existing !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (existing === null || existing > next) await this.ctx.storage.setAlarm(next);
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

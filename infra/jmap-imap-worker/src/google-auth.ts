import type { Env } from './config';

export const GOOGLE_START_PATH = '/api/imap/v1/oauth/google/start';
export const GOOGLE_CALLBACK_PATH = '/api/imap/v1/oauth/google/callback';
export const GOOGLE_MAIL_SCOPE = 'https://mail.google.com/';
const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const utf8 = new TextEncoder();

interface GoogleConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleIdentity {
  email: string;
  subject: string;
}

export interface GoogleTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

export class GoogleOAuthError extends Error {
  constructor(readonly code: 'blocked' | 'failed' | 'reconnect_required') { super(code); }
}

export function googleOAuthConfiguration(env: Env): GoogleConfiguration | undefined {
  const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, PUBLIC_ORIGIN: origin } = env;
  if (!env.MANAGED_ACCOUNTS || !/^[A-Za-z0-9+/]{43}=$/.test(env.IMAP_ACCOUNT_ENCRYPTION_KEY ?? '')
    || !clientId || !/^[a-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret || !URL.canParse(origin)) return;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) return;
  return { clientId, clientSecret, redirectUri: new URL(GOOGLE_CALLBACK_PATH, origin).href };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function googleOAuthRandom(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function googleOAuthDigest(input: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(input))));
}

export async function googleAuthorizationUrl(config: GoogleConfiguration, state: string, verifier: string, email?: string) {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: `openid email ${GOOGLE_MAIL_SCOPE}`,
    access_type: 'offline',
    prompt: 'select_account consent',
    state,
    code_challenge: await googleOAuthDigest(verifier),
    code_challenge_method: 'S256',
    ...(email ? { login_hint: email } : {}),
  }).toString();
  return url.href;
}

export function googleOAuthBlocked(code: unknown): boolean {
  return code === 'admin_policy_enforced' || code === 'org_internal' || code === 'restricted_client';
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

async function requestGoogleTokens(config: GoogleConfiguration, grant: Record<string, string>): Promise<GoogleTokens> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...grant }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new GoogleOAuthError('failed');
  }
  const claimed: Record<string, unknown> = await response.json();
  if (!response.ok) {
    if (googleOAuthBlocked(claimed?.error) || googleOAuthBlocked(claimed?.error_subtype)) throw new GoogleOAuthError('blocked');
    if (claimed?.error === 'invalid_grant' && grant.grant_type === 'refresh_token') throw new GoogleOAuthError('reconnect_required');
    throw new GoogleOAuthError('failed');
  }
  const { access_token: accessToken, refresh_token: refreshToken, token_type: type, expires_in: lifetime, scope } = claimed ?? {};
  if (!safeToken(accessToken) || typeof type !== 'string' || type.toLowerCase() !== 'bearer'
    || typeof lifetime !== 'number' || !Number.isSafeInteger(lifetime) || lifetime <= 0
    || (refreshToken !== undefined && !safeToken(refreshToken))) throw new GoogleOAuthError('failed');
  if ((scope !== undefined || grant.grant_type === 'authorization_code')
    && (typeof scope !== 'string' || !scope.split(/\s+/).includes(GOOGLE_MAIL_SCOPE))) throw new GoogleOAuthError('blocked');
  return { accessToken, expiresAt: Date.now() + Math.min(lifetime, 3600) * 1000, refreshToken };
}

export function exchangeGoogleCode(config: GoogleConfiguration, code: string, verifier: string): Promise<GoogleTokens> {
  return requestGoogleTokens(config, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: config.redirectUri,
  });
}

export function refreshGoogleAccess(config: GoogleConfiguration, refreshToken: string): Promise<GoogleTokens> {
  return requestGoogleTokens(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

export async function fetchGoogleIdentity(accessToken: string): Promise<GoogleIdentity> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new GoogleOAuthError('failed');
  }
  const user: Record<string, unknown> = await response.json();
  if (!user || typeof user.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(user.sub) || user.email_verified !== true
    || typeof user.email !== 'string' || user.email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@.]+$/.test(user.email)) {
    throw new GoogleOAuthError('failed');
  }
  return { subject: user.sub, email: user.email };
}

import type { Env } from './config';
import {
  exchangeGoogleCode, fetchGoogleIdentity, googleAuthorizationUrl, googleOAuthBlocked, googleOAuthConfiguration,
  googleOAuthDigest, GoogleOAuthError, googleOAuthRandom,
} from './google-auth';
import { HttpError, json, readJson } from './http';
import { googleReconnectInfo, managedRegistry, registerManagedGoogleAccount } from './managed-accounts';
import type { MailAccount } from './mail-transport';
import { hasPushSubscribers } from './push';

const FLOW_COOKIE = '__Host-stormbox_google_imap';
const FLOW_SECONDS = 10 * 60;
const RANDOM_VALUE = /^[A-Za-z0-9_-]{43}$/;
type Outcome = 'connected' | 'cancelled' | 'blocked' | 'account_mismatch' | 'failed';

function flowCookie(value = ''): string {
  return `${FLOW_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? FLOW_SECONDS : 0}`;
}

function browserBinding(request: Request): string | undefined {
  const matches = (request.headers.get('Cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${FLOW_COOKIE}=`));
  const value = matches.length === 1 ? matches[0].slice(FLOW_COOKIE.length + 1) : '';
  return RANDOM_VALUE.test(value) ? value : undefined;
}

function redirectOutcome(outcome: Outcome, clearCookie = true): Response {
  return json(null, 303, {
    Location: `/?view=attention&google_imap=${outcome}`,
    'Referrer-Policy': 'no-referrer',
    ...(clearCookie ? { 'Set-Cookie': flowCookie() } : {}),
  });
}

export async function cancelGoogleLink(request: Request, env: Env, headers: Headers): Promise<void> {
  const binding = browserBinding(request);
  if (!binding) return;
  headers.append('Set-Cookie', flowCookie());
  await managedRegistry(env)?.cancelGoogleFlow(await googleOAuthDigest(binding));
}

export async function startGoogleLink(request: Request, env: Env): Promise<Response> {
  const config = googleOAuthConfiguration(env);
  const store = managedRegistry(env);
  if (!config || !store) throw new HttpError(404, 'not_found');
  const input: unknown = await readJson(request, 1024);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_account');
  const accountId = (input as { accountId?: unknown }).accountId;
  if (accountId !== undefined && (typeof accountId !== 'string' || !/^managed_[A-Za-z0-9_-]{1,56}$/.test(accountId))) {
    throw new HttpError(400, 'invalid_account');
  }
  const target = accountId ? await googleReconnectInfo(env, accountId) : undefined;
  const binding = googleOAuthRandom();
  const state = googleOAuthRandom();
  const verifier = googleOAuthRandom();
  const priorBinding = browserBinding(request);
  const saved = await store.storeGoogleFlow({
    state, browser_hash: await googleOAuthDigest(binding), verifier, client_id: config.clientId,
    account_id: accountId ?? null, revision: target?.revision ?? null, expires_at: Date.now() + FLOW_SECONDS * 1000,
  }, priorBinding ? await googleOAuthDigest(priorBinding) : undefined);
  if (!saved) throw new HttpError(429, 'google_oauth_busy');
  return json({ url: await googleAuthorizationUrl(config, state, verifier, target?.email) },
    200, { 'Set-Cookie': flowCookie(binding) });
}

export async function finishGoogleLink(request: Request, url: URL, env: Env, configured: MailAccount[], limit: number): Promise<Response> {
  const config = googleOAuthConfiguration(env);
  const store = managedRegistry(env);
  if (!config || !store || url.origin !== env.PUBLIC_ORIGIN) throw new HttpError(404, 'not_found');
  const [state] = url.searchParams.getAll('state');
  const binding = browserBinding(request);
  if (!binding || !state || !RANDOM_VALUE.test(state) || url.searchParams.getAll('state').length !== 1) {
    return redirectOutcome('failed', false);
  }
  const flow = await store.consumeGoogleFlow(state, await googleOAuthDigest(binding));
  if (!flow) return redirectOutcome('failed', false);

  try {
    if (flow.client_id !== config.clientId) return redirectOutcome('failed');
    const error = url.searchParams.get('error');
    if (googleOAuthBlocked(error) || googleOAuthBlocked(url.searchParams.get('error_subtype'))) return redirectOutcome('blocked');
    if (error === 'access_denied') return redirectOutcome('cancelled');
    const codes = url.searchParams.getAll('code');
    const [code] = codes;
    if (error || !code || !/^[\x21-\x7e]{1,2048}$/.test(code) || codes.length !== 1) return redirectOutcome('failed');
    const tokens = await exchangeGoogleCode(config, code, flow.verifier);
    if (!tokens.refreshToken) return redirectOutcome('failed');
    const identity = await fetchGoogleIdentity(tokens.accessToken);
    if (configured.some(({ email }) => email.toLowerCase() === identity.email.toLowerCase())) return redirectOutcome('account_mismatch');
    const account = await registerManagedGoogleAccount(env, identity, flow, tokens.refreshToken, tokens.accessToken, limit);
    if (await hasPushSubscribers(env).catch(() => false)) {
      await env.MAILBOXES.getByName(account.id).watch(60).catch(() => {});
    }
    return redirectOutcome('connected');
  } catch (cause) {
    if (cause instanceof GoogleOAuthError && cause.code === 'blocked') return redirectOutcome('blocked');
    if (cause instanceof HttpError && cause.code === 'google_account_mismatch') return redirectOutcome('account_mismatch');
    return redirectOutcome('failed');
  } finally {
    await store.completeGoogleFlow(state).catch(() => {});
  }
}

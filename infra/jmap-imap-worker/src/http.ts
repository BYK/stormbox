import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { accessToken, RELAY_REGISTRY_NAME, type Env } from './config';

const COOKIE = 'stormbox_relay';
const SESSION_SECONDS = 12 * 60 * 60;
const BRIDGE_SESSION_SECONDS = 30 * 60;
const ASSERTION_MAX_MS = 60_000;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  const output = new Headers(headers);
  output.set('Cache-Control', 'no-store');
  output.set('X-Content-Type-Options', 'nosniff');
  return data === null ? new Response(null, { status, headers: output })
    : Response.json(data, { status, headers: output });
}

export async function readJson(request: Request, maximum = 131_072): Promise<any> {
  const length = request.headers.get('Content-Length');
  if ((length !== null && Number(length) > maximum) || !request.body) throw new HttpError(413, 'request_too_large');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel();
        throw new HttpError(413, 'request_too_large');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json');
  }
}

export function matchesToken(candidate: unknown, expected: string | null): boolean {
  if (typeof candidate !== 'string' || !expected) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(candidate), hash(expected));
}

function signature(expiration: string | number, secret: string): string {
  return createHmac('sha256', secret).update(`${COOKIE}:${expiration}`).digest('base64url');
}

export async function consumeSessionAssertion(value: unknown, env: Env): Promise<boolean> {
  const key = env.RELAY_SESSION_KEY;
  if (typeof value !== 'string' || !key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || !env.MANAGED_ACCOUNTS) return false;
  const proof = /^v1\.(\d{13})\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([a-f0-9]{64})$/.exec(value);
  if (!proof) return false;
  const [, expiry, nonce, digest] = proof;
  const expiresAt = Number(expiry);
  const now = Date.now();
  if (expiresAt <= now || expiresAt > now + ASSERTION_MAX_MS) return false;
  const expected = createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`stormbox-imap-relay:v1.${expiry}.${nonce}`).digest();
  if (!timingSafeEqual(Buffer.from(digest, 'hex'), expected)) return false;
  return env.MANAGED_ACCOUNTS.getByName(RELAY_REGISTRY_NAME).consumeSessionNonce(nonce, expiresAt);
}

export function sessionCookie(env: Env, active: boolean): string {
  const secret = env.RELAY_SESSION_KEY || accessToken(env);
  if (active && !secret) throw new HttpError(503, 'gateway_not_configured');
  const seconds = active ? (env.RELAY_SESSION_KEY ? BRIDGE_SESSION_SECONDS : SESSION_SECONDS) : 0;
  const expires = Date.now() + seconds * 1000;
  const value = active ? `${expires}.${signature(expires, secret!)}` : '';
  const secure = env.PUBLIC_ORIGIN.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
}

export function authorization(request: Request, env: Env, allowPairing = false): boolean {
  const secret = accessToken(env);
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (bearer && matchesToken(bearer[1], secret)) return true;
  return allowPairing && pairedAuthorization(request, env);
}

export function pairedAuthorization(request: Request, env: Env): boolean {
  const secret = env.RELAY_SESSION_KEY || accessToken(env);
  if (!secret || (request.method !== 'GET' && request.headers.get('Origin') !== env.PUBLIC_ORIGIN)) return false;
  const cookies = (request.headers.get('Cookie') ?? '').split(/;\s*/).filter((item) => item.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return false;
  const match = /^\d{13}\.[A-Za-z0-9_-]{43}$/.test(cookies[0].slice(COOKIE.length + 1))
    ? cookies[0].slice(COOKIE.length + 1).split('.') : [];
  return Number(match[0]) > Date.now() && matchesToken(match[1], signature(match[0], secret));
}

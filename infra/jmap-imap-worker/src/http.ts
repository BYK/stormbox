import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { accessToken, type Env } from './config';

const COOKIE = 'stormbox_relay';
const SESSION_SECONDS = 12 * 60 * 60;

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

export function sessionCookie(env: Env, active: boolean): string {
  const secret = accessToken(env);
  if (active && !secret) throw new HttpError(503, 'gateway_not_configured');
  const seconds = active ? SESSION_SECONDS : 0;
  const expires = Date.now() + seconds * 1000;
  const value = active ? `${expires}.${signature(expires, secret!)}` : '';
  const secure = env.PUBLIC_ORIGIN.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
}

export function authorization(request: Request, env: Env, allowPairing = false): boolean {
  const secret = accessToken(env);
  if (!secret) return false;
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (bearer && matchesToken(bearer[1], secret)) return true;
  return allowPairing && pairedAuthorization(request, env);
}

export function pairedAuthorization(request: Request, env: Env): boolean {
  const secret = accessToken(env);
  if (!secret || (request.method !== 'GET' && request.headers.get('Origin') !== env.PUBLIC_ORIGIN)) return false;
  const cookies = (request.headers.get('Cookie') ?? '').split(/;\s*/).filter((item) => item.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return false;
  const match = /^\d{13}\.[A-Za-z0-9_-]{43}$/.test(cookies[0].slice(COOKIE.length + 1))
    ? cookies[0].slice(COOKIE.length + 1).split('.') : [];
  return Number(match[0]) > Date.now() && matchesToken(match[1], signature(match[0], secret));
}

import { BYK_ROUTE, type Route } from './routes';

export const BROWSER_SESSION_PATH = '/jmap/browser-session';
export const BROWSER_SESSION_HEADER = 'X-Stormbox-Session';

const COOKIE_NAME = '__Host-stormbox-jmap';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const NONCE_BYTES = 12;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const ADDITIONAL_DATA = ENCODER.encode('stormbox-byk-browser-session-v1');
const BASIC_AUTH = /^Basic [A-Za-z0-9+/]{4,2040}={0,2}$/;

export function allowsBrowserSession(route: Route, origin: string | null): boolean {
  return route === BYK_ROUTE && origin === 'https://webmail.byk.im';
}

async function importKey(secret: string | undefined): Promise<CryptoKey | null> {
  try {
    if (!secret) return null;
    const bytes = Uint8Array.from(atob(secret), char => char.charCodeAt(0));
    return bytes.length === 32 ? await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
  } catch {
    return null;
  }
}

function encodeCookie(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCookie(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

function cookieValue(request: Request): string | undefined {
  return request.headers.get('cookie')?.split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
}

export async function readBrowserSession(
  request: Request, route: Route, secret: string | undefined,
): Promise<string | null> {
  if (!allowsBrowserSession(route, request.headers.get('origin')) || new URL(request.url).protocol !== 'https:') return null;

  const value = cookieValue(request);
  if (!value || !/^[A-Za-z0-9_-]{39,3500}$/.test(value)) return null;

  const key = await importKey(secret);
  if (!key) return null;
  try {
    const bytes = decodeCookie(value);
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.slice(0, NONCE_BYTES), additionalData: ADDITIONAL_DATA,
    }, key, bytes.slice(NONCE_BYTES));
    const { exp, authorization } = JSON.parse(DECODER.decode(decrypted));
    return Number.isSafeInteger(exp) && exp > Date.now() && typeof authorization === 'string' &&
      BASIC_AUTH.test(authorization) ? authorization : null;
  } catch {
    return null;
  }
}

export async function handleBrowserSession(
  request: Request, route: Route, secret: string | undefined, headers: Headers,
): Promise<Response> {
  headers.set('Cache-Control', 'no-store');
  if (!allowsBrowserSession(route, request.headers.get('origin')) || new URL(request.url).protocol !== 'https:') {
    return new Response(null, { status: 403, headers });
  }

  if (request.method === 'DELETE') {
    headers.set('Set-Cookie', `${COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    headers.set('Allow', 'POST, DELETE, OPTIONS');
    return new Response(null, { status: 405, headers });
  }

  const authorization = request.headers.get('authorization');
  if (!authorization || !BASIC_AUTH.test(authorization)) {
    return new Response(null, { status: 401, headers });
  }
  const key = await importKey(secret);
  if (!key) return new Response(null, { status: 503, headers });

  // The upstream may return a public session without an authenticated account.
  // Require an actual mail account before minting a cookie.
  try {
    const upstream = await fetch(new URL('/jmap/session', route.upstream), {
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'manual',
    });
    if (!upstream.ok) {
      return new Response(null, { status: upstream.status >= 500 ? 502 : 401, headers });
    }
    const session = await upstream.json() as {
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, unknown>;
    };
    const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!accountId || !session.accounts || !Object.hasOwn(session.accounts, accountId)) {
      return new Response(null, { status: 401, headers });
    }
  } catch {
    return new Response(null, { status: 502, headers });
  }

  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const payload = ENCODER.encode(JSON.stringify({ exp: Date.now() + MAX_AGE_SECONDS * 1000, authorization }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ADDITIONAL_DATA }, key, payload));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  headers.set('Set-Cookie', `${COOKIE_NAME}=${encodeCookie(combined)}; ${COOKIE_ATTRIBUTES}; Max-Age=${MAX_AGE_SECONDS}`);
  return new Response(null, { status: 204, headers });
}

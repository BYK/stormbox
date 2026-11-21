import { allowsBrowserSession, readBrowserSession, validatePrimaryMailSession } from './browser-session';
import type { Route } from './routes';

export const RELAY_SESSION_PATH = '/jmap/relay-session';
const ASSERTION_TTL_MS = 45_000;
const ASSERTION_SCOPE = 'stormbox-imap-relay:';

export interface RelaySessionConfig {
  RELAY_SESSION_KEY?: string;
  RELAY_OWNER_EMAIL?: string;
}

async function signingKey(secret: string | undefined): Promise<CryptoKey | null> {
  try {
    if (!secret) return null;
    const bytes = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0));
    return bytes.length === 32
      ? await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      : null;
  } catch {
    return null;
  }
}

function loginFor(authorization: string) {
  const basic = new TextDecoder().decode(Uint8Array.from(atob(authorization.slice(6)), (char) => char.charCodeAt(0)));
  return basic.slice(0, basic.indexOf(':')).trim().toLowerCase();
}

export async function handleRelaySession(
  request: Request,
  route: Route,
  browserSessionKey: string | undefined,
  config: RelaySessionConfig | undefined,
  headers: Headers,
): Promise<Response> {
  headers.set('Cache-Control', 'no-store');
  if (!allowsBrowserSession(route, request.headers.get('Origin')) || new URL(request.url).protocol !== 'https:') {
    return new Response(null, { status: 403, headers });
  }
  if (request.method !== 'POST') {
    headers.set('Allow', 'POST, OPTIONS');
    return new Response(null, { status: 405, headers });
  }
  const owner = config?.RELAY_OWNER_EMAIL?.trim().toLowerCase();
  const key = await signingKey(config?.RELAY_SESSION_KEY);
  if (!owner || !key) return new Response(null, { status: 503, headers });

  const authorization = await readBrowserSession(request, route, browserSessionKey);
  if (!authorization) return new Response(null, { status: 401, headers });
  if (loginFor(authorization) !== owner) return new Response(null, { status: 403, headers });
  const upstreamStatus = await validatePrimaryMailSession(route, authorization);
  if (upstreamStatus !== 200) return new Response(null, { status: upstreamStatus, headers });

  const payload = `v1.${Date.now() + ASSERTION_TTL_MS}.${crypto.randomUUID()}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(ASSERTION_SCOPE + payload),
  ));
  const digest = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return Response.json({ assertion: `${payload}.${digest}` }, { headers });
}

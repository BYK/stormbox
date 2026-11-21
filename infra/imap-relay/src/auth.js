import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'stormbox_relay';
const SESSION_SECONDS = 12 * 60 * 60;

function sameSecret(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(candidate), hash(expected));
}

function signature(expiration, secret) {
  return createHmac('sha256', secret).update(`${COOKIE}:${expiration}`).digest('base64url');
}

export function matchesAccessToken(candidate, config) {
  return sameSecret(candidate, config.accessToken);
}

export function sameOrigin(request, config) {
  return request.headers.origin === config.publicOrigin;
}

export function sessionCookie(config, active) {
  const maxAge = active ? SESSION_SECONDS : 0;
  const expiration = Date.now() + maxAge * 1000;
  const value = active ? `${expiration}.${signature(expiration, config.accessToken)}` : '';
  const secure = config.publicOrigin.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function requestAuthorized(request, config) {
  const bearer = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : null;
  if (matchesAccessToken(bearer, config)) return true;

  if (request.method !== 'GET' && !sameOrigin(request, config)) return false;
  const cookie = request.headers.cookie?.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  const match = cookie?.slice(COOKIE.length + 1).match(/^(\d{13})\.([a-zA-Z0-9_-]{43})$/);
  return Boolean(match && Number(match[1]) > Date.now() && sameSecret(match[2], signature(match[1], config.accessToken)));
}

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createPushStore } from './store.mjs';

const pairingCookie = 'stormbox_relay';
const maxBodyBytes = 16 * 1024;
const pushHosts = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameSecret(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorizeSubscription(request, { publicOrigin, browserToken }) {
  const userOrigin = request.headers.origin;
  if (userOrigin !== publicOrigin) throw new HttpError(403, 'Origin denied.');

  const cookies = (request.headers.cookie ?? '').split(';').map((value) => value.trim());
  const prefix = `${pairingCookie}=`;
  const matching = cookies.filter((cookie) => cookie.startsWith(prefix));
  const value = matching.length === 1 ? matching[0].slice(prefix.length) : '';
  const cookie = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!cookie || Number(cookie[1]) <= Date.now()) throw new HttpError(401, 'Pair the browser first.');

  const hmac = createHmac('sha256', browserToken)
    .update(`${pairingCookie}:${cookie[1]}`)
    .digest('base64url');
  if (!sameSecret(cookie[2], hmac)) throw new HttpError(401, 'Pair the browser first.');
}

function authorizeIngest(request, ingestToken) {
  if (!sameSecret(request.headers.authorization ?? '', `Bearer ${ingestToken}`)) {
    throw new HttpError(401, 'Invalid ingest credential.');
  }
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Expected a JSON request.');
  }
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    throw new HttpError(413, 'Request body is too large.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function parsePushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new HttpError(400, 'Invalid push endpoint.');
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new HttpError(400, 'Invalid push endpoint.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username
    || endpoint.password || endpoint.hash || endpoint.href !== value) {
    throw new HttpError(400, 'Invalid push endpoint.');
  }
  return endpoint;
}

function validKey(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === size && bytes.toString('base64url') === value;
}

function parseSubscription(body, extraPushHosts) {
  const endpoint = parsePushEndpoint(body?.endpoint);
  const isKnown = pushHosts.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`));
  if (!isKnown && !extraPushHosts.includes(endpoint.hostname)) {
    throw new HttpError(400, 'Unsupported push provider.');
  }
  const { auth, p256dh } = body?.keys ?? {};
  if (!validKey(auth, 16) || !validKey(p256dh, 65) || Buffer.from(p256dh, 'base64url')[0] !== 4) {
    throw new HttpError(400, 'Invalid subscription keys.');
  }
  return { endpoint: endpoint.href, keys: { auth, p256dh } };
}

function parseArrival(body) {
  const { account, event } = body ?? {};
  if (typeof account !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account)
    || typeof event !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(event)) {
    throw new HttpError(400, 'Invalid arrival event.');
  }
  return { account, event };
}

function respond(response, status, body) {
  response.setHeader('Cache-Control', 'no-store');
  if (body !== undefined) response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.writeHead(status).end(body === undefined ? undefined : JSON.stringify(body));
}

export async function createPushRelay(config, send) {
  const store = await createPushStore({ path: config.statePath, send });

  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://relay.invalid').pathname;
      if (request.method === 'GET' && path === '/api/push/config') {
        return respond(response, 200, { publicKey: config.publicKey });
      }
      if (request.method === 'POST' && path === '/api/push/subscriptions/status') {
        authorizeSubscription(request, config);
        const { endpoint } = await readJson(request) ?? {};
        return respond(response, 200, { enabled: await store.has(parsePushEndpoint(endpoint).href) });
      }
      if (path === '/api/push/subscriptions' && ['POST', 'DELETE'].includes(request.method)) {
        authorizeSubscription(request, config);
        const body = await readJson(request);
        if (request.method === 'POST') {
          await store.add(parseSubscription(body, config.extraPushHosts ?? []));
        } else {
          await store.remove(parsePushEndpoint(body?.endpoint).href);
        }
        return respond(response, 204);
      }
      if (request.method === 'POST' && path === '/internal/new-mail') {
        authorizeIngest(request, config.ingestToken);
        const delivered = await store.deliver(parseArrival(await readJson(request)));
        return delivered
          ? respond(response, 204)
          : respond(response, 503, { error: 'Some push deliveries need a retry.' });
      }
      respond(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof HttpError) {
        respond(response, error.status, { error: error.message });
      } else {
        // Subscription URLs and authorization values must stay out of logs.
        console.error('A push relay operation failed.');
        respond(response, 500, { error: 'Push relay operation failed.' });
      }
    }
  });
}

import { createServer } from 'node:http';
import { matchesAccessToken, requestAuthorized, sameOrigin, sessionCookie } from './auth.js';
import { RelayError } from './errors.js';

const BASE = '/api/imap/v1';
const UINT32_MAX = 4_294_967_295;
const MAX_JSON_BYTES = 1024 * 1024;

function respond(response, status, body, headers) {
  response.writeHead(status, {
    ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(request, maximumBytes = MAX_JSON_BYTES) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RelayError(415, 'expected_json');
  }
  if (Number(request.headers['content-length']) > maximumBytes) {
    request.resume();
    throw new RelayError(413, 'request_too_large');
  }
  const parts = [];
  let length = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    length += part.length;
    if (length > maximumBytes) {
      request.resume();
      throw new RelayError(413, 'request_too_large');
    }
    parts.push(part);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new RelayError(400, 'invalid_json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RelayError(400, 'expected_object');
  return value;
}

function unsigned(value, maximum, error) {
  if (!/^[1-9]\d*$/.test(value ?? '') || Number(value) > maximum) throw new RelayError(400, error);
  return Number(value);
}

function mailboxPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\r\n\x00]/.test(value)) {
    throw new RelayError(400, 'invalid_mailbox');
  }
  return value.toUpperCase() === 'INBOX' ? 'INBOX' : value;
}

function routeSegments(url) {
  try {
    return url.pathname.slice(BASE.length + 1).split('/').map(decodeURIComponent);
  } catch {
    throw new RelayError(400, 'invalid_url');
  }
}

function flags(value) {
  const present = Object.keys(value);
  if (!present.length || present.some((key) => !['seen', 'flagged'].includes(key) || typeof value[key] !== 'boolean')) {
    throw new RelayError(400, 'invalid_flags');
  }
  return value;
}

function recipientList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((email) => (
    typeof email !== 'string' || email.length > 254 || !/^[^\s<>@,:;"\\]+@[^\s<>@,:;"\\]+$/.test(email)
  ))) throw new RelayError(400, 'invalid_recipients');
  return value.map((address) => ({ address }));
}

function outgoing(message) {
  const { operationId, subject = '', text = '', html = '' } = message;
  if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)) {
    throw new RelayError(400, 'invalid_operation_id');
  }
  if (typeof subject !== 'string' || subject.length > 1024 || /[\r\n\x00]/.test(subject)) {
    throw new RelayError(400, 'invalid_subject');
  }
  if (typeof text !== 'string' || typeof html !== 'string') throw new RelayError(400, 'invalid_content');
  const to = recipientList(message.to);
  const cc = recipientList(message.cc);
  const bcc = recipientList(message.bcc);
  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount === 0 || recipientCount > 50) throw new RelayError(400, 'invalid_recipients');
  return { operationId, to, cc, bcc, subject, text, html };
}

async function dispatch(request, response, config, service) {
  const url = new URL(request.url, config.publicOrigin);
  const method = request.method;
  if (!url.pathname.startsWith(`${BASE}/`)) throw new RelayError(404, 'not_found');
  const parts = routeSegments(url);
  if (parts.length === 1 && parts[0] === 'session') {
    if (!sameOrigin(request, config)) throw new RelayError(403, 'invalid_origin');
    if (method === 'DELETE') return respond(response, 204, undefined, { 'set-cookie': sessionCookie(config, false) });
    if (method !== 'POST') throw new RelayError(405, 'method_not_allowed');
    const { accessToken } = await readJson(request, 4096);
    if (!matchesAccessToken(accessToken, config)) throw new RelayError(401, 'unauthorized');
    return respond(response, 204, undefined, { 'set-cookie': sessionCookie(config, true) });
  }
  if (!requestAuthorized(request, config)) throw new RelayError(401, 'unauthorized');

  const [resource, id, path, uidParam, action] = parts;
  if (resource !== 'accounts') throw new RelayError(404, 'not_found');
  if (parts.length === 1 && method === 'GET') {
    const accounts = Array.from(config.accounts.values(), ({ id, email, name }) => ({ id, email, name }));
    return respond(response, 200, { accounts });
  }
  const account = config.accounts.get(id);
  if (!account) throw new RelayError(404, 'account_not_found');
  if (parts.length === 3 && path === 'mailboxes' && method === 'GET') {
    return respond(response, 200, { mailboxes: await service.listMailboxes(account) });
  }
  if (parts.length === 3 && path === 'send' && method === 'POST') {
    return respond(response, 200, await service.sendMessage(account, outgoing(await readJson(request))));
  }
  if (path !== 'messages') throw new RelayError(404, 'not_found');

  const mailbox = mailboxPath(url.searchParams.get('mailbox') ?? 'INBOX');
  if (parts.length === 3 && method === 'GET') {
    const limit = unsigned(url.searchParams.get('limit') ?? '50', 100, 'invalid_limit');
    return respond(response, 200, await service.listMessages(account, mailbox, limit));
  }
  const uid = unsigned(uidParam, UINT32_MAX, 'invalid_uid');
  const uidValidity = String(unsigned(url.searchParams.get('uidValidity'), UINT32_MAX, 'invalid_uidvalidity'));

  if (parts.length === 4 && method === 'GET') {
    return respond(response, 200, await service.readMessage(account, mailbox, uidValidity, uid));
  }
  if (parts.length === 4 && method === 'PATCH') {
    return respond(response, 200, await service.patchMessage(account, mailbox, uidValidity, uid, flags(await readJson(request, 4096))));
  }
  if (parts.length === 5 && action === 'move' && method === 'POST') {
    const { destination } = await readJson(request, 4096);
    return respond(response, 200, await service.moveMessage(account, mailbox, uidValidity, uid, mailboxPath(destination)));
  }
  if (parts.length === 5 && action === 'trash' && method === 'POST') {
    return respond(response, 200, await service.trashMessage(account, mailbox, uidValidity, uid));
  }
  throw new RelayError(404, 'not_found');
}

export function createRelayServer(config, service) {
  return createServer({ headersTimeout: 15_000, requestTimeout: 30_000, maxHeaderSize: 8192 }, (request, response) => {
    dispatch(request, response, config, service).catch((error) => {
      const status = error instanceof RelayError ? error.status : 502;
      const code = error instanceof RelayError ? error.code : 'mail_unavailable';
      respond(response, status, { error: code });
    });
  });
}

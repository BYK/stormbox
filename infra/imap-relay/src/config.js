import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function integer(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return number;
}

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\x00]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function origin(value, name) {
  const url = new URL(text(value, name));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return url.origin;
}

function connection(value, protocol) {
  const modes = ['tls', 'starttls'];
  const mode = value?.mode ?? 'tls';
  if (!modes.includes(mode)) throw new Error(`Invalid ${protocol}.mode`);
  return {
    host: text(value?.host, `${protocol}.host`),
    port: integer(value?.port, protocol === 'imap' ? (mode === 'tls' ? 993 : 143) : (mode === 'tls' ? 465 : 587), 1, 65535, `${protocol}.port`),
    secure: mode === 'tls',
    user: text(value?.user, `${protocol}.user`),
    password: text(value?.password, `${protocol}.password`),
  };
}

function account(value) {
  const id = text(value?.id, 'account.id');
  if (!ACCOUNT_ID.test(id)) throw new Error('Invalid account.id');
  const email = text(value.email, 'account.email');
  if (!/^[^\s<>@,]+@[^\s<>@,]+$/.test(email)) throw new Error('Invalid account.email');
  return {
    id,
    email,
    name: text(value.name ?? email, 'account.name'),
    imap: connection(value.imap, 'imap'),
    smtp: value.smtp ? connection(value.smtp, 'smtp') : null,
  };
}

export async function loadConfig(env = process.env) {
  const accessToken = text(env.RELAY_ACCESS_TOKEN, 'RELAY_ACCESS_TOKEN');
  if (accessToken.length < 32) throw new Error('RELAY_ACCESS_TOKEN must contain at least 32 characters');
  const rawAccounts = JSON.parse(await readFile(text(env.RELAY_ACCOUNTS_FILE, 'RELAY_ACCOUNTS_FILE'), 'utf8'));
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) throw new Error('No relay accounts configured');
  const accounts = rawAccounts.map(account);
  const accountsById = new Map(accounts.map((item) => [item.id, item]));
  if (accountsById.size !== accounts.length) throw new Error('Duplicate relay account ID');
  const push = env.PUSH_RELAY_URL || env.PUSH_RELAY_TOKEN ? {
    origin: origin(env.PUSH_RELAY_URL, 'PUSH_RELAY_URL'),
    token: text(env.PUSH_RELAY_TOKEN, 'PUSH_RELAY_TOKEN'),
    intervalMs: integer(env.RELAY_POLL_MS, 60_000, 15_000, 600_000, 'RELAY_POLL_MS'),
  } : null;
  if (push?.token === accessToken) throw new Error('Use separate browser and push relay secrets');
  return {
    accessToken,
    accounts: accountsById,
    listenerHost: env.RELAY_LISTEN_HOST ?? '127.0.0.1',
    listenerPort: integer(env.RELAY_LISTEN_PORT, 4388, 1, 65535, 'RELAY_LISTEN_PORT'),
    publicOrigin: origin(env.RELAY_PUBLIC_ORIGIN, 'RELAY_PUBLIC_ORIGIN'),
    stateDir: resolve(env.RELAY_STATE_DIR ?? '.relay-state'),
    push,
  };
}

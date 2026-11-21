import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { TEST_SMTP_PASSWORD } from '../e2e/helpers/stack-env.js';

const management = 'http://127.0.0.1:8080';
const managementHeaders = {
  authorization: `Basic ${Buffer.from('admin:accounts').toString('base64')}`,
  'content-type': 'application/json',
};
const imapPort = Number(process.env.IMAP_TLS_PORT ?? 2993);
const smtpPort = Number(process.env.SMTP_TLS_PORT ?? 2465);
const relayPort = Number(process.env.RELAY_LISTEN_PORT ?? 4388);
const base = `http://127.0.0.1:${relayPort}/api/imap/v1`;
const ids = { 'relay-alpha': 'Relay Alpha', 'relay-beta': 'Relay Beta' };
const addresses = Object.entries(ids).map(([id, name]) => ({ id, name, email: `${id}@example.org` }));
const accessToken = process.env.RELAY_TEST_ACCESS_TOKEN ?? 'stormbox-test-relay-access-token-0001';

async function json(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed with HTTP ${response.status}`);
  return response.json();
}

async function configureFixtureAccounts() {
  const fixture = await readFile(new URL('./configure-stalwart.mjs', import.meta.url), 'utf8');
  const secret = fixture.match(/const SMTP_E2E_SECRET = '([^']+)'/)?.[1];
  if (!secret) throw new Error('Fixture app password hash is unavailable');

  for (const account of addresses) {
    const id = encodeURIComponent(account.email);
    const existing = await json(`${management}/api/principal/${id}`, { headers: managementHeaders });
    if (existing.data?.id != null) continue;
    const created = await json(`${management}/api/principal/deploy`, {
      method: 'POST',
      headers: managementHeaders,
      body: JSON.stringify({
        name: account.email,
        type: 'individual',
        roles: ['user'],
        emails: [account.email],
        description: 'Stormbox Attention IMAP test account',
        secrets: [secret],
      }),
    });
    if (created.error) throw new Error('Could not create the relay fixture principal');
  }
}

const relayHeaders = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };

async function waitForRelay() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await json(`${base}/accounts`, { headers: relayHeaders });
      return;
    } catch {
      await setTimeout(150);
    }
  }
  throw new Error('IMAP relay did not become ready');
}

async function seed(account) {
  const subject = `Please review the ${account.name} draft`;
  const listUrl = `${base}/accounts/${account.id}/messages?mailbox=INBOX`;
  const initial = await json(listUrl, { headers: relayHeaders });
  if (initial.messages.some((message) => message.subject === subject)) return;
  await json(`${base}/accounts/${account.id}/send`, {
    method: 'POST',
    headers: relayHeaders,
    body: JSON.stringify({
      operationId: `attention-fixture-${account.id}`,
      to: [account.email],
      subject,
      text: `Could you review the ${account.name} draft and send me your approval?`,
    }),
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const recent = await json(listUrl, { headers: relayHeaders });
    if (recent.messages.some((message) => message.subject === subject)) return;
    await setTimeout(250);
  }
  throw new Error('Seeded mail did not reach the fixture inbox');
}

const directory = await mkdtemp(join(tmpdir(), 'stormbox-imap-relay-'));
let child;
try {
  await configureFixtureAccounts();
  const tls = execFileSync('openssl', ['s_client', '-showcerts', '-connect', `127.0.0.1:${imapPort}`, '-servername', 'localhost'], {
    input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000,
  });
  const certificate = tls.match(/-----BEGIN CERTIFICATE-----\r?\n[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!certificate) throw new Error('Could not read the local fixture certificate');
  const certificatePath = join(directory, 'fixture-ca.pem');
  const accountsFile = join(directory, 'accounts.json');
  await writeFile(certificatePath, certificate, { mode: 0o600 });
  await writeFile(accountsFile, JSON.stringify(addresses.map((account) => {
    const connection = { host: 'localhost', user: account.email, password: TEST_SMTP_PASSWORD };
    return { ...account, imap: { ...connection, port: imapPort }, smtp: { ...connection, port: smtpPort } };
  })), { mode: 0o600 });
  child = spawn(process.execPath, ['infra/imap-relay/src/index.js'], {
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: certificatePath,
      RELAY_ACCESS_TOKEN: accessToken,
      RELAY_ACCOUNTS_FILE: accountsFile,
      RELAY_LISTEN_HOST: '127.0.0.1',
      RELAY_LISTEN_PORT: String(relayPort),
      RELAY_PUBLIC_ORIGIN: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
      RELAY_STATE_DIR: join(directory, 'state'),
    },
    stdio: 'inherit',
  });
  const exited = once(child, 'exit');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  await waitForRelay();
  await Promise.all(addresses.map(seed));
  console.log('Stormbox IMAP fixtures ready');
  const [code] = await exited;
  process.exitCode = code ?? 1;
} finally {
  child?.kill();
  await rm(directory, { recursive: true, force: true });
}

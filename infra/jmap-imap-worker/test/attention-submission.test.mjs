import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import PostalMime from 'postal-mime';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:sockets') {
      return { url: 'data:text/javascript,export const connect = () => { throw new Error("inject SMTP") }', shortCircuit: true };
    }
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { Object.assign(this, { ctx, env }) } }', shortCircuit: true };
    }
    if (context.parentURL?.includes('/jmap-imap-worker/src/') && /^\.\.?\/[\w/-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(new URL('../src/', import.meta.url).href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { submitAttentionMessage, canSubmitAttentionMessage } = await import('../src/attention-submission.ts');
const { ManagedAccounts } = await import('../src/managed-accounts.ts');
const { MailTransportError } = await import('../src/mail-transport.ts');
hooks.deregister();

const account = {
  id: 'gmail-test', email: 'me@gmail.com', name: 'Stormbox mailbox',
  imap: { host: 'imap.gmail.com', user: 'me@gmail.com', mode: 'tls', port: 993, password: 'fixture-password' },
};
const payload = {
  requestId: 'f2f20e26-d91d-4f82-9ade-71331be8efec',
  to: [{ email: 'original@example.test', name: 'Seçil' }],
  cc: [{ email: 'copy@example.test' }],
  bcc: [{ email: 'hidden@example.test' }],
  subject: 'Yeni ileti \u2728', textBody: 'Yanıt.', htmlBody: '<p>Yanıt.</p>',
  inReplyTo: ['original@example.test'], references: ['first@example.test', 'original@example.test'],
};

function request(patch = {}) {
  return new Request('https://webmail.example.test/api/imap/v1/accounts/gmail-test/send', {
    method: 'POST', body: JSON.stringify({ ...payload, ...patch }),
  });
}

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const storage = {
    sql: {
      exec(query, ...params) {
        if (query.includes('CREATE TABLE')) {
          db.exec(query);
          return;
        }
        const results = db.prepare(query).all(...params);
        const rowsWritten = db.prepare('SELECT changes() AS count').get().count;
        return { toArray: () => results, rowsWritten };
      },
    },
    transactionSync(run) {
      db.exec('BEGIN');
      try {
        const result = run();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const registry = new ManagedAccounts({ storage }, {});
  return { MANAGED_ACCOUNTS: { getByName: () => registry } };
}

test('submits one multipart reply from the Gmail account with Bcc only in the envelope', async (t) => {
  const env = fixture(t);
  let calls = 0;
  async function send(sender, { to, message }) {
    calls += 1;
    assert.equal(sender.email, 'me@gmail.com');
    assert.deepEqual(sender.smtp, { ...account.imap, host: 'smtp.gmail.com', port: 465 });
    assert.deepEqual(to, ['original@example.test', 'copy@example.test', 'hidden@example.test']);
    const parsed = await PostalMime.parse(message);
    assert.equal(parsed.from.address, 'me@gmail.com');
    assert.equal(parsed.from.name || '', '');
    assert.equal(parsed.to[0].name, 'Seçil');
    assert.equal(parsed.subject, payload.subject);
    assert.equal(parsed.inReplyTo, '<original@example.test>');
    assert.equal(parsed.references, '<first@example.test> <original@example.test>');
    assert.equal(parsed.messageId, `<${payload.requestId}@gmail.com>`);
    assert.match(parsed.text, /Yanıt\./);
    assert.match(parsed.html, /<p>Yanıt\.<\/p>/);
    assert.doesNotMatch(new TextDecoder().decode(message), /^Bcc:|hidden@example\.test/im);
    return { accepted: to.slice(0, 2), rejected: [to[2]] };
  }
  const first = await submitAttentionMessage(request({ from: 'unrelated@example.test' }), account, env, send);
  assert.deepEqual(await first.json(), { status: 'submitted', rejected: 1 });
  const retry = await submitAttentionMessage(request(), account, env, send);
  assert.deepEqual(await retry.json(), { status: 'submitted', rejected: 1 });
  assert.equal(calls, 1);
});

test('only permits Gmail inferred SMTP for the authenticated address and reuses its OAuth token', async (t) => {
  const { password, ...imap } = account.imap;
  const oauth = { ...account, imap: { ...imap, accessToken: 'fixture-token' } };
  const unrelated = { ...oauth, email: 'someone-else@gmail.com' };
  assert.equal(canSubmitAttentionMessage(unrelated), false);
  assert.equal(canSubmitAttentionMessage(oauth), true);
  const env = fixture(t);
  await assert.rejects(submitAttentionMessage(request(), unrelated, env), { code: 'smtp_not_configured' });
  const response = await submitAttentionMessage(request(), oauth, env, async ({ smtp }, { to }) => {
    assert.equal(smtp.host, 'smtp.gmail.com');
    assert.equal(smtp.accessToken, 'fixture-token');
    assert.ok(!('password' in smtp));
    return { accepted: to, rejected: [] };
  });
  assert.equal(response.status, 200);
});

test('blocks concurrent or ambiguous retries but can retry a definite refusal', async (t) => {
  const env = fixture(t);
  let entered;
  const active = new Promise((resolve) => { entered = resolve; });
  let finish;
  const attempt = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const send = async () => {
    calls += 1;
    entered();
    await attempt;
    throw new MailTransportError('submission_unknown');
  };
  const sending = submitAttentionMessage(request(), account, env, send);
  const unknown = assert.rejects(sending, { code: 'submission_unknown', status: 409 });
  await active;
  await assert.rejects(submitAttentionMessage(request(), account, env, send), { code: 'submission_unknown' });
  finish();
  await unknown;
  await assert.rejects(submitAttentionMessage(request(), account, env, send), { code: 'submission_unknown' });
  await assert.rejects(submitAttentionMessage(request({ subject: 'Changed' }), account, env, send), { code: 'submission_conflict' });
  assert.equal(calls, 1);

  const otherRequest = () => request({ requestId: '4be15926-309a-4045-9d35-2fc6457a2852' });
  await assert.rejects(submitAttentionMessage(otherRequest(), account, env, async () => {
    throw new MailTransportError('submission_rejected');
  }), { code: 'submission_rejected', status: 422 });
  const retry = await submitAttentionMessage(otherRequest(), account, env, async (_, { to }) => ({ accepted: to, rejected: [] }));
  assert.equal(retry.status, 200);
});

test('rejects invalid addresses and control characters before SMTP', async (t) => {
  const env = fixture(t);
  const invalidRequest = [
    { to: [{ email: 'missing-domain' }] },
    { to: [{ email: 'a@example.test, b@example.test' }] },
    { bcc: [{ email: 'a@example.test\r\nTo: b@example.test' }] },
    { subject: 'Headers\r\nBcc: injection@example.test' },
    { inReplyTo: ['mail@example.test\r\nBcc: injection@example.test'] },
  ];
  const send = () => assert.fail('SMTP must not receive invalid submissions');
  for (const patch of invalidRequest) {
    await assert.rejects(submitAttentionMessage(request(patch), account, env, send), { code: 'invalid_submission', status: 400 });
  }
});

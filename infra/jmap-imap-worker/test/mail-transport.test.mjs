import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:sockets') {
      return {
        url: 'data:text/javascript,export const connect = () => { throw new Error("inject a test socket") }',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { createMailTransport } = await import('../src/mail-transport.ts');
hooks.deregister();

const endpoint = { host: 'mail.example.test', user: 'me@example.test', password: 'fixture-password' };
const account = { id: 'test', email: endpoint.user, imap: endpoint, smtp: endpoint };
const encoder = new TextEncoder();

function scriptedSocket(greeting, respond) {
  let control;
  let didClose = false;
  let resolveClosed;
  let bytes = '';
  const decoder = new TextDecoder();
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const readable = new ReadableStream({
    start(controller) { control = controller; },
    cancel() { didClose = true; resolveClosed(); },
  });
  function emit(text) {
    if (!didClose) control.enqueue(encoder.encode(text));
  }
  async function close() {
    if (!didClose) control.close();
    didClose = true;
    resolveClosed();
  }
  const writable = new WritableStream({
    async write(chunk) {
      bytes += decoder.decode(chunk, { stream: true });
      while (bytes.includes('\r\n')) {
        const boundary = bytes.indexOf('\r\n');
        const line = bytes.slice(0, boundary);
        bytes = bytes.slice(boundary + 2);
        await respond(line, emit, close);
      }
    },
  });
  emit(greeting);
  return {
    opened: Promise.resolve({}),
    closed,
    readable,
    writable,
    upgraded: false,
    close,
    startTls() { throw new Error('Expected implicit TLS'); },
  };
}

const sample = [
  'From: Alice <alice@example.test>',
  'To: me@example.test',
  'Subject: A test message',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Hi from IMAP!',
  '',
].join('\r\n');

function makeImapSocket({ mailboxSize = 1 } = {}) {
  const calls = [];
  let connections = 0;
  function connect(address, options) {
    connections += 1;
    assert.deepEqual(address, { hostname: endpoint.host, port: 993 });
    assert.equal(options.secureTransport, 'on');
    let current = 'INBOX';
    let authTag;
    const capability = 'IMAP4rev1 AUTH=PLAIN UIDPLUS MOVE';
    return scriptedSocket(`* OK [CAPABILITY ${capability}] fixture ready\r\n`, (line, write) => {
      calls.push(line);
      if (authTag) {
        write(`${authTag} OK logged in\r\n`);
        authTag = undefined;
        return;
      }
      const [, tag, command] = /^(\S+) (.*)$/.exec(line) ?? [];
      const ok = (value = 'OK') => write(`${tag} ${value}\r\n`);
      if (command.startsWith('AUTHENTICATE')) {
        authTag = tag;
        write('+ \r\n');
      } else if (/^LOGIN /i.test(command)) {
        ok();
      } else if (/^CAPABILITY/i.test(command)) {
        write(`* CAPABILITY ${capability}\r\n`);
        ok();
      } else if (command === 'LIST "" ""') {
        write('* LIST (\\Noselect) "/" ""\r\n');
        ok();
      } else if (/^LIST /i.test(command)) {
        write('* LIST (\\HasNoChildren \\Archive) "/" "Archive"\r\n');
        write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
        write('* LIST (\\Noselect) "/" "Parent"\r\n');
        ok();
      } else if (/^LSUB /i.test(command)) {
        write('* LSUB (\\HasNoChildren) "/" "INBOX"\r\n');
        ok();
      } else if (/^(EXAMINE|SELECT) /i.test(command)) {
        current = /ARCHIVE/i.test(command) ? 'Archive' : 'INBOX';
        write(`* ${current === 'INBOX' ? mailboxSize : 0} EXISTS\r\n`);
        write('* OK [UIDVALIDITY 7] fixture UID validity\r\n');
        write('* OK [UIDNEXT 45] fixture next UID\r\n');
        ok('OK [READ-ONLY] selected');
      } else if (/^(UID )?FETCH /i.test(command)) {
        if (/BODY\.PEEK\[\]<0\./i.test(command)) {
          write(`* 1 FETCH (UID 44 BODY[]<0> {${encoder.encode(sample).byteLength}}\r\n${sample})\r\n`);
        } else {
          const date = '"Fri, 20 Nov 2026 00:00:00 +0000"';
          const from = '(("Alice" NIL "alice" "example.test"))';
          const to = '((NIL NIL "me" "example.test"))';
          const envelope = `(${date} "A test message" ${from} NIL NIL ${to} NIL NIL "<first@example.test>" "<reply@example.test>")`;
          write(`* 1 FETCH (UID 44 FLAGS (\\Seen) INTERNALDATE "20-Nov-2026 00:00:00 +0000" RFC822.SIZE ${encoder.encode(sample).byteLength} ENVELOPE ${envelope})\r\n`);
        }
        ok();
      } else {
        ok();
      }
    });
  }
  return { connect, calls, connections: () => connections };
}

test('lists and reads multiple IMAP windows over one TLS connection', async () => {
  const fixture = makeImapSocket();
  const transport = createMailTransport(fixture.connect);
  const snapshot = await transport.listMailboxWindows(account, 10);
  assert.deepEqual(snapshot.folders.map(({ path }) => path).sort(), ['Archive', 'INBOX']);
  assert.deepEqual(snapshot.windows.map(({ mailbox, minUid, complete }) => ({ mailbox, minUid, complete })), [
    { mailbox: 'INBOX', minUid: 44, complete: true },
    { mailbox: 'Archive', minUid: null, complete: true },
  ]);
  const message = snapshot.windows[0].messages[0];
  assert.equal(message.subject, 'A test message');
  assert.equal(message.seen, true);
  assert.equal(message.receivedAt, '2026-11-20T00:00:00.000Z');
  assert.deepEqual(message.from, [{ name: 'Alice', address: 'alice@example.test' }]);
  assert.equal(fixture.connections(), 1);
  assert.equal(fixture.calls.filter((line) => / EXAMINE /.test(line)).length, 2);

  const body = await transport.readMessage(account, 'INBOX', '7', 44);
  assert.match(body.text, /Hi from IMAP!/);
  assert.equal(new TextDecoder().decode(await transport.readMessageSource(account, 'INBOX', '7', 44)), sample);
});

test('rejects stale UIDVALIDITY before sending a UID command', async () => {
  const fixture = makeImapSocket();
  const transport = createMailTransport(fixture.connect);
  await assert.rejects(transport.readMessage(account, 'INBOX', '6', 44), { code: 'mailbox_changed' });
  assert.equal(fixture.calls.some((line) => / FETCH /.test(line)), false);
});

test('partial FETCH does not make missing UIDs eligible for reconciliation', async () => {
  const fixture = makeImapSocket({ mailboxSize: 5 });
  const transport = createMailTransport(fixture.connect);
  const window = await transport.listMessages(account, 'INBOX', 5);
  assert.equal(window.total, 5);
  assert.equal(window.messages.length, 1);
  assert.equal(window.complete, false);
  assert.equal(window.minUid, null);
});

function makeSmtpSocket(outcome) {
  return (address, options) => {
    assert.deepEqual(address, { hostname: endpoint.host, port: 465 });
    assert.equal(options.secureTransport, 'on');
    let inData = false;
    return scriptedSocket('220 fixture ESMTP\r\n', async (line, write, close) => {
      if (inData && line === '.') {
        inData = false;
        if (outcome === 'accepted') write('250 2.0.0 Queued\r\n');
        else if (outcome === 'rejected') write('554 5.0.0 Rejected\r\n');
        else await close();
      } else if (inData) return;
      else if (/^EHLO /i.test(line)) write('250-fixture\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH PLAIN /i.test(line)) write('235 2.7.0 Authenticated\r\n');
      else if (/^MAIL FROM:|^RCPT TO:/i.test(line)) write('250 2.1.0 OK\r\n');
      else if (line === 'DATA') {
        inData = true;
        write('354 Send message\r\n');
      } else if (line === 'QUIT') {
        write('221 Bye\r\n');
      }
    });
  };
}

test('SMTP distinguishes acceptance, explicit refusal, and an uncertain disconnect', async () => {
  const draft = { to: ['alice@example.test'], message: sample };
  assert.deepEqual(await createMailTransport(makeSmtpSocket('accepted')).submitMessage(account, draft), {
    accepted: ['alice@example.test'],
    rejected: [],
  });
  await assert.rejects(createMailTransport(makeSmtpSocket('rejected')).submitMessage(account, draft), {
    code: 'submission_rejected',
  });
  await assert.rejects(createMailTransport(makeSmtpSocket('unknown')).submitMessage(account, draft), {
    code: 'submission_unknown',
  });
});

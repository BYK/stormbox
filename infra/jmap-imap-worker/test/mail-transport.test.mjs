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
    if (specifier === './keywords' && context.parentURL?.endsWith('/src/mail-transport.ts')) {
      return nextResolve('./keywords.ts', context);
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

function makeImapSocket({
  mailboxSize = 1, trash = false, junk = false, archive = true, supportsMove = true, oauth = false, gmail = false,
  keywordsAllowed = true, rejectLabelUpdate = false, omitKeywordFetch = false, stall = () => false, additionalUid, rejectFlagUid,
  keepSourceAfterMove = false, archiveStore = 'apply',
} = {}) {
  const calls = [];
  const sockets = [];
  let connections = 0;
  let moved = false;
  const flags = new Map([[44, new Set(['\\Seen', 'localtriage-category-newsletter'])]]);
  if (additionalUid) flags.set(additionalUid, new Set());
  const labels = new Set(['\\Inbox', 'Read later']);
  const customLabels = new Set(['Read later']);
  function connect(address, options) {
    connections += 1;
    assert.deepEqual(address, { hostname: endpoint.host, port: 993 });
    assert.equal(options.secureTransport, 'on');
    let current = 'INBOX';
    let authTag;
    const capability = `IMAP4rev1 AUTH=${oauth ? 'XOAUTH2' : 'PLAIN'} UIDPLUS${supportsMove ? ' MOVE' : ''}${gmail ? ' X-GM-EXT-1' : ''}`;
    const socket = scriptedSocket(`* OK [CAPABILITY ${capability}] fixture ready\r\n`, (line, write) => {
      calls.push(line);
      if (authTag) {
        write(`${authTag} OK logged in\r\n`);
        authTag = undefined;
        return;
      }
      const [, tag, command] = /^(\S+) (.*)$/.exec(line) ?? [];
      if (stall(command)) return;
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
        if (archive) write('* LIST (\\HasNoChildren \\Archive) "/" "Archive"\r\n');
        if (junk) write('* LIST (\\HasNoChildren \\Junk) "/" "Spam folder"\r\n');
        if (gmail) {
          write('* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"\r\n');
          for (const label of customLabels) write(`* LIST (\\HasNoChildren) "/" ${JSON.stringify(label)}\r\n`);
        }
        write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
        write('* LIST (\\Noselect) "/" "Parent"\r\n');
        if (trash) write('* LIST (\\HasNoChildren \\Trash) "/" "Deleted items"\r\n');
        ok();
      } else if (/^LSUB /i.test(command)) {
        write('* LSUB (\\HasNoChildren) "/" "INBOX"\r\n');
        ok();
      } else if (/^(EXAMINE|SELECT) /i.test(command)) {
        current = /ARCHIVE/i.test(command) ? 'Archive' : 'INBOX';
        write(`* ${current === 'INBOX' && !moved ? mailboxSize : 0} EXISTS\r\n`);
        write('* OK [UIDVALIDITY 7] fixture UID validity\r\n');
        write('* OK [UIDNEXT 45] fixture next UID\r\n');
        if (!keywordsAllowed) write('* OK [PERMANENTFLAGS (\\Seen \\Flagged)] fixture flags\r\n');
        ok(`OK [${command.startsWith('SELECT') ? 'READ-WRITE' : 'READ-ONLY'}] selected`);
      } else if (/^UID STORE [\d,:]+ ([+-])FLAGS/i.test(command)) {
        const [, range, sign, values] = /^UID STORE ([\d,:]+) ([+-])FLAGS(?:\.SILENT)? \((.*)\)/i.exec(command);
        for (const [uid, currentFlags] of flags) {
          if (range.split(',').includes(String(uid))) {
            if (uid !== rejectFlagUid) {
              for (const flag of values.split(' ')) {
                if (sign === '+') currentFlags.add(flag);
                else currentFlags.delete([...currentFlags].find((value) => value.toLowerCase() === flag.toLowerCase()));
              }
            }
            write(`* 1 FETCH (UID ${uid} FLAGS (${[...currentFlags].join(' ')}))\r\n`);
          }
        }
        ok();
      } else if (/^CREATE /i.test(command)) {
        const label = command.slice('CREATE '.length);
        customLabels.add(label.startsWith('"') ? JSON.parse(label) : label);
        ok();
      } else if (/^UID STORE 44 ([+-])X-GM-LABELS/i.test(command)) {
        const [, sign, values] = /^UID STORE 44 ([+-])X-GM-LABELS \((.*)\)/i.exec(command);
        const archiving = sign === '-' && values.toLowerCase() === '\\inbox';
        if (archiving && archiveStore === 'refuse') return ok('NO label refused');
        if (archiving && archiveStore === 'ignore') return ok();
        const parts = values.match(/"(?:[^"\\]|\\.)*"|[^ ]+/g) ?? [];
        for (const part of parts) {
          const label = part.startsWith('"') ? JSON.parse(part) : part;
          if (sign === '+') {
            if (!customLabels.has(label) || rejectLabelUpdate) return ok('NO label refused');
            labels.add(label);
          } else {
            labels.delete(label);
          }
        }
        if (!labels.has('\\Inbox')) {
          moved = true;
          write('* 1 EXPUNGE\r\n');
        }
        ok(archiving && archiveStore === 'apply-and-refuse' ? 'NO label refused' : 'OK');
      } else if (/^UID MOVE 44 (?:"Deleted items"|"?Archive"?|"Spam folder")$/i.test(command)) {
        if (!keepSourceAfterMove) {
          moved = true;
          write('* 1 EXPUNGE\r\n');
        }
        ok('OK [COPYUID 8 44 45] moved');
      } else if (/^UID SEARCH UID /i.test(command)) {
        const requested = command.slice('UID SEARCH UID '.length).split(',').map(Number);
        const found = moved ? [] : requested.filter((uid) => flags.has(uid));
        write(`* SEARCH${found.map((uid) => ` ${uid}`).join('')}\r\n`);
        ok();
      } else if (/^(UID )?FETCH /i.test(command)) {
        if (moved || (omitKeywordFetch && /^UID FETCH [\d,:]+ \(FLAGS UID\)$/i.test(command))) return ok();
        const requested = /^UID FETCH ([\d,]+) /i.exec(command)?.[1].split(',').map(Number);
        for (const [uid, currentFlags] of flags) {
          if (requested && !requested.includes(uid)) continue;
          if (/BODY\.PEEK\[\]<0\./i.test(command)) {
            write(`* 1 FETCH (UID ${uid} BODY[]<0> {${encoder.encode(sample).byteLength}}\r\n${sample})\r\n`);
          } else {
            const date = '"Fri, 20 Nov 2026 00:00:00 +0000"';
            const from = '(("Alice" NIL "alice" "example.test"))';
            const to = '((NIL NIL "me" "example.test"))';
            const envelope = `(${date} "A test message" ${from} NIL NIL ${to} NIL NIL "<first@example.test>" "<reply@example.test>")`;
            const gmailLabels = /X-GM-LABELS/.test(command) ? ` X-GM-LABELS (${[...labels].map((label) => JSON.stringify(label)).join(' ')})` : '';
            write(`* 1 FETCH (UID ${uid} FLAGS (${[...currentFlags].join(' ')}) INTERNALDATE "20-Nov-2026 00:00:00 +0000" RFC822.SIZE ${encoder.encode(sample).byteLength} ENVELOPE ${envelope}${gmailLabels})\r\n`);
          }
        }
        ok();
      } else {
        ok();
      }
    });
    sockets.push(socket);
    return socket;
  }
  return { connect, calls, sockets, connections: () => connections };
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

test('a stalled IMAP command closes its socket and permits a fresh read', { timeout: 3000 }, async () => {
  let stalled = false;
  const fixture = makeImapSocket({ stall: (command) => {
    if (stalled || !/^FETCH /.test(command)) return false;
    stalled = true;
    return true;
  } });
  const transport = createMailTransport(fixture.connect, { operationTimeout: 100 });
  await assert.rejects(transport.listMessages(account, 'INBOX', 10), { code: 'mail_timeout' });
  assert.equal(stalled, true);
  await fixture.sockets[0].closed;
  assert.equal((await transport.listMessages(account, 'INBOX', 10)).messages[0].uid, 44);
  assert.equal(fixture.connections(), 2);
});

test('a slow later folder does not discard Inbox or confirm the unread folders', { timeout: 3000 }, async () => {
  const fixture = makeImapSocket({ trash: true, stall: (command) => /^EXAMINE Archive$/.test(command) });
  const transport = createMailTransport(fixture.connect, { folderTimeout: 100 });
  const result = await transport.listMailboxWindows(account, 10);
  assert.deepEqual(result.windows.map(({ mailbox }) => mailbox), ['INBOX']);
  assert.deepEqual(result.failedFolders, ['Archive', 'Deleted items']);
  await fixture.sockets[0].closed;
  const resumed = await transport.listMailboxWindows(account, 10, 8, result.nextFolder);
  assert.deepEqual(resumed.windows.map(({ mailbox }) => mailbox), ['Deleted items', 'INBOX']);
  assert.deepEqual(resumed.failedFolders, ['Archive']);
});

test('a stalled Inbox leaves the other folders eligible on the next scan', { timeout: 3000 }, async () => {
  const fixture = makeImapSocket({ stall: (command) => /^EXAMINE INBOX$/.test(command) });
  const transport = createMailTransport(fixture.connect, { folderTimeout: 100 });
  const partial = await transport.listMailboxWindows(account, 10);
  assert.deepEqual(partial.windows, []);
  const resumed = await transport.listMailboxWindows(account, 10, 8, partial.nextFolder);
  assert.deepEqual(resumed.windows.map(({ mailbox }) => mailbox), ['Archive']);
  assert.deepEqual(resumed.failedFolders, ['INBOX']);
});

test('aggregate deadlines resume at the unfinished folder after making progress', { timeout: 4000 }, async () => {
  let selections = 0;
  const fixture = makeImapSocket({ trash: true, junk: true, stall: (command) => /^EXAMINE /.test(command) && ++selections % 2 === 0 });
  const transport = createMailTransport(fixture.connect, { syncTimeout: 200, folderTimeout: 1000 });
  let resumeAt = 0;
  const completed = new Set();
  for (let pass = 0; pass < 4; pass++) {
    const result = await transport.listMailboxWindows(account, 10, 8, resumeAt);
    assert.equal(result.windows.length, 1);
    completed.add(result.windows[0].mailbox);
    resumeAt = result.nextFolder;
  }
  assert.deepEqual(completed, new Set(['INBOX', 'Archive', 'Deleted items', 'Spam folder']));
});

test('a deadline after issuing UID STORE preserves the uncertain write outcome', { timeout: 3000 }, async () => {
  const fixture = makeImapSocket({ stall: (command) => /^UID STORE /.test(command) });
  const transport = createMailTransport(fixture.connect, { operationTimeout: 100 });
  await assert.rejects(transport.patchMailboxKeywords(account, 'INBOX', '7', [{ uid: 44, keyword: '$flagged', add: true }]),
    { code: 'keyword_write_unknown' });
  assert.equal(fixture.calls.filter((line) => / UID STORE /.test(line)).length, 1);
  await fixture.sockets[0].closed;
});

test('batched bodies share one selected mailbox and preserve missing and oversized positions', async () => {
  const fixture = makeImapSocket({ additionalUid: 56 });
  const transport = createMailTransport(fixture.connect);
  const requests = [44, 56, 99].map((uid) => ({ type: 'read', uid }));
  const budget = { bodyBytes: encoder.encode(sample).byteLength };
  const [first, oversized, missing] = await transport.runMessageBatch(account, 'INBOX', '7', requests, budget);
  assert.match(first.value.text, /Hi from IMAP!/);
  assert.deepEqual(oversized, { error: 'batch_body_limit' });
  assert.deepEqual(missing, { error: 'message_not_found' });
  assert.equal(fixture.connections(), 1);
  assert.equal(fixture.calls.filter((line) => / EXAMINE /.test(line)).length, 1);
  assert.equal(fixture.calls.filter((line) => / UID FETCH 44,56,99 /.test(line)).length, 1);
  assert.equal(fixture.calls.filter((line) => /BODY\.PEEK\[\]</.test(line)).length, 1);
});

test('a batch groups compatible flags by UID and preserves a later conflicting write', async () => {
  const fixture = makeImapSocket({ additionalUid: 56 });
  const transport = createMailTransport(fixture.connect);
  const requests = [44, 56, 99].map((uid) => ({ type: 'flags', uid, flags: { flagged: true } }));
  requests.push({ type: 'flags', uid: 44, flags: { flagged: false } });
  const result = await transport.runMessageBatch(account, 'INBOX', '7', requests, { bodyBytes: 1024 });
  assert.deepEqual(result, [
    { value: { uid: 44, seen: true, flagged: true } },
    { value: { uid: 56, seen: false, flagged: true } },
    { error: 'message_not_found' },
    { value: { uid: 44, seen: true, flagged: false } },
  ]);
  const stores = fixture.calls.filter((line) => / UID STORE /.test(line));
  assert.equal(stores.length, 2);
  assert.match(stores[0], /UID STORE 44,56 \+FLAGS/);
  assert.match(stores[1], /UID STORE 44 -FLAGS/);
  assert.equal(fixture.connections(), 1);
});

test('a grouped STORE returns the actual flags when one requested change is refused', async () => {
  const fixture = makeImapSocket({ additionalUid: 56, rejectFlagUid: 56 });
  const transport = createMailTransport(fixture.connect);
  const requests = [44, 56].map((uid) => ({ type: 'flags', uid, flags: { flagged: true } }));
  const result = await transport.runMessageBatch(account, 'INBOX', '7', requests, { bodyBytes: 1024 });
  assert.deepEqual(result, [
    { value: { uid: 44, seen: true, flagged: true } },
    { value: { uid: 56, seen: false, flagged: false } },
  ]);
  assert.equal(fixture.calls.filter((line) => / UID STORE 44,56 \+FLAGS/.test(line)).length, 1);
});

test('batched writes retain confirmed outcomes when the next operation times out', { timeout: 3000 }, async () => {
  const fixture = makeImapSocket({ stall: (command) => /^UID STORE 44 -FLAGS/.test(command) });
  const transport = createMailTransport(fixture.connect, { operationTimeout: 150 });
  const requests = [true, false].map((flagged) => ({ type: 'flags', uid: 44, flags: { flagged } }));
  const result = await transport.runMessageBatch(account, 'INBOX', '7', requests, { bodyBytes: 1024 });
  assert.deepEqual(result, [{ value: { uid: 44, seen: true, flagged: true } }, { error: 'mail_timeout' }]);
  await fixture.sockets[0].closed;
});

test('batched writes wait behind an unresolved edit to the same UID', async () => {
  const fixture = makeImapSocket({ omitKeywordFetch: true });
  const transport = createMailTransport(fixture.connect);
  const requests = [true, false].map((flagged) => ({ type: 'flags', uid: 44, flags: { flagged } }));
  const result = await transport.runMessageBatch(account, 'INBOX', '7', requests, { bodyBytes: 1024 });
  assert.deepEqual(result, [{ error: 'mail_unavailable' }, { error: 'mail_unavailable' }]);
  assert.equal(fixture.calls.filter((line) => / UID SEARCH UID 44$/.test(line)).length, 1);
  assert.equal(fixture.calls.filter((line) => / UID STORE /.test(line)).length, 0);
});

test('applies compatible JMAP keyword updates in a single batched UID STORE', async () => {
  const fixture = makeImapSocket();
  const transport = createMailTransport(fixture.connect);
  const updates = [44, 50].map((uid) => ({ uid, keyword: '$flagged', add: true }));
  const result = await transport.patchMailboxKeywords(account, 'INBOX', '7', updates);
  assert.deepEqual(result, [
    { uid: 44, keywords: { $seen: true, $flagged: true, 'localtriage-category-newsletter': true } },
    { uid: 50, error: 'notFound' },
  ]);
  const stores = fixture.calls.filter((line) => / UID STORE /.test(line));
  assert.equal(stores.length, 1);
  assert.match(stores[0], /UID STORE 44,50 \+FLAGS(?:\.SILENT)? \(\\Flagged\)/);
  assert.equal(fixture.connections(), 1);
  await assert.rejects(transport.patchMailboxKeywords(account, 'INBOX', '8', updates), { code: 'mailbox_changed' });
  assert.equal(fixture.calls.filter((line) => / UID STORE /.test(line)).length, 1);
});

test('keeps an incomplete post-STORE FETCH distinct from a verified absent UID', async () => {
  const fixture = makeImapSocket({ omitKeywordFetch: true });
  const transport = createMailTransport(fixture.connect);
  await assert.rejects(transport.patchMailboxKeywords(account, 'INBOX', '7', [{ uid: 44, keyword: '$flagged', add: true }]),
    { code: 'keyword_write_unknown' });
  assert.equal(fixture.calls.filter((line) => / UID STORE /.test(line)).length, 1);
  assert.equal(fixture.calls.filter((line) => / UID SEARCH UID 44$/.test(line)).length, 1);
});

test('reads notification previews with a bounded read-only FETCH', async () => {
  const fixture = makeImapSocket();
  const transport = createMailTransport(fixture.connect);
  assert.match((await transport.readMessagePreviews(account, 'INBOX', '7', [44]))[44], /Hi from IMAP!/);
  assert.equal(fixture.connections(), 1);
  assert.equal(fixture.calls.filter((line) => / UID FETCH 44 .*BODY\.PEEK\[\]<0\.24576>/i.test(line)).length, 1);
  assert.equal(fixture.calls.some((line) => /\bSELECT\b|\bSTORE\b/i.test(line)), false);
});

test('reads custom Gmail labels and IMAP keywords from the message list', async () => {
  const fixture = makeImapSocket({ gmail: true });
  const transport = createMailTransport(fixture.connect);
  const { messages } = await transport.listMessages(account, 'INBOX', 10);

  assert.deepEqual(messages[0].labels, ['Read later']);
  assert.deepEqual(messages[0].keywords, ['localtriage-category-newsletter']);
  assert.equal(messages[0].gmailLabels, true);
});

test('archives Gmail by removing only Inbox membership and safely confirms a retry', async () => {
  const fixture = makeImapSocket({ gmail: true, archive: false, supportsMove: false });
  const transport = createMailTransport(fixture.connect);
  assert.deepEqual(await transport.moveToRole(account, 'INBOX', '7', 44, 'archive'), { status: 'moved' });
  assert.deepEqual(await transport.moveToRole(account, 'INBOX', '7', 44, 'archive'), { status: 'absent' });
  assert.equal(fixture.calls.filter((line) => / UID STORE 44 -X-GM-LABELS \(\\Inbox\)$/.test(line)).length, 1);
  assert.equal(fixture.calls.some((line) => / UID MOVE | UID COPY |\\Deleted|EXPUNGE/.test(line)), false);
});

test('distinguishes a refused Gmail archive from an unconfirmed acknowledgment', async () => {
  for (const [archiveStore, code] of [['refuse', 'archive_rejected'], ['ignore', 'mail_unavailable']]) {
    const fixture = makeImapSocket({ gmail: true, archiveStore });
    const transport = createMailTransport(fixture.connect);
    await assert.rejects(transport.moveToRole(account, 'INBOX', '7', 44, 'archive'), { code });
    const store = fixture.calls.findIndex((line) => / UID STORE 44 -X-GM-LABELS /.test(line));
    assert.ok(store >= 0 && fixture.calls.slice(store + 1).some((line) => / UID FETCH 44 .*X-GM-LABELS/.test(line)));
  }
});

test('confirms a Gmail archive if the source UID disappeared despite the STORE response', async () => {
  const fixture = makeImapSocket({ gmail: true, archiveStore: 'apply-and-refuse' });
  const transport = createMailTransport(fixture.connect);
  assert.deepEqual(await transport.moveToRole(account, 'INBOX', '7', 44, 'archive'), { status: 'moved' });
  assert.ok(fixture.calls.some((line) => / UID SEARCH UID 44$/.test(line)));
});

test('moves standard IMAP mail only to a selectable archive or junk role', async () => {
  for (const [role, destination] of [['archive', 'Archive'], ['junk', 'Spam folder']]) {
    const fixture = makeImapSocket({ archive: true, junk: true });
    const transport = createMailTransport(fixture.connect);
    assert.equal((await transport.moveToRole(account, 'INBOX', '7', 44, role)).destination, destination);
    await assert.rejects(createMailTransport(makeImapSocket({ archive: false }).connect)
      .moveToRole(account, 'INBOX', '7', 44, role), { code: `${role}_not_configured` });
  }
});

test('adds and removes Gmail labels and IMAP keywords without replacing other flags', async () => {
  const fixture = makeImapSocket({ gmail: true });
  const transport = createMailTransport(fixture.connect);
  const patch = {
    add: ['stormbox-work'], remove: ['LOCALTRIAGE-CATEGORY-NEWSLETTER'],
    addLabels: ['Customer follow-up'], removeLabels: ['Read later'],
  };
  const expected = { uid: 44, seen: true, flagged: false, tagsApplied: true,
    labels: ['Customer follow-up'], keywords: ['stormbox-work'] };
  assert.deepEqual(await transport.patchMessageTags(account, 'INBOX', '7', 44, patch), expected);
  assert.deepEqual(await transport.patchMessageTags(account, 'INBOX', '7', 44, patch), expected);
  assert.equal(fixture.calls.filter((line) => / CREATE "Customer follow-up"$/.test(line)).length, 1);
  assert.equal(fixture.calls.filter((line) => / UID STORE /.test(line)).length, 4);
});

test('returns the confirmed tag state when the server rejects part of a patch', async () => {
  const fixture = makeImapSocket({ gmail: true, keywordsAllowed: false, rejectLabelUpdate: true });
  const transport = createMailTransport(fixture.connect);
  assert.deepEqual(await transport.patchMessageTags(account, 'INBOX', '7', 44, {
    add: ['stormbox-work'], remove: [], addLabels: ['Work'], removeLabels: ['Read later'],
  }), { uid: 44, seen: true, flagged: false, tagsApplied: false,
    labels: [], keywords: ['localtriage-category-newsletter'] });
});

test('requires the matching UIDVALIDITY before creating labels or updating a message', async () => {
  const fixture = makeImapSocket({ gmail: true });
  const transport = createMailTransport(fixture.connect);
  await assert.rejects(transport.patchMessageTags(account, 'INBOX', '6', 44, {
    add: [], remove: [], addLabels: ['New label'], removeLabels: [],
  }), { code: 'mailbox_changed' });
  await assert.rejects(transport.moveToRole(account, 'INBOX', '6', 44, 'archive'), { code: 'mailbox_changed' });
  assert.equal(fixture.calls.some((line) => / (CREATE|UID STORE|UID MOVE) /i.test(line)), false);
});

test('rejects stale UIDVALIDITY before sending a UID command', async () => {
  const fixture = makeImapSocket();
  const transport = createMailTransport(fixture.connect);
  await assert.rejects(transport.readMessage(account, 'INBOX', '6', 44), { code: 'mailbox_changed' });
  assert.equal(fixture.calls.some((line) => / FETCH /.test(line)), false);
});

test('verifies credentials by opening Inbox read-only without fetching or changing mail', async () => {
  const fixture = makeImapSocket();
  await createMailTransport(fixture.connect).verifyImapAccount(account);
  assert.equal(fixture.calls.some((line) => / EXAMINE INBOX$/i.test(line)), true);
  assert.equal(fixture.calls.some((line) => / (FETCH|UID (FETCH|STORE)|SELECT) /i.test(line)), false);
});

test('authenticates an IMAP OAuth connection with XOAUTH2 and uses the verified mailbox address', async () => {
  const fixture = makeImapSocket({ oauth: true });
  const { password, ...server } = endpoint;
  await createMailTransport(fixture.connect).verifyImapAccount({
    ...account, imap: { ...server, accessToken: 'fixture-access-token' },
  });
  const auth = fixture.calls.findIndex((line) => / AUTHENTICATE XOAUTH2$/.test(line));
  assert.ok(auth >= 0);
  assert.equal(Buffer.from(fixture.calls[auth + 1], 'base64').toString('utf8'),
    `user=${server.user}\x01auth=Bearer fixture-access-token\x01\x01`);
  assert.equal(fixture.calls.some((line) => / (LOGIN|AUTHENTICATE PLAIN) /.test(line)), false);
});

test('updates flags and moves only to IMAP Trash, with a safe retry after a completed move', async () => {
  const fixture = makeImapSocket({ trash: true });
  const transport = createMailTransport(fixture.connect);
  assert.deepEqual(await transport.patchMessage(account, 'INBOX', '7', 44, { flagged: true }), {
    uid: 44, seen: true, flagged: true,
  });
  assert.deepEqual(await transport.patchMessage(account, 'INBOX', '7', 44, { seen: false }), {
    uid: 44, seen: false, flagged: true,
  });
  assert.equal((await transport.trashMessage(account, 'INBOX', '7', 44)).status, 'moved');
  assert.deepEqual(await transport.trashMessage(account, 'INBOX', '7', 44), { status: 'absent' });
  assert.equal(fixture.calls.filter((line) => / UID MOVE /i.test(line)).length, 1);
  assert.equal(fixture.calls.some((line) => /EXPUNGE|\\Deleted/i.test(line)), false);
});

test('a move acknowledgment without source removal yields a retryable outcome', async () => {
  const fixture = makeImapSocket({ trash: true, keepSourceAfterMove: true });
  const transport = createMailTransport(fixture.connect);
  const batch = [{ uid: 44, type: 'move', role: 'trash' }];
  assert.deepEqual(await transport.runMessageBatch(account, 'INBOX', '7', batch, { bodyBytes: 0 }), [
    { error: 'mail_unavailable' },
  ]);
  const move = fixture.calls.findIndex((line) => / UID MOVE /.test(line));
  assert.ok(move >= 0);
  assert.ok(fixture.calls.slice(move + 1).some((line) => / UID SEARCH UID 44$/.test(line)));
});

test('a move with a lost source confirmation reconciles on retry without moving again', async () => {
  let moved = false;
  const fixture = makeImapSocket({ trash: true, stall(command) {
    if (/^UID MOVE /.test(command)) moved = true;
    return moved && /^UID SEARCH UID 44$/.test(command);
  } });
  const transport = createMailTransport(fixture.connect, { operationTimeout: 100 });
  await assert.rejects(transport.trashMessage(account, 'INBOX', '7', 44), { code: 'mail_timeout' });
  assert.deepEqual(await transport.trashMessage(account, 'INBOX', '7', 44), { status: 'absent' });
  assert.equal(fixture.calls.filter((line) => / UID MOVE /.test(line)).length, 1);
  assert.equal(fixture.calls.filter((line) => / UID SEARCH UID 44$/.test(line)).length, 1);
});

test('requires a Trash role and UID MOVE support', async () => {
  for (const [options, code] of [
    [{ trash: false }, 'trash_not_configured'],
    [{ trash: true, supportsMove: false }, 'move_not_supported'],
  ]) {
    const fixture = makeImapSocket(options);
    await assert.rejects(createMailTransport(fixture.connect).trashMessage(account, 'INBOX', '7', 44), { code });
    assert.equal(fixture.calls.some((line) => / (UID MOVE|UID COPY|UID STORE|EXPUNGE)/i.test(line)), false);
  }
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

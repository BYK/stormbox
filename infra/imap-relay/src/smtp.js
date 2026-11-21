import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import nodemailer from 'nodemailer';
import { RelayError } from './errors.js';

export async function openRelayState(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'submissions.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS submissions (
      account TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      outcome TEXT,
      PRIMARY KEY (account, operation_id)
    );
    CREATE TABLE IF NOT EXISTS inbox_positions (
      account TEXT PRIMARY KEY,
      uid_validity TEXT NOT NULL,
      uid_next INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO submissions(account, operation_id, fingerprint) VALUES (?, ?, ?)
    ON CONFLICT (account, operation_id) DO NOTHING
  `);
  const lookup = db.prepare('SELECT fingerprint, outcome FROM submissions WHERE account = ? AND operation_id = ?');
  const done = db.prepare('UPDATE submissions SET outcome = ? WHERE account = ? AND operation_id = ?');
  const position = db.prepare('SELECT uid_validity AS uidValidity, uid_next AS uidNext FROM inbox_positions WHERE account = ?');
  const updatePosition = db.prepare(`
    INSERT INTO inbox_positions(account, uid_validity, uid_next) VALUES (?, ?, ?)
    ON CONFLICT (account) DO UPDATE SET uid_validity = excluded.uid_validity, uid_next = excluded.uid_next
  `);
  return {
    insert,
    lookup,
    done,
    readInboxPosition: (account) => position.get(account),
    writeInboxPosition: (account, { uidValidity, uidNext }) => updatePosition.run(account, uidValidity, uidNext),
    close: () => db.close(),
  };
}

export async function sendMessage(journal, account, message) {
  if (!account.smtp) throw new RelayError(501, 'smtp_not_configured');
  const { operationId, ...content } = message;
  const fingerprint = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  if (!journal.insert.run(account.id, operationId, fingerprint).changes) {
    const stored = journal.lookup.get(account.id, operationId);
    if (stored.fingerprint !== fingerprint) throw new RelayError(409, 'operation_conflict');
    if (!stored.outcome) throw new RelayError(409, 'submission_unknown');
    return JSON.parse(stored.outcome);
  }

  const smtp = account.smtp;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  const messageId = `<${randomUUID()}@${account.email.split('@')[1]}>`;
  let response;
  try {
    response = await transport.sendMail({
      ...content,
      from: { name: account.name, address: account.email },
      messageId,
    });
  } catch {
    // SMTP can accept DATA before the TCP connection fails. Retain the pending record.
    throw new RelayError(409, 'submission_unknown');
  } finally {
    transport.close();
  }
  const outcome = { messageId, accepted: response.accepted, rejected: response.rejected };
  journal.done.run(JSON.stringify(outcome), account.id, operationId);
  return outcome;
}

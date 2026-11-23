import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { loginViaOidc } from './helpers/oidc-login.js';
import { connectJmap, sweepOrphanTestMessages } from './helpers/jmap-client.js';
import { sendSmtpMessage } from './helpers/smtp-client.js';
import { localStackEnabled, selfEmail, TEST_SMTP_PASSWORD } from './helpers/stack-env.js';

const pairToken = process.env.RELAY_TEST_ACCESS_TOKEN;
const relayEmail = 'relay-alpha@example.org';
const relayAccountId = 'relay-alpha';

test.skip(!localStackEnabled || !pairToken,
  'Start the local IMAP test fixture with RELAY_TEST_ACCESS_TOKEN to exercise mixed accounts.');

test('Attention reads JMAP and IMAP and retains triage state and a downloaded body on offline relaunch', async ({ page, context, request }) => {
  const marker = `Attention E2E ${Date.now()}`;
  const jmapSubject = `${marker} — Please review JMAP`;
  const imapSubject = 'Please review the Relay Alpha draft';
  const imapText = 'Could you review the Relay Alpha draft and send me your approval?';
  const jmap = await connectJmap();
  try {
    await sendSmtpMessage({ to: selfEmail(), subject: jmapSubject, text: 'Please review the JMAP test.' });
    await expect.poll(async () => {
      const response = await request.get(`/api/imap/v1/accounts/${encodeURIComponent(relayAccountId)}/messages?mailbox=INBOX`, {
        headers: { Authorization: `Bearer ${pairToken}` },
      });
      if (!response.ok()) return [];
      return (await response.json()).messages.map((message) => message.subject);
    }, { timeout: 20_000 }).toContain(imapSubject);

    await loginViaOidc(page);
    await page.getByRole('button', { name: 'Attention', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Smart Inbox' })).toBeVisible();
    await page.getByLabel('Smart Inbox options', { exact: true }).and(page.locator('summary')).click();
    await page.getByRole('button', { name: 'Connect IMAP accounts' }).click();
    await page.getByLabel('Mail relay pairing token').fill(pairToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Close IMAP accounts' }).click();

    const jmapRow = page.locator('.attention-inbox__bundle').filter({ hasText: jmapSubject });
    const imapRow = page.locator('.attention-inbox__bundle').filter({ hasText: imapSubject });
    await expect(jmapRow).toBeVisible({ timeout: 20_000 });
    await expect(imapRow).toContainText(relayEmail);
    await expect(page.locator('.attention-inbox__bundle').filter({ hasText: 'Please review the Relay Beta draft' }))
      .toContainText('relay-beta@example.org');
    await imapRow.locator('.msg-list__open').click();
    await expect(page.getByText(imapText)).toBeVisible();
    await page.getByRole('button', { name: 'Back to Attention' }).click();
    await jmapRow.locator('.msg-list__open').hover();
    await jmapRow.getByLabel('Message actions', { exact: true }).and(jmapRow.locator('summary')).click();
    await jmapRow.getByRole('button', { name: 'Mark bundle done' }).click();
    await expect(jmapRow).toHaveCount(0);

    if (process.env.PLAYWRIGHT_PWA === '1') {
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      await context.setOffline(true);
    } else {
      // Vite's unbundled modules remain online when testing the SQLite cold path.
      await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    }
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Smart Inbox' })).toBeVisible({ timeout: 20_000 });
    await expect(imapRow).toBeVisible();
    await expect(jmapRow).toHaveCount(0);
    await page.getByRole('button', { name: /^Done/ }).click();
    await expect(jmapRow).toBeVisible();
    await page.getByRole('button', { name: /^Needs attention/ }).click();
    await imapRow.locator('.msg-list__open').click();
    await expect(page.getByText(imapText)).toBeVisible();
  } finally {
    await context.setOffline(false);
    await sweepOrphanTestMessages(jmap, { subjectPrefix: marker });
  }
});

test('Attention applies IMAP star, read state and Trash to the row, local cache and server', async ({ page }) => {
  const requireRelay = createRequire(new URL('../../infra/imap-relay/package.json', import.meta.url));
  const { ImapFlow } = requireRelay('imapflow');
  const imap = new ImapFlow({
    host: process.env.IMAP_TLS_HOST ?? 'localhost',
    port: Number(process.env.IMAP_TLS_PORT ?? 2993),
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: relayEmail, pass: TEST_SMTP_PASSWORD },
    logger: false,
  });
  const subject = `Attention IMAP actions ${Date.now()} — Please review`;
  let trash;
  await imap.connect();
  async function withMailbox(path, task, readOnly = true) {
    const lock = await imap.getMailboxLock(path, { readOnly });
    try {
      const ids = await imap.search({ header: { subject } }, { uid: true });
      return await task(ids || []);
    } finally {
      lock.release();
    }
  }
  const serverFlags = () => withMailbox('INBOX', async ([uid]) => {
    const item = uid && await imap.fetchOne(uid, { flags: true }, { uid: true });
    return item ? { seen: item.flags.has('\\Seen'), flagged: item.flags.has('\\Flagged') } : null;
  });
  const cachedMessage = () => page.evaluate(async ({ relayAccountId, subject }) => {
    const repo = globalThis.__repo;
    const [account] = await repo.listAccounts();
    const cache = await repo.getAttentionCache(account.id);
    return cache.accounts.find(({ relay_id }) => relay_id === relayAccountId)?.messages.find((row) => row.subject === subject) ?? null;
  }, { relayAccountId, subject });
  try {
    trash = (await imap.list()).find(({ flags }) => flags.has('\\Trash'))?.path;
    expect(trash).toBeTruthy();
    await sendSmtpMessage({ to: relayEmail, subject, text: 'Please review and send your approval.' });
    await expect.poll(serverFlags).toEqual({ seen: false, flagged: false });

    await loginViaOidc(page);
    await page.getByRole('button', { name: 'Attention', exact: true }).click();
    await page.getByLabel('Smart Inbox options', { exact: true }).and(page.locator('summary')).click();
    await page.getByRole('button', { name: 'Connect IMAP accounts' }).click();
    await page.getByLabel('Mail relay pairing token').fill(pairToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Close IMAP accounts' }).click();
    const row = page.locator('.attention-inbox__bundle').filter({ hasText: subject });
    const actions = row.getByRole('group', { name: 'Message actions' }).first();
    const star = actions.getByRole('button', { name: 'Star', exact: true });

    const openActions = async () => {
      await row.locator('.msg-list__open').hover();
      await row.getByLabel('Message actions', { exact: true }).and(row.locator('summary')).click();
    };
    await openActions();
    await star.click();
    await openActions();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(cachedMessage).toMatchObject({ flagged: true });
    await expect.poll(serverFlags).toMatchObject({ flagged: true });

    await actions.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await openActions();
    await actions.getByRole('button', { name: 'Mark as unread', exact: true }).click();
    await openActions();
    await expect(actions.getByRole('button', { name: 'Mark as read', exact: true })).toBeVisible();
    await expect.poll(cachedMessage).toMatchObject({ seen: false, flagged: true });
    await expect.poll(serverFlags).toEqual({ seen: false, flagged: true });

    await actions.getByRole('button', { name: 'Move to Trash', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(cachedMessage).toBeNull();
    await expect.poll(serverFlags).toBeNull();
    await expect.poll(() => withMailbox(trash, (ids) => ids.length)).toBe(1);
  } finally {
    try {
      for (const path of ['INBOX', trash].filter(Boolean)) {
        await withMailbox(path, (ids) => ids.length && imap.messageDelete(ids, { uid: true }), false);
      }
    } finally {
      await imap.logout();
    }
  }
});

import { test, expect } from '@playwright/test';
import { loginViaOidc } from './helpers/oidc-login.js';
import { connectJmap, sweepOrphanTestMessages } from './helpers/jmap-client.js';
import { sendSmtpMessage } from './helpers/smtp-client.js';
import { localStackEnabled, selfEmail } from './helpers/stack-env.js';

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
    await page.getByRole('button', { name: 'Connect IMAP accounts' }).click();
    await page.getByLabel('Mail relay pairing token').fill(pairToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    const jmapRow = page.locator('.attention-inbox__bundle').filter({ hasText: jmapSubject });
    const imapRow = page.locator('.attention-inbox__bundle').filter({ hasText: imapSubject });
    await expect(jmapRow).toBeVisible({ timeout: 20_000 });
    await expect(imapRow).toContainText(relayEmail);
    await expect(page.locator('.attention-inbox__bundle').filter({ hasText: 'Please review the Relay Beta draft' }))
      .toContainText('relay-beta@example.org');
    await imapRow.locator('.attention-inbox__preview').click();
    await expect(page.getByText(imapText)).toBeVisible();
    await page.getByRole('button', { name: 'Back to Attention' }).click();
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
    await imapRow.locator('.attention-inbox__preview').click();
    await expect(page.getByText(imapText)).toBeVisible();
  } finally {
    await context.setOffline(false);
    await sweepOrphanTestMessages(jmap, { subjectPrefix: marker });
  }
});

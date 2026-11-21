import { test, expect } from '@playwright/test';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  connectJmap,
  createEmailInMailbox,
  destroyEmail,
  getEmailKeywords,
  getEmailMailboxIds,
  listMailboxes,
} from './helpers/jmap-client.js';
import { localStackEnabled, selfEmail, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

test('Attention keeps the current filter while reading and applies quick actions to the mail server', async ({ page }) => {
  const jmap = await connectJmap();
  const folders = await listMailboxes(jmap);
  const inbox = folders.find(({ role }) => role === 'inbox');
  const trash = folders.find(({ role }) => role === 'trash');
  const subject = `Please review the Attention pane ${Date.now()}`;
  const bodyText = 'Can you review the request and let me know?';
  const id = await createEmailInMailbox(jmap, {
    mailboxId: inbox.id, fromEmail: selfEmail(), subject, bodyText,
  });

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginViaOidc(page);
    await page.getByRole('button', { name: 'Attention', exact: true }).click();
    const row = page.locator('.attention-inbox__bundle').filter({ hasText: subject });
    const trigger = row.locator('.msg-list__open');
    const handled = page.getByRole('button', { name: /^Done & snoozed/ });
    await trigger.hover();
    await row.getByRole('button', { name: 'Mark bundle done' }).click();
    await handled.click();
    await trigger.click();

    const reader = page.getByRole('region', { name: 'Message detail' });
    const back = reader.getByRole('button', { name: 'Back to Attention' });
    await expect(reader.getByText(bodyText, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/view=attention/);
    await expect(handled).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-current', 'true');
    await expect.poll(async () => (await getEmailKeywords(jmap, id))?.$seen).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(handled).toBeHidden();
    await back.click();
    await expect(handled).toHaveAttribute('aria-pressed', 'true');
    await expect(trigger).toBeFocused();

    const star = row.getByRole('button', { name: 'Star', exact: true });
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await getEmailKeywords(jmap, id))?.$flagged).toBe(true);
    await row.getByRole('button', { name: 'Mark as unread' }).click();
    await expect(row.getByRole('button', { name: 'Mark as read' })).toBeVisible();
    await expect.poll(async () => Boolean((await getEmailKeywords(jmap, id))?.$seen)).toBe(false);
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(() => getEmailMailboxIds(jmap, id)).toEqual({ [trash.id]: true });
  } finally {
    await destroyEmail(jmap, id);
  }
});

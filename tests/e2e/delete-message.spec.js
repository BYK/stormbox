import {
  classifyMailboxState,
  cleanupEmail,
  connectJmap,
  createDraft,
  createEmailInMailbox,
  getEmailMailboxIds,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
  sweepOrphanTestMessages,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  expectRowSoon,
  readRecentMutations,
  readViewCacheForFolderRole,
} from './helpers/ui.js';
import { discardCompose } from './helpers/compose.js';
import { sendSmtpMessage } from './helpers/smtp-client.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

// One parameterised spec exercises explicit removal from Drafts and Inbox.
// Composer Discard permanently destroys a draft; message Delete moves an
// Inbox Email to Trash.
const CASES = [
  {
    name: 'composer Discard permanently destroys a real server-side draft',
    sourceRole: 'drafts',
    subjectPrefix: 'Delete e2e',
    expectedState: 'missing',
    createMessage: async (jmap, { sourceMailbox, fromEmail, subject }) => createDraft(jmap, {
      draftsId: sourceMailbox.id,
      fromEmail,
      subject,
    }),
  },
  {
    name: 'delete moves a real server-side Inbox message to Trash',
    sourceRole: 'inbox',
    subjectPrefix: 'Delete inbox e2e',
    expectedState: 'trash',
    createMessage: async (jmap, { sourceMailbox, fromEmail, subject }) => createEmailInMailbox(jmap, {
      mailboxId: sourceMailbox.id,
      fromEmail,
      subject,
    }),
  },
];

test.describe('Delete message e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  for (const {
    name, sourceRole, createMessage, subjectPrefix, expectedState,
  } of CASES) {
    test(name, async ({ sharedPage: page }, testInfo) => {
      const jmap = await connectJmap();
      const mailboxes = await listMailboxes(jmap);
      const source = mailboxByRole(mailboxes, sourceRole);
      const trash = mailboxByRole(mailboxes, 'trash');
      if (!source || !trash) {
        throw new Error(
          `Test requires ${sourceRole} and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`,
        );
      }

      const fromEmail = selfEmail();
      const subject = `${subjectPrefix} ${Date.now()}`;
      let createdId = null;
      try {
        createdId = await createMessage(jmap, {
          sourceMailbox: source,
          fromEmail,
          subject,
        });

        await expect.poll(
          async () => classifyMailboxState(
            await getEmailMailboxIds(jmap, createdId),
            { source, trash },
          ),
          { timeout: 30_000, message: `created test message should start in ${source.name}` },
        ).toBe('source');

        await clickFolder(page, source.name);
        await expectRowSoon(page, subject);

        await page.locator('.msg-list__item').filter({ hasText: subject }).first().click();
        if (sourceRole === 'drafts') {
          await expect(page.locator('.compose-dialog--expanded')).toBeVisible({ timeout: 30_000 });
          await discardCompose(page);
        } else {
          await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });
          // Scoped to the open message: every list row carries its own
          // Delete in the hover overlay.
          await page.locator('.message-view__header').getByRole('button', { name: 'Delete' }).click();
          const row = page.locator('.msg-list__item').filter({ hasText: subject });
          await expect(row).toHaveCount(0, { timeout: 4_000 });
          expect(classifyMailboxState(await getEmailMailboxIds(jmap, createdId), { source, trash })).toBe('source');
          await page.getByRole('button', { name: /Undo Moved to Trash/i }).click();
          await expect(row).toBeVisible({ timeout: 4_000 });
          expect(classifyMailboxState(await getEmailMailboxIds(jmap, createdId), { source, trash })).toBe('source');
          await row.first().click();
          await page.locator('.message-view__header').getByRole('button', { name: 'Delete' }).click();
        }

        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 30_000, message: `deleted message should disappear from the ${source.name} list` },
        ).toBe(0);

        try {
          await expect.poll(
            async () => classifyMailboxState(
              await getEmailMailboxIds(jmap, createdId),
              { source, trash },
            ),
            {
              timeout: 30_000,
              message: sourceRole === 'drafts'
                ? 'server should report the discarded draft as destroyed'
                : `server should report the deleted message in Trash, not ${source.name}`,
            },
          ).toBe(expectedState);
        } catch (err) {
          const mutationRows = await readRecentMutations(page);
          await testInfo.attach('recent-mutations.json', {
            body: JSON.stringify(mutationRows, null, 2),
            contentType: 'application/json',
          });
          throw err;
        }
        await expect.poll(async () => {
          const sourceCache = await readViewCacheForFolderRole(page, sourceRole);
          return sourceCache == null ? null : sourceCache.remoteIds.includes(createdId);
        }, { timeout: 10_000, message: `remote id should be gone from ${source.name} cache` }).toBe(false);
      } finally {
        await attachConsoleTail(testInfo, consoleLinesFor(page));
        if (createdId) {
          await cleanupEmail(jmap, createdId, trash.id);
        }
      }
    });
  }

  test('a Unified Inbox conversation deletes and undoes both messages together', async ({ sharedPage: page }) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const source = mailboxByRole(mailboxes, 'inbox');
    const trash = mailboxByRole(mailboxes, 'trash');
    const nonce = `${Date.now()}`;
    const subject = `Delete thread e2e ${nonce}`;
    const messageId = `${nonce}@stormbox-e2e.local`;
    let ids = [];
    const serverLocations = () => Promise.all(ids.map(async (id) =>
      classifyMailboxState(await getEmailMailboxIds(jmap, id), { source, trash })));

    try {
      await sendSmtpMessage({ to: selfEmail(), subject, messageId, text: 'First message in the conversation.' });
      await sendSmtpMessage({ to: selfEmail(), subject: `Re: ${subject}`, inReplyTo: messageId, text: 'Second message in the conversation.' });
      await expect.poll(async () => {
        const response = await jmapRequest(jmap, [['Email/query', {
          accountId: jmap.accountId,
          filter: { inMailbox: source.id, subject },
        }, 'q1']]);
        ids = pickResponse(response, 'Email/query')?.ids ?? [];
        return ids.length;
      }).toBe(2);

      await clickFolder(page, source.name);
      await expectRowSoon(page, subject);
      await clickFolder(page, 'Unified Inbox');
      await page.getByRole('searchbox').fill(subject);
      const mail = page.getByRole('region', { name: 'Unified Inbox' });
      const head = mail.getByRole('button', { name: new RegExp(`^Open conversation: .*${subject}`) });
      await head.click();
      const conversation = mail.getByRole('list', { name: 'Messages in conversation' });
      await expect(conversation.getByRole('listitem')).toHaveCount(2);
      await mail.getByRole('button', { name: 'Back to messages' }).click();

      const select = mail.getByRole('checkbox', { name: new RegExp(`^Select conversation: .*${subject}`) });
      await head.hover();
      await select.check();
      await expect(mail.getByText('2 selected')).toBeVisible();
      const remove = mail.locator('.msg-list__header').getByRole('button', { name: 'Delete', exact: true });
      await remove.click();
      await expect(head).toHaveCount(0);
      expect(await serverLocations()).toEqual(['source', 'source']);
      await page.getByRole('button', { name: 'Undo Delete 2 messages' }).click();
      await expect(head).toBeVisible();
      expect(await serverLocations()).toEqual(['source', 'source']);

      await head.hover();
      await select.check();
      await remove.click();
      await expect.poll(serverLocations, { timeout: 20_000 }).toEqual(['trash', 'trash']);
      await expect.poll(async () => {
        const cache = await readViewCacheForFolderRole(page, 'inbox');
        return cache ? ids.some((id) => cache.remoteIds.includes(id)) : null;
      }).toBe(false);
    } finally {
      await page.getByRole('searchbox').fill('');
      await sweepOrphanTestMessages(jmap, { subjectPrefix: subject });
    }
  });
});

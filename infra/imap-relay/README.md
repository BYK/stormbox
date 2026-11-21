# Stormbox IMAP relay

This single-user relay connects a Stormbox installation to the IMAP accounts you configure. Mail credentials stay on the relay. The browser pairs with a separate access token and receives an HttpOnly cookie.

Run inside the development container with Node 24. Save an `accounts.json` file somewhere private and restrict its permissions. Configure the IMAP service and, optionally, the SMTP submission service for each account. This example uses implicit TLS. Use `"mode": "starttls"` for a service that requires STARTTLS.

```json
[
  {
    "id": "personal",
    "email": "me@example.test",
    "name": "Personal",
    "imap": { "host": "imap.example.test", "user": "me@example.test", "password": "app-password" },
    "smtp": { "host": "smtp.example.test", "port": 587, "mode": "starttls", "user": "me@example.test", "password": "app-password" }
  }
]
```

Set `RELAY_ACCOUNTS_FILE` to its absolute path, `RELAY_ACCESS_TOKEN` to a random token of at least 32 characters, and `RELAY_PUBLIC_ORIGIN` to the Stormbox origin that will host the relay route. The relay binds to `127.0.0.1:4388` by default. You can configure `RELAY_LISTEN_HOST`, `RELAY_LISTEN_PORT`, and `RELAY_STATE_DIR`. Back the state directory with a private persistent volume. Keep account IDs stable across configuration changes.

```sh
npm --prefix infra/imap-relay ci
npm --prefix infra/imap-relay start
```

Forward `/api/imap/v1` to the relay from the Stormbox origin. In Vite development, set `STORMBOX_MAIL_RELAY_TARGET` to the relay URL. In production, use the same HTTPS origin for both. Enter the relay access token under **Attention** to pair.

For background notifications, configure `PUSH_RELAY_URL` and `PUSH_RELAY_TOKEN`. The push token must differ from `RELAY_ACCESS_TOKEN`. The relay checks Inbox UID changes once per minute, skips existing mail when first connecting an account, and reports new message IDs to the configured push relay. It saves its last successful position in the state directory so it can resume after a restart. Set `RELAY_POLL_MS` to change the interval. The notification request carries the account ID and IMAP message identity.

## API

All endpoints are under `/api/imap/v1`. Browser requests use the pairing cookie. Service requests may authorize with a bearer token.

| Method and path | Behavior |
| --- | --- |
| `POST /session` | Pair from the configured origin with `{ "accessToken": "…" }`. |
| `DELETE /session` | Clear the pairing cookie. |
| `GET /accounts` | List the accounts available to this relay. |
| `GET /accounts/:id/mailboxes` | List selectable mailboxes and their advertised roles. |
| `GET /accounts/:id/messages?mailbox=INBOX&limit=50` | Read a recent window of envelopes and its `uidValidity`. |
| `GET /accounts/:id/messages/:uid?mailbox=INBOX&uidValidity=…` | Fetch text and HTML for a message of up to 8 MiB. |
| `PATCH /accounts/:id/messages/:uid?mailbox=INBOX&uidValidity=…` | Set `seen`, `flagged`, or both. |
| `POST /accounts/:id/messages/:uid/move?mailbox=INBOX&uidValidity=…` | Move a message on IMAP servers that advertise `MOVE`. Set `destination` to the target mailbox path. |
| `POST /accounts/:id/send` | Submit via SMTP using `operationId`, address arrays `to`, `cc` and `bcc`, `subject`, `text` and `html`. A retry with the same operation ID returns its recorded outcome. An uncertain outcome returns `submission_unknown` and requires reconciliation. |

The first slice uses app-password authentication, recent Inbox windows, and plain message bodies in Attention. Before using the HTML response in another client, render it with the app's email-content sandbox. Configured SMTP servers may save their own Sent copy. The relay reports the submission outcome and currently leaves Sent-folder filing to the server.

## Testing

Run `npm --prefix infra/imap-relay test` inside the development container. For the local Playwright fixture, start `node tests/fixtures/start-imap-relay.mjs` after the disposable Stalwart stack is up. It provisions two test accounts, trusts the test server's localhost certificate, and seeds their inboxes through SMTP. It expects the IMAP and SMTP TLS listeners on ports `2993` and `2465` by default. Configure Vite with `STORMBOX_MAIL_RELAY_TARGET=http://127.0.0.1:4388` and set `RELAY_TEST_ACCESS_TOKEN` to the same test token for the fixture and Playwright.

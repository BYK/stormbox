# Stormbox Web Push relay

This service sends generic new-mail notifications even when the installable web
app is closed. The IMAP relay reports new inbox UIDs after it has established
its initial snapshot. Devices see a generic alert, grouped per account, that
opens **Needs attention**. The push payload carries an opaque notification tag.
Message previews, subjects, senders, and addresses stay out of push.

## Setup

Install dependencies and generate a VAPID key pair in the project development
container. Save the key pair for future runs so browsers can keep their existing
subscriptions.

```sh
cd infra/push-relay
npm ci
npx web-push generate-vapid-keys --json
npm start
```

Set these environment variables before starting the relay.

| Variable | Value |
| --- | --- |
| `RELAY_ACCESS_TOKEN` | Browser pairing token shared with the IMAP relay. |
| `RELAY_PUBLIC_ORIGIN` | Exact web app origin, including scheme and port. |
| `PUSH_RELAY_TOKEN` | Separate arrival-ingest token shared with the IMAP relay. |
| `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` | Keys generated above. |
| `WEB_PUSH_VAPID_SUBJECT` | Operator contact URI, such as `mailto:operator@example.org`. |
| `WEB_PUSH_STATE_PATH` | Private persistent state file. Defaults to `./data/state.json`. |
| `WEB_PUSH_HOST` / `WEB_PUSH_PORT` | Listener. Defaults to `127.0.0.1:8789`. |
| `WEB_PUSH_EXTRA_HOSTS` | Optional comma-separated, exact HTTPS push-provider hostnames. |

Reverse-proxy `/api/push/` on the app origin to this service, preserving the
browser's `Origin` and `Cookie` headers. The public endpoint returns the VAPID
public key. Subscription changes require the IMAP relay's signed HttpOnly
pairing cookie and the configured app origin. This deployment serves one mail
user and sends arrivals from all configured accounts to that user's subscribed
browsers. Keep the state file private and writable by a single relay instance.

For Vite development or preview on the same machine, set
`STORMBOX_PUSH_RELAY_TARGET=http://127.0.0.1:8789` when starting Vite.

Set `PUSH_RELAY_URL` on the IMAP relay to the internal push service origin.
The mail relay calls the private `POST /internal/new-mail` endpoint with
`Authorization: Bearer <PUSH_RELAY_TOKEN>` and JSON such as
`{"account":"personal","event":"213:50001"}`. Reuse the same event key when
retrying a transient failure. Delivery acceptance is recorded for 24 hours and
expired provider endpoints are removed. A provider accepts a push for delivery
asynchronously, so the response is an acceptance receipt.

For a smoke test, pair the browser, enable notifications, then close the app
window and deliver new mail to the watched IMAP inbox. Use an HTTPS app origin
or localhost. On iOS, open the installed Home Screen app to subscribe.

Run the relay's local protocol tests with `npm test` in the project container.

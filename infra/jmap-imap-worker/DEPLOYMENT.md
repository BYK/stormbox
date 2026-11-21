# Cloudflare deployment

The `stormbox-jmap-imap` Worker serves a JMAP endpoint on `workers.dev` and the
Attention inbox API on `webmail.byk.im`. The existing Pages project
`stormbox-byk` serves the app. Its production branch is
`agent/mail-rules-jmap-sieve`, and app-password sign-in reaches Thundermail
through `jmap.byk.im`.

## Configure and deploy the Worker

From this directory in the development container, use an authenticated Wrangler
session with Workers Scripts edit access and the correct Cloudflare account.
The `byk.im` route also requires Zone read and Workers Routes edit access.

```sh
npm ci
npm run typecheck
npm test
npm run build
npx wrangler deploy
npx wrangler secret put RELAY_ACCESS_TOKEN
npx wrangler secret put IMAP_ACCOUNTS
npx wrangler secret put IMAP_ACCOUNT_ENCRYPTION_KEY
npx wrangler secret put RELAY_SESSION_KEY
npx wrangler deploy --route "webmail.byk.im/api/imap/v1/*" --route "webmail.byk.im/api/push/*"
```

The generic JMAP endpoint uses a relay access token of at least 32 random
characters. On BYK the Thundermail bridge authorizes Attention from the
current owner's sign-in.
Set the same randomly generated, base64-encoded 32-byte `RELAY_SESSION_KEY`
on both Workers. Existing browser pairings and push subscriptions created
before the signing key was configured need to be established again.
Self-hosted installations without a session issuer can enter the relay
access token to pair the browser.

Set `IMAP_ACCOUNT_ENCRYPTION_KEY` separately to a random, base64-encoded 32-byte
value. Keep that key stable across deployments so Workers can read passwords
for accounts added in Attention. Managed account credentials are encrypted in
the account registry Durable Object. They remain available to paired browsers
until the account is removed. The deployment represents one operator trust
boundary. Paired browsers on the same deployment share its managed accounts.

Set optional `IMAP_ACCOUNTS` to a JSON array of operator-configured accounts.
Passwords for those accounts stay in the Worker secret.

```json
[
  {
    "id": "work",
    "email": "you@example.net",
    "name": "Work",
    "imap": {
      "host": "imap.example.net",
      "port": 993,
      "mode": "tls",
      "user": "you@example.net",
      "password": "app-password"
    }
  }
]
```

Use `"mode": "starttls"` and the server's explicit-TLS port when appropriate.
Use a public IMAP hostname with a publicly trusted certificate. Keep account
IDs stable for the same mailbox login so the gateway continues to use its
existing Durable Object. Use a new ID when changing the provider or login.
Set `PUBLIC_ORIGIN` to `https://webmail.byk.im` for the BYK deployment.
Accounts added from Attention use TLS on port 993 or STARTTLS on port 143.
Gmail uses `imap.gmail.com` on port 993 and a Google app password. Changes to
an existing account's login endpoint require removing and adding the account
again. A new app password can replace an existing password in place.

For Web Push, set `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
`WEB_PUSH_VAPID_SUBJECT`. Configure the `/api/push/*` route when the Worker is
ready to serve it. When adding this route with Wrangler, pass both routes
in the same deployment command so the existing IMAP route remains bound.

## Publish the app

Push the verified frontend to the Pages production branch and wait for the
`stormbox-byk` deployment. The existing build command is `npm run build` and
its output directory is `dist`. Preserve the app-password and service settings
in the [BYK deployment guide](../../docs/byk-cloudflare-deployment.md).

Route `webmail.byk.im/api/imap/v1/*` to `stormbox-jmap-imap` in the `byk.im`
zone. The route applies only to that path prefix, so Pages continues to host
mail and the PWA. The separate `jmap.byk.im` Thundermail bridge continues to
serve the primary account and Sieve rules.

Check the published app and API paths:

```sh
curl --silent --show-error --head https://webmail.byk.im/
curl --silent --show-error --include https://webmail.byk.im/api/imap/v1/health
curl --silent --show-error --include https://webmail.byk.im/api/imap/v1/accounts
```

The app returns HTML, the health endpoint returns JSON, and the accounts
endpoint requires a bearer token or a paired browser. Open **Attention → IMAP accounts**
to add an account and open a message from it. Attention can update IMAP stars and
read state. Delete requires an IMAP server that advertises `MOVE` and a
mailbox marked `\Trash`. Independent JMAP clients can use
`/.well-known/jmap` on the `workers.dev` URL emitted by Wrangler with the relay
access token as a bearer credential. The preview covers mailbox and message
reads for operator-configured accounts.

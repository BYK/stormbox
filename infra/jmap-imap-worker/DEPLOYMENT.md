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
npx wrangler deploy --route "webmail.byk.im/api/imap/v1/*"
```

Generate a relay access token with at least 32 random characters. Enter it in
Attention when connecting the IMAP accounts. Set `IMAP_ACCOUNTS` to a JSON array
of operator-configured accounts. The IMAP password stays in the Worker secret.

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
endpoint requires a bearer token or a paired browser. Open **Attention → Connect IMAP accounts**, enter the relay access token,
and open a message from the linked account. Attention can update IMAP stars and
read state. Delete requires an IMAP server that advertises `MOVE` and a
mailbox marked `\Trash`. Independent JMAP clients can use
`/.well-known/jmap` on the `workers.dev` URL emitted by Wrangler with the relay
access token as a bearer credential. The preview covers mailbox and message
reads.

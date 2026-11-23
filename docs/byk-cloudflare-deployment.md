# BYK Cloudflare deployment

The personal deployment uses two production-named hosts:

- `https://webmail.byk.im` — Cloudflare Pages SPA
- `https://jmap.byk.im` — Cloudflare Worker JMAP bridge

The bridge forwards to `https://mail.thundermail.com`. HTTP CORS and
WebSocket `Origin` checks allow only `https://webmail.byk.im`.

## Pages project

Connect the Pages project to `BYK/stormbox` and use:

| Setting | Value |
| --- | --- |
| Pages project | `stormbox-byk` |
| Production branch | `agent/mail-rules-jmap-sieve` |
| Build command | `npm run build` |
| Build output | `dist` |
| Root directory | `/` |
| Custom domain | `webmail.byk.im` |

Set these production build variables:

```text
VITE_JMAP_SERVER_URL=https://jmap.byk.im
VITE_APP_PASSWORD_ONLY=1
VITE_ACCOUNTS_URL=https://accounts.tb.pro
VITE_APPOINTMENT_URL=https://appointment.tb.pro
VITE_SEND_URL=https://send.tb.pro
VITE_SENDER_AVATAR_PROXY_URL=https://avatars.thunderbird.net
ONNXRUNTIME_NODE_INSTALL=skip
```

`VITE_APP_PASSWORD_ONLY=1` avoids offering Thundermail OIDC from an
unregistered redirect origin. Sign-in sends the app password to the
JMAP bridge over HTTPS and establishes a browser session.

`ONNXRUNTIME_NODE_INSTALL=skip` skips extra native runtime downloads. The
Attention model uses the bundled browser runtime.

## JMAP bridge

The BYK Wrangler configuration intentionally has no committed
Cloudflare account ID. Supply it together with a scoped API token:

```bash
cd infra/jmap-bridge
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run deploy:byk
```

Provision the BYK bridge's browser session key once before deploying the
app-password sign-in flow. Replacing it signs out browsers that used the old key.

```bash
openssl rand -base64 32 | npx wrangler secret put BROWSER_SESSION_KEY --config wrangler.byk.toml
```

The bridge validates the app password against Thundermail and encrypts it
in a host-only, HttpOnly cookie valid for 30 days. The only browser origin
permitted to use the cookie is `https://webmail.byk.im`. Signing out deletes
the cookie and clears the account used to reopen offline mail.

Set `RELAY_OWNER_EMAIL` on the bridge to the Thundermail sign-in address
allowed to use the IMAP relay. Set the same random, base64-encoded 32-byte
`RELAY_SESSION_KEY` on both Workers. The bridge revalidates the owner's
session and issues a short-lived, single-use assertion that the relay
exchanges for its browser cookie. The browser can then add IMAP accounts
directly in Attention. See the [relay deployment guide](../infra/jmap-imap-worker/DEPLOYMENT.md)
for the separate account encryption key.

The token needs account-level Cloudflare Pages edit and Workers Scripts
edit access, plus Zone read, DNS edit, and Workers Routes edit access
for `byk.im`. Restrict the token to this account and zone. The
custom-domain deployment creates the required DNS record and edge
certificate.

The `Build BYK Cloudflare artifacts` GitHub Actions workflow runs the
unit suite and typecheck, builds the SPA with the production variables
above, and emits a dry-run Wrangler bundle. It never receives the
Cloudflare token.

## Android and Windows packages

The [Android](../packaging/android/pwabuilder.json) and
[Windows](../packaging/windows/pwabuilder.json) PWABuilder requests package
the deployed site and launch Attention. Both use its browser cache and
Web Push subscription.

Sign the Android APK with the distribution keystore. The SHA-256
fingerprint of the certificate used to sign the APK must appear in
[`assetlinks.json`](../public/.well-known/assetlinks.json) on the Pages
deployment. Use the Play App Signing certificate fingerprint for a
Play-distributed build. Keep signing keys outside the repository.

For a Windows preview, extract the PWABuilder sideload ZIP and run
`install.ps1` with Windows PowerShell. The preview uses Microsoft Edge
Stable. Store distribution requires a separate Microsoft Store submission.

## Smoke checks

An unauthenticated session request should reach Thundermail and return
an authentication response rather than a bridge error:

```bash
curl -i https://jmap.byk.im/.well-known/jmap
```

The paired origin should receive a successful preflight:

```bash
curl -i -X OPTIONS \
  -H 'Origin: https://webmail.byk.im' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Authorization, Content-Type' \
  https://jmap.byk.im/jmap/
```

Repeat with an unrelated `Origin`; it must return `403` without an
`Access-Control-Allow-Origin` header.

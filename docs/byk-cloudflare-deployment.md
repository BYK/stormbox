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
```

`VITE_APP_PASSWORD_ONLY=1` avoids offering Thundermail OIDC from an
unregistered redirect origin. The app password remains in browser
session memory and is sent directly to the JMAP bridge over HTTPS.

## JMAP bridge

The BYK Wrangler configuration intentionally has no committed
Cloudflare account ID. Supply it together with a scoped API token:

```bash
cd infra/jmap-bridge
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run deploy:byk
```

The token needs account-level Cloudflare Pages edit and Workers Scripts
edit access, plus Zone read, DNS edit, and Workers Routes edit access
for `byk.im`. Restrict the token to this account and zone. The
custom-domain deployment creates the required DNS record and edge
certificate.

The `Build BYK Cloudflare artifacts` GitHub Actions workflow runs the
unit suite and typecheck, builds the SPA with the production variables
above, and emits a dry-run Wrangler bundle. It never receives the
Cloudflare token.

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

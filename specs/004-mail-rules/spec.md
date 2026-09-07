# Visual server-side mail rules

**Status**: Prototype proposed upstream
**Proposal**: https://ideas.tb.pro/p/visual-server-side-mail-rules-using-jmap-sieve

## Goal

Stormbox shall let a signed-in user build ordered mail rules visually and run them on the mail server through JMAP for Sieve (RFC 9661). The feature remains fully browser-owned and does not add a Stormbox application backend.

## Requirements

| ID | Requirement |
|---|---|
| MR-1 | When the account advertises `urn:ietf:params:jmap:sieve`, the account menu shall offer a Mail Rules editor. When the capability is absent, the editor shall explain that server-side rules are unavailable. |
| MR-2 | The editor shall support ordered, enabled/disabled rules; all/any condition matching; From, To, To/Cc, Subject, and custom-header conditions; and exact, contains, or wildcard matching. |
| MR-3 | The editor shall support move, mark read, star, forward a copy, discard, and stop-processing actions, exposing only actions supported by the account's advertised Sieve extensions. |
| MR-4 | Stormbox shall store the visual rule document as versioned metadata in a clearly marked managed Sieve script. Generated Sieve is a build artifact rather than the source model. |
| MR-5 | Every save shall use the durable mutation outbox, upload the generated script, call `SieveScript/validate`, and activate it only after validation succeeds. |
| MR-6 | A save shall use the last observed `SieveScript` state and reject a concurrent server change instead of overwriting it. |
| MR-7 | Stormbox shall not modify or delete a script it does not own. If a foreign script is active, activation shall require explicit confirmation and shall preserve the foreign script on the server. |
| MR-8 | Move actions shall use the RFC 9042 `:mailboxid` extension when supported, retaining a readable hierarchy path as the fallback mailbox name. |
| MR-9 | Invalid rule data, unsupported actions, server validation failures, and server conflicts shall remain visible and recoverable in the editor. Controls shall be disabled while a save is in flight. |
| MR-10 | The editor shall be keyboard accessible, trap focus while open, and confirm before discarding unsaved changes. |

## Initial scope

- Server-side filtering of newly delivered mail.
- One managed visual-rule script per account.
- A deliberately limited, typed rules model and purpose-built Sieve emitter.
- Existing arbitrary Sieve scripts remain opaque and preserved.

## Non-goals

- Importing arbitrary Sieve into the visual model.
- A raw Sieve editor.
- Retroactively applying rules to existing messages.
- Shared-account rule management.
- A Cloudflare Worker rule engine; the deployment bridge only adapts browser CORS and WebSocket authentication.

## Verification

- Unit tests cover normalization, escaping, capability checks, metadata round-tripping, conflict handling, server validation, and outbox integration.
- Component tests cover loading, editing, takeover confirmation, save locking, and discard confirmation.
- Local-stack Playwright coverage asserts the visible editor result, durable mutation completion, and the active script directly through JMAP in Chromium and Firefox.

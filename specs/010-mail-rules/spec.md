# Visual server-side mail rules

**Status**: Prototype proposed upstream
**Proposal**: https://ideas.tb.pro/p/visual-server-side-mail-rules-using-jmap-sieve
**Issue**: https://github.com/thunderbird/stormbox/issues/128

## Goal

Stormbox shall let a signed-in user build ordered mail rules visually and run them on the mail server through JMAP for Sieve (RFC 9661). The feature remains fully browser-owned and does not add a Stormbox application backend.

## Requirements

| ID | Requirement |
|---|---|
| MR-1 | When the account advertises `urn:ietf:params:jmap:sieve`, the account menu shall offer a Mail Rules editor. When the capability is absent, the editor shall explain that server-side rules are unavailable. |
| MR-2 | The editor shall support ordered, enabled/disabled rules; recursively nested all/any/not condition groups; From, To, To/Cc, Subject, and custom-header conditions; and exact, contains, or wildcard matching. |
| MR-3 | The editor shall support move, mark read, star, forward a copy, discard, and stop-processing actions, exposing only actions supported by the account's advertised Sieve extensions. |
| MR-4 | The server-stored Sieve source shall be authoritative. Stormbox shall parse scripts into a source-ranged syntax tree and project every completely representable script into the visual rule model. UI-only identifiers may be regenerated and shall not duplicate the executable rule model in metadata. |
| MR-5 | Every save shall use the durable mutation outbox, upload the generated script, call `SieveScript/validate`, and activate it only after validation succeeds. |
| MR-6 | A save shall use the last observed `SieveScript` state and reject a concurrent server change instead of overwriting it. |
| MR-7 | A compatible existing active script shall be edited in place only after it has been parsed and completely represented. If the active script cannot be represented, activating a new visual script shall require explicit confirmation and shall preserve the existing script on the server. |
| MR-8 | Move actions shall use the RFC 9042 `:mailboxid` extension when supported, retaining a readable hierarchy path as the fallback mailbox name. |
| MR-9 | Invalid rule data, unsupported actions, server validation failures, and server conflicts shall remain visible and recoverable in the editor. Controls shall be disabled while a save is in flight. |
| MR-10 | The editor shall be keyboard accessible, trap focus while open, and confirm before discarding unsaved changes. |
| MR-11 | Stormbox shall only rewrite a script when every required extension is within the visual editor's semantics-preserving subset. Scripts requiring other extensions shall remain opaque and preserved. |

## Initial scope

- Server-side filtering of newly delivered mail.
- One visually edited script at a time; JMAP may retain other scripts and permits at most one active script.
- A source parser, deliberately limited visual projection, and Sieve emitter.
- Compatible existing scripts can be visualized and edited in place.
- Unsupported syntax remains preserved and available to a future Advanced editor.

## Non-goals

- Visually representing every Sieve extension or control-flow construct.
- A raw Sieve editor in the initial delivery; the parser and source ranges shall not preclude it.
- Retroactively applying rules to existing messages.
- Shared-account rule management.
- A Cloudflare Worker rule engine; the deployment bridge only adapts browser CORS and WebSocket authentication.

## Verification

- Unit tests cover syntax parsing, visual projection, nested grouping, escaping, capability checks, source round-tripping, conflict handling, server validation, and outbox integration.
- Component tests cover loading, nested editing, takeover confirmation, save locking, and discard confirmation.
- Local-stack Playwright coverage asserts the visible editor result, durable mutation completion, and the active script directly through JMAP in Chromium and Firefox.

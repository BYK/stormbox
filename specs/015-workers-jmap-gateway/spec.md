# Workers JMAP gateway

A Cloudflare Worker connects configured IMAP accounts to JMAP Mail and to the Attention inbox. Cloudflare Durable Objects retain message identities and sync cursors, scoped to one mail account per object. The mail provider remains authoritative.

## First release

- Keep the existing same-origin Attention pairing, account list, inbox, and message-reader contract.
- Expose a JMAP session and read methods to authenticated clients. Use the protocol's explicit errors for unsupported methods or a delta that needs a fresh query.
- Validate every mailbox UID against UIDVALIDITY. Read messages without setting Seen. Keep IMAP credentials in Worker secrets, outside the browser and SQLite.
- Attach the Worker to the gateway paths on the existing Pages hostname. The Pages app keeps its current sign-in and JMAP connection.
- Exercise authentication and account isolation in workerd. Confirm optional notifications and actual upstream mailbox access separately.

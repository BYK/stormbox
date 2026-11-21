# Unified Attention inbox

The Attention space groups recent inbox messages across connected accounts. Local ranking keeps an unanswered request visible through routine updates. Reading, sorting, marking a bundle done, and snoozing use the local cache. A new request can reopen a finished bundle.

## First slice

- Keep Stormbox's existing JMAP account and mail features. A user can add the IMAP accounts configured on a same-origin relay using a pairing token.
- Read a bounded inbox window from each account. Preserve account identity, message threading, and IMAP mailbox UIDVALIDITY. Cache opened message bodies and the most recent messages for offline reading.
- Keep Done and Snooze in SQLite. These actions change the Attention view, never the server mailbox. An unfamiliar message stays visible for review.
- Make the app shell installable and test an offline reload. Offer Web Push for a paired relay, with a notification opening Attention. Push payloads carry no message content.

## Architecture

The fork extends the upstream browser-owned, single-account MVP with an optional same-origin transport and notification service. Direct JMAP and its existing outbox retain their current path. The shared writer worker owns the additional cache, with relay transport behind a sync backend. Web Push requires a reachable relay while the client sleeps. Mailbox write support for IMAP and native packaging are subsequent steps.

## Native runtime probe

A Linux Tauri 2.12.7 and WebKitGTK 2.52.6 probe ran the production Stormbox
SQLite worker against a fixed loopback HTTP origin. Data persisted across two
native process launches, and a same-origin request carried its pairing cookie.
The Tauri custom protocol failed worker IndexedDB and WASM initialization in
that WebView. Native notification delivery and mobile runtimes still require
platform integration and testing.

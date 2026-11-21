CREATE TABLE attention_imap_accounts (
  owner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  relay_id TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  mailbox TEXT,
  uid_validity TEXT,
  messages_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (owner_account_id, relay_id)
);

CREATE TABLE attention_imap_pairing (
  owner_account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE attention_imap_bodies (
  owner_account_id INTEGER NOT NULL,
  relay_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  uid INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (owner_account_id, relay_id, mailbox, uid_validity, uid),
  FOREIGN KEY (owner_account_id, relay_id)
    REFERENCES attention_imap_accounts(owner_account_id, relay_id) ON DELETE CASCADE
);

CREATE TABLE attention_bundle_states (
  owner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (owner_account_id, bundle_id)
);

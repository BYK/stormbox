ALTER TABLE attention_imap_accounts ADD COLUMN last_synced_at INTEGER;
ALTER TABLE attention_imap_accounts ADD COLUMN sync_error TEXT;
ALTER TABLE attention_imap_accounts ADD COLUMN total_messages INTEGER;
ALTER TABLE attention_imap_accounts ADD COLUMN folders_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE imap_folder_windows (
  owner_account_id INTEGER NOT NULL,
  relay_id TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uid_validity TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  total_messages INTEGER,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (owner_account_id, relay_id, mailbox),
  FOREIGN KEY (owner_account_id, relay_id)
    REFERENCES attention_imap_accounts(owner_account_id, relay_id) ON DELETE CASCADE
);

CREATE TABLE attention_imap_settings (
  owner_account_id INTEGER PRIMARY KEY REFERENCES attention_imap_pairing(owner_account_id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL
);
